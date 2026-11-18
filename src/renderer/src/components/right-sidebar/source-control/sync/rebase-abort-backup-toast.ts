import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { continueRuntimeGitRebase } from '@/runtime/source-control/git/runtime-git-rebase-client'

/** After an Abort that backed up tracked edits: say they are kept and offer them back. */
export function showRebaseAbortBackupToast(
  context: RuntimeGitContext,
  backup: string,
  refreshAfterRestore: () => void
): void {
  toast.success(
    translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseEditsSaved',
      'Rebase aborted. Your edits are saved.'
    ),
    {
      duration: 15000,
      action: {
        label: translate(
          'auto.components.right.sidebar.SourceControl.restoreAbortedEdits',
          'Restore'
        ),
        onClick: () => void restoreAbortedEdits(context, backup, refreshAfterRestore)
      }
    }
  )
}

async function restoreAbortedEdits(
  context: RuntimeGitContext,
  backup: string,
  refreshAfterRestore: () => void
): Promise<void> {
  const failedTitle = translate(
    'auto.components.right.sidebar.SourceControl.restoreAbortedEditsFailed',
    "Couldn't restore your edits"
  )
  try {
    const result = await continueRuntimeGitRebase(context, 'restore', { backup })
    if (result.outcome === 'restored_with_conflicts') {
      toast.warning(
        translate(
          'auto.components.right.sidebar.SourceControl.restoreAbortedEditsConflicts',
          'Edits restored with conflicts. Resolve them in Changes.'
        )
      )
    } else if (result.outcome !== 'restored') {
      toast.error(failedTitle, { description: result.message })
    }
  } catch (error) {
    toast.error(failedTitle, {
      description: error instanceof Error ? error.message : String(error)
    })
  }
  refreshAfterRestore()
}
