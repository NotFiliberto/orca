import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import type { Worker } from 'node:worker_threads'
import { admitProcessTreeKill } from '@orca/process-host/process-tree-kill-gate'
import { startWindowsTreeKill } from '@orca/process-host/windows-tree-kill'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../worker-threads/lazy-worker-thread-host'
import type {
  WorkerRequestTransport,
  WorkerThreadFactory
} from '../worker-threads/worker-thread-transport'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadChildRequest,
  WorkerThreadChildSpec
} from './worker-thread-child-process-protocol'

// #27362: Windows code-integrity hashing can block CreateProcessW for seconds on the calling loop. Spawn in a worker and fail closed if unavailable (#11161).

// Amortize worker startup across nearby probes.
export const IDLE_TEARDOWN_MS = 2 * 60_000

const WORKER_ENTRY_FILENAME = 'worker-thread-child-process-entry.js'
// A stalled worker must not collect launches without bound; past this, optional launches spawn in-thread.
export const MAX_PENDING_OPTIONAL_LAUNCHES = 16
// Node reports a negative errno as the exit code of a child that never started.
const SPAWN_FAILED_EXIT_CODE = -1

/** False when the child is no longer reachable through a live worker. */
type SendRequest = (request: WorkerThreadChildRequest) => boolean

function toError(payload: WorkerThreadChildErrorPayload): Error {
  const { message, ...fields } = payload
  return Object.assign(new Error(message), fields)
}

/** Native-like children get stdin pipe errors here; others see them as child 'error' events. */
class WorkerThreadChildStdin extends EventEmitter {
  constructor(
    private readonly id: number,
    private readonly send: SendRequest
  ) {
    super()
  }

  write(data: string | Uint8Array): boolean {
    this.send({ type: 'stdin-write', id: this.id, data })
    return true
  }

  end(data?: string | Uint8Array): void {
    if (data !== undefined && data.length > 0) {
      this.write(data)
    }
    this.send({ type: 'stdin-end', id: this.id })
  }
}

/** Main-thread stand-in for a piped ChildProcess whose real process lives on the worker. */
export class WorkerThreadChildProcess extends EventEmitter {
  ownedGroupStopping = false
  ownedGroupTerminated = false
  closed = false
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin: WorkerThreadChildStdin
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  constructor(
    readonly id: number,
    private readonly send: SendRequest,
    /** Behave like a native piped ChildProcess: stdin pipe errors stay on stdin, and losing the worker ends the child. */
    readonly nativeLike = false
  ) {
    super()
    this.stdin = new WorkerThreadChildStdin(id, send)
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false
    }
    return this.send({ type: 'kill', id: this.id, signal })
  }

  stopOwnedGroup(): void {
    this.ownedGroupStopping = true
    this.send({ type: 'stop-owned-group', id: this.id })
  }

  receive(event: WorkerThreadChildEvent): void {
    switch (event.type) {
      case 'group-terminated':
        this.ownedGroupTerminated = true
        this.emit('group-terminated')
        return
      case 'spawn':
        this.pid = event.pid
        this.emit('spawn')
        return
      case 'stdout':
      case 'stderr':
        try {
          this[event.type].emit(
            'data',
            Buffer.from(event.chunk.buffer, event.chunk.byteOffset, event.chunk.byteLength)
          )
        } finally {
          this.send({ type: 'output-consumed', id: this.id, bytes: event.chunk.byteLength })
        }
        return
      case 'error':
        if (event.stdin && this.nativeLike) {
          // Native callers ignore stdin EPIPE and keep the real exit; an unobserved stdin error is dropped.
          if (this.stdin.listenerCount('error') > 0) {
            this.stdin.emit('error', toError(event.error))
          }
          return
        }
        this.emitErrorIfObserved(event.error)
        return
      case 'spawn-error':
        this.emit('group-terminated')
        this.emitErrorIfObserved(event.error)
        this.receive({ type: 'exit', id: this.id, code: SPAWN_FAILED_EXIT_CODE, signal: null })
        this.receive({ type: 'close', id: this.id, code: SPAWN_FAILED_EXIT_CODE, signal: null })
        return
      case 'exit':
        this.exitCode = event.code
        this.signalCode = event.signal
        this.emit('exit', event.code, event.signal)
        return
      case 'close':
        this.closed = true
        this.emit('close', event.code, event.signal)
    }
  }

  /** The worker is gone: a running native-like child closes only once a tree kill proves it ended, so callers keep their locks while it may still run; others keep the error-only contract. */
  abandon(message: string): void {
    const pid = this.pid
    if (this.nativeLike && !this.closed && pid === undefined) {
      // The worker posts the pid as soon as the process exists and its messages drain before exit, so after an uncaught error
      // or exit no pid means no process (only a V8 termination between the two, e.g. worker OOM, could break this).
      this.receive({ type: 'spawn-error', id: this.id, error: { message } })
      return
    }
    this.emitErrorIfObserved({ message })
    if (!this.nativeLike || this.closed || pid === undefined) {
      return
    }
    // Callers may return admission now but keep mutation fences until close, which needs proof (council ruling).
    this.emit('worker-lost')
    // An exited root's pid may be reused, and descendants may still hold its pipes: no kill, no close.
    if (this.exitCode !== null || this.signalCode !== null) {
      return
    }
    if (!admitProcessTreeKill({ pid, site: 'worker-child-abandon', scope: 'win-taskkill-tree' })) {
      return
    }
    // In-thread taskkill, started now: the worker is gone and so is its handle, so a delayed kill could hit a reused pid.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tree kill keys on this object and reads only exitCode, signalCode and exit listeners, which the stand-in has.
    void startWindowsTreeKill(this as unknown as ChildProcess, pid, () => {}).settled.then(
      (verdict) => {
        if (verdict !== 'exited' || this.closed) {
          return
        }
        this.receive({ type: 'exit', id: this.id, code: null, signal: null })
        this.receive({ type: 'close', id: this.id, code: null, signal: null })
      }
    )
  }

  // Ignore unobserved late errors after caller detach or EventEmitter would throw fatally into main.
  private emitErrorIfObserved(payload: WorkerThreadChildErrorPayload): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', toError(payload))
    }
  }
}

