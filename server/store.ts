import { mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  initResourceStore,
  listResourceNames,
  putWindowFile,
  readWindowFileFromStore,
  updateWindowStatusInStore,
  putFolloweeWindowFile,
  readFolloweeWindowFileFromStore,
  readOverlayFromStore,
  patchOverlayInStore,
  patchOverlayManyInStore,
  readSchedulerSpecFromStore as resourceReadSchedulerSpec,
  writeSchedulerSpecToStore as resourceWriteSchedulerSpec,
  readMediaManifestFromStore as resourceReadMediaManifest,
  putMediaObject as resourcePutMediaObject,
  putResource as resourcePutResource,
  getResource as resourceGetResource,
  listResources as resourceListResources,
} from './resource-store'
import { FolloweeWindowResource, RefreshWindowResource, type ResourceDefinition } from './resource-definitions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 可被测试覆盖的根目录（RADAR_DATA_DIR 环境变量优先）
export const DATA_DIR = process.env.RADAR_DATA_DIR ?? join(__dirname, '..', 'data')
export const WINDOWS_DIR = join(DATA_DIR, 'windows')
export const FOLLOWEE_WINDOWS_DIR = join(DATA_DIR, 'followee-windows')
export const OVERLAY_DIR = join(DATA_DIR, 'overlay')
export const MEDIA_DIR = join(DATA_DIR, 'media')

// ---------- 资源信封 ----------

export interface ResourceMeta {
  name: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  creationTimestamp?: string
}

export interface Resource<S = unknown, T = unknown> {
  apiVersion: 'radar/v1'
  kind: string
  metadata: ResourceMeta
  spec: S
  status: T
}

// RefreshWindow 档案文件 = RefreshWindow 资源 + 本轮抓到的原始 payload
// rawItems 是 fetcher 返回的原样数据，Message 的 spec.raw 由此派生
export interface WindowFile extends Resource {
  kind: 'RefreshWindow'
  rawItems: unknown[]
}

export interface FolloweeWindowFile extends Resource {
  kind: 'FolloweeWindow'
  rawItems: unknown[]
}

// ---------- 初始化 ----------

export async function ensureDirs(): Promise<void> {
  await Promise.all([
    mkdir(WINDOWS_DIR, { recursive: true }),
    mkdir(FOLLOWEE_WINDOWS_DIR, { recursive: true }),
    mkdir(OVERLAY_DIR, { recursive: true }),
    mkdir(MEDIA_DIR, { recursive: true }),
  ])
  await initResourceStore({ dataDir: DATA_DIR, windowsDir: WINDOWS_DIR, followeeWindowsDir: FOLLOWEE_WINDOWS_DIR, overlayDir: OVERLAY_DIR, mediaDir: MEDIA_DIR })
}

// ---------- Window 档案（只追加，不可变） ----------

export async function listWindowNames(): Promise<string[]> {
  await ensureDirs()
  return listResourceNames(RefreshWindowResource)
}

export async function readWindowFile(name: string): Promise<WindowFile> {
  return readWindowFileFromStore(name)
}

/** 追加一个 window 档案。档案不可变：重名即报错，绝不覆盖。 */
export async function appendWindow(win: WindowFile): Promise<void> {
  await ensureDirs()
  await putWindowFile(win)
}

/**
 * 例外：RefreshWindow 的 status 在 Running → Succeeded/Failed 期间需要推进。
 * 只允许更新 status，spec/rawItems 一经写入不可变。
 */
export async function updateWindowStatus(name: string, status: unknown): Promise<WindowFile> {
  return updateWindowStatusInStore(name, status)
}

// ---------- FolloweeWindow 档案（只追加，不可变） ----------

export async function listFolloweeWindowNames(): Promise<string[]> {
  await ensureDirs()
  return listResourceNames(FolloweeWindowResource)
}

export async function readFolloweeWindowFile(name: string): Promise<FolloweeWindowFile> {
  return readFolloweeWindowFileFromStore(name)
}

export async function appendFolloweeWindow(win: FolloweeWindowFile): Promise<void> {
  await ensureDirs()
  await putFolloweeWindowFile(win)
}

// ---------- Overlay（可变用户态，按 kind 一个文件） ----------

export interface OverlayEntry {
  labels?: Record<string, string>
  annotations?: Record<string, string>
  status?: Record<string, unknown>
}

export type OverlayMap = Record<string, OverlayEntry>

const OVERLAY_KINDS = ['messages', 'authors', 'followees'] as const
export type OverlayKind = (typeof OVERLAY_KINDS)[number]

export async function readOverlay(kind: OverlayKind): Promise<OverlayMap> {
  await ensureDirs()
  return readOverlayFromStore(kind)
}

/**
 * 合并一个 patch 到 overlay。labels/annotations/status 各自浅合并；
 * patch 中值为 null 表示删除该 key。返回合并后的 entry。
 */
export async function patchOverlay(
  kind: OverlayKind,
  name: string,
  patch: OverlayEntry,
): Promise<OverlayEntry> {
  await ensureDirs()
  return patchOverlayInStore(kind, name, patch)
}

/** 批量合并多个 entry（单次读写文件），mark-read 这类批量操作用 */
export async function patchOverlayMany(kind: OverlayKind, patches: Record<string, OverlayEntry>): Promise<void> {
  await ensureDirs()
  await patchOverlayManyInStore(kind, patches)
}

/** 档案派生的资源 + overlay 用户态 → 完整对象。overlay 的 labels/annotations 浅覆盖，status 浅合并。 */
export function applyOverlay<S, T extends Record<string, unknown>>(
  resource: Resource<S, T>,
  entry: OverlayEntry | undefined,
): Resource<S, T> {
  if (!entry) return resource
  return {
    ...resource,
    metadata: {
      ...resource.metadata,
      labels: { ...resource.metadata.labels, ...entry.labels },
      annotations: { ...resource.metadata.annotations, ...entry.annotations },
    },
    status: { ...resource.status, ...entry.status } as T,
  }
}

// ---------- Singleton / manifest resources ----------

export async function readSchedulerSpecFromStore(): Promise<Record<string, unknown> | null> {
  await ensureDirs()
  return resourceReadSchedulerSpec()
}

export async function writeSchedulerSpecToStore(spec: Record<string, unknown>): Promise<void> {
  await ensureDirs()
  await resourceWriteSchedulerSpec(spec)
}

export async function readMediaManifestFromStore(): Promise<Record<string, { file: string; bytes: number }>> {
  await ensureDirs()
  return resourceReadMediaManifest()
}

export async function putMediaObject(originUrl: string, entry: { file: string; bytes: number }): Promise<void> {
  await ensureDirs()
  await resourcePutMediaObject(originUrl, entry)
}

export async function putStoredResource(resource: Resource): Promise<void> {
  await ensureDirs()
  await resourcePutResource(resource)
}

export async function getStoredResource(definition: ResourceDefinition, name: string): Promise<Resource | null> {
  await ensureDirs()
  return resourceGetResource(definition, name)
}

export async function listStoredResources(definition: ResourceDefinition): Promise<Resource[]> {
  await ensureDirs()
  return resourceListResources(definition)
}
