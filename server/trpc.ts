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

interface DataItem {
  id: string
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

  for (const file of [...matched].reverse()) {
    const content = await readFile(join(DATA_DIR, file), 'utf-8')
    const data: DataFile = JSON.parse(content)

    if (!type && data.type) {
      type = data.type
    }

    const fetchedAtStr = typeof data.fetchedAt === 'number'
      ? data.fetchedAt.toString()
      : data.fetchedAt

    if (fetchedAtStr && (!latestFetchedAt || fetchedAtStr > latestFetchedAt)) {
      latestFetchedAt = fetchedAtStr
    }

    totalItems += (data.items || []).length

    for (const item of data.items || []) {
      if (item.id && !seenIds.has(item.id)) {
        seenIds.add(item.id)
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

async function scanAllSources() {
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
  // 获取 feed 数据
  feed: publicProcedure
    .input(z.object({ source: z.string() }))
    .query(async ({ input }) => {
      const prefix = input.source.includes('following')
        ? input.source.replace('following', 'following-')
        : input.source.replace('follow', 'follow-')

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
