import { describe, expect, it, vi } from 'vitest'
import { confirmRebaseAbort, type AbortConfirmRequest } from './rebase-abort-confirmation'

function readsInOrder(...results: (string[] | null)[]) {
  const queue = [...results]
  return vi.fn(async () => queue.shift() ?? null)
}

describe('confirmRebaseAbort', () => {
  it('names the edits Abort would discard, and Cancel aborts nothing', async () => {
    const confirm = vi.fn(async (_request: AbortConfirmRequest) => false)

    await expect(
      confirmRebaseAbort({ readDiscards: readsInOrder(['c.txt']), confirm })
    ).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Abort rebase and discard edits to 1 file?',
        description: 'c.txt',
        confirmLabel: 'Discard and abort'
      })
    )
  })

  it('lists three files and counts the rest', async () => {
    const confirm = vi.fn(async (_request: AbortConfirmRequest) => false)
    await confirmRebaseAbort({
      readDiscards: readsInOrder(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']),
      confirm
    })
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: 'Abort rebase and discard edits to 5 files?',
      description: 'a.ts, b.ts, c.ts and 2 more'
    })
  })

  it('asks again when the set changed while the dialog was open', async () => {
    const confirm = vi.fn(async (_request: AbortConfirmRequest) => true)

    await expect(
      confirmRebaseAbort({ readDiscards: readsInOrder([], ['notes.txt'], ['notes.txt']), confirm })
    ).resolves.toBe(true)
    expect(confirm.mock.calls.map(([request]) => request.title)).toEqual([
      'Abort rebase?',
      'Abort rebase and discard edits to 1 file?'
    ])
  })
})
