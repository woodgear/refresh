// LoginSession（docs/design.md §4）：把"登录"以最低摩擦递到用户手上。
// - qr 模式（知乎/B站）：登录页二维码区域截图镜像到网页，扫码即可；
// - password 模式（推特，无扫码）：交互式凭据中继——服务端检测登录页当前要填什么字段，
//   报给网页；用户在 refresh 上填，服务端经 CDP 代填+提交，再检测下一步。
//   不硬编码完整流程，因此 2FA/邮箱验证码等后续挑战都能自然走通。
// 成功后：关 tab → Account.status=ok → 对该账号所有源补抓一轮（post-login RefreshWindow）。

import { randomUUID } from 'crypto'
import { getAccount, SOURCES } from './config'
import { closeTab, ensureBrowser, openSession, CdpSession } from './cdp'
import { checkAuth } from './auth'
import { createRefreshWindow } from './refresh'
import { accountStatus } from './resources'
import type { Resource } from './store'
import { rlog } from './logger'

type LoginMode = 'qr' | 'password'

const LOGIN_CONF: Record<string, { url: string; mode: LoginMode; successWhen: (href: string) => boolean }> = {
  zhihu: {
    url: 'https://www.zhihu.com/signin',
    mode: 'qr',
    successWhen: href => href.includes('zhihu.com') && !href.includes('/signin'),
  },
  twitter: {
    url: 'https://x.com/i/flow/login',
    mode: 'password',
    successWhen: href => {
      const url = new URL(href)
      return url.hostname === 'x.com' && url.pathname === '/home'
    },
  },
  bilibili: {
    url: 'https://passport.bilibili.com/login',
    mode: 'qr',
    successWhen: href => href.includes('bilibili.com') && !href.includes('passport.'),
  },
}

/** 网页需要用户填的一步（一个或多个字段） */
export interface Challenge {
  fields: { name: string; label: string; kind: 'text' | 'password' }[]
  note?: string
}

interface LoginSessionState {
  id: string
  account: string
  platform: string
  mode: LoginMode
  phase: 'Pending' | 'WaitingScan' | 'WaitingInput' | 'Submitting' | 'Succeeded' | 'Failed' | 'Expired'
  createdAt: string
  error: string | null
  challenge: Challenge | null
  lastSignature: string | null // 上一步挑战的字段签名，用于判断"提交后是否进入新步骤"
  mockPollCount: number
  tabId?: string
  session?: CdpSession
  postLoginFired?: boolean
}

const sessions = new Map<string, LoginSessionState>()
const SESSION_TTL_MS = 10 * 60 * 1000

export async function createLoginSession(accountName: string): Promise<Resource> {
  const account = getAccount(accountName)
  if (!account) throw new Error(`unknown account: ${accountName}`)
  const conf = LOGIN_CONF[account.platform]
  if (!conf) throw new Error(`no login flow for platform ${account.platform}`)

  const state: LoginSessionState = {
    id: `login-${accountName}-${randomUUID().slice(0, 8)}`,
    account: accountName,
    platform: account.platform,
    mode: conf.mode,
    phase: 'Pending',
    createdAt: new Date().toISOString(),
    error: null,
    challenge: null,
    lastSignature: null,
    mockPollCount: 0,
  }
  sessions.set(state.id, state)

  if (process.env.RADAR_AUTH_MOCK === 'logged_out') {
    state.phase = conf.mode === 'qr' ? 'WaitingScan' : 'WaitingInput'
    if (conf.mode === 'password') {
      state.challenge = { fields: [
        { name: 'username_or_email', label: '用户名 / 邮箱 / 手机号', kind: 'text' },
      ] }
      state.lastSignature = 'username_or_email:text'
    }
    return toResource(state)
  }

  if (!(await ensureBrowser())) {
    state.phase = 'Failed'
    state.error = 'browser_down: Chrome unavailable'
    return toResource(state)
  }

  try {
    const { tab, session } = await openSession(conf.url)
    state.tabId = tab.id
    state.session = session
  } catch (err) {
    state.phase = 'Failed'
    state.error = `login page navigation failed: ${err instanceof Error ? err.message : err}`
    return toResource(state)
  }

  if (conf.mode === 'qr') {
    state.phase = 'WaitingScan'
  } else {
    // password：等页面就绪后检测第一步挑战
    await detectAndSetChallenge(state)
  }
  return toResource(state)
}

