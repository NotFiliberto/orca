// SCRATCH PROFILING ONLY (never merged): times every window/document key-family listener and every app-router owner.
type Stat = { site: string; n: number; total: number; max: number; over5: number }
const KEY_TYPES = new Set(['keydown', 'keypress', 'keyup', 'beforeinput', 'input'])
const stats = new Map<string, Stat>()
let recording = false

export function keylatSite(skip: number): string {
  const lines = (new Error().stack ?? '').split('\n').slice(skip, skip + 3)
  return lines
    .map((line) =>
      line
        .trim()
        .replace(/^at /, '')
        .replace(/(file|https?):\/\/[^)]*?\/(assets|src)\//, '$2/')
    )
    .join(' < ')
}

export function recordKeylat(key: string, ms: number): void {
  if (!recording) {
    return
  }
  let stat = stats.get(key)
  if (!stat) {
    stat = { site: key, n: 0, total: 0, max: 0, over5: 0 }
    stats.set(key, stat)
  }
  stat.n += 1
  stat.total += ms
  stat.max = Math.max(stat.max, ms)
  stat.over5 += ms > 5 ? 1 : 0
}

;(globalThis as Record<string, unknown>).__keylat = {
  start() {
    stats.clear()
    recording = true
  },
  stop() {
    recording = false
  },
  snapshot() {
    return [...stats.values()]
      .map((stat) => ({ ...stat, total: Math.round(stat.total * 10) / 10, max: Math.round(stat.max * 10) / 10 }))
      .sort((a, b) => b.total - a.total)
  }
}

const originalAdd = EventTarget.prototype.addEventListener
const originalRemove = EventTarget.prototype.removeEventListener
const wrappers = new WeakMap<object, Map<string, EventListener>>()

function wrapperKey(target: EventTarget, type: string, options: unknown): string {
  const capture = typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean })?.capture)
  return `${target === window ? 'window' : 'document'} ${capture ? 'capture' : 'bubble'} ${type}`
}

EventTarget.prototype.addEventListener = function (type, listener, options) {
  if (listener && KEY_TYPES.has(type) && (this === window || this === document)) {
    const phase = wrapperKey(this, type, options)
    let byPhase = wrappers.get(listener)
    if (!byPhase) {
      byPhase = new Map()
      wrappers.set(listener, byPhase)
    }
    let wrapped = byPhase.get(phase)
    if (!wrapped) {
      const name = (listener as { name?: string }).name || 'anonymous'
      const key = `[${phase}] ${name} @ ${keylatSite(2)}`
      wrapped = function (this: unknown, event: Event) {
        const started = performance.now()
        try {
          return typeof listener === 'function'
            ? listener.call(this, event)
            : listener.handleEvent(event)
        } finally {
          recordKeylat(key, performance.now() - started)
        }
      }
      byPhase.set(phase, wrapped)
    }
    return originalAdd.call(this, type, wrapped, options)
  }
  return originalAdd.call(this, type, listener, options)
}

EventTarget.prototype.removeEventListener = function (type, listener, options) {
  if (listener && KEY_TYPES.has(type) && (this === window || this === document)) {
    const wrapped = wrappers.get(listener)?.get(wrapperKey(this, type, options))
    return originalRemove.call(this, type, wrapped ?? listener, options)
  }
  return originalRemove.call(this, type, listener, options)
}
