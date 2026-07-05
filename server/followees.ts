import { ACCOUNTS, getAccount, type AccountConfig } from './config'
import { rlog } from './logger'
import {
  appendFolloweeWindow,
  applyOverlay,
  listFolloweeWindowNames,
  listStoredResources,
  putStoredResource,
  readFolloweeWindowFile,
  readOverlay,
  type FolloweeWindowFile,
  type OverlayKind,
  type Resource,
} from './store'
import { FolloweeResource, FolloweeWindowResource } from './resource-definitions'
import {
  accountsForFolloweeSync,
  defaultFolloweeFetcher,
  type FolloweeFetcher,
  type FolloweeSpec,
  type NormalizedFollowee,
} from './followee-fetcher'
import { parseSelector } from './resources'
import { downloadAll, localMediaUrl } from './media'

export interface FolloweeStatus extends Record<string, unknown> {
  following: boolean
  firstSeenAt: string
  lastSeenFollowingAt: string | null
  lastSyncedAt: string
}

interface FolloweeSyncSpec {
  account?: string
  trigger: 'manual'
}

const followees = new Map<string, Resource<FolloweeSpec, FolloweeStatus>>()
const followeeWindows = new Map<string, Resource>()

function followeeOverlayKind(): OverlayKind {
  return 'followees'
}

export async function ingestFolloweeWindow(
  win: FolloweeWindowFile,
  opts: { persist?: boolean } = {},
): Promise<{ seen: number; unfollowed: number }> {
  const persist = opts.persist ?? true
  const labels = win.metadata.labels ?? {}
  const accountName = String(labels.account ?? '')
  const account = getAccount(accountName)
  if (!account) throw new Error(`unknown followee window account: ${accountName}`)
  const status = win.status as Record<string, unknown>
  const complete = status.complete === true && account.platform !== 'twitter'
  const syncedAt = win.metadata.creationTimestamp ?? new Date().toISOString()
  const seenNames = new Set<string>()
  const changed = new Map<string, Resource<FolloweeSpec, FolloweeStatus>>()

  for (const item of ((win.spec as Record<string, unknown>).followees ?? []) as NormalizedFollowee[]) {
    seenNames.add(item.name)
    const existing = followees.get(item.name)
    const baseStatus: FolloweeStatus = existing?.status ?? {
      following: true,
      firstSeenAt: syncedAt,
      lastSeenFollowingAt: syncedAt,
      lastSyncedAt: syncedAt,
    }
    const resource: Resource<FolloweeSpec, FolloweeStatus> = {
      apiVersion: 'radar/v1',
      kind: FolloweeResource.kind,
      metadata: {
        name: item.name,
        labels: { platform: account.platform, account: account.name },
        annotations: {},
        creationTimestamp: existing?.metadata.creationTimestamp ?? syncedAt,
      },
      spec: item.spec,
      status: {
        ...baseStatus,
        following: true,
        lastSeenFollowingAt: syncedAt,
        lastSyncedAt: syncedAt,
      },
    }
    followees.set(item.name, resource)
    changed.set(resource.metadata.name, resource)
  }

  let unfollowed = 0
  if (complete) {
    for (const item of followees.values()) {
      if (item.metadata.labels?.account !== account.name) continue
      if (seenNames.has(item.metadata.name)) continue
      if (!item.status.following) continue
      item.status = { ...item.status, following: false, lastSyncedAt: syncedAt }
      changed.set(item.metadata.name, item)
      unfollowed++
    }
  }

  registerFolloweeWindowResource(win, { seen: seenNames.size, unfollowed })
  if (persist) {
    for (const resource of changed.values()) await putStoredResource(resource)
  }
  return { seen: seenNames.size, unfollowed }
}

