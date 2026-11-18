import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { abortRebase, detectConflictOperation } from './git-conflict-operation'
import { continueRebase } from './rebase-continue'
import { createConflictingRebaseRepo } from './rebase-real-git.test-fixture'

describe('rebase Abort backup against real git', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function pausedRebase() {
    const repo = createConflictingRebaseRepo(tempPaths)
    expect(() => repo.git('rebase', 'main')).toThrow()
    const backups = (): string[] =>
      repo
        .git('for-each-ref', '--format=%(objectname)', 'refs/orca/rebase-abort-backup/')
        .split('\n')
        .filter(Boolean)
    return { ...repo, backups }
  }

  it('names staged edits an unstaged edit cancels out, with exact file names', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    write('c.txt', 'staged c\n')
    git('add', 'c.txt')
    write('c.txt', 'main c\n')
    write(' lead.txt', 'new\n')
    git('add', ' lead.txt')

    await expect(continueRebase(repoPath, 'inspect')).resolves.toMatchObject({
      abortWouldDiscard: [' lead.txt', 'a.txt', 'c.txt']
    })
  })

  it('aborts only the confirmed set, keeping every edit in a backup', async () => {
    const { repoPath, git, write, backups } = pausedRebase()
    write('a.txt', 'resolved a\n')
    git('add', 'a.txt')
    write('c.txt', 'edited during the pause\n')
    const inspected = await continueRebase(repoPath, 'inspect')
    expect(inspected.abortWouldDiscard).toEqual(['a.txt', 'c.txt'])

    write('b.txt', 'another edit\n')
    await expect(
      continueRebase(repoPath, 'abort', {
        expected: inspected.stop,
        expectedDiscards: inspected.abortWouldDiscard
      })
    ).resolves.toMatchObject({
      outcome: 'abort_changed',
      abortWouldDiscard: ['a.txt', 'b.txt', 'c.txt']
    })
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
    expect(backups()).toEqual([])

    const aborted = await continueRebase(repoPath, 'abort', {
      expected: inspected.stop,
      expectedDiscards: ['a.txt', 'b.txt', 'c.txt']
    })
    expect(aborted.outcome).toBe('aborted')
    await expect(detectConflictOperation(repoPath)).resolves.toBe('unknown')
    expect(backups()).toEqual([aborted.backup])
    expect(git('show', `${aborted.backup}:c.txt`)).toBe('edited during the pause\n')
  })

  it('restores a backup that applies cleanly and then drops it', async () => {
    const { repoPath, git, write, backups } = pausedRebase()
    git('checkout', 'HEAD', '--', 'a.txt')
    write('d.txt', 'new during the pause\n')
    git('add', 'd.txt')
    const aborted = await continueRebase(repoPath, 'abort')
    expect(git('ls-files', 'd.txt')).toBe('')

    await expect(continueRebase(repoPath, 'restore', { backup: aborted.backup })).resolves.toEqual({
      outcome: 'restored'
    })
    expect(readFileSync(join(repoPath, 'd.txt'), 'utf8')).toBe('new during the pause\n')
    expect(backups()).toEqual([])
  })

  it('backs up an unresolved conflict and restores it with conflicts, keeping the backup', async () => {
    const { repoPath, git, write, backups } = pausedRebase()
    write('c.txt', 'edited during the pause\n')
    const aborted = await continueRebase(repoPath, 'abort')
    expect(aborted.outcome).toBe('aborted')

    await expect(
      continueRebase(repoPath, 'restore', { backup: aborted.backup })
    ).resolves.toMatchObject({ outcome: 'restored_with_conflicts' })
    expect(git('ls-files', '-u')).not.toBe('')
    expect(backups()).toEqual([aborted.backup])
  })

  it('does not abort when the backup cannot be pinned', async () => {
    const { repoPath, git, write } = pausedRebase()
    write('c.txt', 'edited during the pause\n')
    // A file where the backup refs' directory belongs makes pinning fail.
    mkdirSync(join(repoPath, '.git', 'refs', 'orca'), { recursive: true })
    writeFileSync(join(repoPath, '.git', 'refs', 'orca', 'rebase-abort-backup'), '')

    await expect(continueRebase(repoPath, 'abort')).resolves.toMatchObject({ outcome: 'failed' })
    await expect(abortRebase(repoPath)).rejects.toThrow()
    await expect(detectConflictOperation(repoPath)).resolves.toBe('rebase')
    expect(git('diff', '--name-only')).toContain('c.txt')
  })

  it('aborts a clean pause without a backup', async () => {
    const { repoPath, git, backups } = pausedRebase()
    git('checkout', 'HEAD', '--', 'a.txt')
    await expect(continueRebase(repoPath, 'abort')).resolves.toEqual({ outcome: 'aborted' })
    expect(backups()).toEqual([])
  })

  it('restores only Orca backups', async () => {
    const { repoPath, git } = pausedRebase()
    const head = git('rev-parse', 'HEAD').trim()
    await expect(continueRebase(repoPath, 'restore', { backup: head })).resolves.toMatchObject({
      outcome: 'failed'
    })
  })
})
