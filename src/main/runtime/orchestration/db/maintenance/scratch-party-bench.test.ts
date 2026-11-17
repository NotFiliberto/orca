import { it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { retireSettledRun } from './settled-run-retirement'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

it('final step time at large P', () => {
  for (const P of [1000, 5000, 20000]) {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({ objective: 'x', coordinatorHandle: 'term_c' })
    db.db.exec('BEGIN')
    for (let n = 0; n < P; n++) {
      db.insertMessage({ runId: run.id, from: 'w', to: `term_reader_${n}`, subject: 's' })
    }
    db.db.exec('COMMIT')
    for (const t of ['runs', 'messages']) {
      for (const c of db.db.prepare(`PRAGMA table_info(${t})`).all()) {
        const name = String(c.name)
        if (name.endsWith('_at')) db.db.exec(`UPDATE ${t} SET ${name} = '2000-01-01 00:00:00' WHERE ${name} IS NOT NULL`)
      }
    }
    const steps = retireSettledRun(db, run.id, { isLiveHandle: () => false, isLivePane: () => false, waitedMailboxes: () => [] })
    let worst = 0
    let last = 0
    for (;;) {
      const t0 = performance.now()
      const s = steps.next()
      const dt = performance.now() - t0
      worst = Math.max(worst, dt)
      if (s.done) { last = dt; console.log(`VARIANT=${process.env.VARIANT} P=${P + 3} deleted=${s.value} finalStepMs=${last.toFixed(1)} worstStepMs=${worst.toFixed(1)}`); break }
    }
    db.close()
  }
}, 600_000)