export function registerFolloweeWindowResource(win: FolloweeWindowFile, counts?: { seen: number; unfollowed: number }): void {
  const { rawItems: _rawItems, ...fullResource } = win
  const fullSpec = fullResource.spec as Record<string, unknown>
  const archivedFollowees = Array.isArray(fullSpec.followees) ? fullSpec.followees : []
  const { followees: _followees, ...spec } = fullSpec
  const resource = { ...fullResource, spec: { ...spec, followeeCount: archivedFollowees.length } }
  if (counts) {
    const status = resource.status as Record<string, unknown>
    status.stats = { seen: counts.seen, unfollowed: counts.unfollowed }
  }
  followeeWindows.set(win.metadata.name, resource as Resource)
}

export async function buildFolloweeIndex(): Promise<void> {
  followees.clear()
  followeeWindows.clear()
  const names = await listFolloweeWindowNames()
  const persistProjections = names.length > 0 && (await listStoredResources(FolloweeResource)).length === 0
  for (const name of names) {
    try {
      await ingestFolloweeWindow(await readFolloweeWindowFile(name), { persist: persistProjections })
    } catch (err) {
      rlog('followee-index', `skip corrupt followee window ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  rlog('followee-index', `built: ${followees.size} followees, ${followeeWindows.size} followee windows`)
}

function matchFolloweeLabels(resource: Resource, selector: Record<string, string> | null): boolean {
  if (!selector) return true
  const labels = resource.metadata.labels ?? {}
  return Object.entries(selector).every(([k, v]) => {
    if (k === 'group') return (labels.group ?? '').split(',').filter(Boolean).includes(v)
    return labels[k] === v
  })
}

async function withFolloweeOverlay(items: Resource<FolloweeSpec, FolloweeStatus>[]) {
  const overlay = await readOverlay(followeeOverlayKind())
  return items.map(item => applyOverlay(item, overlay[item.metadata.name]))
}

function apiFollowee(resource: Resource<FolloweeSpec, FolloweeStatus>): Resource<FolloweeSpec, FolloweeStatus> {
  const { raw: _raw, ...rest } = resource.spec
  const spec = { ...rest }
  return { ...resource, spec: spec as FolloweeSpec }
}

export async function queryFollowees(opts: { labelSelector?: string; platform?: string; includeNotFollowing?: boolean; limit?: number; offset?: number }) {
  const selector = parseSelector(opts.labelSelector)
  let merged = await withFolloweeOverlay([...followees.values()])
  if (!opts.includeNotFollowing) merged = merged.filter(f => f.status.following)
  if (opts.platform) merged = merged.filter(f => f.metadata.labels?.platform === opts.platform)
  let result = merged.filter(f => matchFolloweeLabels(f, selector))
  result.sort((a, b) => {
    const ap = a.metadata.labels?.platform ?? ''
    const bp = b.metadata.labels?.platform ?? ''
    return ap.localeCompare(bp) || a.spec.displayName.localeCompare(b.spec.displayName)
  })
  const total = result.length
  const offset = Math.max(opts.offset ?? 0, 0)
  const limit = opts.limit && opts.limit > 0 ? opts.limit : total
  result = result.slice(offset, offset + limit)
  return { items: result.map(apiFollowee), total, offset, limit }
}

export async function listFollowees(opts: { labelSelector?: string; platform?: string; includeNotFollowing?: boolean; limit?: number; offset?: number }) {
  return (await queryFollowees(opts)).items
}

export async function getFollowee(name: string) {
  const f = followees.get(name)
  if (!f) return null
  const [merged] = await withFolloweeOverlay([f])
  return apiFollowee(merged)
}

export function listFolloweeWindowResources(accountFilter?: string): Resource[] {
  let result = [...followeeWindows.values()]
  if (accountFilter) result = result.filter(w => (w.spec as Record<string, unknown>).account === accountFilter)
  return result.sort((a, b) => b.metadata.name.localeCompare(a.metadata.name))
}

export function getFolloweeWindowResource(name: string): Resource | null {
  return followeeWindows.get(name) ?? null
}

export async function exportFollowees() {
  const items = await listFollowees({})
  return {
    apiVersion: 'radar/v1' as const,
    kind: 'FolloweeExport',
    exportedAt: new Date().toISOString(),
    count: items.length,
    items: items.map(f => ({
      platform: f.metadata.labels?.platform ?? '',
      account: f.metadata.labels?.account ?? '',
      platformId: f.spec.platformId,
      handle: f.spec.handle,
      displayName: f.spec.displayName,
      avatar: f.spec.avatar,
      url: f.spec.url,
      description: f.spec.description,
      group: (f.metadata.labels?.group ?? '').split(',').filter(Boolean),
      labels: f.metadata.labels ?? {},
      note: f.metadata.annotations?.['refresh/note'] ?? '',
    })),
  }
}

export function createFolloweeWindows(spec: FolloweeSyncSpec, fetcher: FolloweeFetcher = defaultFolloweeFetcher()): Resource[] {
  const accounts = accountsForFolloweeSync(spec.account)
  return accounts.map(account => createFolloweeWindow(account, spec.trigger, fetcher))
}

function createFolloweeWindow(account: AccountConfig, trigger: 'manual', fetcher: FolloweeFetcher): Resource {
  const now = new Date().toISOString()
  const name = uniqueFolloweeWindowName(account.name)
  const resource: Resource = {
    apiVersion: 'radar/v1',
    kind: FolloweeWindowResource.kind,
    metadata: { name, creationTimestamp: now, labels: { account: account.name, platform: account.platform } },
    spec: { account: account.name, trigger, followees: [] },
    status: { phase: 'Running', startedAt: now, finishedAt: null, complete: false, stats: null, error: null },
  }
  followeeWindows.set(name, resource)
  setTimeout(() => void executeFolloweeWindow(resource, account, trigger, fetcher), 0)
  return resource
}

async function executeFolloweeWindow(
  resource: Resource,
  account: AccountConfig,
  trigger: 'manual',
  fetcher: FolloweeFetcher,
): Promise<void> {
  const name = resource.metadata.name
  const startedAt = String((resource.status as Record<string, unknown>).startedAt)
  const log = (line: string) => rlog(name, line)
  let win: FolloweeWindowFile
  try {
    const result = await fetcher.fetch(account, log)
    await downloadAll(result.followees.map(f => f.spec.avatar).filter((url): url is string => !!url && url.startsWith('http')), log)
    const followees = result.followees.map(f => ({
      ...f,
      spec: {
        ...f.spec,
        avatar: f.spec.avatar ? localMediaUrl(f.spec.avatar) ?? f.spec.avatar : null,
      },
    }))
    const finishedAt = new Date().toISOString()
    resource.spec = { account: account.name, trigger, followees }
    resource.status = {
      phase: 'Succeeded',
      startedAt,
      finishedAt,
      complete: result.complete,
      stats: null,
      error: null,
    }
    win = { ...(resource as FolloweeWindowFile), rawItems: result.rawItems }
  } catch (err) {
    const finishedAt = new Date().toISOString()
    resource.status = {
      phase: 'Failed',
      startedAt,
      finishedAt,
      complete: false,
      stats: null,
      error: err instanceof Error ? err.message : String(err),
    }
    win = { ...(resource as FolloweeWindowFile), rawItems: [] }
  }

  try {
    await appendFolloweeWindow(win)
  } catch (err) {
    resource.status = {
      ...(resource.status as Record<string, unknown>),
      phase: 'Failed',
      error: `archive write failed: ${err instanceof Error ? err.message : String(err)}`,
    }
    rlog(name, String((resource.status as Record<string, unknown>).error))
    return
  }

  if ((win.status as Record<string, unknown>).phase === 'Succeeded') {
    await ingestFolloweeWindow(win)
  } else {
    registerFolloweeWindowResource(win)
  }
}

function uniqueFolloweeWindowName(account: string): string {
  let ts = Math.floor(Date.now() / 1000)
  let name = `${account}-followees-${ts}`
  while (getFolloweeWindowResource(name)) {
    ts++
    name = `${account}-followees-${ts}`
  }
  return name
}

export function followeeAccounts(): AccountConfig[] {
  return ACCOUNTS
}
