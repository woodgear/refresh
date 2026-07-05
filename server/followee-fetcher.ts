import { ACCOUNTS, getAccount, type AccountConfig } from './config'
import { openSession, closeTab, sleep } from './cdp'

export interface FolloweeSpec extends Record<string, unknown> {
  platformId: string
  handle: string | null
  displayName: string
  avatar: string | null
  url: string
  description: string | null
  raw: unknown
}

export interface NormalizedFollowee {
  name: string
  spec: FolloweeSpec
}

export interface FolloweeFetchResult {
  rawItems: unknown[]
  followees: NormalizedFollowee[]
  fetchedAt: number
  complete: boolean
}

export interface FolloweeFetcher {
  fetch(account: AccountConfig, log: (line: string) => void): Promise<FolloweeFetchResult>
}

export class MockFolloweeFetcher implements FolloweeFetcher {
  private static rounds = new Map<string, number>()

  async fetch(account: AccountConfig, log: (line: string) => void): Promise<FolloweeFetchResult> {
    const round = (MockFolloweeFetcher.rounds.get(account.name) ?? 0) + 1
    MockFolloweeFetcher.rounds.set(account.name, round)
    log(`mock followee fetch ${account.name} round=${round}`)
    const rows = mockRows(account.platform, round)
    return {
      rawItems: rows,
      followees: rows.map(raw => normalizeMockFollowee(account.platform, raw)),
      fetchedAt: 1781110000,
      complete: true,
    }
  }
}

export class CdpFolloweeFetcher implements FolloweeFetcher {
  async fetch(account: AccountConfig, log: (line: string) => void): Promise<FolloweeFetchResult> {
    if (account.platform === 'zhihu') return fetchZhihuFollowees(log)
    if (account.platform === 'twitter') return fetchTwitterFollowees(log)
    if (account.platform === 'bilibili') return fetchBilibiliFollowees(log)
    throw new Error(`no followee fetcher for platform ${account.platform}`)
  }
}

export function defaultFolloweeFetcher(): FolloweeFetcher {
  return process.env.RADAR_FETCHER === 'mock' ? new MockFolloweeFetcher() : new CdpFolloweeFetcher()
}

export function accountsForFolloweeSync(accountName: string | undefined): AccountConfig[] {
  if (!accountName) return ACCOUNTS
  const account = getAccount(accountName)
  if (!account) throw new Error(`unknown account: ${accountName}`)
  return [account]
}

function mockRows(platform: AccountConfig['platform'], round: number): unknown[] {
  const base = {
    zhihu: [
      { id: 'z1', handle: 'zhihu-alice', displayName: '知乎 Alice', avatar: 'https://example.test/z1.png', url: 'https://www.zhihu.com/people/zhihu-alice', description: 'writes about AI' },
      { id: 'z2', handle: 'zhihu-bob', displayName: '知乎 Bob', avatar: 'https://example.test/z2.png', url: 'https://www.zhihu.com/people/zhihu-bob', description: 'infra notes' },
    ],
    twitter: [
      { id: 't1', handle: 'tw_alice', displayName: 'Twitter Alice', avatar: 'https://example.test/t1.png', url: 'https://x.com/tw_alice', description: 'research' },
      { id: 't2', handle: 'tw_bob', displayName: 'Twitter Bob', avatar: 'https://example.test/t2.png', url: 'https://x.com/tw_bob', description: 'systems' },
    ],
    bilibili: [
      { id: 'b1', handle: '1001', displayName: 'B站 Alice', avatar: 'https://example.test/b1.png', url: 'https://space.bilibili.com/1001', description: 'tech videos' },
      { id: 'b2', handle: '1002', displayName: 'B站 Bob', avatar: 'https://example.test/b2.png', url: 'https://space.bilibili.com/1002', description: 'dev logs' },
    ],
  }[platform]
  return round === 2 ? base.slice(0, 1) : base
}

function normalizeMockFollowee(platform: AccountConfig['platform'], raw: unknown): NormalizedFollowee {
  const r = raw as Record<string, string>
  return {
    name: `${platform}-${r.id}`,
    spec: {
      platformId: r.id,
      handle: r.handle,
      displayName: r.displayName,
      avatar: r.avatar,
      url: r.url,
      description: r.description,
      raw,
    },
  }
}

