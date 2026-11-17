// 查询层：所有读操作直接下推到 SQLite，不再在启动时把整库搬进内存。
//
// 约定：
//   - 资源行用 litectl 的 storage kind（message / author / refresh-window / overlay-entry …），
//     public kind 由 outside 的 facade 还原。
//   - creationTimestamp 写在 annotation refresh.internal/creationTimestamp 上（facade 负责搬运）。
//   - overlay（已读、分类 label 等）按 name 批量取，不再整表加载。

import type { Database } from 'bun:sqlite'
import { resourceDatabase } from './resource-store'
import type { OverlayEntry } from './store'

const API_VERSION = 'radar/v1'
const TS_ANNOTATION = '$."refresh.internal/creationTimestamp"'

export type WindowRow = RawRow

export interface RawRow {
  name: string
  labels_json: string
  annotations: string
  spec_json: string
  status_spec_json: string | null
}

function db(): Database {
  return resourceDatabase()
}

/** 单条资源行（不含 overlay/status 合并）。 */
export function readRow(kind: string, name: string): RawRow | null {
  return db()
    .query<RawRow, [string, string, string, string, string]>(
      `SELECT r.name AS name,
              COALESCE((SELECT json_group_object(key, value) FROM labels WHERE resource_id = r.id), '{}') AS labels_json,
              r.annotations AS annotations,
              r.spec_json AS spec_json,
              (SELECT s.spec_json
                 FROM resource_links link
                 JOIN resources s ON s.id = link.from_id
                WHERE link.to_id = r.id AND link.relation = 'status'
                  AND s.api_version = ? AND s.kind = ?
                  AND json_extract(s.spec_json, '$.controller') = 'refresh'
                LIMIT 1) AS status_spec_json
         FROM resources r
        WHERE r.api_version = ? AND r.kind = ? AND r.name = ?`,
    )
    .get(API_VERSION, statusKindOf(kind), API_VERSION, kind, name)
}

function statusKindOf(kind: string): string {
  return `${kind}-status`
}

/** 一页 message：selector / author / 未读过滤 / 排序 / limit 全部在 SQL 里完成。 */
export interface MessageQuery {
  labelSelector?: Record<string, string> | null
  /** source 是多值归属：按 radar/sources 集合匹配 */
  source?: string | null
  authorNames?: string[] | null
  names?: string[] | null
  unreadOnly?: boolean
  sort?: 'time' | 'unread-first'
  limit?: number | null
}

const OVERLAY_LABEL_EXPR = `EXISTS (
  SELECT 1
    FROM resource_links ol
    JOIN resources oe ON oe.id = ol.from_id
   WHERE ol.to_id = r.id
     AND ol.relation = 'overlay-for'
     AND oe.api_version = '${API_VERSION}'
     AND oe.kind = 'overlay-entry'
     AND json_extract(oe.spec_json, '$.entry.labels.' || ?) = ?
)`

const READ_EXPR = `EXISTS (
  SELECT 1
    FROM resource_links ol
    JOIN resources oe ON oe.id = ol.from_id
   WHERE ol.to_id = r.id
     AND ol.relation = 'overlay-for'
     AND oe.api_version = '${API_VERSION}'
     AND oe.kind = 'overlay-entry'
     AND COALESCE(json_extract(oe.spec_json, '$.entry.status.read'), 0) != 0
)`

function buildMessageWhere(query: MessageQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = ['r.api_version = ?', "r.kind = 'message'"]
  const params: (string | number)[] = [API_VERSION]

  for (const [key, value] of Object.entries(query.labelSelector ?? {})) {
    if (key === 'source') continue
    clauses.push(`EXISTS (SELECT 1 FROM labels WHERE resource_id = r.id AND key = ? AND value = ?)`)
    params.push(key, value)
  }
  if (query.source) {
    clauses.push(`instr(',' || COALESCE(json_extract(r.annotations, '$."radar/sources"'), '') || ',', ',' || ? || ',') > 0`)
    params.push(query.source)
  }
  if (query.authorNames && query.authorNames.length > 0) {
    clauses.push(`EXISTS (SELECT 1 FROM labels WHERE resource_id = r.id AND key = 'author' AND value IN (${query.authorNames.map(() => '?').join(',')}))`)
    params.push(...query.authorNames)
  }
  if (query.names && query.names.length > 0) {
    clauses.push(`r.name IN (${query.names.map(() => '?').join(',')})`)
    params.push(...query.names)
  }
  if (query.unreadOnly) {
    clauses.push(`NOT ${READ_EXPR}`)
  }
  return { sql: clauses.join(' AND '), params }
}

