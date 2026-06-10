import { mkdir, readFile, readdir, rename, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 可被测试覆盖的根目录（RADAR_DATA_DIR 环境变量优先）
export const DATA_DIR = process.env.RADAR_DATA_DIR ?? join(__dirname, '..', 'data')
export const WINDOWS_DIR = join(DATA_DIR, 'windows')
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

// ---------- 初始化 ----------

export async function ensureDirs(): Promise<void> {
  await Promise.all([
    mkdir(WINDOWS_DIR, { recursive: true }),
    mkdir(OVERLAY_DIR, { recursive: true }),
    mkdir(MEDIA_DIR, { recursive: true }),
  ])
}

// ---------- Window 档案（只追加，不可变） ----------

function windowPath(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid window name: ${name}`)
  }
  return join(WINDOWS_DIR, `${name}.json`)
}

export async function listWindowNames(): Promise<string[]> {
  await ensureDirs()
  const files = await readdir(WINDOWS_DIR)
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -'.json'.length))
    .sort()
}

export async function readWindowFile(name: string): Promise<WindowFile> {
  const content = await readFile(windowPath(name), 'utf-8')
  return JSON.parse(content) as WindowFile
}

/** 追加一个 window 档案。档案不可变：重名即报错，绝不覆盖。 */
export async function appendWindow(win: WindowFile): Promise<void> {
  await ensureDirs()
  const path = windowPath(win.metadata.name)
  if (existsSync(path)) {
    throw new Error(`window already exists (archives are immutable): ${win.metadata.name}`)
  }
  await atomicWrite(path, JSON.stringify(win, null, 2))
}

/**
 * 例外：RefreshWindow 的 status 在 Running → Succeeded/Failed 期间需要推进。
 * 只允许更新 status，spec/rawItems 一经写入不可变。
 */
export async function updateWindowStatus(name: string, status: unknown): Promise<WindowFile> {
  const win = await readWindowFile(name)
  win.status = status
  await atomicWrite(windowPath(name), JSON.stringify(win, null, 2))
  return win
}

// ---------- Overlay（可变用户态，按 kind 一个文件） ----------

export interface OverlayEntry {
  labels?: Record<string, string>
  annotations?: Record<string, string>
  status?: Record<string, unknown>
}

export type OverlayMap = Record<string, OverlayEntry>

const OVERLAY_KINDS = ['messages', 'authors'] as const
export type OverlayKind = (typeof OVERLAY_KINDS)[number]

function overlayPath(kind: OverlayKind): string {
  return join(OVERLAY_DIR, `${kind}.json`)
}

export async function readOverlay(kind: OverlayKind): Promise<OverlayMap> {
  try {
    return JSON.parse(await readFile(overlayPath(kind), 'utf-8')) as OverlayMap
  } catch {
    return {}
  }
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
  const all = await readOverlay(kind)
  const entry = all[name] ?? {}
  for (const section of ['labels', 'annotations', 'status'] as const) {
    const p = patch[section]
    if (!p) continue
    const merged: Record<string, unknown> = { ...(entry[section] ?? {}) }
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete merged[k]
      else merged[k] = v
    }
    entry[section] = merged as never
  }
  all[name] = entry
  await atomicWrite(overlayPath(kind), JSON.stringify(all, null, 2))
  return entry
}

/** 批量合并多个 entry（单次读写文件），mark-read 这类批量操作用 */
export async function patchOverlayMany(kind: OverlayKind, patches: Record<string, OverlayEntry>): Promise<void> {
  await ensureDirs()
  const all = await readOverlay(kind)
  for (const [name, patch] of Object.entries(patches)) {
    const entry = all[name] ?? {}
    for (const section of ['labels', 'annotations', 'status'] as const) {
      const p = patch[section]
      if (!p) continue
      const merged: Record<string, unknown> = { ...(entry[section] ?? {}) }
      for (const [k, v] of Object.entries(p)) {
        if (v === null) delete merged[k]
        else merged[k] = v
      }
      entry[section] = merged as never
    }
    all[name] = entry
  }
  await atomicWrite(overlayPath(kind), JSON.stringify(all, null, 2))
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

// ---------- 工具 ----------

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, path)
}
