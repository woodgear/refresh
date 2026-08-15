import { expect, test } from 'bun:test'
import { collectTwitterPages, type TwitterPageLoader } from './cdp-twitter'

test('twitter continuation preserves full responses and resumes from bottom cursor', async () => {
  const calls: Array<string | null> = []
  const loader: TwitterPageLoader = async cursor => {
    calls.push(cursor)
    return cursor === null
      ? timelinePayload(['a', 'b'], 'bottom-1')
      : timelinePayload(['c'], null)
  }

  const head = await collectTwitterPages('following', 1, null, loader, async () => {})
  expect(head.rawItems.map(item => (item as { rest_id: string }).rest_id)).toEqual(['a', 'b'])
  expect(head.hasMore).toBe(true)

  const next = await collectTwitterPages('following', 1, head.nextCursor!, loader, async () => {})
  expect(next.rawItems.map(item => (item as { rest_id: string }).rest_id)).toEqual(['c'])
  expect(next.hasMore).toBe(false)
  expect(calls).toEqual([null, 'bottom-1'])
})

test('multiple upstream responses deduplicate tweets before committing a logical page', async () => {
  const loader: TwitterPageLoader = async cursor => cursor === null
    ? timelinePayload(['a', 'b'], 'bottom-1')
    : timelinePayload(['b', 'c'], 'bottom-2')

  const page = await collectTwitterPages('recommend', 3, null, loader, async () => {})
  expect(page.rawItems.map(item => (item as { rest_id: string }).rest_id)).toEqual(['a', 'b', 'c'])
  expect(page.hasMore).toBe(true)
})

test('twitter cursor is capability-bound and malformed payloads fail explicitly', async () => {
  const loader: TwitterPageLoader = async () => timelinePayload(['a'], 'bottom-1')
  const recommend = await collectTwitterPages('recommend', 1, null, loader, async () => {})

  await expect(collectTwitterPages('following', 1, recommend.nextCursor!, loader)).rejects.toThrow(
    'invalid twitter continuation cursor',
  )
  await expect(collectTwitterPages('recommend', 1, '{"version":1}', loader)).rejects.toThrow(
    'invalid twitter continuation cursor',
  )
  await expect(collectTwitterPages('recommend', 1, null, async () => ({ data: {} }), async () => {})).rejects.toThrow(
    'twitter timeline payload.data.home must be an object',
  )
})

function timelinePayload(tweetIds: string[], bottomCursor: string | null): unknown {
  const entries = tweetIds.map(id => ({
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: { result: { __typename: 'Tweet', rest_id: id, legacy: {} } },
      },
    },
  }))
  if (bottomCursor) {
    entries.push({
      content: {
        entryType: 'TimelineTimelineCursor',
        cursorType: 'Bottom',
        value: bottomCursor,
      },
    } as never)
  }
  return {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [{ type: 'TimelineAddEntries', entries }],
        },
      },
    },
  }
}
