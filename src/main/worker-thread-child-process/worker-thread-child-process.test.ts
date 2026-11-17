import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  WorkerThreadChildProcessHost,
  type WorkerThreadChildProcess
} from './worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'
import { createWorkerThreadChildProcessTestEntry } from './worker-thread-child-process-worker.test-fixtures'

// Use a real MessageChannel so protocol tests include structured-clone behavior.
const openPorts: MessagePort[] = []

function makeConnectedHost(): WorkerThreadChildProcessHost {
  return new WorkerThreadChildProcessHost(() => {
    const { port1, port2 } = new MessageChannel()
    openPorts.push(port1, port2)
    serveWorkerThreadChildProcesses(port2)
    const transport = new EventEmitter()
    port1.on('message', (message) => transport.emit('message', message))
    return Object.assign(transport, {
      postMessage: (message: unknown) => port1.postMessage(message),
      unref: () => port1.unref(),
      terminate: async () => {
        port1.close()
        return 0
      }
    })
  })
}

function waitForClose(child: WorkerThreadChildProcess): Promise<[number | null, string | null]> {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])))
}

function waitForSpawn(child: WorkerThreadChildProcess): Promise<number> {
  return new Promise((resolve, reject) =>
    child.once('spawn', () =>
      child.pid === undefined ? reject(new Error('spawn reported no pid')) : resolve(child.pid)
    )
  )
}

// After worker-loop death libuv can no longer reap POSIX children; zombies persist until Orca exits.
async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'win32') {
    return true
  }
  const { stdout } = await runProcess({ program: 'ps', args: ['-o', 'stat=', '-p', String(pid)] })
  const state = stdout.trim()
  return state !== '' && !state.startsWith('Z')
}

async function waitUntilExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!(await isRunning(pid))) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`process ${pid} is still running`)
}

const ECHO_SCRIPT = `
process.stdin.setEncoding('utf8')
process.stdin.on('data', (line) => process.stdout.write('echo:' + line))
process.stdin.on('end', () => { process.stderr.write('bye'); process.exit(7) })
`
const IDLE_SCRIPT = 'setInterval(() => {}, 1000)'

afterEach(() => {
  for (const port of openPorts.splice(0)) {
    port.close()
  }
})

describe('WorkerThreadChildProcessHost over a message channel', () => {
  it('delivers large stdout and stderr exactly across backpressure and buffer transfer', async () => {
    const blocks = 64
    const bytes = Buffer.alloc(64 * 1024, 0x61)
    const script = `
      const bytes = Buffer.alloc(64 * 1024, 0x61);
      (async () => {
        for (let i = 0; i < ${blocks}; i++) {
          for (const pipe of [process.stdout, process.stderr]) {
            await new Promise((resolve, reject) =>
              pipe.write(bytes, error => error ? reject(error) : resolve()));
          }
        }
      })().catch(() => process.exitCode = 1);
    `
    const child = makeConnectedHost().spawn({ program: process.execPath, args: ['-e', script] })
    const expected = createHash('sha256')
    const stdout = createHash('sha256')
    const stderr = createHash('sha256')
    let received = 0
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.update(chunk)
      received += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.update(chunk)
      received += chunk.length
    })
    for (let i = 0; i < blocks; i++) {
      expected.update(bytes)
    }
    expect(await waitForClose(child)).toEqual([0, null])
    const digest = expected.digest('hex')
    expect(stdout.digest('hex')).toBe(digest)
    expect(stderr.digest('hex')).toBe(digest)
    expect(received).toBe(blocks * bytes.length * 2)
  })

  it('runs a real piped child across the message boundary', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', ECHO_SCRIPT]
    })
    const stdout: string[] = []
    const stderr: string[] = []
    // Convert cloned bytes back to Buffer for RPC readers using toString.
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const closed = waitForClose(child)
    await waitForSpawn(child)

    child.stdin.write('{"id":1}\n')
    await new Promise((resolve) => child.stdout.once('data', resolve))
    child.stdin.end()

    await expect(closed).resolves.toEqual([7, null])
    expect(stdout.join('')).toBe('echo:{"id":1}\n')
    expect(stderr.join('')).toBe('bye')
    expect(child.exitCode).toBe(7)
    expect(child.kill()).toBe(false)
  }, 20_000)

  // Spawns a real Node child through the worker; Windows CI process startup can exceed the default timeout.
  it('serves runProcess as its launched child, stdin bytes included', async () => {
    const host = makeConnectedHost()
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', ECHO_SCRIPT],
      input: new TextEncoder().encode('{"id":2}\n'),
      launch: (spec) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in is what launchProcessSpecOffMainThreadOnWindows returns in production.
        host.spawn({
          program: spec.program,
          args: [...(spec.args ?? [])]
        }) as unknown as ChildProcess
    })
    expect(result).toMatchObject({
      code: 7,
      stdout: 'echo:{"id":2}\n',
      stderr: 'bye',
      timedOut: false
    })
  }, 20_000)

  // Spawns a real Node child through the worker; Windows CI process startup can exceed the default timeout.
  it('keeps the exit of a child that closes stdin unread, as a native child would', async () => {
    const host = makeConnectedHost()
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stderr.write("early"); process.exit(3)'],
      input: 'x'.repeat(4 * 1024 * 1024),
      launch: (spec) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in is what launchProcessSpecOffMainThreadOnWindows returns in production.
        host.trySpawn({
          program: spec.program,
          args: [...(spec.args ?? [])]
        }) as unknown as ChildProcess
    })
    expect(result).toMatchObject({ code: 3, stderr: 'early', timedOut: false })
  }, 20_000)

  it('passes env and cwd through to the child', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.ORCA_PROBE_MARKER + "|" + process.cwd())'],
      cwd: process.cwd(),
      env: { ...process.env, ORCA_PROBE_MARKER: 'marker' }
    })
    const stdout: string[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))

    await expect(waitForClose(child)).resolves.toEqual([0, null])
    expect(stdout.join('')).toBe(`marker|${process.cwd()}`)
  }, 20_000)

  it('reports a missing program as ENOENT so callers can say the CLI is not installed', async () => {
    const child = makeConnectedHost().spawn({
      program: 'orca-definitely-missing-program',
      args: []
    })
    const error = new Promise<NodeJS.ErrnoException>((resolve) => child.once('error', resolve))

    // Missing binary and missing cwd detection read syscall and path, not just code.
    await expect(error).resolves.toMatchObject({
      code: 'ENOENT',
      syscall: 'spawn orca-definitely-missing-program',
      path: 'orca-definitely-missing-program'
    })
  }, 20_000)

  it('drops an error nobody listens for instead of throwing on the main loop', async () => {
    const child = makeConnectedHost().spawn({
      program: 'orca-definitely-missing-program',
      args: []
    })

    await expect(waitForClose(child)).resolves.toEqual([expect.any(Number), null])
  }, 20_000)

  it('kills a running child on request', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', IDLE_SCRIPT]
    })
    await waitForSpawn(child)
    const closed = waitForClose(child)

    expect(child.kill()).toBe(true)

    const [code, signal] = await closed
    expect(code !== 0 || signal !== null).toBe(true)
  }, 20_000)
})