export class WorkerThreadChildProcessHost {
  private readonly host: LazyWorkerThreadHost<WorkerThreadChildEvent>
  private readonly children = new Map<number, WorkerThreadChildProcess>()
  private nextId = 1
  // A worker that dies before answering any launch is broken (e.g. a bad entry); stop routing optional launches to it.
  private servedBy: WorkerRequestTransport | null = null
  private brokenBeforeServing = false
  // Keyed by worker: an idle teardown between 'error' and 'exit' must not leave later workers marked failing.
  private failing: { worker: WorkerRequestTransport | null; message: string } | null = null

  constructor(factory: WorkerThreadFactory) {
    this.host = new LazyWorkerThreadHost<WorkerThreadChildEvent>({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      onMessage: (event) => this.route(event),
      // 'exit' follows 'error' after the worker's queued messages are delivered; abandoning on 'error' would drop them.
      onError: (error) => {
        this.failing = { worker: this.host.current, message: error.message }
      },
      onExit: (code) => {
        const failure = this.failing?.worker === this.host.current ? this.failing : null
        this.failing = null
        this.abandonAll(
          failure
            ? `Child process worker failed: ${failure.message}`
            : `Child process worker exited with code ${code}`
        )
      },
      isIdle: () => this.children.size === 0,
      onUnavailable: (error) =>
        console.warn(
          `[worker-thread-child-process] worker unavailable. ${error instanceof Error ? error.message : String(error)}`
        )
    })
  }

  spawn(spec: WorkerThreadChildSpec, nativeLike = false): WorkerThreadChildProcess {
    const id = this.nextId++
    const child = new WorkerThreadChildProcess(id, (request) => this.post(request), nativeLike)
    if (this.host.ensure()) {
      this.host.clearIdleTimer()
      this.children.set(id, child)
      if (this.post({ type: 'spawn', id, spec })) {
        return child
      }
      this.forget(id)
    }
    // Deferred like Node's own spawn errors, so the caller can attach listeners first.
    process.nextTick(() =>
      child.receive({
        type: 'spawn-error',
        id,
        error: { message: 'Child process worker is unavailable' }
      })
    )
    return child
  }

  /** A native-like child, or null when the worker cannot start or proved broken, so the caller spawns in-thread instead. */
  trySpawn(spec: WorkerThreadChildSpec): WorkerThreadChildProcess | null {
    if (
      this.brokenBeforeServing ||
      this.failing?.worker === this.host.current ||
      this.pendingLaunches() >= MAX_PENDING_OPTIONAL_LAUNCHES
    ) {
      return null
    }
    return this.host.ensure() ? this.spawn(spec, true) : null
  }

  private pendingLaunches(): number {
    let pending = 0
    for (const child of this.children.values()) {
      if (child.pid === undefined && !child.closed) {
        pending++
      }
    }
    return pending
  }

  private post(request: WorkerThreadChildRequest): boolean {
    const worker = this.host.current
    if (!worker || !this.children.has(request.id)) {
      return false
    }
    try {
      worker.postMessage(request)
      return true
    } catch {
      return false
    }
  }

  private route(event: WorkerThreadChildEvent): void {
    this.servedBy = this.host.current
    const child = this.children.get(event.id)
    if (!child) {
      return
    }
    child.receive(event)
    if (event.type === 'close' && event.retained) {
      this.post({ type: 'release', id: event.id })
    }
    if (
      event.type === 'spawn-error' ||
      (child.closed && (!child.ownedGroupStopping || child.ownedGroupTerminated))
    ) {
      this.forget(event.id)
    }
  }

  private forget(id: number): void {
    this.children.delete(id)
    if (this.children.size === 0) {
      this.host.scheduleIdleTeardown()
    }
  }

  // Worker death closes stdin for graceful stop but proves no child exit; only native-like children close (see abandon).
  private abandonAll(message: string): void {
    const abandoned = [...this.children.values()]
    this.children.clear()
    this.brokenBeforeServing ||= this.servedBy !== this.host.current
    this.host.destroy()
    for (const child of abandoned) {
      child.abandon(message)
    }
  }
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  // Reject missing worker synchronously so spawning fails closed instead of awaiting impossible readiness.
  if (!existsSync(workerPath)) {
    throw new Error(`Child process worker entry not found: ${workerPath}`)
  }
  return spawnWorkerThread(workerPath, { name: 'orca-child-process-spawner' })
}

let sharedHost: WorkerThreadChildProcessHost | null = null

function sharedChildProcessHost(): WorkerThreadChildProcessHost {
  sharedHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedHost
}

export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
  return sharedChildProcessHost().spawn(spec)
}

/** Windows process creation blocks its calling thread (#27362), so routine Git/gh launches run on the worker there; null elsewhere or when the worker cannot start. */
export function spawnOffMainThreadOnWindows(
  spec: WorkerThreadChildSpec
): WorkerThreadChildProcess | null {
  if (process.platform !== 'win32') {
    return null
  }
  // The worker's env is a snapshot from its start; pass the caller's view explicitly.
  return sharedChildProcessHost().trySpawn({ ...spec, env: spec.env ?? process.env })
}
