import { expect, test } from 'bun:test'
import { feedUpdateMessageRefs } from './feed-updates'
import type { FeedSessionResource } from './feed-sessions'
import type { Resource } from './store'

const session: FeedSessionResource = {
  apiVersion: 'radar/v1',
  kind: 'FeedSession',
  metadata: { name: 'feed-1', creationTimestamp: '2026-08-15T10:00:00.000Z' },
  spec: { source: 'source-a', generation: 'generation-1' },
  status: { nextCursor: 'next', hasMore: true, pageCount: 1, lastPage: 'page-1', lastWindow: 'window-head' },
}

function message(name: string, sources: string, lastSeenWindow: string): Resource {
  return {
    apiVersion: 'radar/v1',
    kind: 'Message',
    metadata: {
      name,
      annotations: { 'radar/sources': sources, 'radar/lastSeenWindow': lastSeenWindow },
    },
    spec: {},
    status: {},
  }
}

const windows = new Map<string, Resource>([
  ['window-before', {
    apiVersion: 'radar/v1', kind: 'RefreshWindow',
    metadata: { name: 'window-before', creationTimestamp: '2026-08-15T09:59:00.000Z' }, spec: {}, status: {},
  }],
  ['window-after', {
    apiVersion: 'radar/v1', kind: 'RefreshWindow',
    metadata: { name: 'window-after', creationTimestamp: '2026-08-15T10:01:00.000Z' }, spec: {}, status: {},
  }],
])

test('updates include only unpublished source messages observed after generation start', () => {
  const updates = feedUpdateMessageRefs(
    session,
    ['already-published'],
    [
      message('already-published', 'source-a', 'window-after'),
      message('old', 'source-a', 'window-before'),
      message('other-source', 'source-b', 'window-after'),
      message('new', 'source-a,source-b', 'window-after'),
    ],
    name => windows.get(name) ?? null,
  )
  expect(updates).toEqual(['new'])
})

test('updates fail when a message references a missing window', () => {
  expect(() => feedUpdateMessageRefs(
    session,
    [],
    [message('broken', 'source-a', 'window-missing')],
    name => windows.get(name) ?? null,
  )).toThrow('Message/broken references missing RefreshWindow/window-missing')
})
