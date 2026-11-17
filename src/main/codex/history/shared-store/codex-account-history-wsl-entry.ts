import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  listCodexIndexPendingRollouts,
  shareCodexAccountHistory,
  unshareCodexAccountHistory
} from './codex-account-history-links'
import { checkCodexHistoryLeftBehind } from './codex-account-history-content-check'
import { feedCodexHistorySource } from './codex-history-source-feed'

// Under the host's helper timeout; an unfinished check or feed resumes on a later launch.
const CHECK_BUDGET_MS = 8 * 60_000

// Each share or unshare helper leaves its pid here while it runs, so a feed stops for it.
const RUNNING_PASSES = join(homedir(), '.local', 'share', 'orca', 'codex-history-passes')
const PASS_POLL_MS = 500

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function isPassRunning(): Promise<boolean> {
  const pids = await readdir(RUNNING_PASSES).catch(() => [])
  return pids.some((name) => /^\d+$/.test(name) && isAlive(Number(name)))
}

function printResult(result: string, pendingDir: string, pending: string[] = []): void {
  process.stdout.write(pending.map((name) => `${name}\n`).join(''))
  process.stdout.write(`${JSON.stringify({ result, pendingDir })}\n`)
}

// Runs inside a WSL distro on Orca's pinned Node: `<share|unshare|check> <account home> <store home>`
// or `feed <history source> <store home>`.
// Prints each rollout still owed an index row, then `{"result":…,"pendingDir":…}` last.
async function main(): Promise<void> {
  const [mode, home = '', storeHome = ''] = process.argv.slice(2)
  if (!home.startsWith('/') || !storeHome.startsWith('/')) {
    throw new Error('Codex account history needs absolute Linux homes')
  }
  // Beside the guest's account homes, so it is per store and never inside the user's ~/.codex.
  const pendingDir = join(homedir(), '.local', 'share', 'orca', 'codex-index-pending')
  if (mode === 'check') {
    const deadline = Date.now() + CHECK_BUDGET_MS
    const finished = await checkCodexHistoryLeftBehind({
      accountHome: home,
      storeHome,
      shouldStop: () => Date.now() > deadline
    })
    printResult(finished ? 'checked' : 'stopped', pendingDir)
    return
  }
  if (mode === 'feed') {
    await feed(home, storeHome, pendingDir)
    return
  }
  const marker = join(RUNNING_PASSES, String(process.pid))
  await mkdir(RUNNING_PASSES, { recursive: true })
  await writeFile(marker, '')
  try {
    printResult(
      await runPass(mode, home, storeHome, pendingDir),
      pendingDir,
      await listCodexIndexPendingRollouts(pendingDir)
    )
  } finally {
    await unlink(marker).catch(() => {})
  }
}

async function feed(sourceHome: string, storeHome: string, pendingDir: string): Promise<void> {
  const deadline = Date.now() + CHECK_BUDGET_MS
  let passRunning = await isPassRunning()
  const poll = setInterval(() => {
    void isPassRunning().then((running) => {
      passRunning = running
    })
  }, PASS_POLL_MS)
  const shouldStop = (): boolean => passRunning || Date.now() > deadline
  try {
    await feedCodexHistorySource({ sourceHome, storeHome, indexPendingDir: pendingDir, shouldStop })
    printResult(
      shouldStop() ? 'stopped' : 'fed',
      pendingDir,
      await listCodexIndexPendingRollouts(pendingDir)
    )
  } finally {
    clearInterval(poll)
  }
}

async function runPass(
  mode: string | undefined,
  accountHome: string,
  storeHome: string,
  pendingDir: string
): Promise<string> {
  const onWarning = (error: unknown): void => {
    console.error(error instanceof Error ? error.message : String(error))
  }
  if (mode === 'unshare') {
    const complete = await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })
    return complete ? 'unshared' : 'incomplete'
  }
  return shareCodexAccountHistory({
    accountHome,
    storeHome,
    sqliteHome: storeHome,
    indexPendingDir: pendingDir,
    platform: 'linux',
    onWarning
  })
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
