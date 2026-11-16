import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { continueRuntimeGitRebase } from '@/runtime/source-control/git/runtime-git-rebase-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type {
  ContinueRebaseAction,
  ContinueRebaseExpectedStop,
  ContinueRebaseResult,
  GitConflictOperation
} from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'
import { requireGitOwnerTarget } from './worktree-git-owner-target'

function failureTitle(action: ContinueRebaseAction): string {
  return action === 'skip'
    ? translate(
        'auto.components.right.sidebar.SourceControl.skipRebaseCommitFailed',
        'Skip commit failed'
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.continueRebaseFailed',
        'Continue rebase failed'
      )
}

// Only a completed outcome reads as success; every other stop keeps the paused strip and says why.
function announceRebaseStep(action: ContinueRebaseAction, result: ContinueRebaseResult): void {
  switch (result.outcome) {
    case 'completed':
      return
    case 'completed_autostash_conflict':
      toast.warning(
        translate(
          'auto.components.right.sidebar.SourceControl.rebaseAutostashConflict',
          "Rebased. Your uncommitted changes didn't reapply cleanly; they're saved in the stash."
        )
      )
      return
    case 'conflicted':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.continueRebasePausedAgain',
          'Rebase paused at the next conflict'
        )
      )
      return
    case 'empty':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.rebaseEmptyCommit',
          'Nothing left to commit here. Skip this commit or abort the rebase.'
        )
      )
      return
    case 'stopped':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.rebaseStoppedByGit',
          'Git paused the rebase'
        ),
        { description: result.message }
      )
      return
    case 'not_rebasing':
      toast.info(
        translate(
          'auto.components.right.sidebar.SourceControl.noRebaseInProgress',
          'No rebase is in progress'
        )
      )
      return
    case 'skip_refused_dirty':
      toast.error(failureTitle(action), {
        description: translate(
          'auto.components.right.sidebar.SourceControl.skipNeedsCleanTree',
          'Commit, stash or discard your edits before skipping.'
        )
      })
      return
    case 'skip_refused_stale':
      toast.error(failureTitle(action), {
        description: translate(
          'auto.components.right.sidebar.SourceControl.skipStopMovedOn',
          'The rebase already moved on. Check the panel and try again.'
        )
      })
      return
    case 'failed':
      toast.error(failureTitle(action), { description: result.message })
  }
}

// Finishing the rebase Orca started (same branch) arms the Pull-hiding marker.
function promoteOrcaRebaseMarker(
  operationStore: SourceControlWorktreeOperationState['operationStore'],
  result: ContinueRebaseResult
): void {
  const marker = operationStore.getState().orcaRebase
  if (
    (result.outcome === 'completed' || result.outcome === 'completed_autostash_conflict') &&
    marker?.state === 'paused' &&
    result.branch === marker.branch
  ) {
    operationStore.setState({ orcaRebase: { ...marker, state: 'done' } })
  }
}

// Module-level so the hook stays React Compiler friendly (no try/finally inside it).
async function runRebaseStepRequest({
  action,
  context,
  expected,
  operationStore,
  refresh
}: {
  action: ContinueRebaseAction
  context: RuntimeGitContext
  expected: ContinueRebaseExpectedStop | undefined
  operationStore: SourceControlWorktreeOperationState['operationStore']
  refresh: () => void
}): Promise<void> {
  try {
    const result = await continueRuntimeGitRebase(context, action, expected)
    if (result.outcome === 'empty') {
      operationStore.setState({
        rebaseEmptyStop: { head: result.head ?? null, step: result.step ?? null }
      })
    }
    promoteOrcaRebaseMarker(operationStore, result)
    announceRebaseStep(action, result)
  } catch (error) {
    // A transport timeout leaves the host's result unknown; the refresh below shows the truth.
    toast.error(failureTitle(action), {
      description:
        error instanceof Error && error.message
          ? error.message
          : translate(
              'auto.components.right.sidebar.SourceControl.continueRebaseUnconfirmed',
              "Couldn't confirm the result. Source Control refreshed to show the current state."
            )
    })
  } finally {
    operationStore.setState({ isAbortingOperation: false, isContinuingRebase: false })
    refresh()
  }
}

export function useSourceControlRebaseContinue({
  activeRepoTarget,
  activeWorktreeId,
  conflictOperation,
  operationStore,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  operationStore: SourceControlWorktreeOperationState['operationStore']
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const runRebaseStep = useCallback(
    async (action: ContinueRebaseAction): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        conflictOperation !== 'rebase' ||
        operationStore.getState().isAbortingOperation
      ) {
        return
      }
      // Skip may only drop the exact empty stop the user was shown.
      const expected =
        action === 'skip' ? (operationStore.getState().rebaseEmptyStop ?? undefined) : undefined
      // isAbortingOperation is the shared conflict-operation lock that Abort and the busy gates read.
      operationStore.setState({
        isAbortingOperation: true,
        isContinuingRebase: true,
        rebaseEmptyStop: null,
        remoteActionError: null
      })
      await runRebaseStepRequest({
        action,
        context: {
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: sourceControlConnectionId(scope, activeWorktreeId)
        },
        expected,
        operationStore,
        refresh: () =>
          refreshSourceControlAfterRemoteAction({
            worktreeId: activeWorktreeId,
            refreshGitStatus: refreshActiveGitStatusAfterMutation,
            refreshBranchCompare: refreshBranchCompareRef.current,
            refreshGitHistory: refreshGitHistoryRef.current
          })
      })
    },
    [
      scope,
      activeRepoTarget,
      activeWorktreeId,
      conflictOperation,
      operationStore,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      worktreePath
    ]
  )
  const handleContinueRebase = useCallback(() => runRebaseStep('continue'), [runRebaseStep])
  const handleSkipRebaseCommit = useCallback(() => runRebaseStep('skip'), [runRebaseStep])
  return { handleContinueRebase, handleSkipRebaseCommit }
}
export type SourceControlRebaseContinue = ReturnType<typeof useSourceControlRebaseContinue>
