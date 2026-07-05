import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIStore {
  /** 'all' 或 source name */
  activeSource: string
  view: 'feed' | 'windows' | 'followees' | 'admin'
  /** windows 视图中选中的 window */
  selectedWindow: string | null
  /** 阅读偏好（localStorage 持久化） */
  sortMode: 'time' | 'unread-first'
  unreadOnly: boolean
  autoRead: boolean
  /** 每个源的布局偏好；未设置时 B 站默认网格、其他默认单列 */
  layouts: Record<string, 'list' | 'grid'>
  setActiveSource: (source: string) => void
  setView: (view: 'feed' | 'windows' | 'followees' | 'admin') => void
  setSelectedWindow: (name: string | null) => void
  setSortMode: (mode: 'time' | 'unread-first') => void
  setUnreadOnly: (v: boolean) => void
  setAutoRead: (v: boolean) => void
  setLayout: (source: string, mode: 'list' | 'grid') => void
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
      sortMode: 'unread-first',
      unreadOnly: false,
      autoRead: true,
      layouts: {},
      setActiveSource: source => set({ activeSource: source, view: 'feed' }),
      setView: view => set({ view }),
      setSelectedWindow: name => set({ selectedWindow: name }),
      setSortMode: sortMode => set({ sortMode }),
      setUnreadOnly: unreadOnly => set({ unreadOnly }),
      setAutoRead: autoRead => set({ autoRead }),
      setLayout: (source, mode) => set(s => ({ layouts: { ...s.layouts, [source]: mode } })),
    }),
    {
      name: 'radar-ui',
      partialize: s => ({
        activeSource: s.activeSource,
        sortMode: s.sortMode,
        unreadOnly: s.unreadOnly,
        autoRead: s.autoRead,
        layouts: s.layouts,
      }),
    },
  ),
)
