import { describe, expect, it } from 'vitest'
import { orcaRebaseMarkerIsRetired } from './orca-rebase-marker'

describe('orcaRebaseMarkerIsRetired', () => {
  it('retires a done marker on a branch switch before the new upstream is known', () => {
    const marker = { branch: 'feature', upstreamOid: 'u1', state: 'done' as const }
    const noUpstreamOid = { hasUpstream: true, ahead: 0, behind: 0 }
    expect(orcaRebaseMarkerIsRetired(marker, 'other', noUpstreamOid)).toBe(true)
    expect(orcaRebaseMarkerIsRetired(marker, 'feature', noUpstreamOid)).toBe(false)
  })
})
