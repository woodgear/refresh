import { createFileRoute } from '@tanstack/react-router'
import { defaultLayout, useUIStore } from '@/stores/uiStore'
import { MessageCard } from '@/components/MessageCard'
import { AdminPage } from '@/components/AdminPage'
import { FolloweesPage } from '@/components/FolloweesPage'
import {
  markRead,
  setMessageRead,
  useFeedUpdates,
  useMessagesByNames,
  useUnreadCounts,
  useWindows,
  type Message,
  type RefreshWindow,
} from '@/api/radar'
import { Loader2, ChevronLeft, CheckCheck, List, LayoutGrid, RotateCcw, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { Profiler, useEffect, useRef } from 'react'
import { reportPerfEvent } from '@/observability'
import { VirtualizedFeed } from '@/components/VirtualizedFeed'
import { useFeedSession } from '@/hooks/useFeedSession'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const view = useUIStore(s => s.view)
  if (view === 'admin') return <AdminPage />
  if (view === 'followees') return <FolloweesPage />
  return view === 'windows' ? <WindowsPage /> : <FeedPage />
}

/** 本地缓存内就地更新 read 状态（不触发重新排序，阅读中卡片不跳动） */
function useReadActions(onLocal?: (names: string[], read: boolean) => void) {
  const qc = useQueryClient()
  const applyLocal = (names: string[], read: boolean) => {
    const update = (old?: Message[]) =>
      old?.map(m => (names.includes(m.metadata.name) ? { ...m, status: { ...m.status, read } } : m))
    qc.setQueriesData({ queryKey: ['messages'] }, update)
    qc.setQueriesData({ queryKey: ['messages-by-names'] }, update)
    onLocal?.(names, read)
    void qc.invalidateQueries({ queryKey: ['unread-counts'] })
  }
  return {
    toggleRead: (name: string, read: boolean) => {
      applyLocal([name], read)
      void setMessageRead(name, read).catch(() => applyLocal([name], !read))
    },
    batchRead: (names: string[]) => {
      applyLocal(names, true)
      void markRead({ names }).catch(() => {})
    },
  }
}

