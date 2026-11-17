import { WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME } from '../../../../shared/remote-runtime/orcad-distribution/remote-bundle-artifacts'
import { runWslGuestNodeHelper } from '../../../wsl/execution/wsl-guest-node-helper'
import { assertWslUncPathRunning } from '../../../wsl/filesystem/wsl-unc-access-gate'
import type { onRunningWslDistrosStopped } from '../../../wsl/discovery/wsl-running-distro-cache'
import { onWslDistroGateNote } from '../../../wsl/discovery/wsl-background-distro-gate'

export type WslCodexAccountHistoryTarget = {
  distro: string
  /** Linux paths inside the distro. */
  accountHome: string
  storeHome: string
  shared: boolean
}

export type WslCodexHistorySourceTarget = { distro: string; sourceHome: string; storeHome: string }

export type WslAccountHistoryDependencies = {
  runHelper: typeof runWslGuestNodeHelper
  /** Throws unless the distro runs; each step outlives the launch that started it (E9). */
  requireRunning: (distro: string) => Promise<void>
  subscribeStops: typeof onRunningWslDistrosStopped
}

export const defaultDependencies: WslAccountHistoryDependencies = {
  runHelper: runWslGuestNodeHelper,
  requireRunning: (distro) => assertWslUncPathRunning('', distro),
  // Gate notes carry running-list stops and explicit ones (a relay or watcher exit) no list saw yet.
  subscribeStops: (listener) =>
    onWslDistroGateNote((note) => {
      if (note.kind === 'stopped') {
        listener([note.distro], [])
      }
    })
}

// The helper may move a whole history on first run; pending names are ~75 bytes each.
const HELPER_TIMEOUT_MS = 10 * 60_000
const HELPER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export type HelperOutput = { result: string; pendingDir: string; pending: string[] }

/** Links (or unlinks) the home inside its distro; the guest helper also owns its sqlite_home. */
export async function linkInGuest(
  target: WslCodexAccountHistoryTarget,
  dependencies: WslAccountHistoryDependencies
): Promise<HelperOutput | null> {
  // Every wsl.exe step re-checks: the user may stop the distro mid-pass, and a step would boot it.
  const stdout = await dependencies.runHelper({
    distro: target.distro,
    helperFilename: WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME,
    helperLabel: 'Codex account history',
    helperArgs: [target.shared ? 'share' : 'unshare', target.accountHome, target.storeHome],
    timeoutMs: HELPER_TIMEOUT_MS,
    maxOutputBytes: HELPER_MAX_OUTPUT_BYTES,
    requireRunning: () => dependencies.requireRunning(target.distro)
  })
  return parseHelperOutput(stdout)
}

/** Compares the home's left-behind rollouts with the guest store within the helper's budget. */
export async function checkInGuest(
  target: WslCodexAccountHistoryTarget,
  dependencies: WslAccountHistoryDependencies
): Promise<void> {
  const stdout = await dependencies.runHelper({
    distro: target.distro,
    helperFilename: WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME,
    helperLabel: 'Codex account history',
    helperArgs: ['check', target.accountHome, target.storeHome],
    timeoutMs: HELPER_TIMEOUT_MS,
    requireRunning: () => dependencies.requireRunning(target.distro)
  })
  if (!parseHelperOutput(stdout)) {
    throw new Error('The WSL Codex history check printed no summary')
  }
}

/** Links the distro's configured history source into its store; stops for a guest pass. */
export async function feedInGuest(
  target: WslCodexHistorySourceTarget,
  dependencies: WslAccountHistoryDependencies
): Promise<HelperOutput | null> {
  const stdout = await dependencies.runHelper({
    distro: target.distro,
    helperFilename: WSL_CODEX_ACCOUNT_HISTORY_HELPER_FILENAME,
    helperLabel: 'Codex account history',
    helperArgs: ['feed', target.sourceHome, target.storeHome],
    timeoutMs: HELPER_TIMEOUT_MS,
    maxOutputBytes: HELPER_MAX_OUTPUT_BYTES,
    requireRunning: () => dependencies.requireRunning(target.distro)
  })
  return parseHelperOutput(stdout)
}

/** Marker lines precede the summary; a missing summary means the list may be clipped. */
function parseHelperOutput(stdout: string): HelperOutput | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let summary: unknown
  try {
    summary = JSON.parse(lines.at(-1) ?? '')
  } catch {
    return null
  }
  if (
    !summary ||
    typeof summary !== 'object' ||
    !('pendingDir' in summary) ||
    typeof summary.pendingDir !== 'string'
  ) {
    return null
  }
  // Login scripts may print before the helper; only rollout names are markers.
  return {
    result: 'result' in summary && typeof summary.result === 'string' ? summary.result : '',
    pendingDir: summary.pendingDir,
    pending: lines.slice(0, -1).filter((line) => line.startsWith('rollout-'))
  }
}
