import { HandlerType, openobserveLogs, type Logger } from '@openobserve/browser-logs'
import { openobserveRum } from '@openobserve/browser-rum'
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals/attribution'
import type {
  CLSMetricWithAttribution,
  FCPMetricWithAttribution,
  INPMetricWithAttribution,
  LCPMetricWithAttribution,
  TTFBMetricWithAttribution,
} from 'web-vitals'

const SITE = 'openobserve.k2.woodgear.me'
const ORGANIZATION = 'default'
const CLIENT_TOKEN = 'rumhrXEe93L0Q4U5dgz'
const SERVICE = 'refresh'
const ENV = 'production'
const VERSION = import.meta.env.VITE_REFRESH_VERSION ?? '1.0.0'

type PerfValue = string | number | boolean
type PerfAttrs = Record<string, PerfValue | undefined>

let perfLogger: Logger | null = null
const perfSampleBuckets = new Map<string, {
  name: string
  attrs: Record<string, PerfValue>
  count: number
  totalMs: number
  maxMs: number
}>()
let sampleFlushTimer: number | null = null

export function initRum(): void {
  if (typeof window === 'undefined') return

  openobserveRum.init({
    applicationId: SERVICE,
    clientToken: CLIENT_TOKEN,
    site: SITE,
    organizationIdentifier: ORGANIZATION,
    service: SERVICE,
    env: ENV,
    version: VERSION,
    sessionSampleRate: 100,
    sessionReplaySampleRate: 100,
    trackResources: true,
    trackLongTasks: true,
    trackUserInteractions: true,
    allowedTracingUrls: [
      { match: /^\/api\//, propagatorTypes: ['tracecontext'] },
      { match: /^https:\/\/refresh-k2\.woodgear\.me\/api\//, propagatorTypes: ['tracecontext'] },
    ],
    traceSampleRate: 100,
    traceContextInjection: 'all',
    apiVersion: 'v1',
    insecureHTTP: false,
  })

  openobserveLogs.init({
    clientToken: CLIENT_TOKEN,
    site: SITE,
    organizationIdentifier: ORGANIZATION,
    service: SERVICE,
    env: ENV,
    version: VERSION,
    forwardErrorsToLogs: true,
    forwardConsoleLogs: ['error', 'warn'],
    sessionSampleRate: 100,
    apiVersion: 'v1',
    insecureHTTP: false,
  })

  perfLogger = openobserveLogs.createLogger('refresh_perf', {
    level: 'info',
    handler: HandlerType.http,
    context: { event_source: 'refresh_frontend_perf' },
  })

  initPerfObservers()
  initWebVitalsAttribution()
}

export function reportPerfEvent(name: string, durationMs?: number, attrs: PerfAttrs = {}): void {
  if (typeof window === 'undefined' || !perfLogger) return
  perfLogger.info('refresh frontend perf', {
    perf_event: name,
    ...(durationMs !== undefined ? { duration_ms: round(durationMs) } : {}),
    at_ms: round(performance.now()),
    page_path: window.location.pathname,
    page_search: window.location.search,
    ...cleanAttrs(attrs),
  })
}

export function recordPerfSample(name: string, durationMs: number, attrs: PerfAttrs = {}): void {
  if (typeof window === 'undefined' || !perfLogger) return
  const clean = cleanAttrs(attrs)
  const key = `${name}:${JSON.stringify(clean)}`
  const current = perfSampleBuckets.get(key) ?? {
    name,
    attrs: clean,
    count: 0,
    totalMs: 0,
    maxMs: 0,
  }
  current.count++
  current.totalMs += durationMs
  current.maxMs = Math.max(current.maxMs, durationMs)
  perfSampleBuckets.set(key, current)
  if (sampleFlushTimer === null) {
    sampleFlushTimer = window.setTimeout(flushPerfSamples, 1000)
  }
}

function initPerfObservers(): void {
  performance.setResourceTimingBufferSize?.(5000)

  try {
    new PerformanceObserver((list) => {
      const entry = list.getEntries().at(-1) as LargestContentfulPaint | undefined
      if (!entry) return
      const element = entry.element
      reportPerfEvent('web_vital.lcp_candidate', entry.startTime, {
        lcp_render_time_ms: entry.renderTime ? round(entry.renderTime) : undefined,
        lcp_load_time_ms: entry.loadTime ? round(entry.loadTime) : undefined,
        lcp_size: entry.size,
        lcp_url: entry.url || imageCurrentSrc(element ?? undefined),
        lcp_tag: element?.tagName,
        lcp_class: typeof element?.className === 'string' ? element.className.slice(0, 160) : undefined,
        lcp_text: elementText(element ?? undefined),
      })
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {}
}

function initWebVitalsAttribution(): void {
  const opts = { generateTarget, reportAllChanges: true }

  onLCP(metric => {
    const attr = metric.attribution
    reportPerfEvent('web_vital.lcp_attribution', metric.value, {
      ...metricAttrs(metric),
      lcp_target: attr.target,
      lcp_url: truncate(attr.url),
      lcp_time_to_first_byte_ms: round(attr.timeToFirstByte),
      lcp_resource_load_delay_ms: round(attr.resourceLoadDelay),
      lcp_resource_load_duration_ms: round(attr.resourceLoadDuration),
      lcp_element_render_delay_ms: round(attr.elementRenderDelay),
      ...navigationAttrs(attr.navigationEntry),
      ...resourceAttrs('lcp_resource', attr.lcpResourceEntry),
      lcp_entry_size: attr.lcpEntry?.size,
      lcp_entry_start_ms: roundMaybe(attr.lcpEntry?.startTime),
      lcp_entry_render_time_ms: roundMaybe(attr.lcpEntry?.renderTime),
      lcp_entry_load_time_ms: roundMaybe(attr.lcpEntry?.loadTime),
    })
  }, opts)

  onFCP(metric => {
    const attr = metric.attribution
    reportPerfEvent('web_vital.fcp_attribution', metric.value, {
      ...metricAttrs(metric),
      fcp_time_to_first_byte_ms: round(attr.timeToFirstByte),
      fcp_first_byte_to_fcp_ms: round(attr.firstByteToFCP),
      fcp_load_state: attr.loadState,
      ...navigationAttrs(attr.navigationEntry),
    })
  }, opts)

  onTTFB(metric => {
    const attr = metric.attribution
    reportPerfEvent('web_vital.ttfb_attribution', metric.value, {
      ...metricAttrs(metric),
      ttfb_waiting_duration_ms: round(attr.waitingDuration),
      ttfb_cache_duration_ms: round(attr.cacheDuration),
      ttfb_dns_duration_ms: round(attr.dnsDuration),
      ttfb_connection_duration_ms: round(attr.connectionDuration),
      ttfb_request_duration_ms: round(attr.requestDuration),
      ...navigationAttrs(attr.navigationEntry),
    })
  }, opts)

  onCLS(metric => {
    const attr = metric.attribution
    reportPerfEvent('web_vital.cls_attribution', metric.value, {
      ...metricAttrs(metric),
      cls_largest_shift_target: attr.largestShiftTarget,
      cls_largest_shift_time_ms: roundMaybe(attr.largestShiftTime),
      cls_largest_shift_value: roundMaybe(attr.largestShiftValue),
      cls_load_state: attr.loadState,
    })
  }, opts)

  onINP(metric => {
    const attr = metric.attribution
    reportPerfEvent('web_vital.inp_attribution', metric.value, {
      ...metricAttrs(metric),
      inp_interaction_target: attr.interactionTarget,
      inp_interaction_type: attr.interactionType,
      inp_interaction_time_ms: round(attr.interactionTime),
      inp_input_delay_ms: round(attr.inputDelay),
      inp_processing_duration_ms: round(attr.processingDuration),
      inp_presentation_delay_ms: round(attr.presentationDelay),
      inp_next_paint_time_ms: round(attr.nextPaintTime),
      inp_load_state: attr.loadState,
      inp_total_script_duration_ms: roundMaybe(attr.totalScriptDuration),
      inp_total_style_layout_duration_ms: roundMaybe(attr.totalStyleAndLayoutDuration),
      inp_total_paint_duration_ms: roundMaybe(attr.totalPaintDuration),
      inp_total_unattributed_duration_ms: roundMaybe(attr.totalUnattributedDuration),
      inp_longest_script_invoker: attr.longestScript?.entry.invoker,
      inp_longest_script_source_url: truncate(attr.longestScript?.entry.sourceURL),
      inp_longest_script_source_function: attr.longestScript?.entry.sourceFunctionName,
      inp_longest_script_subpart: attr.longestScript?.subpart,
      inp_longest_script_duration_ms: roundMaybe(attr.longestScript?.intersectingDuration),
    })
  }, { ...opts, includeProcessedEventEntries: false })
}

function flushPerfSamples(): void {
  sampleFlushTimer = null
  for (const bucket of perfSampleBuckets.values()) {
    reportPerfEvent('aggregate.sample', bucket.totalMs, {
      sample_name: bucket.name,
      sample_count: bucket.count,
      sample_avg_ms: round(bucket.totalMs / bucket.count),
      sample_max_ms: round(bucket.maxMs),
      ...bucket.attrs,
    })
  }
  perfSampleBuckets.clear()
}

function metricAttrs(
  metric:
    | LCPMetricWithAttribution
    | FCPMetricWithAttribution
    | TTFBMetricWithAttribution
    | CLSMetricWithAttribution
    | INPMetricWithAttribution,
): Record<string, PerfValue> {
  return {
    metric_id: metric.id,
    metric_name: metric.name,
    metric_rating: metric.rating,
    metric_delta: round(metric.delta),
    metric_navigation_type: metric.navigationType,
    metric_entry_count: metric.entries.length,
  }
}

function navigationAttrs(entry: PerformanceNavigationTiming | undefined): PerfAttrs {
  if (!entry) return {}
  return {
    nav_type: entry.type,
    nav_start_ms: round(entry.startTime),
    nav_redirect_ms: duration(entry.redirectStart, entry.redirectEnd),
    nav_dns_ms: duration(entry.domainLookupStart, entry.domainLookupEnd),
    nav_connection_ms: duration(entry.connectStart, entry.connectEnd),
    nav_tls_ms: entry.secureConnectionStart > 0 ? duration(entry.secureConnectionStart, entry.connectEnd) : undefined,
    nav_request_ms: duration(entry.requestStart, entry.responseStart),
    nav_response_ms: duration(entry.responseStart, entry.responseEnd),
    nav_ttfb_ms: round(entry.responseStart),
    nav_dom_interactive_ms: round(entry.domInteractive),
    nav_dom_content_loaded_ms: round(entry.domContentLoadedEventEnd),
    nav_load_event_ms: round(entry.loadEventEnd),
    nav_transfer_size_bytes: entry.transferSize,
    nav_encoded_body_size_bytes: entry.encodedBodySize,
    nav_decoded_body_size_bytes: entry.decodedBodySize,
    nav_protocol: entry.nextHopProtocol,
  }
}

function resourceAttrs(prefix: string, entry: PerformanceResourceTiming | undefined): PerfAttrs {
  if (!entry) return {}
  return {
    [`${prefix}_name`]: truncate(entry.name),
    [`${prefix}_initiator_type`]: entry.initiatorType,
    [`${prefix}_start_ms`]: round(entry.startTime),
    [`${prefix}_duration_ms`]: round(entry.duration),
    [`${prefix}_fetch_start_ms`]: round(entry.fetchStart),
    [`${prefix}_request_ms`]: duration(entry.requestStart, entry.responseStart),
    [`${prefix}_response_ms`]: duration(entry.responseStart, entry.responseEnd),
    [`${prefix}_transfer_size_bytes`]: entry.transferSize,
    [`${prefix}_encoded_body_size_bytes`]: entry.encodedBodySize,
    [`${prefix}_decoded_body_size_bytes`]: entry.decodedBodySize,
    [`${prefix}_protocol`]: entry.nextHopProtocol,
  }
}

function generateTarget(node: Node | null): string | undefined {
  if (!(node instanceof Element)) return undefined
  const el = node.closest('[data-perf-target]')
  if (!(el instanceof HTMLElement)) return undefined
  const target = el.dataset.perfTarget
  if (!target) return undefined
  const variant = el.dataset.mediaVariant
  const loading = el.dataset.loading
  const priority = el.dataset.fetchPriority
  return [target, variant && `variant=${variant}`, loading && `loading=${loading}`, priority && `priority=${priority}`]
    .filter(Boolean)
    .join(' ')
}

function cleanAttrs(attrs: PerfAttrs): Record<string, PerfValue> {
  return Object.fromEntries(
    Object.entries(attrs).filter((entry): entry is [string, PerfValue] => entry[1] !== undefined),
  )
}

function imageCurrentSrc(element: Element | undefined): string | undefined {
  return element instanceof HTMLImageElement ? element.currentSrc || element.src : undefined
}

function elementText(element: Element | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function roundMaybe(value: number | undefined): number | undefined {
  return value === undefined ? undefined : round(value)
}

function duration(start: number, end: number): number | undefined {
  if (start <= 0 || end <= 0) return undefined
  return round(Math.max(0, end - start))
}

function truncate(value: string | undefined): string | undefined {
  return value && value.length > 500 ? `${value.slice(0, 497)}...` : value
}
