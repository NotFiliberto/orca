import type { ChildProcess } from 'node:child_process'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { assertWslNotLatchedAbsent } from '@orca/process-host/wsl-not-installed-latch'
import { spawnOffMainThreadOnWindows } from './worker-thread-child-process'

/** runProcess `launch` for Windows: plain piped specs start on the worker; any other stdio or flag keeps the in-thread spawn. */
export function launchProcessSpecOffMainThreadOnWindows(spec: ProcessSpec): ChildProcess | null {
  // The worker has its own module state, so the WSL-absent latch is only known here.
  assertWslNotLatchedAbsent(spec.program)
  const piped =
    spec.stdio === undefined ||
    spec.stdio === 'pipe' ||
    (Array.isArray(spec.stdio) &&
      spec.stdio.length === 3 &&
      spec.stdio.every((entry) => entry === 'pipe'))
  if (!piped || spec.detached || spec.windowsVerbatimArguments || spec.serialization) {
    return null
  }
  const child = spawnOffMainThreadOnWindows({
    program: spec.program,
    args: [...(spec.args ?? [])],
    cwd: spec.cwd,
    env: spec.env
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in carries the piped surface runProcess and tree termination use: stdio events, stdin, pid, kill, exit and close.
  return child as unknown as ChildProcess | null
}