async function fetchZhihuFollowees(log: (line: string) => void): Promise<FolloweeFetchResult> {
  const { tab, session } = await openSession('https://www.zhihu.com/people')
  try {
    await sleep(1500)
    log('fetch zhihu followees from page context')
    const data = await session.evaluate<{ rawItems: unknown[]; followees: NormalizedFollowee[] }>(`(async () => {
      const meRes = await fetch('/api/v4/me?include=url_token,name,avatar_url,headline', { credentials: 'include' })
      if (!meRes.ok) throw new Error('zhihu me failed: ' + meRes.status)
      const me = await meRes.json()
      const token = me.url_token
      if (!token) throw new Error('zhihu current user token missing')
      const rawItems = []
      let offset = 0
      const limit = 20
      while (true) {
        const res = await fetch('/api/v4/members/' + encodeURIComponent(token) + '/followees?include=data%5B*%5D.url_token%2Cname%2Cavatar_url%2Cheadline&offset=' + offset + '&limit=' + limit, { credentials: 'include' })
        if (!res.ok) throw new Error('zhihu followees failed: ' + res.status)
        const json = await res.json()
        const rows = Array.isArray(json.data) ? json.data : []
        rawItems.push(...rows)
        if (!json.paging || json.paging.is_end || rows.length === 0) break
        offset += rows.length
      }
      const followees = rawItems.map((u) => {
        const id = String(u.id || u.url_token || '')
        if (!id) throw new Error('zhihu followee id missing')
        const handle = u.url_token ? String(u.url_token) : null
        return {
          name: 'zhihu-' + id,
          spec: {
            platformId: id,
            handle,
            displayName: String(u.name || handle || id),
            avatar: u.avatar_url || null,
            url: handle ? 'https://www.zhihu.com/people/' + handle : 'https://www.zhihu.com/people/' + id,
            description: u.headline || null,
            raw: u
          }
        }
      })
      return { rawItems, followees }
    })()`, 120_000)
    return { ...data, fetchedAt: Math.floor(Date.now() / 1000), complete: true }
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

async function fetchBilibiliFollowees(log: (line: string) => void): Promise<FolloweeFetchResult> {
  const { tab, session } = await openSession('https://space.bilibili.com')
  try {
    await sleep(1500)
    log('fetch bilibili followees from page context')
    const data = await session.evaluate<{ rawItems: unknown[]; followees: NormalizedFollowee[] }>(`(async () => {
      const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
      if (!navRes.ok) throw new Error('bilibili nav failed: ' + navRes.status)
      const nav = await navRes.json()
      const vmid = nav && nav.data && nav.data.mid
      if (!vmid) throw new Error('bilibili current user mid missing')
      const rawItems = []
      let pn = 1
      const ps = 50
      while (true) {
        const res = await fetch('https://api.bilibili.com/x/relation/followings?vmid=' + encodeURIComponent(vmid) + '&pn=' + pn + '&ps=' + ps + '&order=desc&jsonp=jsonp', { credentials: 'include' })
        if (!res.ok) throw new Error('bilibili followings failed: ' + res.status)
        const json = await res.json()
        if (json.code !== 0) throw new Error('bilibili followings code: ' + json.code)
        const rows = json.data && Array.isArray(json.data.list) ? json.data.list : []
        rawItems.push(...rows)
        if (rows.length < ps) break
        pn += 1
      }
      const followees = rawItems.map((u) => {
        const id = String(u.mid || '')
        if (!id) throw new Error('bilibili followee mid missing')
        return {
          name: 'bilibili-' + id,
          spec: {
            platformId: id,
            handle: id,
            displayName: String(u.uname || id),
            avatar: u.face || null,
            url: 'https://space.bilibili.com/' + id,
            description: u.sign || null,
            raw: u
          }
        }
      })
      return { rawItems, followees }
    })()`, 120_000)
    return { ...data, fetchedAt: Math.floor(Date.now() / 1000), complete: true }
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

async function fetchTwitterFollowees(log: (line: string) => void): Promise<FolloweeFetchResult> {
  const { tab, session } = await openSession('https://x.com/following')
  const pendingBodies: string[] = []
  const wanted = new Set<string>()
  const users = new Map<string, NormalizedFollowee>()
  try {
    await session.send('Network.enable')
    session.on('Network.responseReceived', params => {
      const url = String(((params.response as Record<string, unknown> | undefined)?.url) ?? '')
      if (url.includes('/Following?') || url.includes('/friends/following/list.json')) wanted.add(String(params.requestId))
    })
    session.on('Network.loadingFinished', params => {
      const requestId = String(params.requestId)
      if (wanted.has(requestId)) pendingBodies.push(requestId)
    })
    await sleep(1500)
    log('collect twitter followees from Following GraphQL responses')

    const drain = async () => {
      while (pendingBodies.length > 0) {
        const requestId = pendingBodies.shift()!
        try {
          const { body, base64Encoded } = await session.send<{ body: string; base64Encoded: boolean }>(
            'Network.getResponseBody',
            { requestId },
          )
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body
          const before = users.size
          extractTwitterUsers(JSON.parse(text), users)
          if (users.size > before) log(`+${users.size - before} twitter followees (total ${users.size})`)
        } catch {
          /* response body may be gone; next page still gives coverage */
        }
      }
    }

    let idleRounds = 0
    let lastY = -1
    for (let i = 0; i < 120; i++) {
      await sleep(1200)
      const before = users.size
      await drain()
      const y = await session.evaluate<number>('window.scrollY')
      if (users.size === before) {
        idleRounds++
        if (idleRounds >= 8 && y === lastY) break
      } else {
        idleRounds = 0
      }
      lastY = y
      await session.evaluate('window.scrollBy(0, document.documentElement.clientHeight * 2); true')
    }
    await sleep(1500)
    await drain()

    const followees = [...users.values()]
    if (followees.length === 0) {
      const domData = await session.evaluate<unknown[]>(`(() => {
        const out = []
        for (const a of document.querySelectorAll('a[href^="/"][role="link"]')) {
          const href = a.getAttribute('href') || ''
          const m = href.match(/^\\/([^/?#]+)$/)
          if (!m) continue
          const handle = m[1]
          if (['home','explore','notifications','messages','i','settings','compose','following'].includes(handle)) continue
          const cell = a.closest('div[data-testid="cellInnerDiv"]')
          const text = cell ? cell.innerText : a.innerText
          const lines = String(text || '').split('\\n').map(s => s.trim()).filter(Boolean)
          const displayName = lines.find(line => !line.startsWith('@')) || handle
          const img = cell ? cell.querySelector('img[src*="profile_images"]') : null
          out.push({ id: handle, handle, displayName, avatar: img ? img.src : null, description: lines.slice(2).join(' ') || null })
        }
        return out
      })()`)
      for (const raw of domData) {
        const f = normalizeTwitterUser(raw)
        if (f) users.set(f.name, f)
      }
    }

    const finalFollowees = [...users.values()]
    if (finalFollowees.length === 0) throw new Error('twitter followees not found in GraphQL or rendered page')
    return {
      rawItems: finalFollowees.map(f => f.spec.raw),
      followees: finalFollowees,
      fetchedAt: Math.floor(Date.now() / 1000),
      complete: false,
    }
  } finally {
    session.close()
    await closeTab(tab.id)
  }
}

function extractTwitterUsers(payload: unknown, out: Map<string, NormalizedFollowee>): void {
  walk(payload, value => {
    if (!value || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    const typename = obj.__typename
    const legacy = obj.legacy as Record<string, unknown> | undefined
    const restId = obj.rest_id
    if ((typename === 'User' || typename === 'UserWithVisibilityResults') && legacy && restId) {
      const core = obj.core as Record<string, unknown> | undefined
      const avatar = obj.avatar as Record<string, unknown> | undefined
      const normalized = normalizeTwitterUser({
        ...legacy,
        id_str: String(restId),
        rest_id: String(restId),
        name: core?.name,
        screen_name: core?.screen_name,
        profile_image_url_https: avatar?.image_url,
      })
      if (normalized) out.set(normalized.name, normalized)
    }
    const result = (obj.result ?? obj.user) as Record<string, unknown> | undefined
    const resultLegacy = result?.legacy as Record<string, unknown> | undefined
    const resultRestId = result?.rest_id
    if (resultLegacy && resultRestId) {
      const core = result.core as Record<string, unknown> | undefined
      const avatar = result.avatar as Record<string, unknown> | undefined
      const normalized = normalizeTwitterUser({
        ...resultLegacy,
        id_str: String(resultRestId),
        rest_id: String(resultRestId),
        name: core?.name,
        screen_name: core?.screen_name,
        profile_image_url_https: avatar?.image_url,
      })
      if (normalized) out.set(normalized.name, normalized)
    }
  })
}

function normalizeTwitterUser(raw: unknown): NormalizedFollowee | null {
  const r = raw as Record<string, unknown>
  const id = str(r.rest_id) ?? str(r.id_str) ?? str(r.id) ?? str(r.screen_name)
  if (!id) return null
  const handle = str(r.screen_name) ?? str(r.handle) ?? id
  const displayName = str(r.name) ?? str(r.displayName) ?? handle
  const avatar = str(r.profile_image_url_https) ?? str(r.avatar)
  return {
    name: `twitter-${id}`,
    spec: {
      platformId: id,
      handle,
      displayName,
      avatar: avatar ? avatar.replace('_normal.', '_400x400.') : null,
      url: `https://x.com/${handle}`,
      description: str(r.description),
      raw,
    },
  }
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value)
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) walk(item, visit)
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
