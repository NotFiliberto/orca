import { runWslProcess } from '../../../wsl/execution/wsl-runner'
import { runCodexAppServerSession } from '../../app-server/codex-app-server-session'
import { buildWslHealInvocation } from '../index/codex-session-index-heal'
import {
  healCodexIndexPendingRollouts,
  isCodexAccountHistoryWorkStopping
} from './codex-account-history-index'
import {
  checkInGuest,
  defaultDependencies,
  feedInGuest,
  linkInGuest,
  type HelperOutput,
  type WslAccountHistoryDependencies,
  type WslCodexAccountHistoryTarget,
  type WslCodexHistorySourceTarget
} from './wsl-codex-history-guest-helper'

export type { WslCodexAccountHistoryTarget, WslCodexHistorySourceTarget }

const CLEAR_TIMEOUT_MS = 30_000

/** Codex's own `thread/read` inside the distro indexes moved rollouts against the guest store. */
async function healInGuest(
  target: WslCodexAccountHistoryTarget,
  output: HelperOutput,
  dependencies: WslAccountHistoryDependencies,
  passes: { isPaused: () => boolean; startedSince: () => boolean }
): Promise<boolean> {
  const distroKey = target.distro.toLowerCase()
  let distroStopped = false
  const unsubscribe = dependencies.subscribeStops((stopped) => {
    distroStopped ||= stopped.some((distro) => distro.toLowerCase() === distroKey)
  })
  const stillRunning = async (): Promise<void> => {
    await dependencies.requireRunning(target.distro).catch((error: unknown) => {
      distroStopped = true
      throw error
    })
  }
  try {
    return await healCodexIndexPendingRollouts({
      storeHome: target.storeHome,
      rolloutNames: output.pending,
      clear: async (names) => {
        await stillRunning()
        await clearPendingMarkers(target.distro, output.pendingDir, names)
      },
      passStartedSince: passes.startedSince,
      options: {
        // Windows can't take SQLite's locks over \\wsl.localhost; the guest's own codex indexes.
        buildInvocation: (_home, timeoutMs) =>
          buildWslHealInvocation(target.distro, target.storeHome, timeoutMs),
        runSession: async (invocation, body) => {
          await stillRunning()
          return runCodexAppServerSession(invocation, body)
        },
        shouldStop: () => distroStopped || passes.isPaused()
      }
    })
  } finally {
    unsubscribe()
  }
}

