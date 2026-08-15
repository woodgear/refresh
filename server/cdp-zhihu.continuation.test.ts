import { expect, test } from 'bun:test'
import { collectZhihuPages, type ZhihuPageLoader } from './cdp-zhihu'

test('recommend continuation preserves full pages and resumes a validated next URL', async () => {
  const calls: string[] = []
  const loader: ZhihuPageLoader = async url => {
    calls.push(url)
    if (url.includes('cursor=second')) {
      return { items: [{ id: 'd' }], nextUrl: null, isEnd: true }
    }
    return {
      items: [
        { id: 'a' },
        { id: 'ad', type: 'feed_advert' },
        { id: 'group', type: 'feed_group', list: [{ id: 'b' }, { id: 'c' }] },
      ],
      nextUrl: 'https://www.zhihu.com/api/v3/feed/topstory/recommend?cursor=second',
      isEnd: false,
    }
  }

  const head = await collectZhihuPages('recommend', 2, null, loader, async () => {})
  expect(head.rawItems).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  expect(head.hasMore).toBe(true)

  const next = await collectZhihuPages('recommend', 2, head.nextCursor!, loader, async () => {})
  expect(next.rawItems).toEqual([{ id: 'd' }])
  expect(next.hasMore).toBe(false)
  expect(calls).toEqual([
    '/api/v3/feed/topstory/recommend?desktop=true&limit=6',
    '/api/v3/feed/topstory/recommend?cursor=second',
  ])
})

test('cursor rejects another capability and non-Zhihu URLs', async () => {
  const recommendLoader: ZhihuPageLoader = async () => ({
    items: [{ id: 'a' }],
    nextUrl: '/api/v3/feed/topstory/recommend?cursor=second',
    isEnd: false,
  })
  const recommend = await collectZhihuPages('recommend', 1, null, recommendLoader, async () => {})
  const terminalLoader: ZhihuPageLoader = async () => ({ items: [], nextUrl: null, isEnd: true })

  await expect(collectZhihuPages('follow', 1, recommend.nextCursor!, terminalLoader)).rejects.toThrow(
    'invalid zhihu continuation cursor',
  )

  const externalLoader: ZhihuPageLoader = async () => ({
    items: [{ id: 'a' }],
    nextUrl: 'https://example.com/api/v3/feed/topstory/recommend?cursor=second',
    isEnd: false,
  })
  await expect(collectZhihuPages('recommend', 1, null, externalLoader, async () => {})).rejects.toThrow(
    'invalid zhihu continuation URL',
  )
})

test('non-terminal pages require a next URL', async () => {
  const loader: ZhihuPageLoader = async () => ({ items: [{ id: 'a' }], nextUrl: null, isEnd: false })
  await expect(collectZhihuPages('follow', 1, null, loader, async () => {})).rejects.toThrow(
    'zhihu follow page is not terminal but has no next URL',
  )
})
