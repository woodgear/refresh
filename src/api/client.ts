import type { FeedSource, Message, TwitterMessage, ZhihuMessage } from '@/types'

const API_BASE = '/api'

interface ZhihuRawItem {
  id: string
  title: string
  excerpt: string
  url: string
  type: string
  meta: {
    actor_name: string
    voteup_count: number
    comment_count: number
  }
}

interface TwitterRawItem {
  id: string
  author: string
  url: string
  text: string
  type: string
  likes: number
  retweets: number
  replies: number
  views: number
}

interface RawResponse {
  count: number
  items: ZhihuRawItem[] | TwitterRawItem[]
  fetchedAt?: number
  sources?: number
}

export interface FeedResult {
  messages: Message[]
  fetchedAt: number | null
  sources: number
}

export interface SourceMeta {
  files: string[]
  fileCount: number
  totalItems: number
  uniqueItems: number
  latestFetchedAt: string | null
  lastScannedAt: string
}

export interface MetaResponse {
  lastScanTime: string
  scanInterval: number
  sources: Record<string, SourceMeta | undefined>
  files: { file: string; size: number; mtime: string }[]
}

export async function fetchFeed(source: FeedSource): Promise<FeedResult> {
  const [platform, type] = source.split('-')

  const response = await fetch(`${API_BASE}/${platform}/${type}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${source}: ${response.statusText}`)
  }

  const data: RawResponse = await response.json()

  if (!data.items || !Array.isArray(data.items)) {
    return { messages: [], fetchedAt: data.fetchedAt || null, sources: data.sources || 0 }
  }

  const messages = data.items.map((item) => {
    if (platform === 'zhihu') {
      const zhihuItem = item as ZhihuRawItem
      return {
        type: 'zhihu' as const,
        id: zhihuItem.id,
        title: zhihuItem.title,
        excerpt: zhihuItem.excerpt,
        url: zhihuItem.url,
        author: { name: zhihuItem.meta?.actor_name || '未知' },
        stats: {
          voteup_count: zhihuItem.meta?.voteup_count || 0,
          comment_count: zhihuItem.meta?.comment_count || 0,
        },
      } satisfies ZhihuMessage
    } else {
      const twitterItem = item as TwitterRawItem
      return {
        type: 'twitter' as const,
        id: twitterItem.id,
        author: twitterItem.author,
        url: twitterItem.url,
        text: twitterItem.text,
        likes: twitterItem.likes || 0,
        retweets: twitterItem.retweets || 0,
        views: twitterItem.views || 0,
      } satisfies TwitterMessage
    }
  })

  return { messages, fetchedAt: data.fetchedAt || null, sources: data.sources || 0 }
}

export async function fetchMeta(): Promise<MetaResponse> {
  const response = await fetch(`${API_BASE}/meta`)
  if (!response.ok) {
    throw new Error(`Failed to fetch meta: ${response.statusText}`)
  }
  return response.json()
}
