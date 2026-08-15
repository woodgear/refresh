import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { Resource, OverlayEntry, OverlayKind, WindowFile, FolloweeWindowFile } from './store'
import { recordOperation, recordResourceWrite, recordValidationFailure } from './observability'
import {
  FolloweeWindowItemResource,
  FolloweeWindowResource,
  MediaObjectResource,
  OverlayEntryResource,
  RefreshWindowItemResource,
  RefreshWindowResource,
  SchedulerResource,
  type ResourceDefinition,
} from './resource-definitions'
import {
  getRefreshResource,
  listRefreshResources,
  putRefreshResource,
  registerRefreshLitectlKinds,
} from './litectl-resource-facade'
import {
  detectRefreshDatabaseFormat,
  migrateCustomResourceStoreInPlace,
} from './litectl-migration'
import { litectlExtensionPath, cleanupLitectlExtensionForTests } from './litectl-extension'
import { assertLitectlV2Extension, litectlWriteTransaction, openLitectlDatabase } from './litectl-runtime'

export interface MediaManifestEntry {
  file: string
  bytes: number
  width?: number
  height?: number
}

interface StorePaths {
  dataDir: string
  windowsDir: string
  followeeWindowsDir: string
  overlayDir: string
  mediaDir: string
}

interface ItemSpecRow {
  spec_json: string
}

const API_VERSION = 'radar/v1'
const DB_FILE = 'refresh.db'

let db: Database | null = null
let initPromise: Promise<void> | null = null

export async function initResourceStore(paths: StorePaths): Promise<void> {
  initPromise ??= initialize(paths)
  await initPromise
}

export async function closeResourceStoreForTests(): Promise<void> {
  db?.close()
  db = null
  initPromise = null
  cleanupLitectlExtensionForTests()
}

function database(): Database {
  if (!db) throw new Error('ResourceStore is not initialized')
  return db
}

async function initialize(paths: StorePaths): Promise<void> {
  const path = join(paths.dataDir, DB_FILE)
  const extensionPath = litectlExtensionPath()
  assertLitectlV2Extension(extensionPath)
  if (existsSync(path)) {
    const format = detectRefreshDatabaseFormat(path)
    if (format === 'custom-resource-store') {
      migrateCustomResourceStoreInPlace(path, extensionPath)
    } else if (format !== 'litectl-v1' && format !== 'litectl-v2') {
      throw new Error(`unsupported Refresh database format: ${path}`)
    }
  } else {
    assertNoLegacyStructuredData(paths)
  }

  db = openLitectlDatabase(path, extensionPath)
  registerRefreshLitectlKinds(db)
}

function assertNoLegacyStructuredData(paths: StorePaths): void {
  const legacyFiles = [
    ...jsonFiles(paths.windowsDir),
    ...jsonFiles(paths.followeeWindowsDir),
    ...jsonFiles(paths.overlayDir),
    ...(existsSync(join(paths.dataDir, 'scheduler.json')) ? ['scheduler.json'] : []),
    ...(existsSync(join(paths.mediaDir, 'index.json')) ? ['media/index.json'] : []),
  ]
  if (legacyFiles.length > 0) {
    throw new Error(`legacy JSON data requires the one-time SQLite importer before litectl cutover: ${legacyFiles[0]}`)
  }
}

function jsonFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(file => file.endsWith('.json'))
}

export async function putResource(resource: Resource): Promise<void> {
  putResourceSync(resource)
}

export async function getResource(definition: ResourceDefinition, name: string): Promise<Resource | null> {
  return getRefreshResource(database(), definition, name)
}

export async function listResources(definition: ResourceDefinition): Promise<Resource[]> {
  return listRefreshResources(database(), definition)
}

export async function listResourceNames(definition: ResourceDefinition): Promise<string[]> {
  return database()
    .query<{ name: string }, [string, string]>(
      'SELECT name FROM resources WHERE api_version = ? AND kind = ? ORDER BY name',
    )
    .all(definition.apiVersion, definition.storageKind)
    .map(row => row.name)
}

