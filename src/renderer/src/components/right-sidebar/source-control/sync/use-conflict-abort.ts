import { useCallback } from 'react'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import {
  abortRuntimeGitMerge,
  abortRuntimeGitRebase
} from '@/runtime/source-control/git/runtime-git-sync-client'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { AbortConflictOperation } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import { confirmRebaseAbort } from './rebase-abort-confirmation'
import { continueRuntimeGitRebase } from '@/runtime/source-control/git/runtime-git-rebase-client'
import type { SourceControlStatusRefresh } from './use-status-refresh'

// Unknown (older host, unreachable) keeps the plain confirm rather than blocking Abort.
async function readRebaseAbortDiscards(
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget'],
  worktreeId: string,
  worktreePath: string,
  scope: ReturnType<typeof useSourceControlScope>
): Promise<string[] | null> {
  try {
    const result = await continueRuntimeGitRebase(
      {
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, worktreeId)
      },
      'inspect'
    )
    return result.abortWouldDiscard ?? null
  } catch {
    return null
  }
}

export function useSourceControlConflictAbort({
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
  const confirmAction = useConfirmationDialog()

  const handleAbortOperation = useCallback(
    async (requestedOperation: AbortConflictOperation): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        conflictOperation !== requestedOperation ||
        operationStore.getState().isAbortingOperation
      ) {
        return
      }

      const isRebase = requestedOperation === 'rebase'
      const confirmed = isRebase
        ? await confirmRebaseAbort({
            readDiscards: () =>
              readRebaseAbortDiscards(activeRepoTarget, activeWorktreeId, worktreePath, scope),
            confirm: confirmAction
          })
        : await confirmAction({
            title: translate(
              'auto.components.right.sidebar.SourceControl.abortMergeConfirmTitle',
              'Abort merge?'
            ),
            description: translate(
              'auto.components.right.sidebar.SourceControl.abortMergeConfirmDescription',
              'This cancels the merge in progress and can discard conflict resolutions made during this merge.'
            ),
            confirmLabel: translate(
              'auto.components.right.sidebar.SourceControl.540ca8f78c',
              'Abort merge'
            ),
            confirmVariant: 'destructive'
          })
      if (!confirmed || operationStore.getState().isAbortingOperation) {
        return
      }

      const connectionId = sourceControlConnectionId(scope, activeWorktreeId)
      operationStore.setState({ isAbortingOperation: true, remoteActionError: null })
      try {
        const context = {
          // Abort on the repo owner, which may differ from the focused host.
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        }
        const abortGitOperation = isRebase ? abortRuntimeGitRebase : abortRuntimeGitMerge
        await abortGitOperation(context)
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : isRebase
              ? translate(
                  'auto.components.right.sidebar.SourceControl.abortRebaseFailedFallback',
                  'Failed to abort rebase'
                )
              : translate(
                  'auto.components.right.sidebar.SourceControl.abortMergeFailedFallback',
                  'Failed to abort merge'
                )
        toast.error(
          isRebase
            ? translate(
                'auto.components.right.sidebar.SourceControl.abortRebaseFailed',
                'Abort rebase failed'
              )
            : translate(
                'auto.components.right.sidebar.SourceControl.abortMergeFailed',
                'Abort merge failed'
              ),
          { description: message }
        )
        operationStore.setState({
          remoteActionError: {
            kind: isRebase ? 'abort_rebase' : 'abort_merge',
            message,
            rawError: message
          }
        })
      } finally {
        operationStore.setState({ isAbortingOperation: false })
        refreshSourceControlAfterRemoteAction({
          worktreeId: activeWorktreeId,
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
      }
    },
    [
      scope,
      activeRepoTarget,
      activeWorktreeId,
      confirmAction,
      conflictOperation,
      operationStore,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      worktreePath
    ]
  )

  const handleAbortMerge = useCallback(async (): Promise<void> => {
    await handleAbortOperation('merge')
  }, [handleAbortOperation])

  const handleAbortRebase = useCallback(async (): Promise<void> => {
    await handleAbortOperation('rebase')
  }, [handleAbortOperation])

  const handleAbortOperationForConflict = useCallback(
    (operation: GitConflictOperation): void => {
      if (operation === 'merge') {
        void handleAbortMerge()
        return
      }
      if (operation === 'rebase') {
        void handleAbortRebase()
      }
    },
    [handleAbortMerge, handleAbortRebase]
  )

  return {
    confirmAction,
    handleAbortMerge,
    handleAbortOperation,
    handleAbortOperationForConflict,
    handleAbortRebase
  }
}

export type SourceControlConflictAbort = ReturnType<typeof useSourceControlConflictAbort>
