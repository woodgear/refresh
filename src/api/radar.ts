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
  durationSec?: number
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
  status: { hydrated: boolean; read?: boolean; readAt?: string; [k: string]: unknown }
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

export interface Followee {
  apiVersion: string
  kind: 'Followee'
  metadata: ResourceMeta
  spec: {
    platformId: string
    handle: string | null
    displayName: string
    avatar: string | null
    url: string
    description: string | null
    raw?: unknown
  }
  status: {
    following: boolean
    firstSeenAt: string
    lastSeenFollowingAt: string | null
    lastSyncedAt: string
    [k: string]: unknown
  }
}

export interface FolloweeWindow {
  kind: 'FolloweeWindow'
  metadata: ResourceMeta
  spec: { account: string; trigger: string }
  status: {
    phase: 'Running' | 'Succeeded' | 'Failed'
    complete: boolean
    stats?: { seen: number; unfollowed: number } | null
    error?: string | null
  }
}

export interface FolloweeExport {
  apiVersion: string
  kind: 'FolloweeExport'
  exportedAt: string
  count: number
  items: {
    platform: string
    account: string
    platformId: string
    handle: string | null
    displayName: string
    avatar: string | null
    url: string
    description: string | null
    group: string[]
    labels: Record<string, string>
    note: string
  }[]
}

export interface LoginChallenge {
  fields: { name: string; label: string; kind: 'text' | 'password' }[]
  note?: string
}

export interface LoginSession {
  kind: 'LoginSession'
  metadata: ResourceMeta
  spec: { account: string; mode: 'qr' | 'password' }
  status: { phase: string; error: string | null; challenge?: LoginChallenge | null }
}

// ---------- 静态源注册表（与 server/config.ts 对应） ----------

export interface SourceInfo {
  name: string
  account: string
  platform: 'zhihu' | 'twitter' | 'bilibili'
  label: string
}

export const SOURCES: SourceInfo[] = [
  { name: 'zhihu-main-recommend', account: 'zhihu-main', platform: 'zhihu', label: '知乎 · 推荐' },
  { name: 'zhihu-main-follow', account: 'zhihu-main', platform: 'zhihu', label: '知乎 · 关注' },
  { name: 'twitter-main-recommend', account: 'twitter-main', platform: 'twitter', label: '推特 · 推荐' },
  { name: 'twitter-main-following', account: 'twitter-main', platform: 'twitter', label: '推特 · 关注' },
  { name: 'bilibili-main-follow', account: 'bilibili-main', platform: 'bilibili', label: 'B站 · 关注' },
  { name: 'bilibili-main-popular', account: 'bilibili-main', platform: 'bilibili', label: 'B站 · 热门' },
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

export function useMessages(source: string, opts?: { sort?: 'time' | 'unread-first'; unreadOnly?: boolean }) {
  const params = new URLSearchParams()
  if (source !== 'all') params.set('labelSelector', `source=${source}`)
  params.set('limit', '200')
  if (opts?.sort) params.set('sort', opts.sort)
  if (opts?.unreadOnly) params.set('unread', 'true')
  return useQuery({
    queryKey: ['messages', source, opts?.sort ?? 'time', opts?.unreadOnly ?? false],
    queryFn: () => getJson<{ items: Message[] }>(`/api/v1/messages?${params}`).then(r => r.items),
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

export function useFollowees(opts?: { platform?: string; labelSelector?: string; includeNotFollowing?: boolean; limit?: number; offset?: number }) {
  const params = new URLSearchParams()
  if (opts?.platform && opts.platform !== 'all') params.set('platform', opts.platform)
  if (opts?.labelSelector) params.set('labelSelector', opts.labelSelector)
  if (opts?.includeNotFollowing) params.set('includeNotFollowing', 'true')
  params.set('limit', String(opts?.limit ?? 200))
  params.set('offset', String(opts?.offset ?? 0))
  return useQuery({
    queryKey: ['followees', opts?.platform ?? 'all', opts?.labelSelector ?? '', opts?.includeNotFollowing ?? false, opts?.limit ?? 200, opts?.offset ?? 0],
    queryFn: () => getJson<{ items: Followee[]; total: number; offset: number; limit: number }>(`/api/v1/followees?${params}`),
  })
}

export function useFolloweeWindows() {
  return useQuery({
    queryKey: ['followee-windows'],
    queryFn: () => getJson<{ items: FolloweeWindow[] }>('/api/v1/followeewindows').then(r => r.items),
  })
}

export function listFolloweeWindows(): Promise<FolloweeWindow[]> {
  return getJson<{ items: FolloweeWindow[] }>('/api/v1/followeewindows').then(r => r.items)
}

export function getFolloweeWindow(name: string): Promise<FolloweeWindow> {
  return getJson(`/api/v1/followeewindows/${name}`)
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

export function useUnreadCounts() {
  return useQuery({
    queryKey: ['unread-counts'],
    queryFn: () => getJson<{ total: number; sources: Record<string, number> }>('/api/v1/unread-counts'),
    refetchInterval: 30_000,
  })
}

export interface Scheduler {
  kind: 'Scheduler'
  spec: { enabled: boolean; intervalMs: number }
  status: { running: boolean; lastRoundAt: string | null; nextRoundAt: string | null }
}

export function useScheduler() {
  return useQuery({
    queryKey: ['scheduler'],
    queryFn: () => getJson<Scheduler>('/api/v1/scheduler'),
    refetchInterval: 10_000,
  })
}

export function patchScheduler(spec: { enabled?: boolean; intervalMs?: number }): Promise<Scheduler> {
  return send('PATCH', '/api/v1/scheduler', { spec })
}

/** 批量标记已读；names 或 labelSelector（'' = 全部）二选一 */
export function markRead(target: { names?: string[]; labelSelector?: string }): Promise<{ marked: number }> {
  return send('POST', '/api/v1/messages/mark-read', target)
}

/** 手动切换单条已读/未读 */
export function setMessageRead(name: string, read: boolean): Promise<Message> {
  return send('PATCH', `/api/v1/messages/${name}`, {
    status: read ? { read: true, readAt: new Date().toISOString() } : { read: null, readAt: null },
  })
}

export function useInvalidate() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['messages'] })
    void qc.invalidateQueries({ queryKey: ['windows'] })
    void qc.invalidateQueries({ queryKey: ['followees'] })
    void qc.invalidateQueries({ queryKey: ['followee-windows'] })
    void qc.invalidateQueries({ queryKey: ['accounts'] })
  }
}

// ---------- 命令式 API ----------

export function createRefreshWindow(source: string, count?: number): Promise<RefreshWindow> {
  return send('POST', '/api/v1/refreshwindows', { spec: { source, count, trigger: 'manual' } })
}

export function syncFollowees(account?: string): Promise<{ items: FolloweeWindow[] }> {
  return send('POST', '/api/v1/followeewindows', { spec: account ? { account } : {} })
}

export function patchFollowee(name: string, patch: { labels?: Record<string, string | null>; annotations?: Record<string, string | null> }): Promise<Followee> {
  return send('PATCH', `/api/v1/followees/${name}`, patch)
}

export function exportFollowees(): Promise<FolloweeExport> {
  return getJson('/api/v1/followees/export')
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

/** password 模式：提交一步字段值（用户名/密码、或后续 2FA/验证码） */
export function submitLoginInput(id: string, values: Record<string, string>): Promise<LoginSession> {
  return send('POST', `/api/v1/loginsessions/${id}/input`, { values })
}

export function checkAccount(name: string): Promise<Account> {
  return getJson(`/api/v1/accounts/${name}?check=1`)
}
