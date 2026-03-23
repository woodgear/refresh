import { create } from 'zustand'
import { trpcClient } from '@/trpc/client'
import { FEED_SOURCES } from '@/types'

interface ItemStore {
  // State
  items: Map<string, any>
  ids: string[]
  fetchedAt: string | null
  isLoading: boolean
  error: Error | null

  // Actions
  refresh: (sourceOrCategory: string) => Promise<void>
  getMissingIds: (ids: string[]) => string[]
}

export const useItemStore = create<ItemStore>((set, get) => ({
  items: new Map(),
  ids: [],
  fetchedAt: null,
  isLoading: false,
  error: null,

  refresh: async (sourceOrCategory: string) => {
    set({ isLoading: true, error: null })

    try {
      // 判断是分类还是单个源
      const isCategory = sourceOrCategory === 'follow' || sourceOrCategory === 'recommend'
      const sources = isCategory
        ? FEED_SOURCES[sourceOrCategory].map((s: { id: string }) => s.id)
        : [sourceOrCategory]

      // 1. 并行获取所有源的 ID 列表
      const listResults = await Promise.all(
        sources.map((source: string) => trpcClient.feedList.query({ source }))
      )

      // 2. 合并去重 ID 列表
      const seenIds = new Set<string>()
      const allIds: string[] = []
      let latestFetchedAt: string | null = null

      for (const result of listResults) {
        if (!result?.ids) continue
        if (result.fetchedAt && (!latestFetchedAt || result.fetchedAt > latestFetchedAt)) {
          latestFetchedAt = result.fetchedAt
        }
        for (const id of result.ids) {
          if (!seenIds.has(id)) {
            seenIds.add(id)
            allIds.push(id)
          }
        }
      }

      // 3. 更新 IDs
      set({ ids: allIds, fetchedAt: latestFetchedAt })

      // 4. 找出缺失的 IDs 并批量获取
      const { items } = get()
      const missingIds = allIds.filter(id => !items.has(id))

      if (missingIds.length > 0) {
        const itemsResult = await trpcClient.items.query({ ids: missingIds })
        if (itemsResult?.items) {
          set((state) => {
            const newMap = new Map(state.items)
            for (const item of itemsResult.items) {
              newMap.set(item.id, item)
            }
            return { items: newMap }
          })
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err : new Error(String(err)) })
    } finally {
      set({ isLoading: false })
    }
  },

  getMissingIds: (ids) => {
    const { items } = get()
    return ids.filter(id => !items.has(id))
  },
}))
