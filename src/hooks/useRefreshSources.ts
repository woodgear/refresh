import { useState } from 'react'
import { createRefreshWindow, useInvalidate, watchRefreshWindow, SOURCES } from '@/api/radar'

export function useRefreshSources() {
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [lastResult, setLastResult] = useState<string | null>(null)
  const invalidate = useInvalidate()

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

  const refreshAll = () => refreshSources(SOURCES.map(s => s.name))

  return { refreshing, lastResult, refreshSources, refreshAll }
}