/** 轮询：qr 看 tab 去向；password 看是否已登录（提交后 UI 继续轮询）；成功则收尾 */
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
    state.mockPollCount++
    if (state.mode === 'qr' && state.mockPollCount >= 3) {
      await succeed(state)
    }
    return toResource(state)
  }

  try {
    const href = await state.session!.evaluate<string>('location.href', 10_000)
    if (LOGIN_CONF[state.platform].successWhen(href) || (await isLoggedIn(state))) {
      await succeed(state)
    } else if (state.mode === 'password' && state.phase !== 'Submitting') {
      await detectAndSetChallenge(state, true)
    }
  } catch (err) {
    const auth = await checkAuth(state.account)
    if (auth.auth === 'ok') await succeed(state)
    else {
      state.phase = 'Failed'
      state.error = `login tab lost: ${err instanceof Error ? err.message : err}`
      await cleanup(state)
    }
  }
  return toResource(state)
}

/** password 模式：网页提交一步的字段值 → 代填 + 提交 → 检测下一步 */
export async function submitLoginInput(id: string, values: Record<string, string>): Promise<Resource | null> {
  const state = sessions.get(id)
  if (!state) return null
  if (state.mode !== 'password') throw new Error('not a password login session')
  if (!['WaitingInput', 'Submitting'].includes(state.phase)) return toResource(state)

  const missing = (state.challenge?.fields ?? []).filter(f => !values[f.name]?.trim()).map(f => f.label)
  if (missing.length > 0) throw new Error(`missing login input: ${missing.join(', ')}`)

  if (process.env.RADAR_AUTH_MOCK === 'logged_out') {
    if (state.challenge?.fields.some(f => f.name === 'username_or_email')) {
      state.phase = 'WaitingInput'
      state.challenge = { fields: [{ name: 'password', label: '密码', kind: 'password' }] }
      state.lastSignature = 'password:password'
      state.error = null
    } else if (state.challenge?.fields.some(f => f.name === 'password')) {
      await succeed(state)
    } else {
      state.phase = 'WaitingInput'
      state.error = 'mock login challenge is not recognized'
    }
    return toResource(state)
  }

  const session = state.session
  if (!session) {
    state.phase = 'Failed'
    state.error = 'no browser session'
    return toResource(state)
  }

  state.phase = 'Submitting'
  state.error = null
  try {
    await fillAndSubmit(session, values)
    // 等页面响应（导航/下一步渲染/校验报错）
    for (let i = 0; i < 12; i++) {
      await sleep(1000)
      if (await isLoggedIn(state)) {
        await succeed(state)
        return toResource(state)
      }
      const err = await pageError(session)
      if (err) {
        state.phase = 'WaitingInput'
        state.error = err
        await detectAndSetChallenge(state, true)
        return toResource(state)
      }
      const sig = await challengeSignature(session)
      if (sig && sig !== state.lastSignature) {
        // 进入了新的一步（2FA / 验证码等）
        state.phase = 'WaitingInput'
        await detectAndSetChallenge(state)
        return toResource(state)
      }
    }
    // 既没登录成功也没明显报错：回到等待，让用户重试或补充
    state.phase = 'WaitingInput'
    await detectAndSetChallenge(state)
  } catch (err) {
    state.phase = 'WaitingInput'
    state.error = err instanceof Error ? err.message : String(err)
  }
  return toResource(state)
}

// ---------- 挑战检测 / 代填提交（推特 DOM） ----------

interface DomChallenge {
  fields: Challenge['fields']
  signature: string
  note?: string
}

/** 当前可见登录输入框的签名，用于判断步骤是否变化 */
async function challengeSignature(session: CdpSession): Promise<string | null> {
  const snapshot = await loginChallengeSnapshot(session).catch(() => null)
  return snapshot?.signature || null
}

async function detectAndSetChallenge(state: LoginSessionState, keepError = false): Promise<void> {
  const session = state.session!
  let snapshot: DomChallenge = { fields: [], signature: '' }
  let lastError: unknown = null
  for (let i = 0; i < 16; i++) {
    try {
      snapshot = await loginChallengeSnapshot(session)
      if (snapshot.fields.length > 0) break
    } catch (err) {
      lastError = err
    }
    await sleep(800)
  }
  state.phase = 'WaitingInput'
  if (snapshot.fields.length === 0) {
    state.challenge = { fields: [], note: '未在登录页找到输入框，可能流程有变；可尝试稍后重试' }
    state.lastSignature = null
    if (!keepError) state.error = lastError instanceof Error ? lastError.message : state.challenge.note ?? null
    return
  }
  state.challenge = { fields: snapshot.fields, note: snapshot.note }
  state.lastSignature = snapshot.signature
  if (!keepError) state.error = null
}

