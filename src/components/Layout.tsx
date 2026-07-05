import { ReactNode, useState } from 'react'
import { Menu, RefreshCw } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { LoginBanner } from './LoginBanner'
import { useUnreadCounts } from '@/api/radar'
import { useRefreshSources } from '@/hooks/useRefreshSources'
import { useUIStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'
import { SOURCES } from '@/api/radar'

interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const unread = useUnreadCounts()
  const { refreshing, refreshSources } = useRefreshSources()
  const { activeSource, view } = useUIStore()

  const anyRefreshing = refreshing.size > 0

  const handleRefresh = () => {
    const targets = activeSource === 'all' || view !== 'feed'
      ? SOURCES.map(s => s.name)
      : [activeSource]
    refreshSources(targets)
  }

  return (
    <div className="flex h-[100dvh] flex-col md:flex-row">
      {/* 移动端顶栏（md 以上隐藏） */}
      <header className="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-2.5 md:hidden">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="菜单"
          className="rounded-sm p-1 -ml-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="font-semibold">Refresh</h1>
        {(unread.data?.total ?? 0) > 0 && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{unread.data!.total} 未读</span>
        )}
        <button
          onClick={handleRefresh}
          disabled={anyRefreshing}
          aria-label="刷新"
          className="rounded-sm p-1 -mr-1 hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <RefreshCw className={cn('h-5 w-5', anyRefreshing && 'animate-spin')} />
        </button>
      </header>

      {/* 桌面侧栏 */}
      <div className="hidden md:flex h-full">
        <Sidebar />
      </div>

      {/* 移动端抽屉 */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden animate-[fade-in_200ms_ease-out]" onClick={() => setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="absolute left-0 top-0 h-full shadow-xl animate-[slide-in-left_300ms_ease-out]"
            onClick={e => e.stopPropagation()}
          >
            <Sidebar onNavigate={() => setDrawerOpen(false)} className="w-72 bg-background border-r-0" />
          </div>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/15">
        <LoginBanner />
        <div className="flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  )
}
