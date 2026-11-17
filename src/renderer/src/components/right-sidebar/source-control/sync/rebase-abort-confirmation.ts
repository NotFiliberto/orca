import { translate } from '@/i18n/i18n'

export type AbortConfirmRequest = {
  title: string
  description: string
  confirmLabel: string
  confirmVariant: 'destructive'
}

const LISTED_FILE_LIMIT = 3

function abortRebaseDialog(files: string[] | null): AbortConfirmRequest {
  if (!files || files.length === 0) {
    return {
      title: translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseConfirmTitle',
        'Abort rebase?'
      ),
      description: translate(
        'auto.components.right.sidebar.SourceControl.abortRebaseConfirmDescription',
        'This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
      ),
      confirmLabel: translate(
        'auto.components.right.sidebar.SourceControl.425f138269',
        'Abort rebase'
      ),
      confirmVariant: 'destructive'
    }
  }
  const listed = files.slice(0, LISTED_FILE_LIMIT).join(', ')
  const hidden = files.length - LISTED_FILE_LIMIT
  return {
    title: translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseDiscardTitle',
      'Abort rebase and discard edits to {{count}} files?',
      { count: files.length, defaultValue_one: 'Abort rebase and discard edits to {{count}} file?' }
    ),
    description:
      hidden > 0
        ? translate(
            'auto.components.right.sidebar.SourceControl.abortRebaseDiscardFilesMore',
            '{{files}} and {{count}} more',
            { files: listed, count: hidden }
          )
        : listed,
    confirmLabel: translate(
      'auto.components.right.sidebar.SourceControl.abortRebaseDiscardConfirm',
      'Discard and abort'
    ),
    confirmVariant: 'destructive'
  }
}

function sameFiles(a: string[] | null, b: string[] | null): boolean {
  return (a ?? []).join('\n') === (b ?? []).join('\n')
}

/**
 * Abort resets every tracked file, so name edits outside the stopped pick before losing them, and
 * re-ask if that set changed while the dialog was open. `readDiscards` returns null when the host
 * cannot tell (older hosts), which keeps the plain confirm.
 */
export async function confirmRebaseAbort({
  readDiscards,
  confirm
}: {
  readDiscards: () => Promise<string[] | null>
  confirm: (request: AbortConfirmRequest) => Promise<boolean>
}): Promise<boolean> {
  let shown = await readDiscards()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await confirm(abortRebaseDialog(shown)))) {
      return false
    }
    const current = await readDiscards()
    if (sameFiles(current, shown)) {
      return true
    }
    shown = current
  }
  return false
}
