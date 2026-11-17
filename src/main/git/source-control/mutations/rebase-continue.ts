import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  ContinueRebaseAction,
  ContinueRebaseResult,
  RebaseStopToken
} from '../../../../shared/git/status/git-status-types'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'
import { runWithGitWorktreeOperationLock } from '../../../../shared/git/worktrees/git-worktree-operation-lock'
import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../git-read-cache-invalidation'
import { resolveGitDir } from '../resolve-git-dir'
import { AUTOSTASH_REAPPLY_CONFLICT, detectConflictOperation } from './git-conflict-operation'
import { takeOrcaRebaseProvenance } from './orca-rebase-provenance'

// Git's own words for a pick the resolution left empty (apply backend; merge backend in older Git).
const EMPTY_PICK_OUTPUT = /No changes - did you forget to use 'git add'|nothing to commit/i

/**
 * `inspect` reads the current stop without changing anything. `continue` runs only when the
 * rebase is still at the stop the caller was shown, so a retry after an unknown settlement
 * cannot advance a later stop the user never saw.
 */
export async function continueRebase(
  worktreePath: string,
  action: ContinueRebaseAction = 'continue',
  options: GitRuntimeOptions & { expected?: RebaseStopToken } = {}
): Promise<ContinueRebaseResult> {
  const { expected, ...gitOptions } = options
  return runWithGitWorktreeOperationLock(worktreePath, gitOptions.signal, () =>
    runWithGitReadCacheInvalidation(() =>
      action === 'inspect'
        ? inspectRebaseStop(worktreePath, gitOptions)
        : continueRebaseUnlocked(worktreePath, expected, gitOptions)
    )
  )
}

