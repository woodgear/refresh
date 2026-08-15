// 推特采集（直连 CDP）：捕获 x.com 当前 HomeTimeline GraphQL 请求模板，
// 从响应中提取 tweet 与 bottom cursor，并在同一 tab 内重放后续页面。

import { closeTab, ensureBrowser, openSession, sleep, type CdpSession } from './cdp'
import type { FetchPageResult } from './fetcher'

type Json = Record<string, unknown>

export type TwitterCapability = 'recommend' | 'following'
export type TwitterPageLoader = (cursor: string | null) => Promise<unknown>

interface TwitterCursor {
  version: 1
  capability: TwitterCapability
  value: string
}

type CapturedRequest =
  | { method: 'GET'; url: string; headers: Record<string, string> }
  | { method: 'POST'; url: string; postData: string; headers: Record<string, string> }

const TIMELINE_URL_MARK: Record<TwitterCapability, string> = {
  recommend: '/HomeTimeline',
  following: '/HomeLatestTimeline',
}

const TAB_TEXTS: Record<TwitterCapability, string[]> = {
  recommend: ['For you', '为你推荐', '推荐'],
  following: ['Following', '正在关注'],
}

const REPLAY_HEADER_NAMES = new Set([
  'authorization',
  'content-type',
  'x-client-transaction-id',
  'x-csrf-token',
  'x-twitter-active-user',
  'x-twitter-auth-type',
])

export async function collectTwitterPages(
  capability: TwitterCapability,
  targetCount: number,
  inputCursor: string | null,
  loader: TwitterPageLoader,
  pause: () => Promise<unknown> = () => sleep(800),
): Promise<FetchPageResult> {
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error(`twitter target count must be a positive integer: ${targetCount}`)
  }

  let cursor = inputCursor === null ? null : parseCursor(inputCursor, capability).value
  const collected = new Map<string, Json>()
  for (let upstreamPage = 0; upstreamPage < 25 && collected.size < targetCount; upstreamPage++) {
    const payload = await loader(cursor)
    cursor = extractTimelinePage(payload, collected)
    if (cursor === null || collected.size >= targetCount) break
    await pause()
  }

  const outputCursor: TwitterCursor | null = cursor === null
    ? null
    : { version: 1, capability, value: cursor }
  return {
    rawItems: [...collected.values()],
    nextCursor: outputCursor === null ? null : JSON.stringify(outputCursor),
    hasMore: outputCursor !== null,
    fetchedAt: Math.floor(Date.now() / 1000),
  }
}