export function selectMessages(query: MessageQuery): { name: string; ts: string | null; read: number }[] {
  const { sql: where, params } = buildMessageWhere(query)
  const order = query.sort === 'unread-first'
    ? `ORDER BY (${READ_EXPR}) ASC, COALESCE(json_extract(r.annotations, '${TS_ANNOTATION}'), '') DESC`
    : `ORDER BY COALESCE(json_extract(r.annotations, '${TS_ANNOTATION}'), '') DESC`
  const limit = query.limit && query.limit > 0 ? `LIMIT ${Math.floor(query.limit)}` : ''
  return db()
    .query<{ name: string; ts: string | null; read: number }, (string | number)[]>(
      `SELECT r.name AS name,
              json_extract(r.annotations, '${TS_ANNOTATION}') AS ts,
              (${READ_EXPR}) AS read
         FROM resources r
        WHERE ${where}
        ${order}
        ${limit}`,
    )
    .all(...params)
}

/** names 批量取（保序由调用方处理）。 */
export function selectMessageNames(names: string[]): { name: string; ts: string | null; read: number }[] {
  if (names.length === 0) return []
  return db()
    .query<{ name: string; ts: string | null; read: number }, (string | number)[]>(
      `SELECT r.name AS name,
              json_extract(r.annotations, '${TS_ANNOTATION}') AS ts,
              (${READ_EXPR}) AS read
         FROM resources r
        WHERE r.api_version = ? AND r.kind = 'message'
          AND r.name IN (${names.map(() => '?').join(',')})`,
    )
    .all(API_VERSION, ...names)
}

/** 未读数：只取仍未读的 message 的 sources annotation，在 JS 里按逗号拆分聚合。 */
export function selectUnreadSources(): string[] {
  return db()
    .query<{ sources: string | null }, []>(
      `SELECT COALESCE(json_extract(r.annotations, '$."radar/sources"'),
                       (SELECT value FROM labels WHERE resource_id = r.id AND key = 'source'),
                       '') AS sources
         FROM resources r
        WHERE r.api_version = '${API_VERSION}' AND r.kind = 'message'
          AND NOT ${READ_EXPR}`,
    )
    .all()
    .map(row => row.sources ?? '')
}

/**
 * author name 列表：selector 在 labels 上判，按 messageCount 倒序，limit 在 SQL 里截断。
 * 这样 27k 个 author 不会被整表读进内存，也不会在 selector 之前就解析 spec。
 */
export function selectAuthorNames(
  selector: Record<string, string> | null,
  limit: number | null,
): string[] {
  const clauses: string[] = ['r.api_version = ?', "r.kind = 'author'"]
  const params: (string | number)[] = [API_VERSION]
  for (const [key, value] of Object.entries(selector ?? {})) {
    if (key === 'group') {
      // group 是多值 label（逗号分隔），按成员匹配
      clauses.push(`instr(',' || COALESCE((SELECT value FROM labels WHERE resource_id = r.id AND key = 'group'), '') || ',', ',' || ? || ',') > 0`)
      params.push(value)
      continue
    }
    // overlay 的 label（如 category）覆盖资源 label：两者任一匹配即可
    clauses.push(`(
      EXISTS (SELECT 1 FROM labels WHERE resource_id = r.id AND key = ? AND value = ?)
      OR ${OVERLAY_LABEL_EXPR}
    )`)
    params.push(key, value, key, value)
  }
  const limitSql = limit && limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''
  return db()
    .query<{ name: string }, (string | number)[]>(
      `SELECT r.name AS name
         FROM resources r
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(json_extract(
                   (SELECT s.spec_json
                      FROM resource_links link
                      JOIN resources s ON s.id = link.from_id
                     WHERE link.to_id = r.id AND link.relation = 'status'
                       AND s.kind = 'author-status'
                     LIMIT 1),
                   '$.value.messageCount'), 0) DESC,
                 r.name
        ${limitSql}`,
    )
    .all(...params)
    .map(row => row.name)
}

