import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIStore {
  /** 'all' 或 source name */
  activeSource: string
  view: 'feed' | 'windows' | 'followees' | 'admin'
  /** windows 视图中选中的 window */
  selectedWindow: string | null
  /** 阅读偏好（localStorage 持久化） */
  autoRead: boolean
  /** 每个源的布局偏好；未设置时 B 站默认网格、其他默认单列 */
  layouts: Record<string, 'list' | 'grid'>
  feedSessions: Record<string, string>
  feedPositions: Record<string, { messageName: string; offset: number }>
  setActiveSource: (source: string) => void
  setView: (view: 'feed' | 'windows' | 'followees' | 'admin') => void
  setSelectedWindow: (name: string | null) => void
  setAutoRead: (v: boolean) => void
  setLayout: (source: string, mode: 'list' | 'grid') => void
  setFeedSession: (feedKey: string, name: string) => void
  setFeedPosition: (feedKey: string, position: { messageName: string; offset: number } | null) => void
}

export function defaultLayout(source: string): 'list' | 'grid' {
  return source.startsWith('bilibili') ? 'grid' : 'list'
}

export const useUIStore = create<UIStore>()(
  persist(
    set => ({
      activeSource: 'all',
      view: 'feed',
      selectedWindow: null,
      autoRead: true,
      layouts: {},
      feedSessions: {},
      feedPositions: {},
      setActiveSource: source => set({ activeSource: source, view: 'feed' }),
      setView: view => set({ view }),
      setSelectedWindow: name => set({ selectedWindow: name }),
      setAutoRead: autoRead => set({ autoRead }),
      setLayout: (source, mode) => set(s => ({ layouts: { ...s.layouts, [source]: mode } })),
      setFeedSession: (feedKey, name) => set(s => ({ feedSessions: { ...s.feedSessions, [feedKey]: name } })),
      setFeedPosition: (feedKey, position) => set(s => {
        const feedPositions = { ...s.feedPositions }
        if (position === null) delete feedPositions[feedKey]
        else feedPositions[feedKey] = position
        return { feedPositions }
      }),
    }),
    {
      name: 'radar-ui',
      partialize: s => ({
        activeSource: s.activeSource,
        autoRead: s.autoRead,
        layouts: s.layouts,
        feedSessions: s.feedSessions,
        feedPositions: s.feedPositions,
      }),
    },
  ),
)
