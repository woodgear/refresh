// 登录态检测（docs/design.md §4）：browser_down 自愈，logged_out 标记并引导。
// RADAR_AUTH_MOCK=logged_out 可强制所有账号登出（调 UI 流程用，A5 真实验收前的开关）。

import { getAccount } from './config'
import { closeTab, ensureBrowser, openSession, sleep } from './cdp'
import { accountStatus } from './resources'

export type AuthState = 'ok' | 'logged_out' | 'browser_down' | 'unknown'

export interface AuthResult {
  auth: AuthState
  lastChecked: string
  userInfo?: Record<string, unknown> | null
  detail?: string
}

export async function checkAuth(accountName: string, log: (s: string) => void = () => {}): Promise<AuthResult> {
  const account = getAccount(accountName)
  const finish = (r: Omit<AuthResult, 'lastChecked'>): AuthResult => {
    const result = { ...r, lastChecked: new Date().toISOString() }
    accountStatus.set(accountName, result as unknown as Record<string, unknown>)
    return result
  }

  if (!account) return finish({ auth: 'unknown', detail: 'unknown account' })

  if (process.env.RADAR_AUTH_MOCK === 'logged_out') {
    return finish({ auth: 'logged_out', detail: 'mocked by RADAR_AUTH_MOCK' })
  }

  if (!(await ensureBrowser(log))) {
    return finish({ auth: 'browser_down', detail: 'CDP unreachable after self-heal' })
  }

  try {
    if (account.platform === 'zhihu') return finish(await checkZhihu())
    if (account.platform === 'twitter') return finish(await checkTwitter())
    return finish({ auth: 'unknown', detail: `no checker for platform ${account.platform}` })
  } catch (err) {
    return finish({ auth: 'unknown', detail: err instanceof Error ? err.message : String(err) })
  }
}

async function checkZhihu(): Promise<Omit<AuthResult, 'lastChecked'>> {
  const { tab, session } = await openSession('https://www.zhihu.com/')
  try {
    await waitForHost(session, 'zhihu.com')
    const res = await session.evaluate<{ status: number; me?: Record<string, unknown> }>(
      `fetch('/api/v4/me', { credentials: 'include' }).then(async r => ({
        status: r.status,
        me: r.ok ? await r.json() : undefined,
      }))`,
      20_000,
    )
    if (res.status === 200 && res.me) {
      return { auth: 'ok', userInfo: { name: res.me.name, url_token: res.me.url_token } }
    }
    return { auth: 'logged_out', detail: `/api/v4/me ${res.status}` }
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

async function checkTwitter(): Promise<Omit<AuthResult, 'lastChecked'>> {
  const { tab, session } = await openSession('https://x.com/home')
  try {
    // 登出时 /home 会被重定向到落地页或 login flow；给重定向留时间
    let href = ''
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try {
        href = await session.evaluate<string>('location.href')
        if (href.includes('x.com')) {
          await sleep(2500) // 等可能的客户端重定向
          href = await session.evaluate<string>('location.href')
          break
        }
      } catch {
        /* 导航中 */
      }
      await sleep(500)
    }
    if (href.includes('/home')) return { auth: 'ok' }
    if (!href.includes('x.com')) return { auth: 'unknown', detail: `page stuck at ${href || 'about:blank'}` }
    return { auth: 'logged_out', detail: `redirected to ${href}` }
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

async function waitForHost(session: { evaluate<T>(e: string, t?: number): Promise<T> }, host: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const href = await session.evaluate<string>('location.href')
      if (href.includes(host)) return
    } catch {
      /* 导航中 */
    }
    await sleep(500)
  }
  throw new Error(`navigation to ${host} timed out`)
}