/** 一页 overlay（按 name 批量），避免整表加载。 */
export function selectOverlay(kind: string, names: string[]): Record<string, OverlayEntry> {
  if (names.length === 0) return {}
  const rows = db()
    .query<{ target: string; entry: string }, string[]>(
      `SELECT t.name AS target, json_extract(o.spec_json, '$.entry') AS entry
         FROM resources o
         JOIN resource_links link ON link.from_id = o.id AND link.relation = 'overlay-for'
         JOIN resources t ON t.id = link.to_id
        WHERE o.api_version = '${API_VERSION}' AND o.kind = 'overlay-entry'
          AND (SELECT value FROM labels WHERE resource_id = o.id AND key = 'overlay_kind') = ?
          AND t.name IN (${names.map(() => '?').join(',')})`,
    )
    .all(kind, ...names)
    .map(row => ({ target: row.target, entry: row.entry }))
  const out: Record<string, OverlayEntry> = {}
  for (const row of rows) {
    try {
      out[row.target] = JSON.parse(row.entry) as OverlayEntry
    } catch {
      out[row.target] = {}
    }
  }
  return out
}

/** window 列表（按名字倒序，等价于最新的排前面）。 */
export function selectWindows(source?: string | null): WindowRow[] {
  const sql = `SELECT r.name AS name,
                      COALESCE((SELECT json_group_object(key, value) FROM labels WHERE resource_id = r.id), '{}') AS labels_json,
                      r.annotations AS annotations,
                      r.spec_json AS spec_json,
                      (SELECT s.spec_json
                         FROM resource_links link
                         JOIN resources s ON s.id = link.from_id
                        WHERE link.to_id = r.id AND link.relation = 'status'
                          AND s.kind = 'refresh-window-status'
                          AND json_extract(s.spec_json, '$.controller') = 'refresh'
                        LIMIT 1) AS status_spec_json
                 FROM resources r
                WHERE r.api_version = '${API_VERSION}' AND r.kind = 'refresh-window'
                ${source ? `AND json_extract(r.spec_json, '$.source') = ?` : ''}
                ORDER BY r.name DESC`
  return source
    ? db().query<RawRow, [string]>(sql).all(source)
    : db().query<RawRow, []>(sql).all()
}

/**
 * session 之后新抓到的、且不在已发布名单里的 message。
 * window 时间取 refresh-window 的 creationTimestamp annotation。
 */
export function selectNewMessageNames(
  sources: string[],
  publishedAfterMs: number,
  publishedNames: string[],
): string[] {
  if (sources.length === 0) return []
  const sourceClause = sources
    .map(() => `instr(',' || COALESCE(json_extract(r.annotations, '$."radar/sources"'), '') || ',', ',' || ? || ',') > 0`)
    .join(' OR ')
  const publishedClause = publishedNames.length > 0
    ? `AND r.name NOT IN (${publishedNames.map(() => '?').join(',')})`
    : ''
  const params: (string | number)[] = [...sources, ...publishedNames]
  return db()
    .query<{ name: string }, (string | number)[]>(
      `SELECT r.name AS name
         FROM resources r
         JOIN resources win
           ON win.api_version = '${API_VERSION}'
          AND win.kind = 'refresh-window'
          AND win.name = json_extract(r.annotations, '$."radar/lastSeenWindow"')
        WHERE r.api_version = '${API_VERSION}' AND r.kind = 'message'
          AND (${sourceClause})
          ${publishedClause}
          AND COALESCE(CAST(strftime('%s', json_extract(win.annotations, '${TS_ANNOTATION}')) AS INTEGER) * 1000, 0) > ?`,
    )
    .all(...params, publishedAfterMs)
    .map(row => row.name)
}
