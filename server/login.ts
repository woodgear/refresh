// LoginSession（docs/design.md §4）：把"登录"以最低摩擦递到用户手上。
// QR 模式（知乎）：登录页后台 tab + 二维码区域截图镜像到 radar 页面；
// window 模式（推特）：受管浏览器窗口带到前台，radar 轮询检测。
// 成功后：关 tab → Account.status=ok → 对该账号所有源补抓一轮（post-login RefreshWindow）。

import { randomUUID } from 'crypto'
import { getAccount, SOURCES } from './config'
import { CDP_HOST, CDP_PORT, closeTab, ensureBrowser, newTab, CdpSession } from './cdp'
import { checkAuth } from './auth'
import { createRefreshWindow } from './refresh'
import { accountStatus } from './resources'
import type { Resource } from './store'
import { rlog } from './logger'

const LOGIN_URLS: Record<string, { url: string; mode: 'qr' | 'window'; successWhen: (href: string) => boolean }> = {
  zhihu: {
    url: 'https://www.zhihu.com/signin',
    mode: 'qr',
    // 扫码成功后会离开 /signin 回到首页
    successWhen: href => href.includes('zhihu.com') && !href.includes('/signin'),
  },
  twitter: {
    url: 'https://x.com/i/flow/login',
    mode: 'window',
    successWhen: href => href.includes('x.com/home'),
  },
  bilibili: {
    url: 'https://passport.bilibili.com/login',
    mode: 'qr',
    // 扫码成功后离开 passport 回到主站
    successWhen: href => href.includes('bilibili.com') && !href.includes('passport.'),
  },
}

interface LoginSessionState {
  id: string
  account: string
  platform: string
  mode: 'qr' | 'window'
  phase: 'Pending' | 'WaitingScan' | 'WaitingUser' | 'Succeeded' | 'Failed' | 'Expired'
  createdAt: string
  error: string | null
  tabId?: string
  session?: CdpSession
  postLoginFired?: boolean
}

const sessions = new Map<string, LoginSessionState>()
const SESSION_TTL_MS = 10 * 60 * 1000

export async function createLoginSession(accountName: string): Promise<Resource> {
  const account = getAccount(accountName)
  if (!account) throw new Error(`unknown account: ${accountName}`)
  const conf = LOGIN_URLS[account.platform]
  if (!conf) throw new Error(`no login flow for platform ${account.platform}`)

  const state: LoginSessionState = {
    id: `login-${accountName}-${randomUUID().slice(0, 8)}`,
    account: accountName,
    platform: account.platform,
    mode: conf.mode,
    phase: 'Pending',
    createdAt: new Date().toISOString(),
    error: null,
  }
  sessions.set(state.id, state)

  if (process.env.RADAR_AUTH_MOCK === 'logged_out') {
    // mock：不开浏览器，第 3 次轮询起视为成功（调 UI 流程）
    state.phase = conf.mode === 'qr' ? 'WaitingScan' : 'WaitingUser'
    return toResource(state)
  }

  if (!(await ensureBrowser())) {
    state.phase = 'Failed'
    state.error = 'browser_down: CDP unreachable'
    return toResource(state)
  }

  const tab = await newTab(conf.url)
  state.tabId = tab.id
  state.session = await CdpSession.connect(tab.webSocketDebuggerUrl)
  state.phase = conf.mode === 'qr' ? 'WaitingScan' : 'WaitingUser'
  if (conf.mode === 'window') {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${tab.id}`).catch(() => {})
  }
  return toResource(state)
}

let mockPollCount = 0

/** 轮询：检查登录 tab 的去向；成功则收尾（关 tab、刷状态、补抓） */
export async function pollLoginSession(id: string): Promise<Resource | null> {
  const state = sessions.get(id)
  if (!state) return null

  if (['Succeeded', 'Failed', 'Expired'].includes(state.phase)) return toResource(state)

  if (Date.now() - new Date(state.createdAt).getTime() > SESSION_TTL_MS) {
    state.phase = 'Expired'
    await cleanup(state)
    return toResource(state)
  }

  if (process.env.RADAR_AUTH_MOCK === 'logged_out') {
    mockPollCount++
    if (mockPollCount >= 3) {
      state.phase = 'Succeeded'
      accountStatus.set(state.account, { auth: 'ok', lastChecked: new Date().toISOString(), detail: 'mock login' })
      firePostLogin(state)
    }
    return toResource(state)
  }

  try {
    const href = await state.session!.evaluate<string>('location.href', 10_000)
    const conf = LOGIN_URLS[state.platform]
    if (conf.successWhen(href)) {
      state.phase = 'Succeeded'
      await cleanup(state)
      // 后台刷新 Account.status（带 userInfo）
      void checkAuth(state.account)
      accountStatus.set(state.account, { auth: 'ok', lastChecked: new Date().toISOString() })
      firePostLogin(state)
    }
  } catch (err) {
    // tab 被手动关掉等场景：再确认一次真实登录态
    const auth = await checkAuth(state.account)
    if (auth.auth === 'ok') {
      state.phase = 'Succeeded'
      firePostLogin(state)
    } else {
      state.phase = 'Failed'
      state.error = `login tab lost: ${err instanceof Error ? err.message : err}`
    }
    await cleanup(state)
  }
  return toResource(state)
}

/** 二维码子资源：对登录页二维码区域截图（每次调用现截，镜像页面状态） */
export async function loginSessionQr(id: string): Promise<Buffer | null> {
  const state = sessions.get(id)
  if (!state || state.mode !== 'qr' || !['WaitingScan', 'Pending'].includes(state.phase)) return null

  if (process.env.RADAR_AUTH_MOCK === 'logged_out') return PLACEHOLDER_PNG

  const session = state.session
  if (!session) return null
  // 找二维码元素：知乎登录页的 .Qrcode-img；兜底找视口内方形 img/canvas
  const rect = await session.evaluate<{ x: number; y: number; width: number; height: number } | null>(`(() => {
    const candidates = [
      ...document.querySelectorAll('.Qrcode-img, .Qrcode-container img, canvas'),
      ...document.querySelectorAll('img'),
    ]
    for (const el of candidates) {
      const r = el.getBoundingClientRect()
      if (r.width >= 100 && r.width <= 400 && Math.abs(r.width - r.height) < 30 && r.top >= 0) {
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
    }
    return null
  })()`)
  if (!rect) return null
  const pad = 8
  const shot = await session.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 2 },
  })
  return Buffer.from(shot.data, 'base64')
}

export function listLoginSessions(): Resource[] {
  return [...sessions.values()].map(toResource)
}

function firePostLogin(state: LoginSessionState): void {
  if (state.postLoginFired) return
  state.postLoginFired = true
  for (const source of SOURCES.filter(s => s.account === state.account)) {
    try {
      createRefreshWindow({ source: source.name, trigger: 'post-login' })
    } catch (err) {
      rlog('login', `post-login refresh failed for ${source.name}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

async function cleanup(state: LoginSessionState): Promise<void> {
  state.session?.close()
  state.session = undefined
  if (state.tabId) {
    await closeTab(state.tabId)
    state.tabId = undefined
  }
}

function toResource(state: LoginSessionState): Resource {
  return {
    apiVersion: 'radar/v1',
    kind: 'LoginSession',
    metadata: { name: state.id, creationTimestamp: state.createdAt, labels: { account: state.account, platform: state.platform } },
    spec: { account: state.account, mode: state.mode },
    status: { phase: state.phase, error: state.error },
  }
}

// 1x1 灰色 PNG，mock 模式下当二维码占位
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
