import { useEffect } from 'react'

/**
 * 部署后自动重载页面。
 *
 * SPA 一旦加载，跑的永远是它加载那一刻的 bundle；服务端更新之后，用户会一直对着
 * 旧代码撞已经修好的 bug —— 只能靠人手动硬刷新。这里轮询 /api/v1/version，
 * 发现服务端的构建号和自己不一致就重载。
 *
 * 时机上不粗暴：页面不可见（切到别的标签）时直接刷；正在看的时候先等一会儿，
 * 用户停手 20 秒后再刷，避免正在读的内容被打断。dev 模式（服务端返回 dev）不启用。
 */
const CHECK_INTERVAL_MS = 60_000
const IDLE_BEFORE_RELOAD_MS = 20_000

function currentBundleId(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[src*="index-"]')
  const matched = script?.src.match(/index-([A-Za-z0-9_-]+)\.js/)
  return matched ? matched[1] : null
}

export function useBuildWatcher(): void {
  useEffect(() => {
    const mine = currentBundleId()
    if (!mine) return

    let pending: string | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const reload = () => {
      pending = null
      window.location.reload()
    }

    const scheduleIdleReload = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (pending) reload()
      }, IDLE_BEFORE_RELOAD_MS)
    }

    const check = async () => {
      try {
        const res = await fetch('/api/v1/version', { cache: 'no-store' })
        if (!res.ok) return
        const { build } = (await res.json()) as { build?: string }
        if (!build || build === 'dev' || build === mine) return
        pending = build
        if (document.visibilityState === 'hidden') reload()
        else scheduleIdleReload()
      } catch {
        // 网络抖动不影响阅读
      }
    }

    const timer = setInterval(check, CHECK_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'hidden' && pending) reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    // 用户有动作就把「空闲重载」往后推
    const bump = () => {
      if (pending) scheduleIdleReload()
    }
    window.addEventListener('scroll', bump, { passive: true })
    window.addEventListener('keydown', bump)

    return () => {
      clearInterval(timer)
      if (idleTimer) clearTimeout(idleTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('scroll', bump)
      window.removeEventListener('keydown', bump)
    }
  }, [])
}