export async function putWindowFile(win: WindowFile): Promise<void> {
  writeTransaction(() => {
    if (getRefreshResource(database(), RefreshWindowResource, win.metadata.name)) {
      throw new Error(`window already exists (archives are immutable): ${win.metadata.name}`)
    }
    const { rawItems, ...resource } = win
    putResourceSync(resource as Resource)
    const platform = String(resource.metadata.labels?.platform ?? '')
    const source = String((resource.spec as Record<string, unknown>).source ?? '')
    rawItems.forEach((raw, ordinal) => {
      putResourceSync({
        apiVersion: API_VERSION,
        kind: RefreshWindowItemResource.kind,
        metadata: {
          name: `${win.metadata.name}-${String(ordinal).padStart(6, '0')}`,
          labels: { window: win.metadata.name, platform, source },
          creationTimestamp: win.metadata.creationTimestamp,
        },
        spec: { window: win.metadata.name, ordinal, raw },
        status: {},
      })
    })
  })
}

export async function readWindowFileFromStore(name: string): Promise<WindowFile> {
  const resource = getRefreshResource(database(), RefreshWindowResource, name)
  if (!resource) throw new Error(`window not found: ${name}`)
  return { ...(resource as WindowFile), kind: RefreshWindowResource.kind, rawItems: readWindowItems(RefreshWindowItemResource, RefreshWindowResource, name) }
}

export async function updateWindowStatusInStore(name: string, status: unknown): Promise<WindowFile> {
  const resource = getRefreshResource(database(), RefreshWindowResource, name)
  if (!resource) throw new Error(`window not found: ${name}`)
  resource.status = status
  putResourceSync(resource)
  return readWindowFileFromStore(name)
}

export async function putFolloweeWindowFile(win: FolloweeWindowFile): Promise<void> {
  writeTransaction(() => {
    if (getRefreshResource(database(), FolloweeWindowResource, win.metadata.name)) {
      throw new Error(`followee window already exists (archives are immutable): ${win.metadata.name}`)
    }
    const { rawItems, ...resource } = win
    putResourceSync(resource as Resource)
    const account = String(resource.metadata.labels?.account ?? (resource.spec as Record<string, unknown>).account ?? '')
    const platform = String(resource.metadata.labels?.platform ?? '')
    rawItems.forEach((raw, ordinal) => {
      putResourceSync({
        apiVersion: API_VERSION,
        kind: FolloweeWindowItemResource.kind,
        metadata: {
          name: `${win.metadata.name}-${String(ordinal).padStart(6, '0')}`,
          labels: { window: win.metadata.name, account, platform },
          creationTimestamp: win.metadata.creationTimestamp,
        },
        spec: { window: win.metadata.name, ordinal, raw },
        status: {},
      })
    })
  })
}

export async function readFolloweeWindowFileFromStore(name: string): Promise<FolloweeWindowFile> {
  const resource = getRefreshResource(database(), FolloweeWindowResource, name)
  if (!resource) throw new Error(`followee window not found: ${name}`)
  return { ...(resource as FolloweeWindowFile), kind: FolloweeWindowResource.kind, rawItems: readWindowItems(FolloweeWindowItemResource, FolloweeWindowResource, name) }
}

export async function readOverlayFromStore(kind: OverlayKind): Promise<Record<string, OverlayEntry>> {
  return readOverlaySync(kind)
}

export async function patchOverlayInStore(
  kind: OverlayKind,
  name: string,
  patch: OverlayEntry,
): Promise<OverlayEntry> {
  return writeTransaction(() => patchOverlaySync(kind, name, patch))
}

export async function patchOverlayManyInStore(kind: OverlayKind, patches: Record<string, OverlayEntry>): Promise<void> {
  writeTransaction(() => {
    for (const [name, patch] of Object.entries(patches)) patchOverlaySync(kind, name, patch)
  })
}

export async function readSchedulerSpecFromStore(): Promise<Record<string, unknown> | null> {
  const scheduler = getRefreshResource(database(), SchedulerResource, 'default')
  return scheduler ? (scheduler.spec as Record<string, unknown>) : null
}

export async function writeSchedulerSpecToStore(spec: Record<string, unknown>): Promise<void> {
  putResourceSync({
    apiVersion: API_VERSION,
    kind: SchedulerResource.kind,
    metadata: { name: 'default' },
    spec,
    status: {},
  })
}

