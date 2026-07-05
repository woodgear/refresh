import { useUIStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'
import { SOURCES, useAccounts, useUnreadCounts } from '@/api/radar'
import { useRefreshSources } from '@/hooks/useRefreshSources'
import { Sparkles, RefreshCw, Layers, Rss, Settings, Users } from 'lucide-react'

const AUTH_DOT: Record<string, string> = {
  ok: 'bg-green-500',
  logged_out: 'bg-red-500',
  browser_down: 'bg-yellow-500',
  unknown: 'bg-gray-400',
}

export function Sidebar({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
  const { activeSource, setActiveSource, view, setView } = useUIStore()
  const accounts = useAccounts()
  const unread = useUnreadCounts()
  const { refreshing, lastResult, refreshSources } = useRefreshSources()

  const nav = (fn: () => void) => () => {
    fn()
    onNavigate?.()
  }

  const authOf = (account: string) =>
    accounts.data?.find(a => a.metadata.name === account)?.status.auth ?? 'unknown'

  const anyRefreshing = refreshing.size > 0

  return (
    <div className={cn('flex h-full w-56 flex-col border-r bg-muted/25 md:bg-muted/35', className)}>
      <div className="border-b px-4 py-4">
        <h1 className="text-lg font-semibold leading-6">Refresh</h1>
        <p className="text-xs text-muted-foreground">信息雷达</p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        <button
          onClick={nav(() => setActiveSource('all'))}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-background/80',
            view === 'feed' && activeSource === 'all' && 'bg-background text-foreground shadow-sm ring-1 ring-border',
          )}
        >
          <Sparkles className="h-4 w-4" />
          全部
          {(unread.data?.total ?? 0) > 0 && (
            <span className="ml-auto text-xs tabular-nums opacity-70">{unread.data!.total}</span>
          )}
        </button>

        {platforms.map(p => (
          <div key={p.platform} className="space-y-0.5">
            <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
              <span className={cn('w-2 h-2 rounded-full', AUTH_DOT[authOf(p.account)])} title={authOf(p.account)} />
              {p.label}
            </div>
            {SOURCES.filter(s => s.platform === p.platform).map(source => {
              const busy = refreshing.has(source.name)
              return (
                <div key={source.name} className="group flex items-center ml-2">
                  <button
                    onClick={nav(() => setActiveSource(source.name))}
                    className={cn(
                      'flex flex-1 items-center gap-1 rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-background/80',
                      view === 'feed' && activeSource === source.name &&
                        'bg-background text-foreground shadow-sm ring-1 ring-border',
                    )}
                  >
                    {source.label.split(' · ')[1]}
                    {(unread.data?.sources?.[source.name] ?? 0) > 0 && (
                      <span className="ml-auto rounded-sm bg-foreground/10 px-1.5 py-0.5 text-[11px] tabular-nums text-foreground/80">
                        {unread.data!.sources[source.name]}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => refreshSources([source.name])}
                    disabled={busy}
                    title={`立即刷新 ${source.label}`}
                    className={cn(
                      'rounded p-1.5 text-muted-foreground transition-opacity hover:bg-background/80 hover:text-foreground disabled:opacity-50',
                      // 触屏没有 hover，移动端常显
                      busy ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100',
                    )}
                  >
                    <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} />
                  </button>
                </div>
              )
            })}
          </div>
        ))}

        <div className="pt-2 border-t mt-2 space-y-1">
          <button
            onClick={nav(() => setView(view === 'followees' ? 'feed' : 'followees'))}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-background/80',
              view === 'followees' && 'bg-background text-foreground shadow-sm ring-1 ring-border',
            )}
          >
            <Users className="h-4 w-4" />
            关注列表
          </button>
          <button
            onClick={nav(() => setView(view === 'windows' ? 'feed' : 'windows'))}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-background/80',
              view === 'windows' && 'bg-background text-foreground shadow-sm ring-1 ring-border',
            )}
          >
            <Layers className="h-4 w-4" />
            刷新历史
          </button>
          <button
            onClick={nav(() => setView(view === 'admin' ? 'feed' : 'admin'))}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-background/80',
              view === 'admin' && 'bg-background text-foreground shadow-sm ring-1 ring-border',
            )}
          >
            <Settings className="h-4 w-4" />
            管理
          </button>
        </div>
      </nav>

      <div className="space-y-2 border-t p-3 text-xs text-muted-foreground">
        <button
          onClick={() => refreshSources(activeSource === 'all' || view !== 'feed' ? SOURCES.map(s => s.name) : [activeSource])}
          disabled={anyRefreshing}
          className="flex w-full items-center justify-center gap-2 rounded-md border bg-background px-3 py-2 text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', anyRefreshing && 'animate-spin')} />
          {anyRefreshing ? `抓取中 (${refreshing.size})…` : `刷新${activeSource === 'all' || view !== 'feed' ? '全部' : '当前源'}`}
        </button>
        {lastResult && <p className="px-1">{lastResult}</p>}
        <a
          href={activeSource === 'all' ? '/rss/all.xml' : `/rss/${activeSource}.xml`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-1 hover:text-foreground"
        >
          <Rss className="h-3 w-3" />
          RSS 订阅当前源
        </a>
      </div>
    </div>
  )
}

const platforms = [
  { platform: 'zhihu' as const, label: '知乎', account: 'zhihu-main' },
  { platform: 'twitter' as const, label: '推特', account: 'twitter-main' },
  { platform: 'bilibili' as const, label: 'B站', account: 'bilibili-main' },
]
