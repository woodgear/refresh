import { expect, test } from 'bun:test'
import type { SourceConfig } from './config'
import { MockContinuationFetcher, type MockPage } from './fetcher'

const source: SourceConfig = {
  name: 'mock-continuation',
  account: 'mock-account',
  platform: 'zhihu',
  capability: 'recommend',
}

const pages: readonly MockPage[] = [
  { inputCursor: null, rawItems: ['a', 'b'], nextCursor: 'cursor-1', fetchedAt: 1 },
  { inputCursor: 'cursor-1', rawItems: ['c', 'd'], nextCursor: 'cursor-2', fetchedAt: 2 },
  { inputCursor: 'cursor-2', rawItems: ['e'], nextCursor: null, fetchedAt: 3 },
]

const log = () => {}

test('restart then continue follows opaque cursors without duplicates', async () => {
  const fetcher = new MockContinuationFetcher({ [source.name]: pages })
  const head = await fetcher.fetchHead(source, 2, log)
  let cursor = head.nextCursor
  const ordered = [...head.rawItems]

  while (cursor !== null) {
    const page = await fetcher.fetchNext(source, cursor, 2, log)
    ordered.push(...page.rawItems)
    cursor = page.nextCursor
  }

  expect(ordered).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(new Set(ordered).size).toBe(ordered.length)
  expect(fetcher.calls.map(call => call.cursor)).toEqual([null, 'cursor-1', 'cursor-2'])
})

test('a failed page does not advance the caller cursor and can be retried', async () => {
  const fetcher = new MockContinuationFetcher({ [source.name]: pages })
  const head = await fetcher.fetchHead(source, 2, log)
  let cursor = head.nextCursor
  expect(cursor).toBe('cursor-1')

  fetcher.failNext(source.name, cursor!, new Error('archive write failed'))
  await expect(fetcher.fetchNext(source, cursor!, 2, log)).rejects.toThrow('archive write failed')
  expect(cursor).toBe('cursor-1')

  const retry = await fetcher.fetchNext(source, cursor!, 2, log)
  cursor = retry.nextCursor
  expect(retry.rawItems).toEqual(['c', 'd'])
  expect(cursor).toBe('cursor-2')
  expect(fetcher.calls.map(call => call.cursor)).toEqual([null, 'cursor-1', 'cursor-1'])
})

test('unknown cursors fail explicitly', async () => {
  const fetcher = new MockContinuationFetcher({ [source.name]: pages })
  await expect(fetcher.fetchNext(source, 'missing', 2, log)).rejects.toThrow(
    'mock continuation page not found: mock-continuation cursor=missing',
  )
})
