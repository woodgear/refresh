import { Database } from 'bun:sqlite'
import { constants, copyFileSync, existsSync, renameSync, rmSync } from 'fs'
import type { Resource, ResourceMeta } from './store'
import { getRefreshResource, putRefreshResource, registerRefreshLitectlKinds } from './litectl-resource-facade'
import { openLitectlDatabase, litectlWriteTransaction } from './litectl-runtime'
import { resourceDefinition } from './resource-definitions'

export type RefreshDatabaseFormat = 'custom-resource-store' | 'litectl-v1' | 'litectl-v2' | 'unknown'

interface LegacyResourceRow {
  api_version: string
  kind: string
  name: string
  metadata: string
  spec: string
  status: string
}

export interface MigrationResult {
  resources: number
  storageResources: number
  statusLinks: number
  businessLinks: number
}

export interface InPlaceMigrationResult extends MigrationResult {
  backupPath: string
}

const CUSTOM_TABLES = [
  'resource_index_terms',
  'resource_index_values',
  'resource_schemas',
  'resources',
  'store_migrations',
] as const

const LITECTL_CORE_TABLES = ['events', 'kinds', 'meta', 'resources'] as const

export function detectRefreshDatabaseFormat(path: string): RefreshDatabaseFormat {
  const database = new Database(path, { readonly: true, strict: true })
  try {
    const tables = new Set(
      database
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(row => row.name),
    )
    if (CUSTOM_TABLES.every(table => tables.has(table)) && !tables.has('meta')) return 'custom-resource-store'
    if (LITECTL_CORE_TABLES.every(table => tables.has(table))) {
      const version = database
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'format_version'")
        .get()
      if (version?.value === '1') return 'litectl-v1'
      if (version?.value === '2') return 'litectl-v2'
    }
    return 'unknown'
  } finally {
    database.close()
  }
}

export function migrateCustomResourceStore(
  sourcePath: string,
  targetPath: string,
  extensionPath: string,
): MigrationResult {
  if (detectRefreshDatabaseFormat(sourcePath) !== 'custom-resource-store') {
    throw new Error(`not a Refresh custom ResourceStore database: ${sourcePath}`)
  }
  if (existsSync(targetPath)) throw new Error(`migration target already exists: ${targetPath}`)

  const source = new Database(sourcePath, { readonly: true, strict: true })
  let target: Database | null = null
  try {
    target = openLitectlDatabase(targetPath, extensionPath)
    registerRefreshLitectlKinds(target)
    const rows = source
      .query<LegacyResourceRow, []>(
        `SELECT api_version, kind, name, metadata, spec, status
           FROM resources
          WHERE deleted_at IS NULL
          ORDER BY CASE kind
            WHEN 'Message' THEN 10
            WHEN 'Author' THEN 11
            WHEN 'Followee' THEN 12
            WHEN 'RefreshWindow' THEN 20
            WHEN 'FolloweeWindow' THEN 21
            WHEN 'MediaObject' THEN 22
            WHEN 'Scheduler' THEN 23
            WHEN 'AccountStatus' THEN 24
            WHEN 'RefreshWindowItem' THEN 30
            WHEN 'FolloweeWindowItem' THEN 31
            WHEN 'OverlayEntry' THEN 40
            ELSE 100
          END, kind, name`,
      )
      .iterate()

    let resources = 0
    litectlWriteTransaction(target, () => {
      for (const row of rows) {
        putRefreshResource(target!, legacyRowToResource(row))
        resources++
      }
    })

    reconcile(source, target, resources)
    assertDatabaseIntegrity(target, targetPath)
    target.query('PRAGMA wal_checkpoint(TRUNCATE)').get()
    const counts = target
      .query<{ resources: number; statusLinks: number; businessLinks: number }, []>(
        `SELECT
           (SELECT count(*) FROM resources) AS resources,
           (SELECT count(*) FROM resource_links WHERE relation = 'status') AS statusLinks,
           (SELECT count(*) FROM resource_links WHERE relation != 'status') AS businessLinks`,
      )
      .get()
    if (!counts) throw new Error(`failed to count migrated litectl resources: ${targetPath}`)
    return {
      resources,
      storageResources: counts.resources,
      statusLinks: counts.statusLinks,
      businessLinks: counts.businessLinks,
    }
  } catch (error) {
    target?.close()
    target = null
    removeDatabaseFiles(targetPath)
    throw error
  } finally {
    target?.close()
    source.close()
  }
}

