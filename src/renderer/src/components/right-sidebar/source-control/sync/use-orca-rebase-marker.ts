import { useEffect } from 'react'
import type { GitUpstreamStatus } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { OrcaRebaseMarker } from '../panel/worktree-operation-store'

function matchesMarker(
  marker: OrcaRebaseMarker,
  branchName: string,
  remoteStatus: GitUpstreamStatus | undefined
): boolean {
  return (
    remoteStatus !== undefined &&
    marker.branch === branchName &&
    marker.upstream === (remoteStatus.upstreamName ?? null) &&
    remoteStatus.ahead > 0 &&
    remoteStatus.behind > 0
  )
}

/** After Orca's own rebase, hide Pull/Sync while the branch still diverges from the same upstream. */
export function useOrcaRebaseMarker({
  branchName,
  operationStore,
  orcaRebase,
  remoteStatus
}: {
  branchName: string
  operationStore: SourceControlWorktreeOperationState['operationStore']
  orcaRebase: OrcaRebaseMarker | null
  remoteStatus: GitUpstreamStatus | undefined
}): boolean {
  const matches = orcaRebase !== null && matchesMarker(orcaRebase, branchName, remoteStatus)
  // Readings right after the rebase are still the pre-rebase ones, so only a marker that has
  // seen the diverged result retires on a later mismatch (switch, push elsewhere, catch-up).
  const nextState: OrcaRebaseMarker['state'] | 'retired' | null =
    orcaRebase?.state === 'done' && matches
      ? 'active'
      : orcaRebase?.state === 'active' && !matches && remoteStatus !== undefined
        ? 'retired'
        : null
  useEffect(() => {
    if (nextState === null) {
      return
    }
    const current = operationStore.getState().orcaRebase
    operationStore.setState({
      orcaRebase: nextState === 'retired' || !current ? null : { ...current, state: nextState }
    })
  }, [nextState, operationStore])
  return (orcaRebase?.state === 'done' || orcaRebase?.state === 'active') && matches
}
