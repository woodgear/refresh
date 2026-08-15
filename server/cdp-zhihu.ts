// 知乎采集（直连 CDP）：在已登录的 www.zhihu.com 页面上下文里调 topstory API，
// 拿到含封面图、完整 excerpt、作者结构的原始 feed item（docs/design.md §5）。

import { closeTab, ensureBrowser, openSession, sleep } from './cdp'
import type { FetchPageResult } from './fetcher'

export type ZhihuCapability = 'recommend' | 'follow'

interface ZhihuApiPage {
  items: unknown[]
  nextUrl: string | null
  isEnd: boolean
}

export type ZhihuPageLoader = (url: string) => Promise<ZhihuApiPage>

interface ZhihuCursor {
  version: 1
  capability: ZhihuCapability
  url: string
}

const INITIAL_URL: Record<ZhihuCapability, string> = {
  recommend: '/api/v3/feed/topstory/recommend?desktop=true&limit=6',
  follow: '/api/v3/moments?limit=10&desktop=true',
}

const PATHNAME: Record<ZhihuCapability, string> = {
  recommend: '/api/v3/feed/topstory/recommend',
  follow: '/api/v3/moments',
}

export async function collectZhihuPages(
  capability: ZhihuCapability,
  targetCount: number,
  inputCursor: string | null,
  loader: ZhihuPageLoader,
  pause: () => Promise<unknown> = () => sleep(800),
): Promise<FetchPageResult> {
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error(`zhihu target count must be a positive integer: ${targetCount}`)
  }

  let url: string | null = inputCursor === null
    ? INITIAL_URL[capability]
    : parseCursor(inputCursor, capability).url
  const rawItems: unknown[] = []
  for (
    let upstreamPage = 0;
    url !== null && upstreamPage < 30 && rawItems.length < targetCount;
    upstreamPage++
  ) {
    const page = await loader(url)
    rawItems.push(...expandFeedItems(page.items))
    if (page.isEnd) {
      url = null
    } else {
      if (!page.nextUrl) throw new Error(`zhihu ${capability} page is not terminal but has no next URL`)
      url = normalizeContinuationUrl(page.nextUrl, capability)
    }
    if (url !== null && rawItems.length < targetCount) await pause()
  }

  const cursor: ZhihuCursor | null = url === null
    ? null
    : { version: 1, capability, url }
  return {
    rawItems,
    nextCursor: cursor === null ? null : JSON.stringify(cursor),
    hasMore: cursor !== null,
    fetchedAt: Math.floor(Date.now() / 1000),
  }
}

export async function fetchZhihuPage(
  capability: ZhihuCapability,
  count: number,
  cursor: string | null,
  log: (s: string) => void,
): Promise<FetchPageResult> {
  if (!(await ensureBrowser(log))) throw new Error('browser_down: CDP unreachable after self-heal')

  const { tab, session } = await openSession('https://www.zhihu.com/')
  try {
    // about:blank 也可能 ready，必须等 hostname 进入知乎；登出时会跳到 /signin。
    const deadline = Date.now() + 25_000
    let href = ''
    while (Date.now() < deadline) {
      try {
        href = await session.evaluate<string>('location.href')
        if (href.includes('zhihu.com') && (await session.evaluate<boolean>(`document.readyState !== 'loading'`))) break
      } catch {
        /* 导航中重试 */
      }
      await sleep(500)
    }
    if (!href.includes('zhihu.com')) throw new Error(`zhihu page did not load (stuck at ${href || 'about:blank'})`)
    if (href.includes('/signin')) throw new Error(`logged_out: redirected to ${href}`)

    const loader: ZhihuPageLoader = async url => {
      const result = await session.evaluate<{
        error?: string
        status?: number
        items?: unknown
        nextUrl?: unknown
        isEnd?: unknown
      }>(`(async () => {
        const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' })
        if (res.status === 401 || res.status === 403) return { error: 'logged_out', status: res.status }
        if (!res.ok) return { error: 'http ' + res.status, status: res.status }
        const data = await res.json()
        return {
          items: data.data,
          nextUrl: data.paging && data.paging.next,
          isEnd: Boolean(data.paging && data.paging.is_end),
        }
      })()`)
      if (result.error === 'logged_out') throw new Error(`logged_out: topstory API ${result.status}`)
      if (result.error) throw new Error(`zhihu feed API failed: ${result.error}`)
      if (!Array.isArray(result.items)) throw new Error('zhihu feed API returned non-array items')
      if (result.nextUrl !== undefined && result.nextUrl !== null && typeof result.nextUrl !== 'string') {
        throw new Error('zhihu feed API returned a non-string next URL')
      }
      return {
        items: result.items,
        nextUrl: typeof result.nextUrl === 'string' ? result.nextUrl : null,
        isEnd: result.isEnd === true,
      }
    }

    const result = await collectZhihuPages(capability, count, cursor, loader)
    log(`zhihu/${capability}: collected ${result.rawItems.length} items via CDP`)
    if (cursor === null && result.rawItems.length === 0) throw new Error('no items collected from zhihu feed API')
    return result
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

export async function fetchZhihuFeed(
  capability: ZhihuCapability,
  count: number,
  log: (s: string) => void,
): Promise<{ rawItems: unknown[]; fetchedAt: number }> {
  const result = await fetchZhihuPage(capability, count, null, log)
  return { rawItems: result.rawItems.slice(0, count), fetchedAt: result.fetchedAt }
}

function expandFeedItems(items: unknown[]): unknown[] {
  const expanded: unknown[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const feed = item as Record<string, unknown>
    if (feed.type === 'feed_advert') continue
    if (feed.type === 'feed_group' && Array.isArray(feed.list)) {
      expanded.push(...feed.list)
    } else {
      expanded.push(item)
    }
  }
  return expanded
}

function parseCursor(value: string, capability: ZhihuCapability): ZhihuCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('invalid zhihu continuation cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid zhihu continuation cursor')
  }
  const cursor = parsed as Record<string, unknown>
  if (cursor.version !== 1 || cursor.capability !== capability || typeof cursor.url !== 'string') {
    throw new Error('invalid zhihu continuation cursor')
  }
  return { version: 1, capability, url: normalizeContinuationUrl(cursor.url, capability) }
}

function normalizeContinuationUrl(value: string, capability: ZhihuCapability): string {
  let url: URL
  try {
    url = new URL(value, 'https://www.zhihu.com')
  } catch {
    throw new Error('invalid zhihu continuation URL')
  }
  if (url.origin !== 'https://www.zhihu.com' || url.pathname !== PATHNAME[capability]) {
    throw new Error('invalid zhihu continuation URL')
  }
  return `${url.pathname}${url.search}`
}