export function migrateCustomResourceStoreInPlace(
  path: string,
  extensionPath: string,
): InPlaceMigrationResult {
  const backupPath = `${path}.pre-litectl-v2.sqlite`
  const targetPath = `${path}.litectl-v2.tmp`
  if (existsSync(backupPath)) throw new Error(`migration backup already exists: ${backupPath}`)
  if (existsSync(targetPath)) throw new Error(`migration target already exists: ${targetPath}`)

  const guard = new Database(path, { strict: true })
  let guardOpen = true
  let backupCreated = false
  try {
    guard.run('PRAGMA busy_timeout = 5000')
    const checkpoint = guard
      .query<{ busy: number; log: number; checkpointed: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)')
      .get()
    if (!checkpoint || checkpoint.busy !== 0) throw new Error(`cannot checkpoint Refresh database before migration: ${path}`)
    guard.run('BEGIN IMMEDIATE')
    copyFileSync(path, backupPath, constants.COPYFILE_EXCL)
    backupCreated = true
    const backup = new Database(backupPath, { readonly: true, strict: true })
    try {
      assertDatabaseIntegrity(backup, backupPath)
    } finally {
      backup.close()
    }
    const result = migrateCustomResourceStore(path, targetPath, extensionPath)
    guard.run('ROLLBACK')
    guard.close()
    guardOpen = false
    removeSidecars(path)
    renameSync(targetPath, path)
    removeSidecars(targetPath)
    return { ...result, backupPath }
  } catch (error) {
    if (guardOpen) {
      if (guard.inTransaction) guard.run('ROLLBACK')
      guard.close()
    }
    removeDatabaseFiles(targetPath)
    if (backupCreated) rmSync(backupPath)
    throw error
  }
}

function reconcile(source: Database, target: Database, expectedCount: number): void {
  const sourceCount = source
    .query<{ count: number }, []>('SELECT count(*) AS count FROM resources WHERE deleted_at IS NULL')
    .get()
  if (!sourceCount || sourceCount.count !== expectedCount) {
    throw new Error(`migration source count changed: expected ${expectedCount}, found ${sourceCount?.count ?? 'missing'}`)
  }

  const rows = source
    .query<LegacyResourceRow, []>(
      'SELECT api_version, kind, name, metadata, spec, status FROM resources WHERE deleted_at IS NULL ORDER BY kind, name',
    )
    .iterate()
  for (const row of rows) {
    const expected = legacyRowToResource(row)
    const actual = getRefreshResource(target, resourceDefinition(row.kind), row.name)
    if (!actual || canonicalJson(normalizeEnvelope(actual)) !== canonicalJson(normalizeEnvelope(expected))) {
      throw new Error(`migration reconciliation failed for ${row.kind}/${row.name}`)
    }
  }
}

function legacyRowToResource(row: LegacyResourceRow): Resource {
  if (row.api_version !== 'radar/v1') throw new Error(`unsupported Refresh apiVersion: ${row.api_version}`)
  const metadata = JSON.parse(row.metadata) as ResourceMeta
  if (metadata.name !== row.name) throw new Error(`${row.kind}/${row.name} metadata.name does not match row name`)
  return {
    apiVersion: row.api_version,
    kind: row.kind,
    metadata,
    spec: JSON.parse(row.spec) as Record<string, unknown>,
    status: JSON.parse(row.status) as Record<string, unknown>,
  }
}

function normalizeEnvelope(resource: Resource): Resource {
  const metadata = { ...resource.metadata }
  if (metadata.labels && Object.keys(metadata.labels).length === 0) delete metadata.labels
  if (metadata.annotations && Object.keys(metadata.annotations).length === 0) delete metadata.annotations
  return { ...resource, metadata }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function removeDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) rmSync(candidate)
  }
}

function removeSidecars(path: string): void {
  for (const candidate of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) rmSync(candidate)
  }
}

function assertDatabaseIntegrity(database: Database, path: string): void {
  const result = database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
  if (result?.integrity_check !== 'ok') {
    throw new Error(`SQLite integrity check failed for ${path}: ${result?.integrity_check ?? 'missing result'}`)
  }
}
