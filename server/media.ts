// 媒体本地化（docs/design.md §6）：抓取时下载图片/头像到 data/media/<sha256>.<ext>，
// originUrl → 本地文件的映射由 ResourceStore 里的 MediaObject 资源维护。
// 视频不下载（只存 poster + playUrl）。知乎图床有 referer 防盗链，下载时带 referer。

import { createHash } from 'crypto'
import { writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { MEDIA_DIR, ensureDirs, readMediaManifestFromStore, putMediaObject } from './store'

interface ManifestEntry {
  file: string // <sha256>.<ext>
  bytes: number
}

let manifest: Record<string, ManifestEntry> | null = null

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
)

function refererFor(url: string): string | undefined {
  if (/zhimg\.com|zhihu\.com/.test(url)) return 'https://www.zhihu.com/'
  return undefined
}

// Bun 的 fetch 不读 macOS 系统代理；直连失败时经代理重试（pbs.twimg.com 等需翻墙的图床）
const PROXY = process.env.RADAR_PROXY ?? process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7890'
// 同一 host 直连失败过就直接走代理，省掉每个 URL 都等一次直连超时
const directFailedHosts = new Set<string>()

async function fetchMaybeProxy(url: string, headers: Record<string, string>): Promise<Response> {
  const host = url.startsWith('data:') ? null : new URL(url).hostname
  const viaProxy = () => fetch(url, { headers, signal: AbortSignal.timeout(30_000), proxy: PROXY } as RequestInit)

  if (host && directFailedHosts.has(host)) return viaProxy()
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) })
    if (res.ok) return res
    throw new Error(`http ${res.status}`)
  } catch (directErr) {
    if (!host) throw directErr
    try {
      const res = await viaProxy()
      directFailedHosts.add(host)
      return res
    } catch {
      throw directErr
    }
  }
}

/** 已本地化则返回 /api/v1/media/<file>，否则 null（同步查 manifest 内存态） */
export function localMediaUrl(originUrl: string): string | null {
  const entry = manifest?.[originUrl]
  return entry ? `/api/v1/media/${entry.file}` : null
}

/** 下载并登记一个媒体 URL（幂等）；失败返回 null，不抛 */
export async function downloadMedia(originUrl: string, log: (s: string) => void = () => {}): Promise<string | null> {
  await ensureDirs()
  const m = manifest ?? (manifest = await readMediaManifestFromStore())
  if (m[originUrl]) return `/api/v1/media/${m[originUrl].file}`
  try {
    const referer = refererFor(originUrl)
    const res = await fetchMaybeProxy(originUrl, referer ? { Referer: referer } : {})
    if (!res.ok) throw new Error(`http ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    // data: URL 的 fetch 可能不带 content-type 头，从 URL 本身解析
    const dataMime = originUrl.startsWith('data:') ? originUrl.slice(5).split(/[;,]/)[0] : null
    const mime = (res.headers.get('content-type') ?? dataMime ?? '').split(';')[0].trim()
    const ext = EXT_BY_MIME[mime] ?? (dataMime ? EXT_BY_MIME[dataMime] : null) ?? guessExt(originUrl) ?? 'bin'
    const hash = createHash('sha256').update(bytes).digest('hex')
    const file = `${hash}.${ext}`
    const path = join(MEDIA_DIR, file)
    if (!existsSync(path)) await writeFile(path, bytes)
    m[originUrl] = { file, bytes: bytes.length }
    await putMediaObject(originUrl, m[originUrl])
    return `/api/v1/media/${file}`
  } catch (err) {
    log(`media download failed: ${originUrl.slice(0, 80)}: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

function guessExt(url: string): string | null {
  const m = url.match(/\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i)
  if (!m) return null
  const ext = m[1].toLowerCase()
  return ext === 'jpeg' ? 'jpg' : ext
}

/** 并发受限地批量下载 */
export async function downloadAll(urls: string[], log: (s: string) => void, concurrency = 4): Promise<void> {
  const queue = [...new Set(urls)]
  let done = 0
  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift()!
      await downloadMedia(url, log)
      done++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  if (done > 0) log(`media: ${done} urls processed`)
}

export async function initMedia(): Promise<void> {
  manifest = await readMediaManifestFromStore()
}

export function mediaFilePath(file: string): string | null {
  if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(file)) return null
  return join(MEDIA_DIR, file)
}

/** 流式代理一个媒体 URL（视频播放用）：透传 Range，直连失败走代理。
 *  不能给流式响应挂超时 signal（会在播放中途掐断 body），超时只管"等响应头"阶段。 */
export async function proxyMediaFetch(url: string, range?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  const referer = refererFor(url)
  if (referer) headers.Referer = referer
  if (range) headers.Range = range

  const host = new URL(url).hostname
  if (!directFailedHosts.has(host)) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal })
      clearTimeout(timer)
      if (res.ok) return res
      throw new Error(`http ${res.status}`)
    } catch {
      clearTimeout(timer)
      directFailedHosts.add(host)
    }
  }
  return fetch(url, { headers, proxy: PROXY } as RequestInit)
}

/** 允许代理的外部媒体域（防开放代理） */
export function isAllowedMediaHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === 'video.twimg.com' ||
      host === 'pbs.twimg.com' ||
      host.endsWith('.zhimg.com') ||
      host.endsWith('.zhihu.com') ||
      host.endsWith('.bilivideo.com') ||
      host.endsWith('.hdslb.com')
    )
  } catch {
    return false
  }
}
