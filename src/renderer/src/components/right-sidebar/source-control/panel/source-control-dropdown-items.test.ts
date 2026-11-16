import { describe, expect, it } from 'vitest'
import type { DropdownActionInputs } from '../../../../../../shared/source-control/dropdown/source-control-dropdown-item-types'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { resolveDropdownItems } from './source-control-dropdown-items'

const CAN_CREATE_PR: HostedReviewCreationEligibility = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found'
}

// Published branch with an open PR, clean tree, nothing to push or pull, 299 behind origin/main.
function inputs(overrides: Partial<DropdownActionInputs> = {}): DropdownActionInputs {
  return {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 0, behind: 0 },
    prState: 'open',
    hostedReviewCreation: null,
    branchCommitsAhead: 4,
    rebaseBaseRef: 'origin/main',
    rebaseBehindCount: 299,
    primaryActionKind: undefined,
    ...overrides
  }
}

function rows(overrides: Partial<DropdownActionInputs> = {}) {
  return resolveDropdownItems(inputs(overrides)).map((entry) =>
    entry.kind === 'separator' ? '---' : `${entry.kind}${entry.status ? ` ${entry.status}` : ''}`
  )
}

describe('resolveDropdownItems lists only actions that can run now', () => {
  it('puts Rebase first with its behind count when the branch is behind its base', () => {
    expect(rows()).toEqual(['rebase_base ↓299', '---', 'force_push', 'fetch'])
  })

  it('leads with the commit compounds when staged, without repeating the Commit primary', () => {
    expect(rows({ stagedCount: 3, hasMessage: true, primaryActionKind: 'commit' })).toEqual([
      'commit_push',
      'commit_sync',
      'rebase_base ↓299',
      '---',
      'force_push',
      'fetch'
    ])
  })

  it('keeps only the fallbacks when the branch is up to date with its base', () => {
    expect(rows({ rebaseBehindCount: 0 })).toEqual(['force_push', 'fetch'])
  })

  it('keeps Rebase without a count when the compare row measures another ref', () => {
    expect(rows({ rebaseBehindCount: null })).toEqual(['rebase_base', '---', 'force_push', 'fetch'])
  })

  it('drops Push and Create PR when they are the primary', () => {
    expect(
      rows({
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
        primaryActionKind: 'push',
        rebaseBehindCount: 0
      })
    ).toEqual(['force_push ↑2', 'fetch'])
    expect(
      rows({
        prState: null,
        hostedReviewCreation: CAN_CREATE_PR,
        primaryActionKind: 'create_pr',
        rebaseBehindCount: 0
      })
    ).toEqual(['force_push', 'fetch'])
  })

  it('offers Create PR in the menu when the primary is busy with something else', () => {
    expect(
      rows({ prState: null, hostedReviewCreation: CAN_CREATE_PR, rebaseBehindCount: 0 })
    ).toEqual(['create_pr', '---', 'force_push', 'fetch'])
  })

  it('hides Rebase while tracked changes would make git refuse it', () => {
    expect(
      rows({
        hasUnstagedChanges: true,
        hasStageableChanges: true,
        rebaseBlockedByDirtyTree: true,
        primaryActionKind: 'stage'
      })
    ).toEqual(['force_push', 'fetch'])
  })

  it('offers neither Pull, Sync nor a plain Push right after a rebase', () => {
    expect(
      rows({
        upstreamStatus: {
          hasUpstream: true,
          ahead: 303,
          behind: 4,
          behindCommitsArePatchEquivalent: true
        },
        primaryActionKind: 'push',
        rebaseBehindCount: 0
      })
    ).toEqual(['fetch'])
  })

  it('hides Pull, Sync and Fast-forward after an Orca rebase but keeps Force Push', () => {
    const diverged = { hasUpstream: true, ahead: 3, behind: 2 }
    expect(rows({ upstreamStatus: diverged, rebaseBehindCount: 0 })).toEqual([
      'push ↑3',
      'pull ↓2',
      'sync ↓2 ↑3',
      'fast_forward May fail',
      '---',
      'force_push Replaces ↓2',
      'fetch'
    ])
    expect(
      rows({ upstreamStatus: diverged, rebaseBehindCount: 0, suppressPullAfterRebase: true })
    ).toEqual(['push ↑3', '---', 'force_push Replaces ↓2', 'fetch'])
  })

  it('limits a paused rebase to Abort, Continue once resolved, and Fetch', () => {
    const paused = { conflictOperation: 'rebase' as const, upstreamStatus: undefined }
    expect(rows({ ...paused, hasUnresolvedConflicts: true })).toEqual([
      'abort_rebase',
      '---',
      'fetch'
    ])
    expect(rows(paused)).toEqual(['abort_rebase', 'continue_rebase', '---', 'fetch'])
    expect(rows({ ...paused, rebaseEmptyStop: true })).toEqual([
      'skip_rebase_commit',
      'abort_rebase',
      '---',
      'fetch'
    ])
  })

  it('keeps a disabled Fetch as the only row while another Git operation runs', () => {
    const entries = resolveDropdownItems(
      inputs({ isRemoteOperationActive: true, inFlightRemoteOpKind: 'rebase' })
    )
    expect(entries).toMatchObject([{ kind: 'fetch', disabled: true }])
  })
})
