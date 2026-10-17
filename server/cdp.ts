// 直连 CDP 的最小客户端（docs/design.md §5）。
// 自管 Chrome：独立 user-data-dir（登录态持久化在 profiles/，与日常浏览器隔离），
// 不可用时自拉起。不依赖 bb-browser。

import { spawn } from 'child_process'
import { mkdir, readlink, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const CDP_HOST = '127.0.0.1'
export const CDP_PORT = parseInt(process.env.RADAR_CDP_PORT ?? '19223', 10)
const PROFILE_DIR = process.env.RADAR_PROFILE_DIR ?? join(__dirname, '..', 'profiles', 'main')
const HTTP_BASE = `http://${CDP_HOST}:${CDP_PORT}`
const PROBE_URL = 'data:text/html,<title>refresh-cdp-probe</title><body>ok</body>'
let launchedBrowserPid: number | null = null

// ---------- 健康检查与自愈 ----------

export async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${HTTP_BASE}/json/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function cdpUsable(): Promise<boolean> {
  if (!(await cdpAlive())) return false
  let tab: TabInfo | null = null
  let session: CdpSession | null = null
  try {
    tab = await newTab('about:blank')
    session = await CdpSession.connect(tab.webSocketDebuggerUrl)
    await navigate(session, PROBE_URL)
    for (let i = 0; i < 10; i++) {
      const href = await session.evaluate<string>('location.href', 1000)
      if (href.startsWith('data:text/html')) return true
      await sleep(100)
    }
    return false
  } catch {
    return false
  } finally {
    session?.close()
    if (tab) await closeTab(tab.id)
  }
}

async function closeBrowser(log: (s: string) => void): Promise<void> {
  try {
    const res = await fetch(`${HTTP_BASE}/json/version`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return
    const version = (await res.json()) as { webSocketDebuggerUrl?: string }
    if (!version.webSocketDebuggerUrl) return
    const session = await CdpSession.connect(version.webSocketDebuggerUrl)
    try {
      await session.send('Browser.close', {}, 3000)
    } finally {
      session.close()
    }
  } catch (err) {
    log(`Chrome close failed: ${err instanceof Error ? err.message : err}`)
  }

  for (let i = 0; i < 20; i++) {
    if (!(await cdpAlive())) return
    await sleep(250)
  }
  await terminateLaunchedBrowser(log, 'Chrome did not exit after Browser.close')
}

function findChromeExecutable(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  return candidates.find(p => existsSync(p)) ?? null
}

function chromeOzonePlatform(): string {
  if (chromeHeadless()) return ''
  if (process.env.RADAR_CHROME_OZONE_PLATFORM !== undefined) return process.env.RADAR_CHROME_OZONE_PLATFORM
  if (process.env.WAYLAND_DISPLAY) return 'wayland'
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir && existsSync(join(runtimeDir, 'wayland-0'))) return 'wayland'
  return ''
}

function chromeEnv(ozonePlatform: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? '/home/cong',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  }
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  if (ozonePlatform === 'wayland' && process.env.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY
  return env
}

function chromeHeadless(): boolean {
  return process.env.RADAR_CHROME_HEADLESS === '1'
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function clearStaleChromeLocks(profileDir: string, log: (s: string) => void): Promise<void> {
  const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
  let lockTarget: string
  try {
    lockTarget = await readlink(join(profileDir, 'SingletonLock'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`read Chrome profile lock failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const match = /-(\d+)$/.exec(lockTarget)
  if (!match) throw new Error(`Chrome profile lock has an invalid target: ${lockTarget}`)
  const pid = Number(match[1])
  if (processAlive(pid)) throw new Error(`Chrome profile is already locked by live pid ${pid}`)
  for (const name of lockNames) {
    try {
      await unlink(join(profileDir, name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`remove stale Chrome profile lock ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  log(`removed stale Chrome profile locks for exited pid ${pid}`)
}

async function terminateLaunchedBrowser(log: (s: string) => void, reason: string): Promise<void> {
  const pid = launchedBrowserPid
  if (!pid) {
    log(reason)
    return
  }
  log(`${reason}; terminating Chrome pid ${pid}`)
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      launchedBrowserPid = null
      return
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!processAlive(pid)) {
      launchedBrowserPid = null
      return
    }
    await sleep(250)
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited.
    }
  }
  launchedBrowserPid = null
}

/** Chrome 不可用时自拉起（有头窗口，扫码登录要用）。返回是否可用。 */
export async function ensureBrowser(log: (s: string) => void = () => {}): Promise<boolean> {
  if (await cdpUsable()) {
    await ensurePageTarget()
    return true
  }
  if (await cdpAlive()) {
    log('Chrome CDP is reachable but page navigation is stuck; restarting Chrome')
    await closeBrowser(log)
  }
  const executable = process.env.RADAR_CHROME_BIN ?? findChromeExecutable()
  if (!executable) {
    log('no Chrome executable found (set RADAR_CHROME_BIN)')
    return false
  }
  await mkdir(PROFILE_DIR, { recursive: true })
  await clearStaleChromeLocks(PROFILE_DIR, log)
  const ozonePlatform = chromeOzonePlatform()
  log(`launching Chrome (profile=${PROFILE_DIR}, cdp=${CDP_PORT}, ozone=${ozonePlatform || 'default'})`)
  const chromeArgs = [
    `--remote-debugging-address=${CDP_HOST}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate',
    ...(chromeHeadless() ? ['--headless=new', '--disable-gpu'] : []),
    ...(ozonePlatform ? [`--ozone-platform=${ozonePlatform}`] : []),
    'about:blank',
  ]
  try {
    const child = spawn(executable, chromeArgs, { detached: true, stdio: 'ignore', env: chromeEnv(ozonePlatform) })
    launchedBrowserPid = child.pid ?? null
    child.on('exit', () => {
      if (launchedBrowserPid === child.pid) launchedBrowserPid = null
    })
    child.unref()
  } catch (err) {
    log(`Chrome launch failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
  for (let i = 0; i < 40; i++) {
    if (await cdpUsable()) {
      await ensurePageTarget()
      log('Chrome up')
      return true
    }
    await sleep(500)
  }
  await terminateLaunchedBrowser(log, 'Chrome did not come up within 20s')
  return false
}

/** Chrome 在但一个页面 target 都没有时（全部 tab 被关），补一个，否则后续操作没有落点 */
async function ensurePageTarget(): Promise<void> {
  try {
    if ((await listTabs()).length === 0) await newTab('about:blank')
  } catch {
    /* 尽力而为 */
  }
}

// ---------- 标签页 ----------

export interface TabInfo {
  id: string
  url: string
  webSocketDebuggerUrl: string
}

export async function listTabs(): Promise<TabInfo[]> {
  const res = await fetch(`${HTTP_BASE}/json`, { signal: AbortSignal.timeout(3000) })
  const all = (await res.json()) as (TabInfo & { type: string })[]
  return all.filter(t => t.type === 'page')
}

export async function newTab(url = 'about:blank'): Promise<TabInfo> {
  const res = await fetch(`${HTTP_BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`CDP /json/new failed: ${res.status}`)
  return (await res.json()) as TabInfo
}

async function navigate(session: CdpSession, url: string): Promise<void> {
  await session.send('Page.enable', {}, 3000)
  await session.send('Page.navigate', { url }, 20_000)
}

export async function closeTab(id: string): Promise<void> {
  await fetch(`${HTTP_BASE}/json/close/${id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {})
}

// ---------- WebSocket 会话 ----------

type EventHandler = (params: Record<string, unknown>) => void

export class CdpSession {
  private ws: WebSocket
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private handlers = new Map<string, Set<EventHandler>>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: unknown
        error?: { message: string }
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        }
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params ?? {})
      }
    })
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${wsUrl}`)), { once: true })
    })
    return new CdpSession(ws)
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  on(method: string, handler: EventHandler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method)!.add(handler)
    return () => this.handlers.get(method)?.delete(handler)
  }

  /** 页面上下文执行 JS（awaitPromise），返回 JSON 序列化结果 */
  async evaluate<T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> {
    const res = await this.send<{
      result: { type: string; value?: unknown; description?: string }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (res.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    }
    return res.result.value as T
  }

  close(): void {
    this.ws.close()
  }
}

/** 开新 tab 并建立会话；用完记得 session.close() + closeTab(tab.id) */
export async function openSession(url: string): Promise<{ tab: TabInfo; session: CdpSession }> {
  const tab = await newTab('about:blank')
  const session = await CdpSession.connect(tab.webSocketDebuggerUrl)
  try {
    await navigate(session, url)
    return { tab, session }
  } catch (err) {
    session.close()
    await closeTab(tab.id)
    throw err
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