export async function readMediaManifestFromStore(): Promise<Record<string, MediaManifestEntry>> {
  const manifest: Record<string, MediaManifestEntry> = {}
  for (const resource of listRefreshResources(database(), MediaObjectResource)) {
    const spec = resource.spec as Record<string, unknown>
    const originUrl = String(spec.originUrl ?? '')
    const file = String(spec.file ?? '')
    const bytes = Number(spec.bytes ?? 0)
    const width = typeof spec.width === 'number' ? spec.width : undefined
    const height = typeof spec.height === 'number' ? spec.height : undefined
    if (originUrl && file) manifest[originUrl] = { file, bytes, width, height }
  }
  return manifest
}

export async function putMediaObject(originUrl: string, entry: MediaManifestEntry): Promise<void> {
  const [hash, ext = 'bin'] = entry.file.split('.')
  putResourceSync({
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
      ...(entry.width !== undefined ? { width: entry.width } : {}),
      ...(entry.height !== undefined ? { height: entry.height } : {}),
      storage: { type: 'file', path: `media/${entry.file}` },
    },
    status: { phase: 'Available' },
  })
}

function readWindowItems(
  itemDefinition: typeof RefreshWindowItemResource | typeof FolloweeWindowItemResource,
  windowDefinition: typeof RefreshWindowResource | typeof FolloweeWindowResource,
  windowName: string,
): unknown[] {
  return database()
    .query<ItemSpecRow, [string, string, string, string]>(
      `SELECT item.spec_json
         FROM resource_links link
         JOIN resources item ON item.id = link.from_id
         JOIN resources window ON window.id = link.to_id
        WHERE link.relation = 'item-of'
          AND item.api_version = ?
          AND item.kind = ?
          AND window.kind = ?
          AND window.name = ?
        ORDER BY json_extract(item.spec_json, '$.ordinal')`,
    )
    .all(itemDefinition.apiVersion, itemDefinition.storageKind, windowDefinition.storageKind, windowName)
    .map(row => (JSON.parse(row.spec_json) as { raw: unknown }).raw)
}

function readOverlaySync(kind: OverlayKind): Record<string, OverlayEntry> {
  const overlays: Record<string, OverlayEntry> = {}
  for (const resource of listRefreshResources(database(), OverlayEntryResource)) {
    if (resource.metadata.labels?.overlayKind !== kind) continue
    const targetName = resource.metadata.labels.targetName
    if (!targetName) throw new Error(`OverlayEntry/${resource.metadata.name} is missing targetName`)
    overlays[targetName] = (resource.spec as { entry: OverlayEntry }).entry
  }
  return overlays
}

function patchOverlaySync(kind: OverlayKind, name: string, patch: OverlayEntry): OverlayEntry {
  const resourceName = `${kind}-${name}`
  const current = getRefreshResource(database(), OverlayEntryResource, resourceName)
  const entry = mergeOverlayEntry(
    current ? (current.spec as { entry: OverlayEntry }).entry : {},
    patch,
  )
  putResourceSync({
    apiVersion: API_VERSION,
    kind: OverlayEntryResource.kind,
    metadata: { name: resourceName, labels: { overlayKind: kind, targetName: name } },
    spec: { entry },
    status: {},
  })
  return entry
}

function putResourceSync(resource: Resource): void {
  const startedAt = performance.now()
  try {
    putRefreshResource(database(), resource)
    recordResourceWrite(resource.kind)
    recordOperation('resource_store.write_transaction', performance.now() - startedAt)
  } catch (error) {
    recordValidationFailure(resource.kind || 'unknown')
    recordOperation('resource_store.write_transaction_failed', performance.now() - startedAt)
    throw error
  }
}

function writeTransaction<T>(operation: () => T): T {
  return litectlWriteTransaction(database(), operation)
}

function mergeOverlayEntry(current: OverlayEntry, patch: OverlayEntry): OverlayEntry {
  const entry: OverlayEntry = { ...current }
  for (const section of ['labels', 'annotations', 'status'] as const) {
    const values = patch[section]
    if (!values) continue
    const merged: Record<string, unknown> = { ...(entry[section] ?? {}) }
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    entry[section] = merged as never
  }
  return entry
}
