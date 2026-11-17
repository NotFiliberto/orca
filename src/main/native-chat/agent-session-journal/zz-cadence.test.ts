import { mkdtempSync, rmSync, statSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { message, messageFixture } from './journal-sql-message.test-fixture'
const switches = vi.hoisted(() => ({ writes: true }))
vi.mock('./journal-text-tail-writes', () => ({ get JOURNAL_TEXT_TAIL_WRITES() { return switches.writes } }))
async function run(tails: boolean, perSave: number, chars: number, answers: number) {
  switches.writes = tails
  const dir = mkdtempSync(join(tmpdir(), 'cad-'))
  const path = join(dir, 'j.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0')
  const { commit } = messageFixture(db)
  const before = statSync(`${path}-wal`).size
  const saves = Math.ceil(chars / perSave)
  for (let s = 1; s <= saves; s++) {
    const text = 'w'.repeat(s * perSave)
    for (let a = 0; a < answers; a++) await commit(message(text, `ans-${a}`))
  }
  const wal = statSync(`${path}-wal`).size - before
  db.close(); rmSync(dir, { recursive: true, force: true })
  return { tails, perSave, chars, answers, saves, walMB: +(wal / 2 ** 20).toFixed(2), kbPerSave: +(wal / saves / answers / 1024).toFixed(1) }
}
it('cadence', { timeout: 600_000 }, async () => {
  for (const [perSave, chars, answers] of [[150, 50_000, 2], [150, 100_000, 1], [683, 100_000, 1]]) {
    for (const tails of [false, true]) console.log('CAD ' + JSON.stringify(await run(tails, perSave, chars, answers)))
  }
})
