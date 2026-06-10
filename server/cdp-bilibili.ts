// B 站采集（直连 CDP）：在已登录的 www.bilibili.com 页面上下文调 API。
// - follow:  关注动态流 /x/polymer/web-dynamic/v1/feed/all（offset 翻页）
// - popular: 热门视频 /x/web-interface/popular（页码翻页）
// 视频不做播放采集（设计约定：封面图即可），媒体只取 cover。

import { closeTab, ensureBrowser, openSession, sleep } from './cdp'

export async function fetchBilibiliFeed(
  capability: 'follow' | 'popular',
  count: number,
  log: (s: string) => void,
): Promise<{ rawItems: unknown[]; fetchedAt: number }> {
  if (!(await ensureBrowser(log))) throw new Error('browser_down: CDP unreachable after self-heal')

  const { tab, session } = await openSession('https://www.bilibili.com/')
  try {
    const deadline = Date.now() + 25_000
    let href = ''
    while (Date.now() < deadline) {
      try {
        href = await session.evaluate<string>('location.href')
        if (href.includes('bilibili.com') && (await session.evaluate<boolean>(`document.readyState !== 'loading'`))) break
      } catch {
        /* 导航中重试 */
      }
      await sleep(500)
    }
    if (!href.includes('bilibili.com')) throw new Error(`bilibili page did not load (stuck at ${href || 'about:blank'})`)

    const script =
      capability === 'follow'
        ? `(async () => {
            const out = []
            let offset = ''
            for (let page = 0; page < 20 && out.length < ${count}; page++) {
              const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?timezone_offset=-480&type=all&platform=web' + (offset ? '&offset=' + offset : '')
              const res = await fetch(url, { credentials: 'include' })
              if (!res.ok) return { error: 'http ' + res.status }
              const data = await res.json()
              if (data.code === -101) return { error: 'logged_out' }
              if (data.code !== 0) return { error: 'api code ' + data.code + ' ' + (data.message || '') }
              out.push(...(data.data.items || []))
              offset = data.data.offset
              if (!data.data.has_more) break
              await new Promise(r => setTimeout(r, 800))
            }
            return { items: out }
          })()`
        : `(async () => {
            const out = []
            for (let pn = 1; pn <= 10 && out.length < ${count}; pn++) {
              const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=' + pn, { credentials: 'include' })
              if (!res.ok) return { error: 'http ' + res.status }
              const data = await res.json()
              if (data.code !== 0) return { error: 'api code ' + data.code + ' ' + (data.message || '') }
              out.push(...(data.data.list || []))
              if (data.data.no_more) break
              await new Promise(r => setTimeout(r, 600))
            }
            return { items: out }
          })()`

    const result = await session.evaluate<{ error?: string; items?: unknown[] }>(script, 120_000)
    if (result.error === 'logged_out') throw new Error('logged_out: bilibili dynamic feed requires login')
    if (result.error) throw new Error(`bilibili ${capability} API failed: ${result.error}`)

    const rawItems = (result.items ?? []).slice(0, count)
    log(`bilibili/${capability}: collected ${rawItems.length} items via CDP`)
    if (rawItems.length === 0) throw new Error('no items collected from bilibili API')
    return { rawItems, fetchedAt: Math.floor(Date.now() / 1000) }
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}
