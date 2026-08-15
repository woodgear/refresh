// B 站采集（直连 CDP）：在已登录的 www.bilibili.com 页面上下文调 API。
// - follow:  关注动态流 /x/polymer/web-dynamic/v1/feed/all（offset 翻页）
// - popular: 热门视频 /x/web-interface/popular（页码翻页）
// 视频不做播放采集（设计约定：封面图即可），媒体只取 cover。

import { closeTab, ensureBrowser, openSession, sleep } from './cdp'
import type { FetchPageResult } from './fetcher'

export type BilibiliCapability = 'follow' | 'popular'

interface FollowPage {
  items: unknown[]
  nextOffset: string
  hasMore: boolean
}

interface PopularPage {
  items: unknown[]
  noMore: boolean
}

export interface BilibiliPageLoader {
  follow(offset: string | null): Promise<FollowPage>
  popular(page: number): Promise<PopularPage>
}

type BilibiliCursor =
  | { version: 1; capability: 'follow'; offset: string }
  | { version: 1; capability: 'popular'; page: number }

export async function collectBilibiliPages(
  capability: BilibiliCapability,
  targetCount: number,
  inputCursor: string | null,
  loader: BilibiliPageLoader,
  pause: () => Promise<unknown> = () => sleep(800),
): Promise<FetchPageResult> {
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error(`bilibili target count must be a positive integer: ${targetCount}`)
  }

  let cursor: BilibiliCursor | null = inputCursor === null
    ? initialCursor(capability)
    : parseCursor(inputCursor, capability)
  const rawItems: unknown[] = []
  for (
    let upstreamPage = 0;
    cursor !== null && upstreamPage < 30 && rawItems.length < targetCount;
    upstreamPage++
  ) {
    if (cursor.capability === 'follow') {
      const page = await loader.follow(cursor.offset || null)
      rawItems.push(...page.items)
      if (!page.hasMore) {
        cursor = null
      } else {
        if (!page.nextOffset) throw new Error('bilibili follow page hasMore=true without next offset')
        cursor = { version: 1, capability: 'follow', offset: page.nextOffset }
      }
    } else {
      const page = await loader.popular(cursor.page)
      rawItems.push(...page.items)
      cursor = page.noMore
        ? null
        : { version: 1, capability: 'popular', page: cursor.page + 1 }
    }
    if (cursor !== null && rawItems.length < targetCount) await pause()
  }

  return {
    rawItems,
    nextCursor: cursor === null ? null : JSON.stringify(cursor),
    hasMore: cursor !== null,
    fetchedAt: Math.floor(Date.now() / 1000),
  }
}

export async function fetchBilibiliPage(
  capability: BilibiliCapability,
  count: number,
  cursor: string | null,
  log: (s: string) => void,
): Promise<FetchPageResult> {
  if (!(await ensureBrowser(log))) throw new Error('browser_down: CDP unreachable after self-heal')

  const { tab, session } = await openSession('https://www.bilibili.com/')
  try {
    const deadline = Date.now() + 25_000
    let href = ''
    while (Date.now() < deadline) {
      try {
        href = await session.evaluate<string>('location.href')
        if (href.includes('bilibili.com') && (await session.evaluate<boolean>(`document.readyState !== 'loading'`))) break
      } catch {
        /* 导航中重试 */
      }
      await sleep(500)
    }
    if (!href.includes('bilibili.com')) throw new Error(`bilibili page did not load (stuck at ${href || 'about:blank'})`)

    const loader: BilibiliPageLoader = {
      async follow(offset) {
        const result = await session.evaluate<{
          error?: string
          items?: unknown[]
          nextOffset?: unknown
          hasMore?: unknown
        }>(`(async () => {
          const offset = ${JSON.stringify(offset ?? '')}
          const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?timezone_offset=-480&type=all&platform=web' + (offset ? '&offset=' + encodeURIComponent(offset) : '')
          const res = await fetch(url, { credentials: 'include' })
          if (!res.ok) return { error: 'http ' + res.status }
          const data = await res.json()
          if (data.code === -101) return { error: 'logged_out' }
          if (data.code !== 0) return { error: 'api code ' + data.code + ' ' + (data.message || '') }
          return {
            items: data.data.items || [],
            nextOffset: data.data.offset,
            hasMore: Boolean(data.data.has_more),
          }
        })()`)
        if (result.error === 'logged_out') throw new Error('logged_out: bilibili dynamic feed requires login')
        if (result.error) throw new Error(`bilibili follow API failed: ${result.error}`)
        if (!Array.isArray(result.items)) throw new Error('bilibili follow API returned non-array items')
        const hasMore = result.hasMore === true
        if (hasMore && (typeof result.nextOffset !== 'string' || !result.nextOffset)) {
          throw new Error('bilibili follow API returned has_more without a next offset')
        }
        return {
          items: result.items,
          nextOffset: hasMore ? String(result.nextOffset) : '',
          hasMore,
        }
      },
      async popular(page) {
        const result = await session.evaluate<{
          error?: string
          items?: unknown[]
          noMore?: unknown
        }>(`(async () => {
          const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=' + ${page}, { credentials: 'include' })
          if (!res.ok) return { error: 'http ' + res.status }
          const data = await res.json()
          if (data.code !== 0) return { error: 'api code ' + data.code + ' ' + (data.message || '') }
          return { items: data.data.list || [], noMore: Boolean(data.data.no_more) }
        })()`)
        if (result.error) throw new Error(`bilibili popular API failed: ${result.error}`)
        if (!Array.isArray(result.items)) throw new Error('bilibili popular API returned non-array items')
        return { items: result.items, noMore: result.noMore === true }
      },
    }

    const result = await collectBilibiliPages(
      capability,
      count,
      cursor,
      loader,
      () => sleep(capability === 'follow' ? 800 : 600),
    )
    log(`bilibili/${capability}: collected ${result.rawItems.length} items via CDP`)
    if (cursor === null && result.rawItems.length === 0) throw new Error('no items collected from bilibili API')
    return result
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

export async function fetchBilibiliFeed(
  capability: BilibiliCapability,
  count: number,
  log: (s: string) => void,
): Promise<{ rawItems: unknown[]; fetchedAt: number }> {
  const result = await fetchBilibiliPage(capability, count, null, log)
  return { rawItems: result.rawItems.slice(0, count), fetchedAt: result.fetchedAt }
}

function initialCursor(capability: BilibiliCapability): BilibiliCursor {
  return capability === 'follow'
    ? { version: 1, capability: 'follow', offset: '' }
    : { version: 1, capability: 'popular', page: 1 }
}

function parseCursor(value: string, capability: BilibiliCapability): BilibiliCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('invalid bilibili continuation cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid bilibili continuation cursor')
  }
  const cursor = parsed as Record<string, unknown>
  if (cursor.version !== 1 || cursor.capability !== capability) {
    throw new Error('invalid bilibili continuation cursor')
  }
  if (capability === 'follow' && typeof cursor.offset === 'string' && cursor.offset.length > 0) {
    return { version: 1, capability, offset: cursor.offset }
  }
  if (capability === 'popular' && Number.isInteger(cursor.page) && Number(cursor.page) >= 1) {
    return { version: 1, capability, page: Number(cursor.page) }
  }
  throw new Error('invalid bilibili continuation cursor')
}
