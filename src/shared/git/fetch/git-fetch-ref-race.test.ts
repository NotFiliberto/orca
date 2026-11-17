import { describe, expect, it, vi } from 'vitest'
import { retryGitFetchRefRace } from './git-fetch-ref-race'

describe('retryGitFetchRefRace', () => {
  it('does not replay a fetch whose previous child cannot be proven finished', async () => {
    const raced = Object.assign(new Error('Command failed: git fetch origin'), {
      stderr: 'error: fetching ref refs/remotes/origin/main failed: incorrect old value provided\n'
    })
    const attempt = vi.fn(async () => 'replayed')

    await expect(
      retryGitFetchRefRace(['fetch', 'origin'], raced, attempt, () => Promise.resolve(false))
    ).rejects.toBe(raced)
    expect(attempt).not.toHaveBeenCalled()
  })
})