async function fillAndSubmit(session: CdpSession, values: Record<string, string>): Promise<void> {
  const ok = await session.evaluate<boolean>(`(() => {
    ${LOGIN_DOM_HELPERS}
    const setNative = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const values = ${JSON.stringify(values)}
    const fields = collectLoginFields()
    let filledAny = false
    let lastEl = null
    for (const field of fields) {
      const val = values[field.name]
      if (val === undefined) continue
      field.el.focus()
      setNative(field.el, val)
      lastEl = field.el
      filledAny = true
    }
    if (!filledAny) return false

    const scope = lastEl.closest('form') || loginRoot()
    const target = findSubmitTarget(scope)
    if (target) {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      target.click()
      return true
    }
    if (lastEl) {
      lastEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
      lastEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
      lastEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    }
    return true
  })()`)
  if (!ok) throw new Error('找不到要填的输入框（登录页结构可能已变）')
}

/** 登录页上的报错文案（用户名/密码错误等） */
async function pageError(session: CdpSession): Promise<string | null> {
  return session
    .evaluate<string | null>(`(() => {
      ${LOGIN_DOM_HELPERS}
      const ERROR_RE = /(错误|不正确|无法登录|找不到|无效|incorrect|wrong|invalid|too many|not found|couldn'?t|could not|doesn'?t exist|active X account|try again|something went wrong|problem)/i
      const hits = [...loginRoot().querySelectorAll('[role=alert],[aria-live],p,span,div')]
        .filter(isVisibleElement)
        .map(el => ({ text: norm(el.textContent), area: areaOf(el) }))
        .filter(x => x.text.length > 0 && x.text.length <= 160 && ERROR_RE.test(x.text))
        .sort((a, b) => a.text.length - b.text.length || a.area - b.area)
      return hits[0] ? hits[0].text : null
    })()`)
    .catch(() => null)
}

async function loginChallengeSnapshot(session: CdpSession): Promise<DomChallenge> {
  return session.evaluate<DomChallenge>(`(() => {
    ${LOGIN_DOM_HELPERS}
    const fields = collectLoginFields().map(({ name, label, kind }) => ({ name, label, kind }))
    return {
      fields,
      signature: fields.map(f => f.name + ':' + f.kind + ':' + f.label).join('|'),
    }
  })()`)
}

