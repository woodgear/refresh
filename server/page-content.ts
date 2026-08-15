import { expandRawItems, normalizeItem } from './normalize'

export function collectMediaUrls(platform: string, rawItems: unknown[]): string[] {
  const urls: string[] = []
  for (const raw of expandRawItems(platform, rawItems)) {
    const normalized = normalizeItem(platform, raw)
    if (!normalized) continue
    for (const media of normalized.message.spec.media) urls.push(media.originUrl)
    const avatar = normalized.message.spec.author?.avatar
    if (avatar && !avatar.startsWith('/')) urls.push(avatar)
    const content = normalized.message.spec.content
    if (!content) continue
    for (const match of content.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      if (match[1].startsWith('http')) urls.push(match[1])
    }
  }
  return urls
}

export function collectMessageRefs(platform: string, rawItems: unknown[]): string[] {
  const refs: string[] = []
  for (const raw of expandRawItems(platform, rawItems)) {
    const normalized = normalizeItem(platform, raw)
    if (normalized) refs.push(normalized.message.name)
  }
  return refs
}
