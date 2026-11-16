import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { continueRebase, detectConflictOperation } from './git-conflict-operation'

describe('continueRebase outcome classification against real git', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  /** Two feature commits each conflict with one main commit on the same files. */
  function createFeatureBehindConflictingMain() {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-continue-rebase-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repoPath,
        encoding: 'utf8',
        env: { ...process.env, GIT_EDITOR: 'true' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    const write = (file: string, text: string) => writeFileSync(join(repoPath, file), text)
    git('init', '--quiet', '-b', 'main')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    write('a.txt', 'base\n')
    write('b.txt', 'base\n')
    write('c.txt', 'base\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    git('checkout', '--quiet', '-b', 'feature')
    write('a.txt', 'feature a\n')
    git('commit', '--quiet', '-am', 'feature a')
    write('b.txt', 'feature b\n')
    git('commit', '--quiet', '-am', 'feature b')
    git('checkout', '--quiet', 'main')
    write('a.txt', 'main a\n')
    write('b.txt', 'main b\n')
    write('c.txt', 'main c\n')
    git('commit', '--quiet', '-am', 'main edits')
    git('checkout', '--quiet', 'feature')
    return { repoPath, git, write }
  }

  it('reports a later conflict as conflicted, then completes', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()

    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    await expect(continueRebase(repoPath)).resolves.toMatchObject({ outcome: 'conflicted' })
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('b.txt\n')

    write('b.txt', 'resolved b\n')
    git('add', 'b.txt')
    await expect(continueRebase(repoPath)).resolves.toMatchObject({ outcome: 'completed' })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
    expect(git('log', '-1', '--format=%s').trim()).toBe('feature b')
  })

  it('keeps the rebase paused and reports git’s refusal for an unstaged resolution', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    write('a.txt', 'resolved a\n')

    const result = await continueRebase(repoPath)
    expect(result.outcome).toBe('failed')
    expect(result.message).toBeTruthy()
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
  })

  it('classifies an empty resolution as empty on the apply backend, and Skip moves on', async () => {
    const { repoPath, git } = createFeatureBehindConflictingMain()
    // Git 2.25's default backend; it refuses to continue when the resolution changes nothing.
    expect(() => git('rebase', '--apply', 'main')).toThrow()
    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')

    const empty = await continueRebase(repoPath)
    expect(empty.outcome).toBe('empty')
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')

    const expected = { head: empty.head ?? null, step: empty.step ?? null }
    await expect(continueRebase(repoPath, 'skip', { expected })).resolves.toMatchObject({
      outcome: 'conflicted'
    })
  })

  it('refuses Skip, keeping the edit, when the tree gained edits after the empty stop', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', '--apply', 'main')).toThrow()
    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')
    const empty = await continueRebase(repoPath)
    expect(empty.outcome).toBe('empty')
    write('c.txt', 'edited during the pause\n')

    const expected = { head: empty.head ?? null, step: empty.step ?? null }
    await expect(continueRebase(repoPath, 'skip', { expected })).resolves.toMatchObject({
      outcome: 'skip_refused_dirty'
    })
    expect(git('show', ':c.txt')).toBe('main c\n')
    expect(git('diff', '--name-only')).toBe('c.txt\n')
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
  })

  it('does not report a dirty refusal as an empty stop', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', '--apply', 'main')).toThrow()
    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')
    write('c.txt', 'edited during the pause\n')

    await expect(continueRebase(repoPath)).resolves.not.toMatchObject({ outcome: 'empty' })
  })

  it('refuses a Skip bound to a stop the rebase already left', async () => {
    const { repoPath, git } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', '--apply', 'main')).toThrow()
    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')
    const empty = await continueRebase(repoPath)
    const expected = { head: empty.head ?? null, step: empty.step ?? null }
    await continueRebase(repoPath, 'skip', { expected })
    const stepAfterFirstSkip = git('rev-parse', 'HEAD')

    // A retry of the same Skip after an unknown settlement must not drop the next commit.
    await expect(continueRebase(repoPath, 'skip', { expected })).resolves.toMatchObject({
      outcome: 'skip_refused_stale'
    })
    expect(git('rev-parse', 'HEAD')).toBe(stepAfterFirstSkip)
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('b.txt\n')
    await expect(continueRebase(repoPath, 'skip')).resolves.toMatchObject({
      outcome: 'skip_refused_stale'
    })
  })

  it('reports a repeated Continue after completion as not rebasing, not success', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', 'main')).toThrow()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    await continueRebase(repoPath)
    write('b.txt', 'resolved b\n')
    git('add', 'b.txt')
    await continueRebase(repoPath)

    await expect(continueRebase(repoPath)).resolves.toEqual({ outcome: 'not_rebasing' })
  })

  it('treats the merge backend dropping an empty pick before the next conflict as conflicted', async () => {
    const { repoPath, git } = createFeatureBehindConflictingMain()
    expect(() => git('rebase', '--merge', 'main')).toThrow()
    git('checkout', '--ours', 'a.txt')
    git('add', 'a.txt')
    const headBefore = git('rev-parse', 'HEAD')

    // HEAD stays put because the empty pick is dropped; only the step counter shows progress.
    await expect(continueRebase(repoPath)).resolves.toMatchObject({ outcome: 'conflicted' })
    expect(git('rev-parse', 'HEAD')).toBe(headBefore)
  })

  it('flags an autostash that could not reapply after the rebase completes', async () => {
    const { repoPath, git, write } = createFeatureBehindConflictingMain()
    write('c.txt', 'uncommitted c\n')
    expect(() => git('rebase', '--autostash', 'main')).toThrow()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    await continueRebase(repoPath)
    write('b.txt', 'resolved b\n')
    git('add', 'b.txt')

    await expect(continueRebase(repoPath)).resolves.toMatchObject({
      outcome: 'completed_autostash_conflict'
    })
    expect(git('stash', 'list')).toContain('autostash')
  })
})