function FeedPage() {
  const {
    activeSource,
    autoRead,
    layouts,
    feedPositions,
    setAutoRead,
    setLayout,
    setFeedPosition,
  } = useUIStore()
  const layout = layouts[activeSource] ?? defaultLayout(activeSource)
  const feed = useFeedSession(activeSource)
  const updates = useFeedUpdates(feed.session?.metadata.name ?? null)
  const unread = useUnreadCounts()
  const { toggleRead, batchRead } = useReadActions(feed.setRead)
  const qc = useQueryClient()
  const dataReadyAt = useRef(0)

  // 视口自动已读：攒批，每 3 秒上报一次
  const pending = useRef(new Set<string>())
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pending.current.size === 0) return
      const startedAt = performance.now()
      const names = [...pending.current]
      pending.current.clear()
      reportPerfEvent('feed.auto_read_flush', performance.now() - startedAt, { item_count: names.length })
      batchRead(names)
    }, 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleMarkAll = async () => {
    await markRead({ labelSelector: activeSource === 'all' ? '' : `source=${activeSource}` })
    feed.setRead(feed.items.map(message => message.metadata.name), true)
    void qc.invalidateQueries({ queryKey: ['messages'] })
    void qc.invalidateQueries({ queryKey: ['unread-counts'] })
  }

  const unreadCount = activeSource === 'all' ? unread.data?.total : unread.data?.sources?.[activeSource]

  const items = feed.items
  const mediaCount = items.reduce((sum, item) => sum + item.spec.media.length, 0)

  useEffect(() => {
    if (!feed.session) return
    dataReadyAt.current = performance.now()
    reportPerfEvent('feed.messages_data_ready', undefined, {
      active_source: activeSource,
      layout,
      item_count: items.length,
      media_count: mediaCount,
      page_count: feed.session.status.pageCount,
    })
    const first = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        reportPerfEvent('feed.data_to_next_paint', performance.now() - dataReadyAt.current, {
          active_source: activeSource,
          layout,
          item_count: items.length,
          media_count: mediaCount,
        })
      })
    })
    return () => window.cancelAnimationFrame(first)
  }, [activeSource, layout, items.length, mediaCount, feed.session])

  const onFeedRender = (
    id: string,
    phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number,
  ) => {
    reportPerfEvent('react.profiler', actualDuration, {
      profiler_id: id,
      phase,
      base_duration_ms: baseDuration,
      render_start_ms: startTime,
      commit_time_ms: commitTime,
      active_source: activeSource,
      layout,
      item_count: items.length,
      media_count: mediaCount,
    })
  }

  const tail = (
    <div className="mx-auto flex min-h-10 max-w-5xl items-center justify-center gap-2 border-t py-4 text-xs text-muted-foreground">
      {feed.loadingMore && (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          获取更多
        </>
      )}
      {!feed.loadingMore && feed.error && feed.failedAction !== 'initial' && (
        <>
          <span className="max-w-xl truncate text-destructive">{feed.error}</span>
          <button onClick={feed.retry} className="rounded px-2 py-1 text-foreground hover:bg-accent">重试</button>
        </>
      )}
      {!feed.loadingMore && !feed.error && feed.hasMore && (
        <button onClick={() => void feed.loadMore()} className="rounded px-2 py-1 text-foreground hover:bg-accent">
          获取更多
        </button>
      )}
      {!feed.loadingMore && !feed.error && !feed.hasMore && <span>本轮已到底</span>}
    </div>
  )

  return (
    <div className="flex h-full flex-col" data-feed-key={activeSource} data-feed-session={feed.session?.metadata.name ?? ''}>
      <div className="border-b bg-background/95 px-3 py-2 text-xs text-muted-foreground md:px-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="font-medium text-foreground tabular-nums">{unreadCount ?? 0} 未读</span>
            <span className="tabular-nums">位置 {feed.loadedThrough} / {feed.total}</span>
          </div>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            {(updates.data?.count ?? 0) > 0 && (
              <button
                onClick={() => void feed.restart()}
                disabled={feed.restarting}
                className="flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
              >
                <ArrowUp className="h-3.5 w-3.5" />
                {updates.data!.count} 条新内容
              </button>
            )}
            {updates.error && (
              <button onClick={() => void updates.refetch()} className="rounded px-2 py-1 text-destructive hover:bg-accent">
                新内容检查失败
              </button>
            )}
            <label className="flex items-center gap-1 cursor-pointer" title="卡片在视口停留 1.5 秒自动标记已读">
              <input type="checkbox" checked={autoRead} onChange={e => setAutoRead(e.target.checked)} />
              滚动已读
            </label>
            <div className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5" title="布局（按源记忆）">
              <button
                onClick={() => setLayout(activeSource, 'list')}
                className={cn(
                  'rounded-sm p-1 transition-colors',
                  layout === 'list' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground',
                )}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setLayout(activeSource, 'grid')}
                className={cn(
                  'rounded-sm p-1 transition-colors',
                  layout === 'grid' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground',
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              onClick={() => void feed.restart()}
              disabled={feed.restarting || feed.initialLoading}
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
              title="重新开始"
            >
              {feed.restarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">重新开始</span>
            </button>
            <button
              onClick={() => void handleMarkAll()}
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent hover:text-foreground"
              title="全部已读"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">全部已读</span>
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {feed.initialLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        {!feed.initialLoading && feed.failedAction === 'initial' && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm">
            <p className="max-w-2xl text-center text-destructive">{feed.error}</p>
            <button onClick={feed.retry} className="rounded-md border px-3 py-1.5 hover:bg-accent">重试</button>
          </div>
        )}
        {!feed.initialLoading && feed.failedAction !== 'initial' && items.length === 0 && (
          <div className="px-3 py-4 md:px-6 lg:px-8">
            <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 border-y border-dashed py-10 text-center text-sm text-muted-foreground">
              <span>本轮暂无内容</span>
              {feed.hasMore && (
                <button onClick={() => void feed.loadMore()} className="rounded-md border px-3 py-1.5 text-foreground hover:bg-accent">
                  获取更多
                </button>
              )}
            </div>
          </div>
        )}
        {!feed.initialLoading && feed.failedAction !== 'initial' && items.length > 0 && (
          <Profiler id="feed-list" onRender={onFeedRender}>
            <VirtualizedFeed
              key={`${activeSource}:${feed.session?.metadata.name ?? 'loading'}`}
              items={items}
              layout={layout}
              baseOffset={feed.baseOffset}
              onToggleRead={toggleRead}
              onSeen={autoRead ? name => batchRead([name]) : undefined}
              initialAnchor={feedPositions[activeSource]?.messageName}
              onAnchorChange={(messageName, offset) => setFeedPosition(activeSource, { messageName, offset })}
              onEndReached={() => void feed.loadMore()}
              footer={tail}
            />
          </Profiler>
        )}
      </div>
    </div>
  )
}

function WindowsPage() {
  const { selectedWindow, setSelectedWindow } = useUIStore()
  const windows = useWindows()

  if (selectedWindow) {
    return <WindowDetail name={selectedWindow} onBack={() => setSelectedWindow(null)} windows={windows.data ?? []} />
  }

  const items = (windows.data ?? []).slice(0, 100)
  return (
    <div className="h-full overflow-y-auto p-4 max-w-3xl mx-auto">
      <h2 className="font-medium mb-3">刷新历史（每个 window = 平台当时推给你的一批内容）</h2>
      <div className="space-y-1">
        {items.map(w => (
          <button
            key={w.metadata.name}
            onClick={() => setSelectedWindow(w.metadata.name)}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md hover:bg-accent text-left"
          >
            <span
              className={cn(
                'w-2 h-2 rounded-full shrink-0',
                w.status.phase === 'Succeeded' ? 'bg-green-500' : w.status.phase === 'Failed' ? 'bg-red-500' : 'bg-yellow-500 animate-pulse',
              )}
            />
            <span className="font-mono text-xs truncate flex-1">{w.metadata.name}</span>
            <span className="text-xs text-muted-foreground shrink-0">{w.spec.trigger}</span>
            <span className="text-xs text-muted-foreground shrink-0 w-32 text-right">
              {w.status.stats ? `新 ${w.status.stats.new} / 重复 ${w.status.stats.duplicate}` : w.status.error ? '失败' : '…'}
            </span>
          </button>
        ))}
        {items.length === 0 && !windows.isLoading && (
          <div className="text-center text-muted-foreground py-8">还没有刷新记录</div>
        )}
      </div>
    </div>
  )
}

function WindowDetail({ name, onBack, windows }: { name: string; onBack: () => void; windows: RefreshWindow[] }) {
  const win = windows.find(w => w.metadata.name === name)
  const refs = win?.status.messageRefs ?? []
  const messages = useMessagesByNames(refs.length > 0 ? refs : undefined)
  const { toggleRead } = useReadActions()

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 text-sm">
        <button onClick={onBack} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          返回
        </button>
        <span className="font-mono text-xs">{name}</span>
        {win?.status.stats && (
          <span className="text-xs text-muted-foreground ml-auto">
            共 {win.status.stats.fetched} · 新 {win.status.stats.new}
          </span>
        )}
      </div>
      {win?.status.error && <p className="text-destructive text-sm">{win.status.error}</p>}
      {refs.length === 0 && <p className="text-muted-foreground text-sm">该 window 没有记录 messageRefs（可能是迁移的历史档案）</p>}
      {(messages.data ?? []).map(m => (
        <MessageCard key={m.metadata.name} message={m} onToggleRead={toggleRead} />
      ))}
    </div>
  )
}
