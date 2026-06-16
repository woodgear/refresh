// 直连 CDP 的最小客户端（docs/design.md §5）。
// 自管 Chrome：独立 user-data-dir（登录态持久化在 profiles/，与日常浏览器隔离），
// 不可用时自拉起。不依赖 bb-browser。

import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const CDP_HOST = '127.0.0.1'
export const CDP_PORT = parseInt(process.env.RADAR_CDP_PORT ?? '19223', 10)
const PROFILE_DIR = process.env.RADAR_PROFILE_DIR ?? join(__dirname, '..', 'profiles', 'main')
const HTTP_BASE = `http://${CDP_HOST}:${CDP_PORT}`

// ---------- 健康检查与自愈 ----------

export async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${HTTP_BASE}/json/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
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
  if (process.env.RADAR_CHROME_OZONE_PLATFORM !== undefined) return process.env.RADAR_CHROME_OZONE_PLATFORM
  if (process.env.WAYLAND_DISPLAY) return 'wayland'
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir && existsSync(join(runtimeDir, 'wayland-0'))) return 'wayland'
  return ''
}

/** Chrome 不可用时自拉起（有头窗口，扫码登录要用）。返回是否可用。 */
export async function ensureBrowser(log: (s: string) => void = () => {}): Promise<boolean> {
  if (await cdpAlive()) {
    await ensurePageTarget()
    return true
  }
  const executable = process.env.RADAR_CHROME_BIN ?? findChromeExecutable()
  if (!executable) {
    log('no Chrome executable found (set RADAR_CHROME_BIN)')
    return false
  }
  await mkdir(PROFILE_DIR, { recursive: true })
  const ozonePlatform = chromeOzonePlatform()
  log(`launching Chrome (profile=${PROFILE_DIR}, cdp=${CDP_PORT}, ozone=${ozonePlatform || 'default'})`)
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate',
    ...(ozonePlatform ? [`--ozone-platform=${ozonePlatform}`] : []),
    'about:blank',
  ]
  try {
    const child = spawn(executable, chromeArgs, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (err) {
    log(`Chrome launch failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
  for (let i = 0; i < 40; i++) {
    if (await cdpAlive()) {
      await ensurePageTarget()
      log('Chrome up')
      return true
    }
    await sleep(500)
  }
  log('Chrome did not come up within 20s')
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
  const res = await fetch(`${HTTP_BASE}/json`)
  const all = (await res.json()) as (TabInfo & { type: string })[]
  return all.filter(t => t.type === 'page')
}

export async function newTab(url = 'about:blank'): Promise<TabInfo> {
  const res = await fetch(`${HTTP_BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`CDP /json/new failed: ${res.status}`)
  return (await res.json()) as TabInfo
}

export async function closeTab(id: string): Promise<void> {
  await fetch(`${HTTP_BASE}/json/close/${id}`).catch(() => {})
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
  const tab = await newTab(url)
  const session = await CdpSession.connect(tab.webSocketDebuggerUrl)
  return { tab, session }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
