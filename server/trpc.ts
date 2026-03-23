import { initTRPC } from '@trpc/server'
import { readdir, readFile, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const t = initTRPC.create()

export const router = t.router
export const publicProcedure = t.procedure

const DATA_DIR = join(__dirname, '..', 'data')

// 将 source 转换为文件前缀
function getPrefix(source: string): string {
  if (source.includes('following')) {
    return source.replace('following', 'following-')
  }
  return source.replace('follow', 'follow-')
}

interface DataItem {
  id: string
  firstFetchedAt?: string  // 首次抓取时间 (server 添加)
  created_time?: number    // 原生创建时间 (知乎)
  created_at?: string      // 原生创建时间 (Twitter)
  [key: string]: unknown
}

interface DataFile {
  count: number
  items: DataItem[]
  type?: string
  fetchedAt?: string | number | null
}

interface FeedCache {
  count: number
  items: DataItem[]
  type?: string
  fetchedAt: string | null
  sources: number
}

interface SourceMeta {
  files: string[]
  fileCount: number
  totalItems: number
  uniqueItems: number
  latestFetchedAt: string | null
  lastScannedAt: string
}

// 缓存
const cache: Record<string, FeedCache> = {}
const metaCache: Record<string, SourceMeta> = {}
let lastScanTime: string = new Date().toISOString()

async function loadMergedData(prefix: string): Promise<FeedCache> {
  const files = await readdir(DATA_DIR)
  // 按文件名升序排列（旧文件在前，新文件在后）
  const matched = files
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()

  if (matched.length === 0) {
    return { count: 0, items: [], fetchedAt: null, sources: 0 }
  }

  const seenIds = new Set<string>()
  const mergedItems: DataItem[] = []
  let type: string | undefined
  let latestFetchedAt: string | null = null
  let totalItems = 0

  // 按时间从旧到新遍历，这样 firstFetchedAt 会是该条目首次出现的时间
  for (const file of matched) {
    const content = await readFile(join(DATA_DIR, file), 'utf-8')
    const data: DataFile = JSON.parse(content)

    if (!type && data.type) {
      type = data.type
    }

    // 获取 fetchedAt：优先用文件内的，否则从文件名提取时间戳
    let fetchedAtStr: string | null = null
    if (data.fetchedAt) {
      fetchedAtStr = typeof data.fetchedAt === 'number'
        ? data.fetchedAt.toString()
        : data.fetchedAt
    } else {
      // 从文件名提取时间戳: twitter-following-1774187540.json
      const tsMatch = file.match(/-(\d{10})\.json$/)
      if (tsMatch) {
        fetchedAtStr = tsMatch[1]
      }
    }

    if (fetchedAtStr && (!latestFetchedAt || fetchedAtStr > latestFetchedAt)) {
      latestFetchedAt = fetchedAtStr
    }

    totalItems += (data.items || []).length

    for (const item of data.items || []) {
      if (item.id && !seenIds.has(item.id)) {
        seenIds.add(item.id)
        // 记录首次抓取时间
        if (fetchedAtStr) {
          item.firstFetchedAt = fetchedAtStr
        }
        mergedItems.push(item)
      }
    }
  }

  metaCache[prefix] = {
    files: matched,
    fileCount: matched.length,
    totalItems,
    uniqueItems: mergedItems.length,
    latestFetchedAt,
    lastScannedAt: new Date().toISOString()
  }

  return {
    count: mergedItems.length,
    items: mergedItems,
    type,
    fetchedAt: latestFetchedAt,
    sources: matched.length
  }
}

async function getAllFilesInfo(): Promise<{ file: string; size: number; mtime: string }[]> {
  const files = await readdir(DATA_DIR)
  const infos = await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .map(async f => {
        const s = await stat(join(DATA_DIR, f))
        return { file: f, size: s.size, mtime: s.mtime.toISOString() }
      })
  )
  return infos.sort((a, b) => a.file.localeCompare(b.file))
}

export async function scanAllSources() {
  const sources = ['twitter-following-', 'twitter-recommend-', 'zhihu-follow-', 'zhihu-recommend-']
  await Promise.all(sources.map(async (s) => {
    cache[s] = await loadMergedData(s)
  }))
  lastScanTime = new Date().toISOString()
  console.log(`[${new Date().toISOString()}] Scanned all sources`)
}

// 初始扫描
scanAllSources()

// 定时扫描 (60秒)
setInterval(scanAllSources, 60000)

export const appRouter = router({
  // 获取 feed ID 列表（已排序）
  feedList: publicProcedure
    .input(z.object({ source: z.string() }))
    .query(async ({ input }) => {
      const prefix = getPrefix(input.source)
      if (!cache[prefix]) {
        cache[prefix] = await loadMergedData(prefix)
      }

      // 按时间排序：优先用原生创建时间，否则用首次抓取时间
      const getSortTime = (item: DataItem): number => {
        if (item.created_time) return item.created_time * 1000
        if (item.created_at) return new Date(item.created_at as string).getTime()
        if (item.firstFetchedAt) {
          const ts = parseInt(item.firstFetchedAt)
          return ts < 1e12 ? ts * 1000 : ts
        }
        return 0
      }

      const sortedItems = [...cache[prefix].items].sort((a, b) => getSortTime(b) - getSortTime(a))

      return {
        ids: sortedItems.map(item => item.id),
        type: cache[prefix].type,
        fetchedAt: cache[prefix].fetchedAt,
      }
    }),

  // 批量获取 items 详情（全局查找）
  items: publicProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .query(async ({ input }) => {
      // 确保所有源都已加载
      const allSources = ['twitter-following-', 'twitter-recommend-', 'zhihu-follow-', 'zhihu-recommend-']
      await Promise.all(allSources.map(async (prefix) => {
        if (!cache[prefix]) {
          cache[prefix] = await loadMergedData(prefix)
        }
      }))

      // 从所有源中查找 items
      const itemMap = new Map<string, DataItem>()
      for (const prefix of allSources) {
        for (const item of cache[prefix]?.items || []) {
          if (!itemMap.has(item.id)) {
            itemMap.set(item.id, item)
          }
        }
      }

      const items = input.ids
        .map(id => itemMap.get(id))
        .filter((item): item is DataItem => item !== undefined)

      return { items }
    }),

  // 兼容旧接口
  feed: publicProcedure
    .input(z.object({ source: z.string() }))
    .query(async ({ input }) => {
      const prefix = getPrefix(input.source)
      if (!cache[prefix]) {
        cache[prefix] = await loadMergedData(prefix)
      }
      return cache[prefix]
    }),

  // 获取 meta 信息
  meta: publicProcedure.query(async () => {
    const files = await getAllFilesInfo()
    return {
      lastScanTime,
      scanInterval: 60000,
      sources: {
        'twitter-following': metaCache['twitter-following-'],
        'twitter-recommend': metaCache['twitter-recommend-'],
        'zhihu-follow': metaCache['zhihu-follow-'],
        'zhihu-recommend': metaCache['zhihu-recommend-']
      },
      files
    }
  }),

  // 手动刷新
  refresh: publicProcedure.mutation(async () => {
    await scanAllSources()
    return { success: true, lastScanTime }
  })
})

export type AppRouter = typeof appRouter
