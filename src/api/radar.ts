// radar REST API 客户端 + react-query hooks（tRPC 已退役，docs/design.md §3）

import { useQuery, useQueryClient } from '@tanstack/react-query'

// ---------- 资源类型（与 server 信封对应） ----------

export interface ResourceMeta {
  name: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  creationTimestamp?: string
}

export interface MediaRef {
  type: 'image' | 'video'
  originUrl: string
  url: string | null
  playUrl?: string
  width?: number
  height?: number
}

export interface MessageSpec {
  title?: string
  text?: string
  url?: string
  author?: { ref?: string | null; name?: string; handle?: string; avatar?: string | null }
  media: MediaRef[]
  stats?: Record<string, number>
  refs?: { quoted?: string | null; replyTo?: string | null; replyToHandle?: string }
  quotedSnapshot?: { id: string | null; author: string | null; text: string | null }
  retweetedBy?: string
  content: string | null
}

export interface Message {
  apiVersion: string
  kind: 'Message'
  metadata: ResourceMeta
  spec: MessageSpec
  status: { hydrated: boolean; [k: string]: unknown }
}

export interface Account {
  kind: 'Account'
  metadata: ResourceMeta
  spec: { platform: string; displayName: string }
  status: { auth?: 'ok' | 'logged_out' | 'browser_down' | 'unknown'; lastChecked?: string; userInfo?: Record<string, unknown> }
}

export interface RefreshWindow {
  kind: 'RefreshWindow'
  metadata: ResourceMeta
  spec: { source: string; account: string; count: number; trigger: string }
  status: {
    phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed'
    stats?: { new: number; duplicate: number; fetched: number } | null
    messageRefs?: string[]
    error?: string | null
  }
}

export interface LoginSession {
  kind: 'LoginSession'
  metadata: ResourceMeta
  spec: { account: string; mode: 'qr' | 'window' }
  status: { phase: string; error: string | null }
}

// ---------- 静态源注册表（与 server/config.ts 对应） ----------

export interface SourceInfo {
  name: string
  account: string
  platform: 'zhihu' | 'twitter'
  label: string
}

export const SOURCES: SourceInfo[] = [
  { name: 'zhihu-main-recommend', account: 'zhihu-main', platform: 'zhihu', label: '知乎 · 推荐' },
  { name: 'zhihu-main-follow', account: 'zhihu-main', platform: 'zhihu', label: '知乎 · 关注' },
  { name: 'twitter-main-recommend', account: 'twitter-main', platform: 'twitter', label: '推特 · 推荐' },
  { name: 'twitter-main-following', account: 'twitter-main', platform: 'twitter', label: '推特 · 关注' },
]

// ---------- fetch 封装 ----------

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text().catch(() => '')}`)
  return res.json() as Promise<T>
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text().catch(() => '')}`)
  return res.json() as Promise<T>
}

// ---------- hooks ----------

export function useMessages(source: string) {
  return useQuery({
    queryKey: ['messages', source],
    queryFn: () =>
      getJson<{ items: Message[] }>(
        source === 'all'
          ? '/api/v1/messages?limit=200'
          : `/api/v1/messages?labelSelector=source=${source}&limit=200`,
      ).then(r => r.items),
  })
}

export function useMessagesByNames(names: string[] | undefined) {
  return useQuery({
    queryKey: ['messages-by-names', names],
    enabled: !!names && names.length > 0,
    queryFn: () =>
      getJson<{ items: Message[] }>(`/api/v1/messages?names=${(names ?? []).slice(0, 300).join(',')}`).then(r => r.items),
  })
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => getJson<{ items: Account[] }>('/api/v1/accounts').then(r => r.items),
    refetchInterval: 60_000,
  })
}

export function useWindows() {
  return useQuery({
    queryKey: ['windows'],
    queryFn: () => getJson<{ items: RefreshWindow[] }>('/api/v1/refreshwindows').then(r => r.items),
  })
}

export interface LogTail {
  dates: string[]
  date: string
  lines: string[]
}

export function useLogs(date?: string, lines = 500) {
  return useQuery({
    queryKey: ['logs', date, lines],
    queryFn: () => getJson<LogTail>(`/api/v1/logs?lines=${lines}${date ? `&date=${date}` : ''}`),
    refetchInterval: 3000,
  })
}

export function useInvalidate() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['messages'] })
    void qc.invalidateQueries({ queryKey: ['windows'] })
    void qc.invalidateQueries({ queryKey: ['accounts'] })
  }
}

// ---------- 命令式 API ----------

export function createRefreshWindow(source: string, count?: number): Promise<RefreshWindow> {
  return send('POST', '/api/v1/refreshwindows', { spec: { source, count, trigger: 'manual' } })
}

/** 订阅 refresh window 的 SSE 进度；返回取消函数 */
export function watchRefreshWindow(
  name: string,
  onLog: (line: string) => void,
  onDone: (result: { phase: string; stats: unknown; error: string | null }) => void,
): () => void {
  const es = new EventSource(`/api/v1/refreshwindows/${name}?watch=1`)
  es.addEventListener('log', e => onLog((e as MessageEvent).data))
  es.addEventListener('phase', e => onLog(`phase: ${(e as MessageEvent).data}`))
  es.addEventListener('done', e => {
    es.close()
    onDone(JSON.parse((e as MessageEvent).data))
  })
  es.onerror = () => {
    es.close()
    onDone({ phase: 'Failed', stats: null, error: 'SSE connection lost' })
  }
  return () => es.close()
}

export function createLoginSession(account: string): Promise<LoginSession> {
  return send('POST', '/api/v1/loginsessions', { spec: { account } })
}

export function pollLoginSession(id: string): Promise<LoginSession> {
  return getJson(`/api/v1/loginsessions/${id}`)
}

export function checkAccount(name: string): Promise<Account> {
  return getJson(`/api/v1/accounts/${name}?check=1`)
}
