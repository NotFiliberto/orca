import { randomUUID } from 'node:crypto'
import { copyFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import type { ContinueRebaseResult } from '../../../../shared/git/status/git-status-types'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'
import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { resolveGitDir } from '../resolve-git-dir'

export const ABORT_BACKUP_REF_PREFIX = 'refs/orca/rebase-abort-backup/'
const BACKUP_MESSAGE = 'Orca: tracked edits before rebase abort'
// The backup is Orca's own commit; a user without a configured identity must still get one.
const BACKUP_IDENTITY = {
  GIT_AUTHOR_NAME: 'Orca',
  GIT_AUTHOR_EMAIL: 'orca@localhost',
  GIT_COMMITTER_NAME: 'Orca',
  GIT_COMMITTER_EMAIL: 'orca@localhost'
}
const BACKUP_OID = /^[0-9a-f]{40,64}$/

type GitExecOptions = Parameters<typeof gitExecFileAsync>[1]

/** Every tracked path Abort would reset, staged and unstaged listed separately; null when unknown. */
export async function readTrackedPathsAbortWouldReset(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string[] | null> {
  const gitOptions = gitOptionsForWorktree(worktreePath, options)
  try {
    // Separately, so staged content an unstaged edit cancels out is still named; -z keeps names exact.
    const staged = await gitExecFileAsync(
      ['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD', '--'],
      gitOptions
    )
    const unstaged = await gitExecFileAsync(
      ['diff', '--name-only', '-z', '--no-renames', '--'],
      gitOptions
    )
    return [...new Set([...splitNul(staged.stdout), ...splitNul(unstaged.stdout)])].sort()
  } catch {
    return null
  }
}

/**
 * Snapshots staged and unstaged tracked edits as a stash commit pinned under refs/orca, so Abort
 * cannot lose them. Null when nothing tracked is dirty; throws when no backup could be made.
 */
export async function backUpEditsBeforeAbort(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  const gitOptions = gitOptionsForWorktree(worktreePath, options)
  const hostGitDir = await resolveGitDir(worktreePath, options)
  const indexName = `orca-abort-backup-${randomUUID()}.index`
  const hostIndex = path.join(hostGitDir, indexName)
  // Git's own view of the same file: a distro path where Node sees a WSL UNC one.
  const gitDir = (await gitExecFileAsync(['rev-parse', '--absolute-git-dir'], gitOptions)).stdout
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...BACKUP_IDENTITY,
    GIT_INDEX_FILE: `${gitDir.trim()}/${indexName}`
  }
  if (process.platform === 'win32') {
    addWslEnvKeys(env, ['GIT_INDEX_FILE', ...Object.keys(BACKUP_IDENTITY)])
  }
  const scratch = { ...gitOptions, env }
  try {
    // A copy leaves the real index alone and keeps its stat cache fast.
    await copyFile(path.join(hostGitDir, 'index'), hostIndex)
    // stash create refuses unmerged entries; their content is the worktree file, captured anyway.
    const unmerged = await readUnmergedPaths(scratch)
    if (unmerged.length > 0) {
      await gitExecFileAsync(['reset', '-q', 'HEAD', '--', ...unmerged], scratch)
    }
    const oid = (await gitExecFileAsync(['stash', 'create', BACKUP_MESSAGE], scratch)).stdout.trim()
    if (!oid) {
      return null
    }
    const ref = `${ABORT_BACKUP_REF_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`
    await gitExecFileAsync(['update-ref', '-m', BACKUP_MESSAGE, ref, oid], gitOptions)
    return oid
  } finally {
    await rm(hostIndex, { force: true })
  }
}

/** Reapplies an abort backup; conflicts are left for the usual conflict UI and the backup kept. */
export async function restoreAbortBackup(
  worktreePath: string,
  backup: string | undefined,
  options: GitRuntimeOptions
): Promise<ContinueRebaseResult> {
  const gitOptions = gitOptionsForWorktree(worktreePath, options)
  const refs = backup && BACKUP_OID.test(backup) ? await readBackupRefs(backup, gitOptions) : []
  if (!backup || refs.length === 0) {
    return { outcome: 'failed', message: 'Not an Orca rebase-abort backup.' }
  }
  const conflictedBefore = (await readUnmergedPaths(gitOptions)).length > 0
  try {
    await gitExecFileAsync(['stash', 'apply', backup], gitOptions)
  } catch (error) {
    const message = readGitErrorOutput(error)
    return !conflictedBefore && (await readUnmergedPaths(gitOptions)).length > 0
      ? { outcome: 'restored_with_conflicts', message }
      : { outcome: 'failed', message }
  }
  for (const ref of refs) {
    await gitExecFileAsync(['update-ref', '-d', ref, backup], gitOptions)
  }
  return { outcome: 'restored' }
}

async function readBackupRefs(backup: string, options: GitExecOptions): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['for-each-ref', '--format=%(refname)', `--points-at=${backup}`, ABORT_BACKUP_REF_PREFIX],
      options
    )
    return stdout.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function readUnmergedPaths(options: GitExecOptions): Promise<string[]> {
  const { stdout } = await gitExecFileAsync(['ls-files', '-u', '-z'], options)
  // Entries are "<mode> <oid> <stage>\t<path>", one per stage.
  return [...new Set(splitNul(stdout).map((entry) => entry.slice(entry.indexOf('\t') + 1)))]
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0)
}

export function joinGitOutput(stdout: unknown, stderr: unknown): string {
  return [stdout, stderr]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join('\n')
}

// Keep Git's diagnostics; spawn failures carry only an Error message.
export function readGitErrorOutput(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const output = joinGitOutput(
      'stdout' in error ? error.stdout : undefined,
      'stderr' in error ? error.stderr : undefined
    )
    if (output) {
      return output
    }
  }
  return error instanceof Error ? error.message : String(error)
}
