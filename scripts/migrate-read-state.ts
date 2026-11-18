// 一次性迁移：把「已读状态」从 overlay 搬进 message.spec，并清掉不再需要的机制产物。
//
// 背景：read 放在 overlay（独立资源 + link）时，`ORDER BY read, ts` 无法用索引，
// 实测 796ms/页；挪进 spec.read 后配合 litectl 的复合索引是 2ms。
// 同一次迁移里清掉：window-item（读路径直查后不需要重放 raw）、message-status
//（hydrated 已进 spec）、message 的 overlay-entry（read 已进 spec）。
//
//   bun scripts/migrate-read-state.ts            # dry-run，只统计
//   bun scripts/migrate-read-state.ts --apply    # 真跑
//
// 幂等：overlay-entry 里没有对应 message 的直接跳过；重复跑不会重复写。
import { ensureDirs, putStoredResources } from '../server/store'
import { resourceDatabase } from '../server/resource-store'
import { listRefreshResourcesByNames } from '../server/litectl-resource-facade'
import { MessageResource } from '../server/resource-definitions'
import type { Resource } from '../server/store'

const apply = process.argv.includes('--apply')
const API_VERSION = 'radar/v1'

await ensureDirs()
const db = resourceDatabase()

// 1. overlay-entry(messages) → spec.read / spec.readAt
const overlayRows = db
  .query<{ name: string; target: string; entry: string }, []>(
    `SELECT o.name AS name, t.name AS target,
            json_extract(o.spec_json, '$.entry') AS entry
       FROM resources o
       JOIN resource_links link ON link.from_id = o.id AND link.relation = 'overlay-for'
       JOIN resources t ON t.id = link.to_id
      WHERE o.api_version = '${API_VERSION}' AND o.kind = 'overlay-entry'
        AND (SELECT value FROM labels WHERE resource_id = o.id AND key = 'overlay_kind') = 'messages'`,
  )
  .all()

const readTargets: { name: string; read: boolean; readAt: string | null }[] = []
for (const row of overlayRows) {
  let entry: { status?: { read?: boolean; readAt?: string } } = {}
  try {
    entry = JSON.parse(row.entry) as typeof entry
  } catch {
    continue
  }
  if (typeof entry.status?.read !== 'boolean') continue
  readTargets.push({ name: row.target, read: entry.status.read, readAt: entry.status.readAt ?? null })
}

const messageNames = readTargets.map(item => item.name)
const messages = new Map(
  listRefreshResourcesByNames(db, MessageResource, messageNames).map(resource => [resource.metadata.name, resource]),
)
const specUpdates: Resource[] = []
for (const target of readTargets) {
  const resource = messages.get(target.name)
  if (!resource) continue
  const spec = { ...(resource.spec as Record<string, unknown>) }
  if (spec.read === target.read && (spec.readAt ?? null) === target.readAt) continue
  spec.read = target.read
  spec.readAt = target.readAt
  resource.spec = spec
  specUpdates.push(resource)
}

// 1b. 给所有 message 补 read 字段（NULL 会让裸表达式索引失效）
const allMessages = db
  .query<{ name: string; spec_json: string }, []>(
    `SELECT name, spec_json FROM resources WHERE api_version = '${API_VERSION}' AND kind = 'message'`,
  )
  .all()
const missingRead = allMessages.filter(row => {
  try {
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>
    return typeof spec.read !== 'boolean'
  } catch {
    return false
  }
})
const backfill: Resource[] = []
for (const row of missingRead) {
  const resource = listRefreshResourcesByNames(db, MessageResource, [row.name])[0]
  if (!resource) continue
  const spec = { ...(resource.spec as Record<string, unknown>), read: false, readAt: null }
  resource.spec = spec
  backfill.push(resource)
}

// 2. 统计要删的机制产物
const counts = db
  .query<{ kind: string; n: number }, []>(
    `SELECT kind, count(*) AS n FROM resources
      WHERE api_version = '${API_VERSION}'
        AND kind IN ('refresh-window-item', 'message-status', 'overlay-entry')
      GROUP BY kind`,
  )
  .all()
const windowItems = db
  .query<{ name: string }, []>(
    `SELECT name FROM resources WHERE api_version = '${API_VERSION}' AND kind = 'refresh-window-item'`,
  )
  .all()
  .map(row => row.name)
const messageStatuses = db
  .query<{ name: string }, []>(
    `SELECT name FROM resources WHERE api_version = '${API_VERSION}' AND kind = 'message-status'`,
  )
  .all()
  .map(row => row.name)

console.log(
  JSON.stringify(
    {
      dryRun: !apply,
      overlayReadStates: readTargets.length,
      messagesToRewrite: specUpdates.length,
      messagesMissingRead: backfill.length,
      counts,
      windowItems: windowItems.length,
      messageStatuses: messageStatuses.length,
    },
    null,
    2,
  ),
)

if (!apply) process.exit(0)

// 3. 真跑：先写 spec（幂等、可重入），再删机制产物
if (backfill.length > 0) {
  await putStoredResources(backfill)
  console.log(`backfilled read=false on ${backfill.length} messages`)
}
if (specUpdates.length > 0) {
  await putStoredResources(specUpdates)
  console.log(`rewrote ${specUpdates.length} message specs with spec.read`)
}


/** 批量删除（单事务）；分块避免单条 SQL 参数过大。 */
function deleteMany(kind: string, names: string[]): number {
  if (names.length === 0) return 0
  const stmt = db.query('SELECT litectl_delete_many(?, ?, ?, ?) AS result')
  let deleted = 0
  for (let start = 0; start < names.length; start += 5000) {
    const chunk = names.slice(start, start + 5000)
    const row = stmt.get('radar/v1', kind, JSON.stringify(chunk), 1) as { result: string }
    const parsed = JSON.parse(row.result) as { deleted: number; missing: number }
    deleted += parsed.deleted
  }
  return deleted
}

console.log(`deleted ${deleteMany('refresh-window-item', windowItems)} window items`)
console.log(`deleted ${deleteMany('message-status', messageStatuses)} message statuses`)
console.log(`deleted ${deleteMany('overlay-entry', overlayRows.map(row => row.name))} message overlay entries`)



// 4. 压掉迁移前的事件（删 13 万条资源会产生等量事件）
const compacted = db
  .query<{ deleted: number }, []>(
    `SELECT litectl_compact_events((SELECT COALESCE(max(rv),0) FROM events)) AS deleted`,
  )
  .get()
console.log(`compacted ${compacted?.deleted ?? 0} events`)
