import { describe, expect, it, vi } from 'vitest'
import type {
  ContinueRebaseResult,
  RebaseStopToken
} from '../../../../../../shared/git/status/git-status-types'
import { confirmAndAbortRebase, type AbortConfirmRequest } from './rebase-abort-confirmation'

const STOP: RebaseStopToken = { head: 'h1', step: '1', incarnation: 'run-1' }

function harness(answers: boolean[]) {
  const queue = [...answers]
  return {
    confirm: vi.fn(async (_request: AbortConfirmRequest) => queue.shift() ?? false),
    beginAbort: vi.fn(),
    abort: vi.fn(
      async (_stop?: RebaseStopToken, _discards?: string[]): Promise<ContinueRebaseResult> => ({
        outcome: 'aborted'
      })
    )
  }
}

describe('confirmAndAbortRebase', () => {
  it('names every path Abort would reset, and Cancel aborts nothing', async () => {
    const h = harness([false])
    await expect(
      confirmAndAbortRebase({
        ...h,
        inspect: async () => ({ stop: STOP, discards: ['app.txt', 'notes.txt'] })
      })
    ).resolves.toBe('cancelled')
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Abort rebase and discard edits to 2 files?',
      description: 'app.txt, notes.txt',
      confirmLabel: 'Discard and abort'
    })
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('aborts only the confirmed stop and set of paths', async () => {
    const h = harness([true])
    await confirmAndAbortRebase({
      ...h,
      inspect: async () => ({ stop: STOP, discards: ['a.txt'] })
    })
    expect(h.abort).toHaveBeenCalledWith(STOP, ['a.txt'])
  })

  it('asks again with the new set when the host saw it change before aborting', async () => {
    const h = harness([true, false])
    h.abort.mockResolvedValueOnce({
      outcome: 'abort_changed',
      stop: STOP,
      abortWouldDiscard: ['a.txt', 'late-edit.txt']
    })
    await expect(
      confirmAndAbortRebase({ ...h, inspect: async () => ({ stop: STOP, discards: ['a.txt'] }) })
    ).resolves.toBe('cancelled')
    expect(h.confirm.mock.calls[1][0]).toMatchObject({
      title: 'Abort rebase and discard edits to 2 files?',
      description: 'a.txt, late-edit.txt'
    })
  })

  it('warns that edits may be lost when the host cannot tell, and sends no binding', async () => {
    const h = harness([true])
    await confirmAndAbortRebase({ ...h, inspect: async () => null })
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Abort rebase?',
      description: 'Uncommitted edits may be lost.',
      confirmLabel: 'Discard and abort'
    })
    expect(h.abort).toHaveBeenCalledWith()
  })

  it('keeps the plain confirm only when the tree is proven clean', async () => {
    const h = harness([false])
    await confirmAndAbortRebase({ ...h, inspect: async () => ({ stop: STOP, discards: [] }) })
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ confirmLabel: 'Abort rebase' })
  })
})
