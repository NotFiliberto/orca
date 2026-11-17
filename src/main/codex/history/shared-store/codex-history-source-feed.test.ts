import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { feedCodexHistorySource } from './codex-history-source-feed'

const NEW = 'rollout-2026-11-14T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl'
const COMPRESSED_IN_STORE = 'rollout-2026-11-14T11-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl'
const DAY = join('2026', '11', '14')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('feedCodexHistorySource', () => {
  it("links the source's rollouts the store lacks in either form, and queues them for indexing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-history-source-')))
    roots.push(root)
    const source = join(root, 'source')
    const store = join(root, 'store')
    const pending = join(root, 'pending')
    mkdirSync(join(source, 'sessions', DAY), { recursive: true })
    mkdirSync(join(store, 'sessions', DAY), { recursive: true })
    writeFileSync(join(source, 'sessions', DAY, NEW), 'from the source\n')
    writeFileSync(join(source, 'sessions', DAY, COMPRESSED_IN_STORE), 'plain\n')
    writeFileSync(join(store, 'sessions', DAY, `${COMPRESSED_IN_STORE}.zst`), 'compressed')

    const linked = await feedCodexHistorySource({
      sourceHome: source,
      storeHome: store,
      indexPendingDir: pending,
      shouldStop: () => false
    })

    expect(linked).toBe(1)
    expect(lstatSync(join(store, 'sessions', DAY, NEW)).ino).toBe(
      lstatSync(join(source, 'sessions', DAY, NEW)).ino
    )
    expect(readdirSync(join(store, 'sessions', DAY)).sort()).toEqual([
      NEW,
      `${COMPRESSED_IN_STORE}.zst`
    ])
    expect(readdirSync(pending)).toEqual([NEW])
  })

  it('skips a rollout the store has archived under the same name', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-history-source-')))
    roots.push(root)
    const source = join(root, 'source')
    const store = join(root, 'store')
    const pending = join(root, 'pending')
    mkdirSync(join(source, 'sessions', DAY), { recursive: true })
    mkdirSync(join(store, 'archived_sessions'), { recursive: true })
    writeFileSync(join(source, 'sessions', DAY, NEW), 'from the source\n')
    writeFileSync(join(store, 'archived_sessions', `${NEW}.zst`), 'archived')

    const linked = await feedCodexHistorySource({
      sourceHome: source,
      storeHome: store,
      indexPendingDir: pending,
      shouldStop: () => false
    })

    expect(linked).toBe(0)
    expect(readdirSync(store)).toEqual(['archived_sessions'])
  })
})
