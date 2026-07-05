import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { Resource, OverlayEntry, OverlayKind, WindowFile, FolloweeWindowFile } from './store'
import { recordOperation, recordResourceWrite, recordValidationFailure } from './observability'
import {
  ALL_RESOURCE_DEFINITIONS,
  FolloweeWindowItemResource,
  FolloweeWindowResource,
  MediaObjectResource,
  OverlayEntryResource,
  RefreshWindowItemResource,
  RefreshWindowResource,
  SchedulerResource,
  type ResourceDefinition,
  resourceDefinition,
} from './resource-definitions'

type Json = Record<string, unknown> | unknown[]

interface ResourceRow {
  api_version: string
  kind: string
  name: string
  schema_version: number
  resource_version: number
  metadata: string
  spec: string
  status: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface ResourceRecord {
  resource: Resource
  schemaVersion: number
  resourceVersion: number
}

interface StorePaths {
  dataDir: string
  windowsDir: string
  followeeWindowsDir: string
  overlayDir: string
  mediaDir: string
}

const API_VERSION = 'radar/v1'
const DB_FILE = 'refresh.db'
const SCHEMA_VERSION = 1

let db: Database | null = null
let initPromise: Promise<void> | null = null
let writeQueue: Promise<unknown> = Promise.resolve()

export async function initResourceStore(p: StorePaths): Promise<void> {
  initPromise ??= initialize(p)
  await initPromise
}

export async function closeResourceStoreForTests(): Promise<void> {
  db?.close()
  db = null
  initPromise = null
  writeQueue = Promise.resolve()
}

function database(): Database {
  if (!db) throw new Error('ResourceStore is not initialized')
  return db
}

async function initialize(p: StorePaths): Promise<void> {
  await Promise.all([
    mkdir(p.dataDir, { recursive: true }),
    mkdir(p.windowsDir, { recursive: true }),
    mkdir(p.followeeWindowsDir, { recursive: true }),
    mkdir(p.overlayDir, { recursive: true }),
    mkdir(p.mediaDir, { recursive: true }),
  ])
  db = new Database(join(p.dataDir, DB_FILE), { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA busy_timeout = 5000')
  migrateSchema(db)
  seedSchemas(db)
  await importLegacyIfNeeded(p)
}

function migrateSchema(d: Database): void {
  d.run(`
    CREATE TABLE IF NOT EXISTS resource_schemas (
      api_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      schema_hash TEXT NOT NULL,
      json_schema JSONB NOT NULL CHECK (json_valid(json_schema)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (api_version, kind, schema_version)
    )
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS resources (
      api_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      resource_version INTEGER NOT NULL,
      metadata JSONB NOT NULL CHECK (json_valid(metadata)),
      spec JSONB NOT NULL CHECK (json_valid(spec)),
      status JSONB NOT NULL CHECK (json_valid(status)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (api_version, kind, name),
      FOREIGN KEY (api_version, kind, schema_version)
        REFERENCES resource_schemas(api_version, kind, schema_version)
    )
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS resource_index_terms (
      api_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (api_version, kind, name, field, value),
      FOREIGN KEY (api_version, kind, name)
        REFERENCES resources(api_version, kind, name)
        ON DELETE CASCADE
    )
  `)
  d.run(`
    CREATE INDEX IF NOT EXISTS idx_resource_index_terms_lookup
    ON resource_index_terms(kind, field, value)
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS resource_index_values (
      api_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      field TEXT NOT NULL,
      text_value TEXT,
      number_value REAL,
      boolean_value INTEGER,
      PRIMARY KEY (api_version, kind, name, field),
      FOREIGN KEY (api_version, kind, name)
        REFERENCES resources(api_version, kind, name)
        ON DELETE CASCADE
    )
  `)
  d.run(`
    CREATE INDEX IF NOT EXISTS idx_resource_index_values_text
    ON resource_index_values(kind, field, text_value)
  `)
  d.run(`
    CREATE INDEX IF NOT EXISTS idx_resource_index_values_number
    ON resource_index_values(kind, field, number_value)
  `)
  d.run(`
    CREATE INDEX IF NOT EXISTS idx_resource_index_values_boolean
    ON resource_index_values(kind, field, boolean_value)
  `)
  d.run(`
    CREATE TABLE IF NOT EXISTS store_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `)
}

function seedSchemas(d: Database): void {
  const schema = {
    type: 'object',
    required: ['apiVersion', 'kind', 'metadata', 'spec', 'status'],
    properties: {
      apiVersion: { const: API_VERSION },
      kind: { type: 'string' },
      metadata: { type: 'object' },
      spec: { type: 'object' },
      status: { type: 'object' },
    },
  }
  const now = new Date().toISOString()
  const stmt = d.query(`
    INSERT OR IGNORE INTO resource_schemas
      (api_version, kind, schema_version, schema_hash, json_schema, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const definition of ALL_RESOURCE_DEFINITIONS) {
    const kind = definition.kind
    const json = JSON.stringify({ ...schema, properties: { ...schema.properties, kind: { const: kind } } })
    stmt.run(definition.apiVersion, kind, definition.schemaVersion, sha256(json), json, now)
  }
}

async function importLegacyIfNeeded(p: StorePaths): Promise<void> {
  const d = database()
  const count = d.query('SELECT COUNT(*) AS count FROM resources').get() as { count: number }
  if (count.count > 0) return

  const imported: { path: string; hash: string; resources: number }[] = []
  let totalResources = 0
  const migrationId = `legacy-json-${SCHEMA_VERSION}`

  const runImport = async () => {
    for (const file of await jsonFiles(p.windowsDir)) {
      const full = join(p.windowsDir, file)
      const content = await readFile(full, 'utf-8')
      const win = JSON.parse(content) as WindowFile
      totalResources += putWindowFileSync(d, win)
      imported.push({ path: full, hash: sha256(content), resources: 1 + (win.rawItems?.length ?? 0) })
    }

    for (const file of await jsonFiles(p.followeeWindowsDir)) {
      const full = join(p.followeeWindowsDir, file)
      const content = await readFile(full, 'utf-8')
      const win = JSON.parse(content) as FolloweeWindowFile
      totalResources += putFolloweeWindowFileSync(d, win)
      imported.push({ path: full, hash: sha256(content), resources: 1 + (win.rawItems?.length ?? 0) })
    }

    for (const kind of ['messages', 'authors', 'followees'] as OverlayKind[]) {
      const full = join(p.overlayDir, `${kind}.json`)
      if (!existsSync(full)) continue
      const content = await readFile(full, 'utf-8')
      const overlay = JSON.parse(content) as Record<string, OverlayEntry>
      for (const [name, entry] of Object.entries(overlay)) {
        putOverlayEntrySync(d, kind, name, entry)
        totalResources++
      }
      imported.push({ path: full, hash: sha256(content), resources: Object.keys(overlay).length })
    }

    const schedulerPath = join(p.dataDir, 'scheduler.json')
    if (existsSync(schedulerPath)) {
      const content = await readFile(schedulerPath, 'utf-8')
      putResourceSync(d, {
        apiVersion: API_VERSION,
        kind: SchedulerResource.kind,
        metadata: { name: 'default' },
        spec: JSON.parse(content) as Record<string, unknown>,
        status: {},
      })
      totalResources++
      imported.push({ path: schedulerPath, hash: sha256(content), resources: 1 })
    }

    const mediaIndexPath = join(p.mediaDir, 'index.json')
    if (existsSync(mediaIndexPath)) {
      const content = await readFile(mediaIndexPath, 'utf-8')
      const manifest = JSON.parse(content) as Record<string, { file: string; bytes: number }>
      for (const [originUrl, entry] of Object.entries(manifest)) {
        putMediaObjectSync(d, originUrl, entry)
        totalResources++
      }
      imported.push({ path: mediaIndexPath, hash: sha256(content), resources: Object.keys(manifest).length })
    }

    const checksum = sha256(JSON.stringify(imported))
    d.query('INSERT INTO store_migrations (id, applied_at, checksum) VALUES (?, ?, ?)').run(
      migrationId,
      new Date().toISOString(),
      checksum,
    )
  }

  d.run('BEGIN IMMEDIATE')
  try {
    await runImport()
    d.run('COMMIT')
  } catch (err) {
    d.run('ROLLBACK')
    throw err
  }

  if (imported.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(p.dataDir, 'migration-snapshots', timestamp)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          migrationId,
          createdAt: new Date().toISOString(),
          database: join(p.dataDir, DB_FILE),
          totalResources,
          imported,
        },
        null,
        2,
      ),
      'utf-8',
    )
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(f => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

export async function putResource(resource: Resource): Promise<void> {
  await enqueueWrite(() => putResourceSync(database(), resource))
}

export async function getResource(definition: ResourceDefinition, name: string): Promise<Resource | null> {
  const row = getRow(definition, name)
  return row ? rowToResource(row).resource : null
}

export async function listResources(definition: ResourceDefinition): Promise<Resource[]> {
  return listRows(definition).map(row => rowToResource(row).resource)
}

export async function listResourceNames(definition: ResourceDefinition): Promise<string[]> {
  return database()
    .query('SELECT name FROM resources WHERE api_version = ? AND kind = ? AND deleted_at IS NULL ORDER BY name')
    .all(definition.apiVersion, definition.kind)
    .map(row => String((row as { name: string }).name))
}

export async function putWindowFile(win: WindowFile): Promise<void> {
  await enqueueWrite(() => {
    const d = database()
    if (getRow(RefreshWindowResource, win.metadata.name)) {
      throw new Error(`window already exists (archives are immutable): ${win.metadata.name}`)
    }
    putWindowFileSync(d, win)
  })
}

export async function readWindowFileFromStore(name: string): Promise<WindowFile> {
  const resource = await getResource(RefreshWindowResource, name)
  if (!resource) throw new Error(`window not found: ${name}`)
  const rawItems = await listWindowItems(RefreshWindowItemResource, name)
  return { ...(resource as WindowFile), kind: RefreshWindowResource.kind, rawItems }
}

export async function updateWindowStatusInStore(name: string, status: unknown): Promise<WindowFile> {
  await enqueueWrite(() => {
    const row = getRow(RefreshWindowResource, name)
    if (!row) throw new Error(`window not found: ${name}`)
    const record = rowToResource(row)
    record.resource.status = status
    putResourceSync(database(), record.resource, record.resourceVersion + 1)
  })
  return readWindowFileFromStore(name)
}

export async function putFolloweeWindowFile(win: FolloweeWindowFile): Promise<void> {
  await enqueueWrite(() => {
    const d = database()
    if (getRow(FolloweeWindowResource, win.metadata.name)) {
      throw new Error(`followee window already exists (archives are immutable): ${win.metadata.name}`)
    }
    putFolloweeWindowFileSync(d, win)
  })
}

export async function readFolloweeWindowFileFromStore(name: string): Promise<FolloweeWindowFile> {
  const resource = await getResource(FolloweeWindowResource, name)
  if (!resource) throw new Error(`followee window not found: ${name}`)
  const rawItems = await listWindowItems(FolloweeWindowItemResource, name)
  return { ...(resource as FolloweeWindowFile), kind: FolloweeWindowResource.kind, rawItems }
}

export async function readOverlayFromStore(kind: OverlayKind): Promise<Record<string, OverlayEntry>> {
  const resources = database()
    .query('SELECT * FROM resources WHERE api_version = ? AND kind = ? AND deleted_at IS NULL ORDER BY name')
    .all(OverlayEntryResource.apiVersion, OverlayEntryResource.kind)
    .map(row => rowToResource(row as ResourceRow).resource)
  const out: Record<string, OverlayEntry> = {}
  for (const resource of resources) {
    if (resource.metadata.labels?.overlayKind !== kind) continue
    const target = resource.metadata.labels.targetName
    if (!target) continue
    out[target] = (resource.spec as { entry?: OverlayEntry }).entry ?? {}
  }
  return out
}

export async function patchOverlayInStore(
  kind: OverlayKind,
  name: string,
  patch: OverlayEntry,
): Promise<OverlayEntry> {
  let entry: OverlayEntry = {}
  await enqueueWrite(() => {
    const all = readOverlaySync(kind)
    entry = mergeOverlayEntry(all[name] ?? {}, patch)
    putOverlayEntrySync(database(), kind, name, entry)
  })
  return entry
}

export async function patchOverlayManyInStore(kind: OverlayKind, patches: Record<string, OverlayEntry>): Promise<void> {
  await enqueueWrite(() => {
    const all = readOverlaySync(kind)
    for (const [name, patch] of Object.entries(patches)) {
      putOverlayEntrySync(database(), kind, name, mergeOverlayEntry(all[name] ?? {}, patch))
    }
  })
}

export async function readSchedulerSpecFromStore(): Promise<Record<string, unknown> | null> {
  const scheduler = await getResource(SchedulerResource, 'default')
  return scheduler ? (scheduler.spec as Record<string, unknown>) : null
}

export async function writeSchedulerSpecToStore(spec: Record<string, unknown>): Promise<void> {
  await putResource({
    apiVersion: API_VERSION,
    kind: SchedulerResource.kind,
    metadata: { name: 'default' },
    spec,
    status: {},
  })
}

export async function readMediaManifestFromStore(): Promise<Record<string, { file: string; bytes: number }>> {
  const out: Record<string, { file: string; bytes: number }> = {}
  for (const resource of await listResources(MediaObjectResource)) {
    const spec = resource.spec as Record<string, unknown>
    const originUrl = String(spec.originUrl ?? '')
    const file = String(spec.file ?? '')
    const bytes = Number(spec.bytes ?? 0)
    if (originUrl && file) out[originUrl] = { file, bytes }
  }
  return out
}

export async function putMediaObject(originUrl: string, entry: { file: string; bytes: number }): Promise<void> {
  await enqueueWrite(() => putMediaObjectSync(database(), originUrl, entry))
}

function putWindowFileSync(d: Database, win: WindowFile): number {
  const { rawItems, ...resource } = win
  putResourceSync(d, resource as Resource)
  const platform = String(resource.metadata.labels?.platform ?? '')
  const source = String((resource.spec as Record<string, unknown>).source ?? '')
  rawItems.forEach((raw, index) => {
    putResourceSync(d, {
      apiVersion: API_VERSION,
      kind: RefreshWindowItemResource.kind,
      metadata: {
        name: `${win.metadata.name}-${String(index).padStart(6, '0')}`,
        labels: { window: win.metadata.name, platform, source },
        creationTimestamp: win.metadata.creationTimestamp,
      },
      spec: { window: win.metadata.name, ordinal: index, raw },
      status: {},
    })
  })
  return 1 + rawItems.length
}

function putFolloweeWindowFileSync(d: Database, win: FolloweeWindowFile): number {
  const { rawItems, ...resource } = win
  putResourceSync(d, resource as Resource)
  const account = String(resource.metadata.labels?.account ?? (resource.spec as Record<string, unknown>).account ?? '')
  const platform = String(resource.metadata.labels?.platform ?? '')
  rawItems.forEach((raw, index) => {
    putResourceSync(d, {
      apiVersion: API_VERSION,
      kind: FolloweeWindowItemResource.kind,
      metadata: {
        name: `${win.metadata.name}-${String(index).padStart(6, '0')}`,
        labels: { window: win.metadata.name, account, platform },
        creationTimestamp: win.metadata.creationTimestamp,
      },
      spec: { window: win.metadata.name, ordinal: index, raw },
      status: {},
    })
  })
  return 1 + rawItems.length
}

function listWindowItems(definition: typeof RefreshWindowItemResource | typeof FolloweeWindowItemResource, windowName: string): unknown[] {
  return database()
    .query(
      `
      SELECT spec
      FROM resources r
      JOIN resource_index_values i
        ON i.api_version = r.api_version AND i.kind = r.kind AND i.name = r.name
      WHERE r.api_version = ?
        AND r.kind = ?
        AND i.field = 'window'
        AND i.text_value = ?
        AND r.deleted_at IS NULL
      ORDER BY json_extract(r.spec, '$.ordinal') ASC
    `,
    )
    .all(definition.apiVersion, definition.kind, windowName)
    .map(row => (JSON.parse(String((row as { spec: string }).spec)) as { raw: unknown }).raw)
}

function putOverlayEntrySync(d: Database, kind: OverlayKind, targetName: string, entry: OverlayEntry): void {
  putResourceSync(d, {
    apiVersion: API_VERSION,
    kind: OverlayEntryResource.kind,
    metadata: {
      name: `${kind}-${targetName}`,
      labels: { overlayKind: kind, targetName },
    },
    spec: { entry },
    status: {},
  })
}

function readOverlaySync(kind: OverlayKind): Record<string, OverlayEntry> {
  const out: Record<string, OverlayEntry> = {}
  for (const resource of listRows(OverlayEntryResource).map(row => rowToResource(row).resource)) {
    if (resource.metadata.labels?.overlayKind !== kind) continue
    const target = resource.metadata.labels.targetName
    if (!target) continue
    out[target] = (resource.spec as { entry?: OverlayEntry }).entry ?? {}
  }
  return out
}

function putMediaObjectSync(d: Database, originUrl: string, entry: { file: string; bytes: number }): void {
  const [hash, ext = 'bin'] = entry.file.split('.')
  putResourceSync(d, {
    apiVersion: API_VERSION,
    kind: MediaObjectResource.kind,
    metadata: {
      name: entry.file,
      labels: { hash, ext },
      annotations: { 'radar/originUrl': originUrl },
    },
    spec: {
      originUrl,
      file: entry.file,
      hash,
      ext,
      bytes: entry.bytes,
      storage: { type: 'file', path: `media/${entry.file}` },
    },
    status: { phase: 'Available' },
  })
}

function putResourceSync(d: Database, resource: Resource, resourceVersion?: number): void {
  try {
    validateResource(resource)
  } catch (err) {
    recordValidationFailure(resource.kind || 'unknown')
    throw err
  }
  const now = new Date().toISOString()
  const definition = resourceDefinition(resource.kind)
  const existing = getRow(definition, resource.metadata.name)
  const version = resourceVersion ?? (existing ? Number(existing.resource_version) + 1 : 1)
  const createdAt = existing?.created_at ?? resource.metadata.creationTimestamp ?? now
  d.query(
    `
    INSERT INTO resources
      (api_version, kind, name, schema_version, resource_version, metadata, spec, status, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(api_version, kind, name) DO UPDATE SET
      schema_version = excluded.schema_version,
      resource_version = excluded.resource_version,
      metadata = excluded.metadata,
      spec = excluded.spec,
      status = excluded.status,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `,
  ).run(
    resource.apiVersion,
    resource.kind,
    resource.metadata.name,
    SCHEMA_VERSION,
    version,
    JSON.stringify(resource.metadata),
    JSON.stringify(resource.spec ?? {}),
    JSON.stringify(resource.status ?? {}),
    createdAt,
    now,
  )
  rebuildIndexes(d, resource)
  recordResourceWrite(resource.kind)
}

function rebuildIndexes(d: Database, resource: Resource): void {
  d.query('DELETE FROM resource_index_terms WHERE api_version = ? AND kind = ? AND name = ?').run(
    resource.apiVersion,
    resource.kind,
    resource.metadata.name,
  )
  d.query('DELETE FROM resource_index_values WHERE api_version = ? AND kind = ? AND name = ?').run(
    resource.apiVersion,
    resource.kind,
    resource.metadata.name,
  )

  const addValue = (field: string, value: unknown) => {
    if (value === undefined || value === null) return
    const text = typeof value === 'string' ? value : null
    const number = typeof value === 'number' ? value : null
    const boolean = typeof value === 'boolean' ? Number(value) : null
    d.query(
      `
      INSERT OR REPLACE INTO resource_index_values
        (api_version, kind, name, field, text_value, number_value, boolean_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(resource.apiVersion, resource.kind, resource.metadata.name, field, text, number, boolean)
  }

  const addTerm = (field: string, value: unknown) => {
    if (typeof value !== 'string' || value === '') return
    d.query(
      `
      INSERT OR IGNORE INTO resource_index_terms
        (api_version, kind, name, field, value)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(resource.apiVersion, resource.kind, resource.metadata.name, field, value)
  }

  addValue('creationTimestamp', resource.metadata.creationTimestamp)
  for (const [key, value] of Object.entries(resource.metadata.labels ?? {})) {
    addValue(`metadata.labels.${key}`, value)
    if (key === 'group') for (const item of value.split(',').filter(Boolean)) addTerm('metadata.labels.group', item)
  }
  for (const [key, value] of Object.entries(resource.metadata.annotations ?? {})) {
    addValue(`metadata.annotations.${key}`, value)
    if (key === 'radar/sources') for (const item of value.split(',').filter(Boolean)) addTerm('metadata.annotations.radar/sources', item)
  }

  const spec = resource.spec as Record<string, unknown>
  const status = resource.status as Record<string, unknown>
  addValue('window', spec.window)
  addValue('spec.source', spec.source)
  addValue('spec.account', spec.account)
  addValue('spec.originUrl', spec.originUrl)
  addValue('spec.hash', spec.hash)
  addValue('spec.author.name', (spec.author as Record<string, unknown> | undefined)?.name)
  addValue('spec.author.ref', (spec.author as Record<string, unknown> | undefined)?.ref)
  addValue('spec.publishedAt', spec.publishedAt ?? resource.metadata.creationTimestamp)
  addValue('status.phase', status.phase)
  addValue('status.read', status.read)
  addValue('status.following', status.following)
}

function getRow(definition: ResourceDefinition, name: string): ResourceRow | null {
  return (
    database()
      .query('SELECT * FROM resources WHERE api_version = ? AND kind = ? AND name = ? AND deleted_at IS NULL')
      .get(definition.apiVersion, definition.kind, name) as ResourceRow | null
  )
}

function listRows(definition: ResourceDefinition): ResourceRow[] {
  return database()
    .query('SELECT * FROM resources WHERE api_version = ? AND kind = ? AND deleted_at IS NULL ORDER BY name')
    .all(definition.apiVersion, definition.kind) as ResourceRow[]
}

function rowToResource(row: ResourceRow): ResourceRecord {
  return {
    resource: {
      apiVersion: row.api_version as 'radar/v1',
      kind: row.kind,
      metadata: JSON.parse(row.metadata),
      spec: JSON.parse(row.spec) as Json,
      status: JSON.parse(row.status) as Json,
    },
    schemaVersion: row.schema_version,
    resourceVersion: row.resource_version,
  }
}

function validateResource(resource: Resource): void {
  if (resource.apiVersion !== API_VERSION) throw new Error(`invalid apiVersion: ${resource.apiVersion}`)
  if (!resource.kind) throw new Error('resource kind is required')
  if (!resource.metadata?.name) throw new Error(`resource metadata.name is required for ${resource.kind}`)
  assertJsonObject(resource.metadata, `${resource.kind}/${resource.metadata.name}.metadata`)
  assertJsonObject(resource.spec ?? {}, `${resource.kind}/${resource.metadata.name}.spec`)
  assertJsonObject(resource.status ?? {}, `${resource.kind}/${resource.metadata.name}.status`)
}

function assertJsonObject(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function mergeOverlayEntry(current: OverlayEntry, patch: OverlayEntry): OverlayEntry {
  const entry: OverlayEntry = { ...current }
  for (const section of ['labels', 'annotations', 'status'] as const) {
    const p = patch[section]
    if (!p) continue
    const merged: Record<string, unknown> = { ...(entry[section] ?? {}) }
    for (const [key, value] of Object.entries(p)) {
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    entry[section] = merged as never
  }
  return entry
}

function enqueueWrite<T>(fn: () => T): Promise<T> {
  const queuedAt = performance.now()
  const run = async () => {
    recordOperation('resource_store.write_queue_wait', performance.now() - queuedAt)
    const d = database()
    const startedAt = performance.now()
    d.run('BEGIN IMMEDIATE')
    try {
      const result = fn()
      d.run('COMMIT')
      recordOperation('resource_store.write_transaction', performance.now() - startedAt)
      return result
    } catch (err) {
      d.run('ROLLBACK')
      recordOperation('resource_store.write_transaction_failed', performance.now() - startedAt)
      throw err
    }
  }
  const next = writeQueue.then(run, run)
  writeQueue = next.catch(() => {})
  return next
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
