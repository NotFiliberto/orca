import { access, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  ContinueRebaseAction,
  ContinueRebaseExpectedStop,
  ContinueRebaseResult,
  GitConflictOperation
} from '../../../../shared/git/status/git-status-types'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'
import { runWithGitWorktreeOperationLock } from '../../../../shared/git/worktrees/git-worktree-operation-lock'
import { runWithGitReadCacheInvalidation } from '../git-read-cache-invalidation'
import { resolveGitDir } from '../resolve-git-dir'

// HEAD detection races may yield unknown for one poll; rebase directories persist more reliably than REBASE_HEAD.
export async function detectConflictOperation(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<GitConflictOperation> {
  const gitDir = await resolveGitDir(worktreePath, options)
  const mergeHead = path.join(gitDir, 'MERGE_HEAD')
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD')
  const revertHead = path.join(gitDir, 'REVERT_HEAD')
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')

  // Probe concurrently without blocking main: each WSL/UNC path can cost a 9p round trip.
  const [hasMergeHead, hasCherryPickHead, hasRebaseMergeDir, hasRebaseApplyDir, hasRevertHead] =
    await Promise.all(
      [mergeHead, cherryPickHead, rebaseMergeDir, rebaseApplyDir, revertHead].map(pathExists)
    )
  const hasRebaseDir = hasRebaseMergeDir || hasRebaseApplyDir

  if (hasMergeHead) {
    return 'merge'
  }
  if (hasRebaseDir) {
    return 'rebase'
  }
  if (hasCherryPickHead) {
    return 'cherry-pick'
  }
  if (hasRevertHead) {
    return 'revert'
  }
  return 'unknown'
}

/** Treat inaccessible paths as absent without throwing. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export async function abortMerge(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['merge', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}

export async function abortRebase(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['rebase', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}

export const AUTOSTASH_REAPPLY_CONFLICT = /Applying autostash resulted in conflicts/i

/** Continue or skip a paused rebase, classifying the stop conservatively so nothing uncertain reads as done. */
export async function continueRebase(
  worktreePath: string,
  action: ContinueRebaseAction = 'continue',
  options: GitRuntimeOptions & { expected?: ContinueRebaseExpectedStop } = {}
): Promise<ContinueRebaseResult> {
  const { expected, ...gitOptions } = options
  // A second click, or a retry after a remote timeout, waits for the first instead of racing it.
  return runWithGitWorktreeOperationLock(worktreePath, gitOptions.signal, () =>
    runWithGitReadCacheInvalidation(() =>
      continueRebaseUnlocked(worktreePath, action, expected, gitOptions)
    )
  )
}

// Git's own words for a pick the resolution left empty (apply backend; merge backend in older Git).
const EMPTY_PICK_OUTPUT = /No changes - did you forget to use 'git add'|nothing to commit/i

async function continueRebaseUnlocked(
  worktreePath: string,
  action: ContinueRebaseAction,
  expected: ContinueRebaseExpectedStop | undefined,
  options: GitRuntimeOptions
): Promise<ContinueRebaseResult> {
  if ((await detectConflictOperation(worktreePath, options)) !== 'rebase') {
    return { outcome: 'not_rebasing' }
  }
  const headBefore = await readHead(worktreePath, options)
  const stepBefore = await readRebaseStep(worktreePath, options)
  const branch = await readRebasingBranch(worktreePath, options)
  if (action === 'skip') {
    // Skip resets the tree; it may only drop the exact empty stop the user saw, with nothing to lose.
    if (!expected || expected.head !== headBefore || expected.step !== stepBefore) {
      return { outcome: 'skip_refused_stale', head: headBefore, step: stepBefore, branch }
    }
    if (!(await isCleanEmptyStop(worktreePath, options))) {
      return { outcome: 'skip_refused_dirty', head: headBefore, step: stepBefore, branch }
    }
  }
  // Why: picks open the commit-message editor and Orca has no TTY; this keeps Git's prepared message.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'true' }
  if (process.platform === 'win32') {
    addWslEnvKeys(env, ['GIT_EDITOR'])
  }
  let output: string
  let exitedCleanly: boolean
  try {
    const { stdout, stderr } = await gitExecFileAsync(['rebase', `--${action}`], {
      ...gitOptionsForWorktree(worktreePath, options),
      env
    })
    output = joinGitOutput(stdout, stderr)
    exitedCleanly = true
  } catch (error) {
    output = readGitErrorOutput(error)
    exitedCleanly = false
  }

  const stillRebasing = (await detectConflictOperation(worktreePath, options)) === 'rebase'
  const head = await readHead(worktreePath, options)
  if (!stillRebasing) {
    if (!exitedCleanly) {
      return { outcome: 'failed', message: output, head, branch }
    }
    return AUTOSTASH_REAPPLY_CONFLICT.test(output)
      ? { outcome: 'completed_autostash_conflict', message: output, head, branch }
      : { outcome: 'completed', head, branch }
  }
  const step = await readRebaseStep(worktreePath, options)
  const stop = { message: output, head, step, branch }
  // Interactive edit/break stops exit 0 mid-rebase; report them, never as done.
  if (exitedCleanly) {
    return { outcome: 'stopped', ...stop }
  }
  // Skips and dropped empty picks advance the step without moving HEAD; exec failures leave no unmerged paths.
  const advanced = head !== headBefore || step !== stepBefore
  if (advanced && (await hasUnmergedPaths(worktreePath, options))) {
    return { outcome: 'conflicted', ...stop }
  }
  // Empty only on Git's own say-so and a tree with nothing a Skip could discard.
  if (
    !advanced &&
    EMPTY_PICK_OUTPUT.test(output) &&
    (await isCleanEmptyStop(worktreePath, options))
  ) {
    return { outcome: 'empty', ...stop }
  }
  return { outcome: 'failed', ...stop }
}

async function isCleanEmptyStop(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<boolean> {
  return (
    !(await hasUnmergedPaths(worktreePath, options)) &&
    (await gitDiffIsQuiet(worktreePath, ['--cached', 'HEAD'], options)) &&
    (await gitDiffIsQuiet(worktreePath, [], options))
  )
}

/** The branch the paused rebase will update (its head-name file); null for a detached rebase. */
async function readRebasingBranch(
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

/** The step Git is on: rebase-merge/msgnum (merge backend) or rebase-apply/next (apply backend). */
async function readRebaseStep(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  const gitDir = await resolveGitDir(worktreePath, options)
  for (const file of [
    path.join(gitDir, 'rebase-merge', 'msgnum'),
    path.join(gitDir, 'rebase-apply', 'next')
  ]) {
    try {
      return (await readFile(file, 'utf8')).trim()
    } catch {
      // Only one backend's directory exists.
    }
  }
  return null
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

/** Git refuses to rebase over tracked changes unless rebase.autoStash is on. */
export async function readRebaseAutoStash(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--bool', '--get', '--default=false', 'rebase.autoStash'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}
