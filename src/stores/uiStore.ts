import { create } from 'zustand'
import type { FeedSource, FeedCategory } from '@/types'

interface UIState {
  activeSource: FeedSource
  activeCategory: FeedCategory
  setActiveSource: (source: FeedSource) => void
  setActiveCategory: (category: FeedCategory) => void
}

export const useUIStore = create<UIState>((set) => ({
  activeSource: 'follow',
  activeCategory: 'follow',
  setActiveSource: (source) => set({ activeSource: source }),
  setActiveCategory: (category) => set({ activeSource: category, activeCategory: category }),
}))
