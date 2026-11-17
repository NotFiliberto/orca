import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { checkCodexHistoryLeftBehind } from './codex-account-history-content-check'
import {
  hasIncompleteHostCodexIndexHeal,
  isCodexAccountHistoryWorkStopping,
  requestHostCodexIndexHeal
} from './codex-account-history-index'
import { shareCodexAccountHistory, unshareCodexAccountHistory } from './codex-account-history-links'
import { feedCodexHistorySource } from './codex-history-source-feed'

type QueuedPass = { shared: boolean; pass: Promise<void> }

// Launches re-feed so new source conversations arrive without a restart; many at once share one.
const FEED_MIN_INTERVAL_MS = 60_000

const INDEX_PENDING_DIR = (): string =>
  join(getOrcaUserDataPath(), 'codex-account-history', 'index-pending')

/**
 * Host account history passes, one at a time in request order (homes merging into one store at
 * once would race on its folders): a request joins only the latest one queued for that home with
 * the same mode. A home settled in a mode this run skips later passes in it.
 */
export class CodexAccountHistoryPasses {
  private readonly latest = new Map<string, QueuedPass>()
  private tail: Promise<void> = Promise.resolve()
  private readonly settledThisRun = new Map<string, boolean>()
  private feedRequest: string | null = null
  private feeding: Promise<void> | null = null
  private lastFeedAt = 0
  private activePasses = 0
  // Homes whose left-behind rollouts still await a content check, checked once no pass runs.
  private readonly owedChecks = new Map<string, { accountHome: string }>()
  private checking = false
  private startedPasses = 0
  private readonly passProgress = {
    isPaused: (): boolean => this.activePasses > 0 || this.feeding !== null,
    started: (): number => this.startedPasses
  }

  run(accountHome: string, shared: boolean): Promise<void> {
    const key = normalizeRuntimePathForComparison(accountHome)
    const previous = this.latest.get(key)
    if (previous?.shared === shared) {
      return previous.pass
    }
    const pass = this.tail.then(async () => {
      if (this.settledThisRun.get(key) === shared) {
        // Moves are done; only index work a stopped or failed heal left behind is retried.
        if (hasIncompleteHostCodexIndexHeal(INDEX_PENDING_DIR())) {
          requestHostCodexIndexHeal(
            INDEX_PENDING_DIR(),
            getSystemCodexHomePath(),
            this.passProgress
          )
        }
        return
      }
      // A running feed stops at its next file once this pass is queued.
      await this.feeding
      this.activePasses += 1
      this.startedPasses += 1
      try {
        await this.runPass(key, accountHome, shared)
      } finally {
        this.activePasses -= 1
      }
      // Index once no pass is moving files.
      requestHostCodexIndexHeal(INDEX_PENDING_DIR(), getSystemCodexHomePath(), this.passProgress)
      this.checkOwed()
    })
    this.tail = pass.catch(() => {})
    this.latest.set(key, { shared, pass })
    void pass.finally(() => {
      if (this.latest.get(key)?.pass === pass) {
        this.latest.delete(key)
      }
      this.startFeed()
    })
    return pass
  }

  /**
   * Links a configured history source's rollouts into the store in the background: launches
   * never wait on it, and it runs only while no pass is queued or running (both would race on the
   * store's names), yielding to one that starts and resuming after it.
   */
  feedSource(sourceHome: string): void {
    this.feedRequest = sourceHome
    this.startFeed()
  }

  private startFeed(): void {
    const sourceHome = this.feedRequest
    if (
      !sourceHome ||
      this.feeding ||
      this.latest.size > 0 ||
      Date.now() - this.lastFeedAt < FEED_MIN_INTERVAL_MS ||
      isCodexAccountHistoryWorkStopping()
    ) {
      return
    }
    this.feedRequest = null
    // Counts as a pass for indexing: a heal must not settle a marker whose link hasn't landed.
    this.startedPasses += 1
    const yieldToPasses = (): boolean => this.latest.size > 0 || isCodexAccountHistoryWorkStopping()
    this.feeding = feedCodexHistorySource({
      sourceHome,
      storeHome: getSystemCodexHomePath(),
      indexPendingDir: INDEX_PENDING_DIR(),
      shouldStop: yieldToPasses
    })
      .then((linked) => {
        if (yieldToPasses()) {
          this.feedRequest ??= sourceHome
        } else {
          this.lastFeedAt = Date.now()
        }
        return linked
      })
      .catch((error: unknown) => {
        console.warn('[codex-account-history] Linking the Codex history source failed:', error)
        return 0
      })
      .then((linked) => {
        this.feeding = null
        if (linked > 0) {
          requestHostCodexIndexHeal(
            INDEX_PENDING_DIR(),
            getSystemCodexHomePath(),
            this.passProgress
          )
        }
        this.startFeed()
      })
  }

  private async runPass(key: string, accountHome: string, shared: boolean): Promise<void> {
    this.settledThisRun.delete(key)
    const storeHome = getSystemCodexHomePath()
    const onWarning = (error: unknown): void => {
      console.warn('[codex-account-history] Account history was not fully shared:', error)
    }
    try {
      if (!shared) {
        if (await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })) {
          this.settledThisRun.set(key, false)
        }
        return
      }
      const indexPendingDir = INDEX_PENDING_DIR()
      const result = await shareCodexAccountHistory({
        accountHome,
        storeHome,
        // A user's own CODEX_SQLITE_HOME already points every home's databases at the store.
        sqliteHome: process.env.CODEX_SQLITE_HOME?.trim() ? null : storeHome,
        indexPendingDir,
        platform: process.platform,
        onWarning
      })
      if (result === 'shared') {
        this.settledThisRun.set(key, true)
      }
      if (result === 'shared' || result === 'incomplete') {
        this.owedChecks.set(key, { accountHome })
      }
    } catch (error) {
      onWarning(error)
    }
  }

  // Hashing a large history must not delay a launch: a starting pass stops it after one file.
  private checkOwed(): void {
    if (this.checking || this.activePasses > 0 || isCodexAccountHistoryWorkStopping()) {
      return
    }
    const next = this.owedChecks.entries().next()
    if (next.done) {
      return
    }
    const [key, request] = next.value
    // A pass that finished meanwhile owes a fresh check; only this run's request is settled.
    const settle = (): void => {
      if (this.owedChecks.get(key) === request) {
        this.owedChecks.delete(key)
      }
    }
    this.checking = true
    void checkCodexHistoryLeftBehind({
      accountHome: request.accountHome,
      storeHome: getSystemCodexHomePath(),
      shouldStop: () => this.activePasses > 0 || isCodexAccountHistoryWorkStopping()
    })
      .then((finished) => {
        if (finished) {
          settle()
        }
      })
      .catch((error: unknown) => {
        settle()
        console.warn('[codex-account-history] Checking left-behind history failed:', error)
      })
      .finally(() => {
        this.checking = false
        this.checkOwed()
      })
  }
}
