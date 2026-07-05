type RumValue = string | number | boolean

interface RumSample {
  name: string
  value: number
  at: string
  attrs: Record<string, RumValue>
}

const buffer: RumSample[] = []
let flushTimer: number | null = null

export function initRum(): void {
  if (typeof window === 'undefined') return
  observeNavigation()
  observePaint()
  observeWebVitals()
  instrumentFetch()
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRum()
  })
  window.addEventListener('pagehide', flushRum)
}

function addRum(name: string, value: number, attrs: Record<string, RumValue> = {}): void {
  if (!Number.isFinite(value)) return
  buffer.push({ name, value, attrs: { path: location.pathname, ...attrs }, at: new Date().toISOString() })
  if (flushTimer === null) flushTimer = window.setTimeout(flushRum, 3000)
}

function flushRum(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  if (buffer.length === 0) return
  const samples = buffer.splice(0, buffer.length)
  const payload = JSON.stringify({ samples })
  if (navigator.sendBeacon) {
    const sent = navigator.sendBeacon('/api/v1/rum', new Blob([payload], { type: 'application/json' }))
    if (sent) return
  }
  void fetch('/api/v1/rum', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    buffer.unshift(...samples.slice(0, 20))
  })
}

function observeNavigation(): void {
  window.addEventListener('load', () => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (!nav) return
    addRum('navigation.duration', nav.duration)
    addRum('navigation.ttfb', nav.responseStart - nav.requestStart)
    addRum('navigation.dom_content_loaded', nav.domContentLoadedEventEnd - nav.startTime)
  }, { once: true })
}

function observePaint(): void {
  const paints = performance.getEntriesByType('paint')
  for (const paint of paints) addRum(`paint.${paint.name.replace(/-/g, '_')}`, paint.startTime)
}

function observeWebVitals(): void {
  if (!('PerformanceObserver' in window)) return
  observeEntries('largest-contentful-paint', entries => {
    const last = entries.at(-1)
    if (last) addRum('web_vital.lcp', last.startTime)
  })
  observeEntries('layout-shift', entries => {
    let cls = 0
    for (const entry of entries as PerformanceEntry[]) {
      const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
      if (!shift.hadRecentInput) cls += shift.value ?? 0
    }
    if (cls > 0) addRum('web_vital.cls', cls)
  })
  observeEntries('event', entries => {
    for (const entry of entries) {
      const event = entry as PerformanceEntry & { duration?: number; interactionId?: number }
      if ((event.interactionId ?? 0) > 0) addRum('web_vital.inp_event', event.duration ?? 0, { event: event.name })
    }
  })
}

function observeEntries(type: string, onEntries: (entries: PerformanceEntry[]) => void): void {
  try {
    const observer = new PerformanceObserver(list => onEntries(list.getEntries()))
    observer.observe({ type, buffered: true } as PerformanceObserverInit)
  } catch {
    // Unsupported browser entry type.
  }
}

function instrumentFetch(): void {
  const original = window.fetch
  window.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const startedAt = performance.now()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    try {
      const response = await original(input, init)
      recordFetch(url, response.status, performance.now() - startedAt)
      return response
    } catch (err) {
      recordFetch(url, 0, performance.now() - startedAt)
      throw err
    }
  }) as typeof fetch
}

function recordFetch(url: string, status: number, durationMs: number): void {
  let path = url
  try {
    path = new URL(url, location.origin).pathname
  } catch {
    // Keep original value.
  }
  if (path === '/api/v1/rum') return
  addRum('api.fetch.duration', durationMs, { path: normalizePath(path), status })
}

function normalizePath(path: string): string {
  return path
    .replace(/\/api\/v1\/messages\/[^/]+/g, '/api/v1/messages/:name')
    .replace(/\/api\/v1\/authors\/[^/]+/g, '/api/v1/authors/:name')
    .replace(/\/api\/v1\/followees\/[^/]+/g, '/api/v1/followees/:name')
    .replace(/\/api\/v1\/refreshwindows\/[^/]+/g, '/api/v1/refreshwindows/:name')
    .replace(/\/api\/v1\/loginsessions\/[^/]+/g, '/api/v1/loginsessions/:id')
}
