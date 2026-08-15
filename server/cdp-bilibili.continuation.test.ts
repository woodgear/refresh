import { expect, test } from 'bun:test'
import {
  collectBilibiliPages,
  type BilibiliPageLoader,
} from './cdp-bilibili'

test('follow continuation keeps whole upstream pages and resumes from offset', async () => {
  const calls: Array<string | null> = []
  const loader: BilibiliPageLoader = {
    async follow(offset) {
      calls.push(offset)
      if (offset === null) return { items: ['a', 'b'], nextOffset: 'offset-1', hasMore: true }
      if (offset === 'offset-1') return { items: ['c', 'd'], nextOffset: 'offset-2', hasMore: true }
      if (offset === 'offset-2') return { items: ['e'], nextOffset: '', hasMore: false }
      throw new Error(`unexpected offset: ${offset}`)
    },
    async popular() {
      throw new Error('popular loader should not be called')
    },
    async recommend() {
      throw new Error('recommend loader should not be called')
    },
  }

  const head = await collectBilibiliPages('follow', 3, null, loader, async () => {})
  expect(head.rawItems).toEqual(['a', 'b', 'c', 'd'])
  expect(head.hasMore).toBe(true)

  const next = await collectBilibiliPages('follow', 3, head.nextCursor!, loader, async () => {})
  expect(next.rawItems).toEqual(['e'])
  expect(next.nextCursor).toBeNull()
  expect(next.hasMore).toBe(false)
  expect(calls).toEqual([null, 'offset-1', 'offset-2'])
})

test('popular continuation resumes from the next page number', async () => {
  const calls: number[] = []
  const loader: BilibiliPageLoader = {
    async follow() {
      throw new Error('follow loader should not be called')
    },
    async popular(page) {
      calls.push(page)
      if (page === 1) return { items: ['a', 'b'], noMore: false }
      if (page === 2) return { items: ['c'], noMore: true }
      throw new Error(`unexpected page: ${page}`)
    },
    async recommend() {
      throw new Error('recommend loader should not be called')
    },
  }

  const head = await collectBilibiliPages('popular', 1, null, loader, async () => {})
  expect(head.rawItems).toEqual(['a', 'b'])
  expect(head.hasMore).toBe(true)

  const next = await collectBilibiliPages('popular', 1, head.nextCursor!, loader, async () => {})
  expect(next.rawItems).toEqual(['c'])
  expect(next.hasMore).toBe(false)
  expect(calls).toEqual([1, 2])
})

test('recommend continuation advances the observed fresh counter sequence', async () => {
  const calls: Array<{ freshIndex: number; freshIndexOneHour: number; brush: number; fetchRow: number }> = []
  const loader: BilibiliPageLoader = {
    async follow() {
      throw new Error('follow loader should not be called')
    },
    async popular() {
      throw new Error('popular loader should not be called')
    },
    async recommend(input) {
      calls.push({ ...input })
      return { items: input.freshIndex === 1 ? ['a', 'b'] : ['c', 'd'] }
    },
  }

  const head = await collectBilibiliPages('recommend', 1, null, loader, async () => {})
  expect(head.rawItems).toEqual(['a', 'b'])
  expect(head.hasMore).toBe(true)

  const next = await collectBilibiliPages('recommend', 1, head.nextCursor!, loader, async () => {})
  expect(next.rawItems).toEqual(['c', 'd'])
  expect(next.hasMore).toBe(true)
  expect(calls).toEqual([
    { freshIndex: 1, freshIndexOneHour: 1, brush: 1, fetchRow: 4 },
    { freshIndex: 2, freshIndexOneHour: 2, brush: 2, fetchRow: 7 },
  ])
})

test('cursor capability mismatch and malformed cursors fail explicitly', async () => {
  const loader: BilibiliPageLoader = {
    async follow() { return { items: [], nextOffset: '', hasMore: false } },
    async popular() { return { items: ['a'], noMore: false } },
    async recommend() { return { items: ['a'] } },
  }
  const popular = await collectBilibiliPages('popular', 1, null, loader, async () => {})
  const recommend = await collectBilibiliPages('recommend', 1, null, loader, async () => {})

  await expect(collectBilibiliPages('follow', 1, popular.nextCursor!, loader)).rejects.toThrow(
    'invalid bilibili continuation cursor',
  )
  await expect(collectBilibiliPages('follow', 1, '{"version":1}', loader)).rejects.toThrow(
    'invalid bilibili continuation cursor',
  )
  await expect(collectBilibiliPages('popular', 1, recommend.nextCursor!, loader)).rejects.toThrow(
    'invalid bilibili continuation cursor',
  )
  await expect(collectBilibiliPages(
    'recommend',
    1,
    '{"version":1,"capability":"recommend","freshIndex":2,"freshIndexOneHour":2,"brush":2,"fetchRow":8}',
    loader,
  )).rejects.toThrow('invalid bilibili continuation cursor')
})
