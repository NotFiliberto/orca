import { link, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'
import { linkCodexRolloutUnlessHeld } from '../rollouts/codex-rollout-deletion-guard'
import { resolveWslCodexSessionSourceHome } from '../rollouts/codex-session-source-home'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'

const HISTORY_FOLDERS = ['sessions', 'archived_sessions']
const warnedRelativeSources = new Set<string>()

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function* rolloutFiles(folder: string): AsyncGenerator<string> {
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      yield* rolloutFiles(path)
    } else if (entry.isFile() && parseCodexRolloutThreadId(entry.name)) {
      yield path
    }
  }
}

// Archiving moves a rollout to another folder under the same name, so a name is one rollout.
function rolloutName(path: string): string {
  const name = basename(path)
  return name.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? name.slice(0, -COMPRESSED_ROLLOUT_SUFFIX.length)
    : name
}

async function historyFolders(home: string): Promise<string[]> {
  return Promise.all(
    HISTORY_FOLDERS.map((folder) => realpath(join(home, folder)).catch(() => join(home, folder)))
  )
}

async function storeRolloutNames(
  store: string,
  shouldStop: () => boolean
): Promise<Set<string> | null> {
  const names = new Set<string>()
  for (const folder of HISTORY_FOLDERS) {
    for await (const path of rolloutFiles(join(store, folder))) {
      if (shouldStop()) {
        return null
      }
      names.add(rolloutName(path))
    }
  }
  return names
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * Makes a configured Codex history source's conversations resumable from every account: each
 * rollout the store has under no name in either folder gets a store name for the same file (a
 * hard link, never a copy) and an index marker, so Codex's own read indexes it. Nothing in the
 * source changes. Returns how many rollouts were linked.
 */
export async function feedCodexHistorySource(args: {
  sourceHome: string
  storeHome: string
  indexPendingDir: string
  shouldStop: () => boolean
}): Promise<number> {
  if (!isAbsolute(args.sourceHome)) {
    if (!warnedRelativeSources.has(args.sourceHome)) {
      warnedRelativeSources.add(args.sourceHome)
      console.warn('[codex-account-history] Codex history source is not absolute:', args.sourceHome)
    }
    return 0
  }
  const [source, store] = await Promise.all(
    [args.sourceHome, args.storeHome].map((path) => realpath(path).catch(() => null))
  )
  if (!source || !store) {
    return 0
  }
  const [sourceFolders, storeFolders] = await Promise.all([
    historyFolders(source),
    historyFolders(store)
  ])
  if (
    sourceFolders.some((from) =>
      storeFolders.some((to) => isInside(from, to) || isInside(to, from))
    )
  ) {
    return 0
  }
  // Hard links can't cross volumes, and a copy would diverge from the source.
  const [sourceDevice, storeDevice] = await Promise.all(
    [source, store].map((path) =>
      stat(path)
        .then((stats) => stats.dev)
        .catch(() => null)
    )
  )
  if (sourceDevice === null || sourceDevice !== storeDevice) {
    return 0
  }
  const inStore = await storeRolloutNames(store, args.shouldStop)
  if (!inStore) {
    return 0
  }
  let linked = 0
  for (const [index, folder] of HISTORY_FOLDERS.entries()) {
    for await (const from of rolloutFiles(sourceFolders[index])) {
      if (args.shouldStop()) {
        return linked
      }
      const name = rolloutName(from)
      if (inStore.has(name)) {
        continue
      }
      const to = join(store, folder, relative(sourceFolders[index], from))
      const marker = join(args.indexPendingDir, basename(to))
      // A marker another pass wrote for this name is that pass's to clear, not this one's.
      let ownsMarker = false
      try {
        await mkdir(dirname(to), { recursive: true })
        // Recorded first, so a stop between the two can't leave a linked rollout unindexed.
        await mkdir(args.indexPendingDir, { recursive: true })
        ownsMarker = await writeFile(marker, '', { flag: 'wx' }).then(
          () => true,
          (error: unknown) => (errorCode(error) === 'EEXIST' ? false : Promise.reject(error))
        )
        if ((await linkCodexRolloutUnlessHeld(from, () => link(from, to))) === 'held') {
          throw new Error('held for deletion')
        }
        inStore.add(name)
        linked += 1
      } catch (error) {
        if (ownsMarker) {
          await rm(marker, { force: true }).catch(() => {})
        }
        if (errorCode(error) === 'EXDEV') {
          return linked
        }
      }
    }
  }
  return linked
}

/** A distro's configured history source as its Linux path; one in another distro is not its own. */
export function wslHistorySourceIn(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>,
  distro: string
): string | null {
  const source = resolveWslCodexSessionSourceHome(settings, distro)
  const unc = source ? parseWslUncPath(source) : null
  if (unc) {
    return unc.distro.toLowerCase() === distro.toLowerCase() ? unc.linuxPath : null
  }
  return source?.startsWith('/') ? source : null
}
