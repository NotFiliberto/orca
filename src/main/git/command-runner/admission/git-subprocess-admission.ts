import { GitAdmissionScheduler } from '../../../../shared/git/admission/git-admission-scheduler'
import type {
  GitAdmissionGrant,
  GitAdmissionRequest
} from '../../../../shared/git/admission/git-admission-state'
import { resolveGitAdmissionTier } from './git-operation-executor'

let scheduler = new GitAdmissionScheduler()

export function acquireGitAdmission(request: GitAdmissionRequest): Promise<GitAdmissionGrant> {
  if (process.env.ORCA_GIT_ADMISSION_DISABLED === '1') {
    return Promise.resolve({ queueWaitMs: 0, release: () => {} })
  }
  return scheduler.acquire({ ...request, tier: resolveGitAdmissionTier(request.tier) })
}

/** A timed-out caller can settle before its child exits; the slot frees when the child does. */
export function releaseGitAdmissionAfter(
  termination: Promise<void> | null,
  grant: Pick<GitAdmissionGrant, 'release'>
): void {
  if (termination) {
    void termination.then(grant.release)
  } else {
    grant.release()
  }
}

/** A child's full termination, plus the earlier point its permit may return: when its worker is lost, mutation fences keep
 * waiting on `terminated` (proof may never come) but scarce Git capacity is not held for the session. */
export function trackGitChildAdmission(): {
  terminated: Promise<void>
  admissionReturned: Promise<void>
  /** True on proven termination, false once the worker is lost first. */
  terminationProven: Promise<boolean>
  onChildTerminated: () => void
  onWorkerLost: () => void
} {
  let onChildTerminated: () => void = () => {}
  let onWorkerLost: () => void = () => {}
  const terminated = new Promise<void>((resolve) => {
    onChildTerminated = resolve
  })
  const workerLost = new Promise<void>((resolve) => {
    onWorkerLost = resolve
  })
  const terminationProven = Promise.race([
    terminated.then(() => true),
    workerLost.then(() => false)
  ])
  const admissionReturned = terminationProven.then(() => {})
  return { terminated, admissionReturned, terminationProven, onChildTerminated, onWorkerLost }
}

export function _resetGitAdmissionForTests(replacement = new GitAdmissionScheduler()): void {
  scheduler = replacement
}

export function _gitAdmissionSnapshotForTests(): ReturnType<GitAdmissionScheduler['snapshot']> {
  return scheduler.snapshot()
}