describe('WorkerThreadChildProcessHost with a stalled worker', () => {
  it('queues a bounded number of optional launches and leaves the rest to the caller', () => {
    // A live worker that never answers: every posted launch stays pending.
    const host = new WorkerThreadChildProcessHost(() =>
      Object.assign(new EventEmitter(), {
        postMessage: () => {},
        unref: () => {},
        terminate: async () => 0
      })
    )
    const accepted = Array.from({ length: 160 }, () =>
      host.trySpawn({ program: process.execPath, args: ['-e', ''] })
    ).filter((child) => child !== null)
    expect(accepted).toHaveLength(16)
  })
})

describe('WorkerThreadChildProcessHost when the worker dies', () => {
  it('fails a launch the worker never started, so its caller is released', async () => {
    const worker = Object.assign(new EventEmitter(), {
      postMessage: () => {},
      unref: () => {},
      terminate: async () => 0
    })
    const host = new WorkerThreadChildProcessHost(() => worker)
    const child = host.trySpawn({ program: process.execPath, args: ['-e', ''] })
    if (!child) {
      throw new Error('worker launch was refused')
    }
    const errors: string[] = []
    child.on('error', (error) => errors.push(error.message))
    const closed = waitForClose(child)

    worker.emit('error', new Error('boom'))
    worker.emit('exit', 1)

    await expect(closed).resolves.toEqual([-1, null])
    expect(errors).toEqual(['Child process worker failed: boom'])
  })

  it('closes a child whose root already exited when the worker dies before its close', async () => {
    const worker = Object.assign(new EventEmitter(), {
      postMessage: () => {},
      unref: () => {},
      terminate: async () => 0
    })
    const host = new WorkerThreadChildProcessHost(() => worker)
    const child = host.trySpawn({ program: process.execPath, args: ['-e', ''] })
    if (!child) {
      throw new Error('worker launch was refused')
    }
    child.on('error', () => {})
    const closed = waitForClose(child)

    worker.emit('message', { type: 'spawn', id: 1, pid: 4242 })
    worker.emit('message', { type: 'exit', id: 1, code: 0, signal: null })
    worker.emit('exit', 1)

    await expect(closed).resolves.toEqual([0, null])
  })
})

// Real thread death closes child pipes; abandoned probes depend on that graceful stop instead of PID-addressed killing.
describe('WorkerThreadChildProcessHost on a real worker thread', () => {
  let directory = ''
  let entryPath = ''
  let dispose: (() => Promise<void>) | undefined

  beforeAll(async () => {
    ;({ directory, entryPath, dispose } = await createWorkerThreadChildProcessTestEntry())
  }, 60_000)

  afterAll(async () => {
    await dispose?.()
  })

  it.each([
    ['terminated', (worker: Worker) => void worker.terminate()],
    // A null request throws inside the worker's message handler.
    ['crashed', (worker: Worker) => worker.postMessage(null)]
  ])(
    'lets the child exit on stdin EOF when its worker is %s',
    async (_, endWorker) => {
      let worker: Worker | undefined
      const host = new WorkerThreadChildProcessHost(() => (worker = new Worker(entryPath)))
      const marker = join(directory, `eof-${Date.now()}-${Math.random()}`)
      const child = host.spawn({
        program: process.execPath,
        args: [
          '-e',
          `process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'');process.exit(0)});${IDLE_SCRIPT}`
        ]
      })
      const pid = await waitForSpawn(child)
      const abandoned = new Promise<Error>((resolve) => child.once('error', resolve))
      let closed = false
      child.on('close', () => (closed = true))
      if (!worker) {
        throw new Error('worker was not started')
      }

      endWorker(worker)

      await expect(abandoned).resolves.toMatchObject({
        message: expect.stringMatching(/^Child process worker (exited|failed)/)
      })
      await waitUntilExited(pid)
      expect(existsSync(marker)).toBe(true)
      expect(closed).toBe(false)
      expect(() => child.stdin.end()).not.toThrow()
      expect(child.kill()).toBe(false)
    },
    30_000
  )
})
