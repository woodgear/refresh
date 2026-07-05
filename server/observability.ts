interface DurationSample {
  name: string
  durationMs: number
  at: string
  attrs: Record<string, string | number | boolean>
}

interface RumSample {
  name: string
  value: number
  at: string
  attrs: Record<string, string | number | boolean>
}

const MAX_RECENT = 300
const httpDurations = new Map<string, { count: number; totalMs: number; maxMs: number }>()
const operationDurations = new Map<string, { count: number; totalMs: number; maxMs: number }>()
const resourceWrites = new Map<string, number>()
const validationFailures = new Map<string, number>()
const recentSlow: DurationSample[] = []
const recentRum: RumSample[] = []

function nowIso(): string {
  return new Date().toISOString()
}

function observe(map: Map<string, { count: number; totalMs: number; maxMs: number }>, key: string, durationMs: number): void {
  const cur = map.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 }
  cur.count++
  cur.totalMs += durationMs
  cur.maxMs = Math.max(cur.maxMs, durationMs)
  map.set(key, cur)
}

function rememberSlow(sample: DurationSample, thresholdMs: number): void {
  if (sample.durationMs < thresholdMs) return
  recentSlow.unshift(sample)
  recentSlow.length = Math.min(recentSlow.length, MAX_RECENT)
}

export function recordHttp(method: string, path: string, status: number, durationMs: number): void {
  const route = normalizePath(path)
  observe(httpDurations, `${method} ${route} ${status}`, durationMs)
  rememberSlow({ name: 'http.request', durationMs, at: nowIso(), attrs: { method, route, status } }, 500)
}

export function recordOperation(name: string, durationMs: number, attrs: Record<string, string | number | boolean> = {}): void {
  observe(operationDurations, name, durationMs)
  rememberSlow({ name, durationMs, at: nowIso(), attrs }, 100)
}

export function recordResourceWrite(kind: string): void {
  resourceWrites.set(kind, (resourceWrites.get(kind) ?? 0) + 1)
}

export function recordValidationFailure(kind: string): void {
  validationFailures.set(kind, (validationFailures.get(kind) ?? 0) + 1)
}

export function recordRum(samples: RumSample[]): void {
  for (const sample of samples) {
    recentRum.unshift({ ...sample, at: sample.at || nowIso(), attrs: sample.attrs ?? {} })
  }
  recentRum.length = Math.min(recentRum.length, MAX_RECENT)
}

export function metricsText(): string {
  const lines = [
    '# HELP refresh_http_request_duration_ms HTTP request duration summary.',
    '# TYPE refresh_http_request_duration_ms summary',
  ]
  for (const [key, value] of httpDurations) {
    const [method, route, status] = splitMetricKey(key)
    lines.push(`refresh_http_request_duration_ms_count{method="${esc(method)}",route="${esc(route)}",status="${esc(status)}"} ${value.count}`)
    lines.push(`refresh_http_request_duration_ms_sum{method="${esc(method)}",route="${esc(route)}",status="${esc(status)}"} ${value.totalMs}`)
    lines.push(`refresh_http_request_duration_ms_max{method="${esc(method)}",route="${esc(route)}",status="${esc(status)}"} ${value.maxMs}`)
  }

  lines.push('# HELP refresh_operation_duration_ms Backend operation duration summary.')
  lines.push('# TYPE refresh_operation_duration_ms summary')
  for (const [name, value] of operationDurations) {
    lines.push(`refresh_operation_duration_ms_count{name="${esc(name)}"} ${value.count}`)
    lines.push(`refresh_operation_duration_ms_sum{name="${esc(name)}"} ${value.totalMs}`)
    lines.push(`refresh_operation_duration_ms_max{name="${esc(name)}"} ${value.maxMs}`)
  }

  lines.push('# HELP refresh_resource_writes_total Resource writes by kind.')
  lines.push('# TYPE refresh_resource_writes_total counter')
  for (const [kind, value] of resourceWrites) lines.push(`refresh_resource_writes_total{kind="${esc(kind)}"} ${value}`)

  lines.push('# HELP refresh_validation_failures_total Resource validation failures by kind.')
  lines.push('# TYPE refresh_validation_failures_total counter')
  for (const [kind, value] of validationFailures) lines.push(`refresh_validation_failures_total{kind="${esc(kind)}"} ${value}`)

  return `${lines.join('\n')}\n`
}

export function observabilitySummary() {
  return {
    apiVersion: 'radar/v1',
    kind: 'ObservabilitySummary',
    status: {
      httpRoutes: httpDurations.size,
      operations: operationDurations.size,
      resourceWriteKinds: resourceWrites.size,
      recentSlow: recentSlow.slice(0, 50),
      recentRum: recentRum.slice(0, 50),
    },
  }
}

function normalizePath(path: string): string {
  return path
    .replace(/\/api\/v1\/messages\/[^/?]+/g, '/api/v1/messages/:name')
    .replace(/\/api\/v1\/authors\/[^/?]+/g, '/api/v1/authors/:name')
    .replace(/\/api\/v1\/followees\/[^/?]+/g, '/api/v1/followees/:name')
    .replace(/\/api\/v1\/refreshwindows\/[^/?]+/g, '/api/v1/refreshwindows/:name')
    .replace(/\/api\/v1\/followeewindows\/[^/?]+/g, '/api/v1/followeewindows/:name')
    .replace(/\/api\/v1\/loginsessions\/[^/?]+\/qr/g, '/api/v1/loginsessions/:id/qr')
    .replace(/\/api\/v1\/loginsessions\/[^/?]+\/input/g, '/api/v1/loginsessions/:id/input')
    .replace(/\/api\/v1\/loginsessions\/[^/?]+/g, '/api/v1/loginsessions/:id')
    .replace(/\/api\/v1\/media\/[^/?]+/g, '/api/v1/media/:file')
    .replace(/\/rss\/[^/?]+/g, '/rss/:source')
}

function splitMetricKey(key: string): [string, string, string] {
  const first = key.indexOf(' ')
  const last = key.lastIndexOf(' ')
  return [key.slice(0, first), key.slice(first + 1, last), key.slice(last + 1)]
}

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