const LOGIN_DOM_HELPERS = String.raw`
function norm(v) {
  return (v || '').replace(/\s+/g, ' ').trim()
}

function areaOf(el) {
  const r = el.getBoundingClientRect()
  return Math.max(0, r.width) * Math.max(0, r.height)
}

function isVisibleElement(el) {
  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  return r.width >= 4 && r.height >= 4 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') > 0.05
}

function loginRoot() {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    .filter(isVisibleElement)
    .sort((a, b) => areaOf(a) - areaOf(b))
  return dialogs[0] || document
}

function isUsableInput(el) {
  if (!isVisibleElement(el)) return false
  if (el.disabled || el.readOnly) return false
  if (el.getAttribute('aria-hidden') === 'true') return false
  const s = getComputedStyle(el)
  if (s.pointerEvents === 'none') return false
  const t = (el.type || 'text').toLowerCase()
  if (['hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes(t)) return false
  const text = norm([el.placeholder, el.name, el.id, el.getAttribute('aria-label')].join(' ')).toLowerCase()
  if (text.includes('search') || text.includes('搜索')) return false
  return true
}

function labelFor(el) {
  const closest = el.closest('label')
  if (closest) return norm(closest.innerText)
  if (el.id) {
    const explicit = [...document.querySelectorAll('label[for]')].find(l => l.htmlFor === el.id)
    if (explicit) return norm(explicit.innerText)
  }
  return norm(el.getAttribute('aria-label') || el.placeholder || '')
}

function fieldBase(el, label, index) {
  const type = (el.type || 'text').toLowerCase()
  const haystack = norm([el.name, el.id, el.autocomplete, el.getAttribute('inputmode'), label].join(' ')).toLowerCase()
  if (type === 'password' || /password|密码/.test(haystack)) return 'password'
  if (/one-time-code|verification|authenticat|confirmation|2fa|mfa|code|验证码|验证|代码|口令/.test(haystack)) return 'verification_code'
  if (/username|email|phone|user name|用户名|邮箱|电子邮箱|手机号|手机/.test(haystack)) return 'username_or_email'
  return norm(el.name || el.id || type || ('field_' + index)).replace(/[^a-zA-Z0-9_:-]+/g, '_') || ('field_' + index)
}

function fallbackLabel(base, kind) {
  if (base === 'username_or_email') return '用户名 / 邮箱 / 手机号'
  if (base === 'password' || kind === 'password') return '密码'
  if (base === 'verification_code') return '验证码 / 验证信息'
  return '登录信息'
}

function collectLoginFields() {
  let root = loginRoot()
  let inputs = [...root.querySelectorAll('input,textarea')].filter(isUsableInput)
  if (inputs.length === 0 && root !== document) inputs = [...document.querySelectorAll('input,textarea')].filter(isUsableInput)

  const active = document.activeElement
  if (active && inputs.includes(active)) {
    const form = active.closest('form')
    if (form) inputs = inputs.filter(el => form.contains(el))
  }

  const firstForm = inputs[0] && inputs[0].closest('form')
  if (firstForm && inputs.some(el => el.closest('form') !== firstForm)) {
    inputs = inputs.filter(el => el.closest('form') === firstForm)
  }

  const seen = new Map()
  return inputs.map((el, index) => {
    const kind = ((el.type || 'text').toLowerCase() === 'password') ? 'password' : 'text'
    const rawLabel = labelFor(el)
    const base = fieldBase(el, rawLabel, index)
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    const name = n === 0 ? base : base + '_' + (n + 1)
    return { el, name, label: rawLabel || fallbackLabel(base, kind), kind }
  })
}

function findSubmitTarget(scope) {
  const SUBMIT_RE = /^(登录|登入|log ?in|sign ?in|下一步|next|继续|continue|确定|verify|验证|提交|submit)$/i
  const SKIP_RE = /(apple|google|手机|phone|忘记|forgot|注册|sign ?up|创建)/i
  const usable = el => isVisibleElement(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
  const textOf = el => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.textContent)
  const standard = [...scope.querySelectorAll('button,[role=button],input[type=submit]')]
    .filter(usable)
    .map(el => ({ el, text: textOf(el), area: areaOf(el) }))
    .filter(x => SUBMIT_RE.test(x.text) && !SKIP_RE.test(x.text))
    .sort((a, b) => b.area - a.area)
  if (standard[0]) return standard[0].el

  const textBlocks = [...scope.querySelectorAll('div,span,p')]
    .filter(usable)
    .map(el => ({ el, text: textOf(el), area: areaOf(el) }))
    .filter(x => x.area >= 100 && SUBMIT_RE.test(x.text) && !SKIP_RE.test(x.text))
    .sort((a, b) => b.area - a.area)
  return textBlocks[0] ? textBlocks[0].el : null
}
`

async function isLoggedIn(state: LoginSessionState): Promise<boolean> {
  const href = await state.session!.evaluate<string>('location.href').catch(() => '')
  if (href && LOGIN_CONF[state.platform].successWhen(href)) return true
  // 兜底：直接问真实 auth（推特登录后会跳 /home）
  if (href.includes('x.com/home')) return true
  return false
}

// ---------- 二维码（qr 模式，不变） ----------

export async function loginSessionQr(id: string): Promise<Buffer | null> {
  const state = sessions.get(id)
  if (!state || state.mode !== 'qr' || !['WaitingScan', 'Pending'].includes(state.phase)) return null
  if (process.env.RADAR_AUTH_MOCK === 'logged_out') return PLACEHOLDER_PNG
  const session = state.session
  if (!session) return null
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

// ---------- 收尾 ----------

async function succeed(state: LoginSessionState): Promise<void> {
  state.phase = 'Succeeded'
  state.challenge = null
  await cleanup(state)
  void checkAuth(state.account)
  accountStatus.set(state.account, { auth: 'ok', lastChecked: new Date().toISOString() })
  firePostLogin(state)
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
    status: { phase: state.phase, error: state.error, challenge: state.challenge },
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
