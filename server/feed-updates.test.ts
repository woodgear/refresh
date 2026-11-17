import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 查询已经下推到 SQL，所以这里用真实的临时资源库验证，而不是内存 fixture。
const dataDir = mkdtempSync(join(tmpdir(), 'refresh-feed-updates-'))
process.env.RADAR_DATA_DIR = dataDir

const { ensureDirs, putStoredResource } = await import('./store')
const { feedUpdateMessageRefs } = await import('./feed-updates')

await ensureDirs()

const session = {
  apiVersion: 'radar/v1',
  kind: 'FeedSession' as const,
  metadata: { name: 'feed-1', creationTimestamp: '2026-08-15T10:00:00.000Z' },
  spec: { source: 'source-a', generation: 'generation-1' },
  status: { hasMore: true, pageCount: 1, lastPage: 'page-1', lastWindow: 'window-head' },
}

await putStoredResource({
  apiVersion: 'radar/v1',
  kind: 'RefreshWindow',
  metadata: { name: 'window-before', creationTimestamp: '2026-08-15T09:59:00.000Z' },
  spec: { source: 'source-a', account: 'zhihu-main', count: 1, trigger: 'scheduled' },
  status: { phase: 'Succeeded' },
} as never)
await putStoredResource({
  apiVersion: 'radar/v1',
  kind: 'RefreshWindow',
  metadata: { name: 'window-after', creationTimestamp: '2026-08-15T10:01:00.000Z' },
  spec: { source: 'source-a', account: 'zhihu-main', count: 1, trigger: 'scheduled' },
  status: { phase: 'Succeeded' },
} as never)

const seeded: [string, string, string][] = [
  ['already-published', 'source-a', 'window-after'],
  ['old', 'source-a', 'window-before'],
  ['other-source', 'source-b', 'window-after'],
  ['new', 'source-a,source-b', 'window-after'],
]
for (const [name, sources, window] of seeded) {
  await putStoredResource({
    apiVersion: 'radar/v1',
    kind: 'Message',
    metadata: {
      name,
      labels: { platform: 'zhihu', source: sources.split(',')[0]!, author: 'zhihu-mock-author' },
      annotations: { 'radar/sources': sources, 'radar/lastSeenWindow': window },
      creationTimestamp: '2026-08-15T10:00:30.000Z',
    },
    spec: { text: name, media: [], content: null },
    status: { hydrated: false },
  } as never)
}

test('updates 只包含未发布、且 window 晚于 session 创建的 message', () => {
  // other-source 只属于 source-b，不属于这个 session 的 source-a，所以不算新内容
  const updates = feedUpdateMessageRefs(session as never, ['already-published'])
  expect(updates).toEqual(['new'])
})

test('已全部发布时没有新内容', () => {
  const updates = feedUpdateMessageRefs(session as never, seeded.map(([name]) => name))
  expect(updates).toEqual([])
})