export async function fetchTwitterPage(
  capability: TwitterCapability,
  count: number,
  cursor: string | null,
  log: (s: string) => void,
): Promise<FetchPageResult> {
  if (cursor !== null) parseCursor(cursor, capability)
  if (!(await ensureBrowser(log))) throw new Error('browser_down: CDP unreachable after self-heal')

  const { tab, session } = await openSession('about:blank')
  try {
    const capture = captureTimelineRequest(session, capability)
    await session.send('Network.enable')
    await session.send('Page.enable')
    await session.send('Page.navigate', { url: 'https://x.com/home' }, 20_000)
    await waitFor(session, `document.querySelectorAll('[role="tab"]').length > 0`, 30_000, 'home tabs')
    log('x.com/home loaded')

    const texts = JSON.stringify(TAB_TEXTS[capability])
    const selected = await session.evaluate<string | null>(`(() => {
      const texts = ${texts}
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const target = tabs.find(tab => texts.some(text => tab.textContent.trim().includes(text)))
      if (target && target.getAttribute('aria-selected') !== 'true') target.click()
      return target ? target.textContent.trim() : null
    })()`)
    if (!selected) throw new Error(`twitter ${capability} tab not found`)

    const { request, payload } = await capture.result()
    const loader: TwitterPageLoader = async pageCursor => pageCursor === null
      ? payload
      : replayTimelineRequest(session, request, pageCursor)
    const result = await collectTwitterPages(capability, count, cursor, loader)
    log(`twitter/${capability}: collected ${result.rawItems.length} tweets via CDP`)
    if (cursor === null && result.rawItems.length === 0) {
      const location = await session.evaluate<string>('location.href')
      if (!location.includes('/home')) throw new Error(`logged_out: redirected to ${location}`)
      throw new Error('no tweets collected (page loaded but timeline empty)')
    }
    return result
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

export async function fetchTwitterTimeline(
  capability: TwitterCapability,
  count: number,
  log: (s: string) => void,
): Promise<{ rawItems: unknown[]; fetchedAt: number }> {
  const result = await fetchTwitterPage(capability, count, null, log)
  return { rawItems: result.rawItems.slice(0, count), fetchedAt: result.fetchedAt }
}

function captureTimelineRequest(
  session: CdpSession,
  capability: TwitterCapability,
): { result: () => Promise<{ request: CapturedRequest; payload: unknown }> } {
  const urlMark = TIMELINE_URL_MARK[capability]
  let requestId: string | null = null
  let request: CapturedRequest | null = null
  let payload: unknown
  let error: Error | null = null

  session.on('Network.requestWillBeSent', params => {
    if (requestId !== null) return
    const candidate = params.request as Json | undefined
    if (!candidate) return
    const url = String(candidate?.url ?? '')
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return
    }
    if (
      parsedUrl.origin !== 'https://x.com'
      || !parsedUrl.pathname.startsWith('/i/api/graphql/')
      || !parsedUrl.pathname.endsWith(urlMark)
    ) return
    if (candidate?.method === 'OPTIONS') return
    const headers = Object.fromEntries(
      Object.entries((candidate.headers ?? {}) as Record<string, string>)
        .filter(([name]) => REPLAY_HEADER_NAMES.has(name.toLowerCase())),
    )
    if (!hasHeader(headers, 'authorization')) {
      error = new Error(`twitter ${capability} timeline request is missing replay headers`)
      return
    }
    try {
      if (candidate?.method === 'GET') {
        validateRequestUrl(parsedUrl, capability)
        request = { method: 'GET', url, headers }
      } else if (candidate?.method === 'POST' && typeof candidate.postData === 'string') {
        if (!hasHeader(headers, 'content-type')) {
          error = new Error(`twitter ${capability} POST timeline request is missing content-type`)
          return
        }
        validateRequestBody(candidate.postData, capability)
        request = { method: 'POST', url, postData: candidate.postData, headers }
      } else {
        error = new Error(`twitter ${capability} timeline request uses unsupported method: ${String(candidate?.method)}`)
      }
    } catch (reason) {
      error = reason instanceof Error ? reason : new Error(String(reason))
      return
    }
    requestId = String(params.requestId)
  })

  session.on('Network.loadingFinished', params => {
    if (String(params.requestId) !== requestId || payload !== undefined || error) return
    void session.send<{ body: string; base64Encoded: boolean }>(
      'Network.getResponseBody',
      { requestId },
    ).then(response => {
      const body = response.base64Encoded
        ? Buffer.from(response.body, 'base64').toString('utf8')
        : response.body
      payload = JSON.parse(body) as unknown
    }).catch(reason => {
      error = new Error(`twitter ${capability} timeline response body unavailable: ${errorMessage(reason)}`)
    })
  })

  return {
    async result() {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (error) throw error
        if (request && payload !== undefined) return { request, payload }
        await sleep(500)
      }
      const location = await session.evaluate<string>('location.href')
      if (!location.includes('/home')) throw new Error(`logged_out: redirected to ${location}`)
      throw new Error(`timeout waiting for twitter ${capability} timeline response`)
    },
  }
}

async function replayTimelineRequest(
  session: CdpSession,
  request: CapturedRequest,
  cursor: string,
): Promise<unknown> {
  const replay = replayRequest(request, cursor)
  const response = await session.evaluate<{ status: number; ok: boolean; body: string }>(`(async () => {
    const response = await fetch(${JSON.stringify(replay.url)}, {
      method: ${JSON.stringify(replay.method)},
      credentials: 'include',
      headers: ${JSON.stringify(request.headers)},
      ${replay.body === undefined ? '' : `body: ${JSON.stringify(replay.body)},`}
    })
    return { status: response.status, ok: response.ok, body: await response.text() }
  })()`)
  if (!response.ok) throw new Error(`twitter timeline API failed: http ${response.status}`)
  try {
    return JSON.parse(response.body) as unknown
  } catch {
    throw new Error('twitter timeline API returned invalid JSON')
  }
}

function replayRequest(request: CapturedRequest, cursor: string): { method: 'GET' | 'POST'; url: string; body?: string } {
  if (request.method === 'GET') {
    const url = new URL(request.url)
    const variables = parseJsonParameter(url, 'variables', 'twitter timeline GET variables')
    url.searchParams.set('variables', JSON.stringify({ ...variables, cursor }))
    return { method: 'GET', url: url.toString() }
  }
  const body = JSON.parse(request.postData) as Json
  const variables = asJson(body.variables, 'twitter timeline request variables')
  body.variables = { ...variables, cursor }
  return { method: 'POST', url: request.url, body: JSON.stringify(body) }
}