async function clearPendingMarkers(
  distro: string,
  pendingDir: string,
  names: readonly string[]
): Promise<void> {
  if (names.length === 0) {
    return
  }
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script: 'cd -- "$1" || exit 1\nshift\nrm -f -- "$@"',
    args: [pendingDir, ...names],
    timeoutMs: CLEAR_TIMEOUT_MS
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Could not clear WSL Codex index markers (code ${result.code})`)
  }
}

type QueuedPass = { shared: boolean; pass: Promise<void> }

/**
 * WSL account history passes, one at a time per distro in request order (homes merging into its
 * store at once would race on its folders; a request joins only the latest queued one for that
 * home with the same mode); indexing runs detached, one at a time per distro.
 */
export class WslCodexAccountHistoryLaunches {
  private readonly latest = new Map<string, QueuedPass>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly heals = new Map<string, Promise<void>>()
  // The newest guest marker list per distro, indexed once no pass runs there.
  private readonly owedHeals = new Map<
    string,
    { target: WslCodexAccountHistoryTarget; output: HelperOutput }
  >()
  // A heal that failed waits for the next launch in that distro, not an immediate retry.
  private readonly failedHeals = new Map<
    string,
    { target: WslCodexAccountHistoryTarget; output: HelperOutput }
  >()
  private readonly activePasses = new Map<string, number>()
  private readonly startedPasses = new Map<string, number>()
  // A home settled in a mode this run skips later guest passes in it.
  private readonly settledThisRun = new Map<string, boolean>()
  // Shared homes whose left-behind rollouts await a content check, one guest check per distro.
  private readonly owedChecks = new Map<string, WslCodexAccountHistoryTarget>()
  private readonly checks = new Set<string>()
  // The newest source feed requested per distro, run detached once no pass is queued there.
  private readonly feedRequests = new Map<string, WslCodexHistorySourceTarget>()
  private readonly feeds = new Set<string>()

  constructor(private readonly dependencies: WslAccountHistoryDependencies = defaultDependencies) {}

  run(target: WslCodexAccountHistoryTarget): Promise<void> {
    if (isCodexAccountHistoryWorkStopping()) {
      return Promise.resolve()
    }
    const distroKey = target.distro.toLowerCase()
    const key = `${distroKey}\0${target.accountHome}`
    const previous = this.latest.get(key)
    if (previous?.shared === target.shared) {
      return previous.pass
    }
    const pass = (this.tails.get(distroKey) ?? Promise.resolve())
      .then(async () => {
        // Quit doesn't await history work, so a pass queued before it must not start guest work.
        if (isCodexAccountHistoryWorkStopping()) {
          return
        }
        if (this.settledThisRun.get(key) === target.shared) {
          this.retryFailedHeal(distroKey)
          return
        }
        this.settledThisRun.delete(key)
        this.activePasses.set(distroKey, (this.activePasses.get(distroKey) ?? 0) + 1)
        this.startedPasses.set(distroKey, (this.startedPasses.get(distroKey) ?? 0) + 1)
        try {
          const output = await linkInGuest(target, this.dependencies)
          if (output && output.result === (target.shared ? 'shared' : 'unshared')) {
            this.settledThisRun.set(key, target.shared)
          }
          if (output && output.pending.length > 0) {
            this.oweHeal(distroKey, { target, output })
          }
          if (target.shared && (output?.result === 'shared' || output?.result === 'incomplete')) {
            this.owedChecks.set(key, { ...target })
          }
        } finally {
          this.activePasses.set(distroKey, (this.activePasses.get(distroKey) ?? 1) - 1)
          this.startOwedHeal(distroKey)
          this.startOwedCheck(distroKey)
        }
      })
      .finally(() => queueMicrotask(() => this.startFeed(distroKey)))
      .catch((error: unknown) => {
        console.warn('[codex-account-history] WSL account history pass failed:', error)
      })
    this.tails.set(distroKey, pass)
    this.latest.set(key, { shared: target.shared, pass })
    void pass.finally(() => {
      if (this.latest.get(key)?.pass === pass) {
        this.latest.delete(key)
      }
    })
    return pass
  }

  // Passes in one distro share its marker folder and may report in any order: keep every name.
  private oweHeal(
    distroKey: string,
    owed: { target: WslCodexAccountHistoryTarget; output: HelperOutput }
  ): void {
    const earlier = this.owedHeals.get(distroKey)?.output.pending ?? []
    const pending = [...new Set([...earlier, ...owed.output.pending])]
    this.owedHeals.set(distroKey, { ...owed, output: { ...owed.output, pending } })
  }

  private retryFailedHeal(distroKey: string): void {
    const failed = this.failedHeals.get(distroKey)
    if (failed) {
      this.failedHeals.delete(distroKey)
      this.oweHeal(distroKey, failed)
      this.startOwedHeal(distroKey)
    }
  }

  // A pass may have recorded markers for files not moved yet, which a read would settle as missing.
  private startOwedHeal(distroKey: string): void {
    const isPaused = (): boolean =>
      (this.activePasses.get(distroKey) ?? 0) > 0 || this.feeds.has(distroKey)
    const owed = this.owedHeals.get(distroKey)
    if (!owed || isPaused() || this.heals.has(distroKey) || isCodexAccountHistoryWorkStopping()) {
      return
    }
    this.owedHeals.delete(distroKey)
    const started = this.startedPasses.get(distroKey) ?? 0
    const heal = healInGuest(owed.target, owed.output, this.dependencies, {
      isPaused,
      startedSince: () => (this.startedPasses.get(distroKey) ?? 0) !== started
    })
      .then((finished) => {
        if (!finished) {
          this.failedHeals.set(distroKey, owed)
        }
      })
      .catch((error: unknown) => {
        console.warn('[codex-account-history] Indexing WSL shared history failed:', error)
        this.failedHeals.set(distroKey, owed)
      })
      .finally(() => {
        this.heals.delete(distroKey)
        this.startOwedHeal(distroKey)
      })
    this.heals.set(distroKey, heal)
  }

  // Detached: hashing a large history must not hold up a launch's pass.
  private startOwedCheck(distroKey: string): void {
    if (
      this.checks.has(distroKey) ||
      (this.activePasses.get(distroKey) ?? 0) > 0 ||
      isCodexAccountHistoryWorkStopping()
    ) {
      return
    }
    const owed = [...this.owedChecks].find(
      ([, target]) => target.distro.toLowerCase() === distroKey
    )
    if (!owed) {
      return
    }
    const [key, target] = owed
    this.checks.add(distroKey)
    // An unfinished check resumes on a later launch, never in a loop now.
    // A pass that finished meanwhile owes a fresh check; only this run's request is settled.
    const settle = (): void => {
      if (this.owedChecks.get(key) === target) {
        this.owedChecks.delete(key)
      }
    }
    void checkInGuest(target, this.dependencies)
      .then(settle)
      .catch((error: unknown) => {
        settle()
        console.warn('[codex-account-history] Checking WSL left-behind history failed:', error)
      })
      .finally(() => {
        this.checks.delete(distroKey)
        this.startOwedCheck(distroKey)
      })
  }

  /** Feeds the distro's history source into its store in the background; launches don't wait. */
  feedSource(target: WslCodexHistorySourceTarget): void {
    const distroKey = target.distro.toLowerCase()
    this.feedRequests.set(distroKey, target)
    this.startFeed(distroKey)
  }

  private hasQueuedPass(distroKey: string): boolean {
    return [...this.latest.keys()].some((key) => key.startsWith(`${distroKey}\0`))
  }

  // One feed per distro, never while a pass there is queued: both write the store's names.
  private startFeed(distroKey: string): void {
    const target = this.feedRequests.get(distroKey)
    if (
      !target ||
      this.feeds.has(distroKey) ||
      this.hasQueuedPass(distroKey) ||
      isCodexAccountHistoryWorkStopping()
    ) {
      return
    }
    this.feedRequests.delete(distroKey)
    this.feeds.add(distroKey)
    // Counts as a pass for indexing: a heal must not settle a marker whose link hasn't landed.
    this.startedPasses.set(distroKey, (this.startedPasses.get(distroKey) ?? 0) + 1)
    void feedInGuest(target, this.dependencies)
      .then((output) => {
        if (output?.result === 'stopped') {
          this.feedRequests.set(distroKey, this.feedRequests.get(distroKey) ?? target)
        }
        if (output && output.pending.length > 0) {
          this.oweHeal(distroKey, { target: { ...target, accountHome: '', shared: true }, output })
        }
      })
      .catch((error: unknown) => {
        console.warn('[codex-account-history] Linking the WSL Codex history source failed:', error)
      })
      .finally(() => {
        // A stopped feed resumes after the next pass or launch there, never in a loop now.
        this.feeds.delete(distroKey)
        this.startOwedHeal(distroKey)
      })
  }
}