async function inspectRebaseStop(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<ContinueRebaseResult> {
  if ((await detectConflictOperation(worktreePath, options)) !== 'rebase') {
    return { outcome: 'not_rebasing' }
  }
  return {
    outcome: 'inspected',
    stop: await readRebaseStopToken(worktreePath, options),
    branch: await readRebasingBranch(worktreePath, options),
    abortWouldDiscard: await readEditsAbortWouldDiscard(worktreePath, options)
  }
}

/**
 * Tracked edits that git rebase --abort would throw away beyond resolving the stopped pick: any
 * changed path the pick itself does not touch. Without REBASE_HEAD every changed path counts.
 */
async function readEditsAbortWouldDiscard(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string[]> {
  const run = (args: string[]) =>
    gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
  const lines = (stdout: string) =>
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  const changed = lines((await run(['diff', '--name-only', '--no-renames', 'HEAD', '--'])).stdout)
  let pickPaths = new Set<string>()
  try {
    const { stdout } = await run([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '--root',
      'REBASE_HEAD',
      '--'
    ])
    pickPaths = new Set(lines(stdout))
  } catch {
    // No stopped pick to attribute edits to: every changed path is at risk.
  }
  return changed.filter((filePath) => !pickPaths.has(filePath)).sort()
}

async function continueRebaseUnlocked(
  worktreePath: string,
  expected: RebaseStopToken | undefined,
  options: GitRuntimeOptions
): Promise<ContinueRebaseResult> {
  if ((await detectConflictOperation(worktreePath, options)) !== 'rebase') {
    return { outcome: 'not_rebasing' }
  }
  const before = await readRebaseStopToken(worktreePath, options)
  const branch = await readRebasingBranch(worktreePath, options)
  // An unreadable run identity fails closed: nothing proves this is the stop the user saw.
  if (!expected || before.incarnation === null || !sameStop(expected, before)) {
    return { outcome: 'stale', stop: before, branch }
  }
  // Why: picks open the commit-message editor and Orca has no TTY; this keeps Git's prepared message.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'true' }
  if (process.platform === 'win32') {
    addWslEnvKeys(env, ['GIT_EDITOR'])
  }
  let output: string
  let exitedCleanly: boolean
  try {
    const { stdout, stderr } = await gitExecFileAsync(['rebase', '--continue'], {
      ...gitOptionsForWorktree(worktreePath, options),
      env
    })
    output = joinGitOutput(stdout, stderr)
    exitedCleanly = true
  } catch (error) {
    output = readGitErrorOutput(error)
    exitedCleanly = false
  }

  if ((await detectConflictOperation(worktreePath, options)) !== 'rebase') {
    if (!exitedCleanly) {
      return { outcome: 'failed', message: output, branch }
    }
    const integratedUpstreamOid = takeOrcaRebaseProvenance(worktreePath, branch, before.incarnation)
    return {
      outcome: AUTOSTASH_REAPPLY_CONFLICT.test(output)
        ? 'completed_autostash_conflict'
        : 'completed',
      ...(AUTOSTASH_REAPPLY_CONFLICT.test(output) ? { message: output } : {}),
      branch,
      ...(integratedUpstreamOid ? { integratedUpstreamOid } : {})
    }
  }
  const stop = await readRebaseStopToken(worktreePath, options)
  const stopped = { message: output, stop, branch }
  // Interactive edit/break stops exit 0 mid-rebase; report them, never as done.
  if (exitedCleanly) {
    return { outcome: 'stopped', ...stopped }
  }
  // Dropped empty picks advance the step without moving HEAD; exec failures leave no unmerged paths.
  const advanced = stop.head !== before.head || stop.step !== before.step
  if (advanced && (await hasUnmergedPaths(worktreePath, options))) {
    return { outcome: 'conflicted', ...stopped }
  }
  if (
    !advanced &&
    EMPTY_PICK_OUTPUT.test(output) &&
    !(await hasUnmergedPaths(worktreePath, options)) &&
    (await gitDiffIsQuiet(worktreePath, ['--cached', 'HEAD'], options))
  ) {
    return { outcome: 'empty', ...stopped }
  }
  return { outcome: 'failed', ...stopped }
}

function sameStop(a: RebaseStopToken, b: RebaseStopToken): boolean {
  return a.head === b.head && a.step === b.step && a.incarnation === b.incarnation
}

export async function readRebaseStopToken(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<RebaseStopToken> {
  const gitDir = await resolveGitDir(worktreePath, options)
  const readState = async (file: string): Promise<string | null> => {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      try {
        return (await readFile(path.join(gitDir, dir, file), 'utf8')).trim()
      } catch {
        // Only one backend's directory exists.
      }
    }
    return null
  }
  // msgnum (merge backend) or next (apply backend) is the step; onto + orig-head name the run.
  const step = (await readState('msgnum')) ?? (await readState('next'))
  const onto = await readState('onto')
  const origHead = await readState('orig-head')
  // An identical abort and restart rewrites the same onto/orig-head; the new state dir does not.
  const runId = await readRebaseDirIdentity(gitDir)
  return {
    head: await readHead(worktreePath, options),
    step,
    incarnation: onto && origHead && runId ? `${runId}:${onto}:${origHead}` : null
  }
}

/** The branch the paused rebase will update (its head-name file); null for a detached rebase. */
export async function readRebasingBranch(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  const gitDir = await resolveGitDir(worktreePath, options)
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const ref = (await readFile(path.join(gitDir, dir, 'head-name'), 'utf8')).trim()
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
    } catch {
      // Only one backend's directory exists.
    }
  }
  return null
}

async function readRebaseDirIdentity(gitDir: string): Promise<string | null> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const info = await stat(path.join(gitDir, dir), { bigint: true })
      // Never ctime: Git adds and removes files in this dir on every step. Birth time is 0 where
      // the filesystem lacks it, leaving the inode alone to tell runs apart.
      return `${dir}:${info.ino}:${info.birthtimeNs}`
    } catch {
      // Only one backend's directory exists.
    }
  }
  return null
}

async function readHead(worktreePath: string, options: GitRuntimeOptions): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '-q', 'HEAD'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function hasUnmergedPaths(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['diff', '--name-only', '--diff-filter=U'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function gitDiffIsQuiet(
  worktreePath: string,
  args: string[],
  options: GitRuntimeOptions
): Promise<boolean> {
  try {
    await gitExecFileAsync(
      ['diff', '--quiet', ...args, '--'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return true
  } catch {
    return false
  }
}

function joinGitOutput(stdout: unknown, stderr: unknown): string {
  return [stdout, stderr]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join('\n')
}

// Keep Git's diagnostics; spawn failures carry only an Error message.
function readGitErrorOutput(error: unknown): string {
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
