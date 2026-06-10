import { useState } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'
import { SOURCES, createRefreshWindow, useAccounts, useInvalidate, watchRefreshWindow } from '@/api/radar'
import { Sparkles, RefreshCw, Layers, Rss, Settings } from 'lucide-react'

const AUTH_DOT: Record<string, string> = {
  ok: 'bg-green-500',
  logged_out: 'bg-red-500',
  browser_down: 'bg-yellow-500',
  unknown: 'bg-gray-400',
}

export function Sidebar() {
  const { activeSource, setActiveSource, view, setView } = useUIStore()
  const accounts = useAccounts()
  const invalidate = useInvalidate()
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [lastResult, setLastResult] = useState<string | null>(null)

  const authOf = (account: string) =>
    accounts.data?.find(a => a.metadata.name === account)?.status.auth ?? 'unknown'

  const refreshSources = (targets: string[]) => {
    setLastResult(null)
    setRefreshing(prev => new Set([...prev, ...targets]))
    let failed = 0
    let remaining = targets.length
    const finishOne = (source: string) => {
      setRefreshing(prev => {
        const next = new Set(prev)
        next.delete(source)
        return next
      })
      remaining--
      if (remaining <= 0) {
        setLastResult(failed > 0 ? `${failed} 个源失败，详见管理页日志` : '完成')
        invalidate()
      }
    }
    for (const source of targets) {
      createRefreshWindow(source)
        .then(win =>
          watchRefreshWindow(
            win.metadata.name,
            () => {},
            result => {
              if (result.phase === 'Failed') failed++
              finishOne(source)
            },
          ),
        )
        .catch(() => {
          failed++
          finishOne(source)
        })
    }
  }

  const platforms = [
    { platform: 'zhihu' as const, label: '知乎', account: 'zhihu-main' },
    { platform: 'twitter' as const, label: '推特', account: 'twitter-main' },
  ]

  const anyRefreshing = refreshing.size > 0

  return (
    <div className="w-52 border-r bg-muted/30 flex flex-col">
      <div className="p-4 border-b">
        <h1 className="font-semibold text-lg">Radar</h1>
        <p className="text-xs text-muted-foreground">信息雷达</p>
      </div>

      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        <button
          onClick={() => setActiveSource('all')}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors hover:bg-accent',
            view === 'feed' && activeSource === 'all' && 'bg-primary text-primary-foreground hover:bg-primary',
          )}
        >
          <Sparkles className="h-4 w-4" />
          全部
        </button>

        {platforms.map(p => (
          <div key={p.platform} className="space-y-0.5">
            <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-xs text-muted-foreground">
              <span className={cn('w-2 h-2 rounded-full', AUTH_DOT[authOf(p.account)])} title={authOf(p.account)} />
              {p.label}
            </div>
            {SOURCES.filter(s => s.platform === p.platform).map(source => {
              const busy = refreshing.has(source.name)
              return (
                <div key={source.name} className="group flex items-center ml-2">
                  <button
                    onClick={() => setActiveSource(source.name)}
                    className={cn(
                      'flex-1 flex items-center gap-1 px-3 py-1.5 text-sm rounded-md transition-colors hover:bg-accent text-left',
                      view === 'feed' && activeSource === source.name &&
                        'bg-primary text-primary-foreground hover:bg-primary',
                    )}
                  >
                    {source.label.split(' · ')[1]}
                  </button>
                  <button
                    onClick={() => refreshSources([source.name])}
                    disabled={busy}
                    title={`立即刷新 ${source.label}`}
                    className={cn(
                      'p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-opacity',
                      busy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
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
            onClick={() => setView(view === 'windows' ? 'feed' : 'windows')}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors hover:bg-accent',
              view === 'windows' && 'bg-primary text-primary-foreground hover:bg-primary',
            )}
          >
            <Layers className="h-4 w-4" />
            刷新历史
          </button>
          <button
            onClick={() => setView(view === 'admin' ? 'feed' : 'admin')}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors hover:bg-accent',
              view === 'admin' && 'bg-primary text-primary-foreground hover:bg-primary',
            )}
          >
            <Settings className="h-4 w-4" />
            管理
          </button>
        </div>
      </nav>

      <div className="p-3 border-t text-xs text-muted-foreground space-y-2">
        <button
          onClick={() => refreshSources(activeSource === 'all' || view !== 'feed' ? SOURCES.map(s => s.name) : [activeSource])}
          disabled={anyRefreshing}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md border bg-background hover:bg-accent transition-colors disabled:opacity-50 text-foreground"
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
