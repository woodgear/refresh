import { createFileRoute } from '@tanstack/react-router'
import { defaultLayout, useUIStore } from '@/stores/uiStore'
import { MessageCard } from '@/components/MessageCard'
import { AdminPage } from '@/components/AdminPage'
import {
  markRead,
  setMessageRead,
  useMessages,
  useMessagesByNames,
  useUnreadCounts,
  useWindows,
  type Message,
  type RefreshWindow,
} from '@/api/radar'
import { Loader2, ChevronLeft, CheckCheck, List, LayoutGrid } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const view = useUIStore(s => s.view)
  if (view === 'admin') return <AdminPage />
  return view === 'windows' ? <WindowsPage /> : <FeedPage />
}

/** 本地缓存内就地更新 read 状态（不触发重新排序，阅读中卡片不跳动） */
function useReadActions() {
  const qc = useQueryClient()
  const applyLocal = (names: string[], read: boolean) => {
    const update = (old?: Message[]) =>
      old?.map(m => (names.includes(m.metadata.name) ? { ...m, status: { ...m.status, read } } : m))
    qc.setQueriesData({ queryKey: ['messages'] }, update)
    qc.setQueriesData({ queryKey: ['messages-by-names'] }, update)
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
  const { activeSource, sortMode, unreadOnly, autoRead, layouts, setSortMode, setUnreadOnly, setAutoRead, setLayout } =
    useUIStore()
  const layout = layouts[activeSource] ?? defaultLayout(activeSource)
  const messages = useMessages(activeSource, { sort: sortMode, unreadOnly })
  const unread = useUnreadCounts()
  const { toggleRead, batchRead } = useReadActions()
  const qc = useQueryClient()

  // 视口自动已读：攒批，每 3 秒上报一次
  const pending = useRef(new Set<string>())
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pending.current.size === 0) return
      const names = [...pending.current]
      pending.current.clear()
      batchRead(names)
    }, 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleMarkAll = async () => {
    await markRead({ labelSelector: activeSource === 'all' ? '' : `source=${activeSource}` })
    void qc.invalidateQueries({ queryKey: ['messages'] })
    void qc.invalidateQueries({ queryKey: ['unread-counts'] })
  }

  const unreadCount = activeSource === 'all' ? unread.data?.total : unread.data?.sources?.[activeSource]

  const items = messages.data ?? []
  return (
    <div className="h-full flex flex-col">
      <div className="border-b px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground bg-background">
        <span className="font-medium text-foreground">{unreadCount ?? 0} 未读</span>
        <div className="flex items-center gap-1">
          {(['unread-first', 'time'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setSortMode(mode)}
              className={cn(
                'px-2 py-0.5 rounded',
                sortMode === mode ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
              )}
            >
              {mode === 'unread-first' ? '未读优先' : '按时间'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={unreadOnly} onChange={e => setUnreadOnly(e.target.checked)} />
          只看未读
        </label>
        <label className="flex items-center gap-1 cursor-pointer" title="卡片在视口停留 1.5 秒自动标记已读">
          <input type="checkbox" checked={autoRead} onChange={e => setAutoRead(e.target.checked)} />
          滚动已读
        </label>
        <div className="flex items-center gap-0.5" title="布局（按源记忆）">
          <button
            onClick={() => setLayout(activeSource, 'list')}
            className={cn('p-1 rounded', layout === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
          >
            <List className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setLayout(activeSource, 'grid')}
            className={cn('p-1 rounded', layout === 'grid' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          onClick={() => void handleMarkAll()}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          全部已读
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        {messages.error && (
          <p className="text-center text-destructive py-8">加载失败: {(messages.error as Error).message}</p>
        )}
        <div className={cn(layout === 'grid' ? 'max-w-6xl mx-auto columns-2 xl:columns-3 gap-4' : 'max-w-2xl mx-auto space-y-4')}>
          {items.map(m => (
            <MessageCard
              key={m.metadata.name}
              message={m}
              layout={layout}
              onToggleRead={toggleRead}
              onSeen={autoRead ? name => pending.current.add(name) : undefined}
            />
          ))}
          {!messages.isLoading && items.length === 0 && (
            <div className="text-center text-muted-foreground py-8">
              {unreadOnly ? '没有未读内容 🎉' : '暂无内容，点左下角刷新抓一轮'}
            </div>
          )}
        </div>
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