function validateRequestUrl(url: URL, capability: TwitterCapability): void {
  parseJsonParameter(url, 'variables', `twitter ${capability} timeline GET variables`)
  parseJsonParameter(url, 'features', `twitter ${capability} timeline GET features`)
}

function validateRequestBody(postData: string, capability: TwitterCapability): void {
  let body: unknown
  try {
    body = JSON.parse(postData)
  } catch {
    throw new Error(`twitter ${capability} timeline request body is invalid JSON`)
  }
  const object = asJson(body, `twitter ${capability} timeline request body`)
  asJson(object.variables, `twitter ${capability} timeline request variables`)
  asJson(object.features, `twitter ${capability} timeline request features`)
  if (typeof object.queryId !== 'string' || !object.queryId) {
    throw new Error(`twitter ${capability} timeline request is missing queryId`)
  }
}

function parseJsonParameter(url: URL, name: string, context: string): Json {
  const value = url.searchParams.get(name)
  if (!value) throw new Error(`${context} is missing`)
  try {
    return asJson(JSON.parse(value), context)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${context} is invalid JSON`)
    throw error
  }
}

function extractTimelinePage(payload: unknown, out: Map<string, Json>): string | null {
  const root = asJson(payload, 'twitter timeline payload')
  if (Array.isArray(root.errors) && root.errors.length > 0) throw new Error('twitter timeline payload contains errors')
  const data = asJson(root.data, 'twitter timeline payload.data')
  const home = asJson(data.home, 'twitter timeline payload.data.home')
  const timeline = asJson(home.home_timeline_urt, 'twitter timeline payload.data.home.home_timeline_urt')
  if (!Array.isArray(timeline.instructions)) throw new Error('twitter timeline payload is missing instructions')

  extractTweets(timeline.instructions as Json[], out)
  let bottomCursor: string | null = null
  for (const instruction of timeline.instructions as Json[]) {
    for (const entry of instructionEntries(instruction)) {
      const content = asJson(entry.content, 'twitter timeline entry content')
      if (
        content.entryType === 'TimelineTimelineCursor'
        && content.cursorType === 'Bottom'
        && typeof content.value === 'string'
        && content.value
      ) {
        bottomCursor = content.value
      }
    }
  }
  return bottomCursor
}

function extractTweets(instructions: Json[], out: Map<string, Json>): void {
  for (const instruction of instructions) {
    if (instruction.type !== 'TimelineAddEntries') continue
    for (const entry of instructionEntries(instruction)) {
      const content = asJson(entry.content, 'twitter timeline entry content')
      const items: Json[] = []
      if (content.entryType === 'TimelineTimelineItem') {
        items.push(content)
      } else if (content.entryType === 'TimelineTimelineModule' && Array.isArray(content.items)) {
        for (const item of content.items as Json[]) items.push(asJson(item.item, 'twitter timeline module item'))
      }
      for (const item of items) {
        const itemContent = asJson(item.itemContent, 'twitter timeline item content')
        if (itemContent.itemType !== 'TimelineTweet' || itemContent.promotedMetadata) continue
        const results = asJson(itemContent.tweet_results, 'twitter timeline tweet results')
        const tweet = unwrapTweet(results.result)
        if (!tweet || typeof tweet.rest_id !== 'string') continue
        if (!out.has(tweet.rest_id)) out.set(tweet.rest_id, tweet)
      }
    }
  }
}

function instructionEntries(instruction: Json): Json[] {
  if (Array.isArray(instruction.entries)) return instruction.entries as Json[]
  if (instruction.entry && typeof instruction.entry === 'object') return [instruction.entry as Json]
  return []
}

function unwrapTweet(value: unknown): Json | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as Json
  if (result.__typename === 'TweetWithVisibilityResults') {
    return result.tweet && typeof result.tweet === 'object' ? result.tweet as Json : undefined
  }
  return result
}

function parseCursor(value: string, capability: TwitterCapability): TwitterCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('invalid twitter continuation cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid twitter continuation cursor')
  }
  const cursor = parsed as Record<string, unknown>
  if (
    cursor.version !== 1
    || cursor.capability !== capability
    || typeof cursor.value !== 'string'
    || !cursor.value
  ) {
    throw new Error('invalid twitter continuation cursor')
  }
  return { version: 1, capability, value: cursor.value }
}

function hasHeader(headers: Record<string, string>, wanted: string): boolean {
  return Object.keys(headers).some(name => name.toLowerCase() === wanted)
}

function asJson(value: unknown, context: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Json
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function waitFor(session: CdpSession, expression: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await session.evaluate<boolean>(expression)) return
    } catch {
      /* 导航中 context 销毁，重试 */
    }
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${what}`)
}
