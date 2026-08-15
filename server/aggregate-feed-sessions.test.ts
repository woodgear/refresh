import { expect, test } from 'bun:test'
import type { SourceConfig } from './config'
import {
  AggregateFeedSessionService,
  publicFeedSourcePage,
  rankRoundRobin,
  type AggregateFeedPageResource,
  type AggregateFeedSessionRepository,
  type FeedSourcePageResource,
} from './aggregate-feed-sessions'
import {
  type AggregateFeedSessionResource,
  type FeedPageArchive,
  type FeedPageArchiver,
  type FeedSessionResource,
  publicFeedSession,
} from './feed-sessions'
import { MockContinuationFetcher, type MockPage } from './fetcher'

const zhihu: SourceConfig = {
  name: 'zhihu-main-recommend',
  account: 'zhihu-main',
  platform: 'zhihu',
  capability: 'recommend',
}
const twitter: SourceConfig = {
  name: 'twitter-main-recommend',
  account: 'twitter-main',
  platform: 'twitter',
  capability: 'recommend',
}

const pages: Record<string, MockPage[]> = {
  [zhihu.name]: [
    { inputCursor: null, rawItems: ['z1', 'shared'], nextCursor: 'z-next', fetchedAt: 1 },
    { inputCursor: 'z-next', rawItems: ['z3'], nextCursor: null, fetchedAt: 2 },
  ],
  [twitter.name]: [
    { inputCursor: null, rawItems: ['t1', 'shared'], nextCursor: 't-next', fetchedAt: 1 },
    { inputCursor: 't-next', rawItems: ['t3'], nextCursor: null, fetchedAt: 2 },
  ],
}

class MemoryAggregateRepository implements AggregateFeedSessionRepository {
  readonly sessions = new Map<string, FeedSessionResource>()
  readonly pages = new Map<string, AggregateFeedPageResource>()
  readonly sourcePages = new Map<string, FeedSourcePageResource>()

  async get(name: string): Promise<FeedSessionResource | null> {
    const session = this.sessions.get(name)
    return session ? structuredClone(session) : null
  }

  async listPages(name: string): Promise<AggregateFeedPageResource[]> {
    return [...this.pages.values()]
      .filter(page => page.spec.session === name)
      .map(page => structuredClone(page))
  }

  async commit(
    session: AggregateFeedSessionResource,
    page: AggregateFeedPageResource,
    sourcePages: FeedSourcePageResource[],
  ): Promise<void> {
    if (this.pages.has(page.metadata.name)) throw new Error(`aggregate feed page already exists: ${page.metadata.name}`)
    this.sessions.set(session.metadata.name, structuredClone(session))
    this.pages.set(page.metadata.name, structuredClone(page))
    for (const sourcePage of sourcePages) {
      this.sourcePages.set(sourcePage.metadata.name, structuredClone(sourcePage))
    }
  }
}

class MemoryArchiver implements FeedPageArchiver {
  readonly calls: FeedPageArchive[] = []
  failSource: string | null = null

  async archive(input: FeedPageArchive): Promise<{ windowName: string; messageRefs: string[] }> {
    this.calls.push(structuredClone(input))
    if (input.source.name === this.failSource) throw new Error(`archive failed: ${input.source.name}`)
    return {
      windowName: `${input.sessionName}-${input.source.name}-window-${input.ordinal}`,
      messageRefs: input.result.rawItems.map(String),
    }
  }
}

function service(
  repository: MemoryAggregateRepository,
  fetcher: MockContinuationFetcher,
  archiver = new MemoryArchiver(),
): AggregateFeedSessionService {
  return new AggregateFeedSessionService(repository, fetcher, archiver, () => 'generation-1', () => {})
}

test('aggregate restart and continuation rank sources deterministically without republishing duplicates', async () => {
  const repository = new MemoryAggregateRepository()
  const fetcher = new MockContinuationFetcher(pages)
  const feed = service(repository, fetcher)

  const first = await feed.restart([zhihu, twitter], 4)
  expect(first.page.spec.messageRefs).toEqual(['z1', 't1', 'shared'])
  expect(first.sourcePages.map(page => page.spec.messageRefs)).toEqual([
    ['z1', 'shared'],
    ['t1', 'shared'],
  ])

  const second = await service(repository, fetcher).continue(first.session.metadata.name, 4)
  expect(second.page.spec.messageRefs).toEqual(['z3', 't3'])
  expect(second.session.status.hasMore).toBe(false)
  expect(await service(repository, fetcher).messageRefs(first.session.metadata.name)).toEqual([
    'z1',
    't1',
    'shared',
    'z3',
    't3',
  ])
  expect(fetcher.calls.map(call => [call.source, call.cursor])).toEqual([
    [zhihu.name, null],
    [twitter.name, null],
    [zhihu.name, 'z-next'],
    [twitter.name, 't-next'],
  ])
})

test('one failed source keeps its cursor while successful sources commit and exhaust', async () => {
  const repository = new MemoryAggregateRepository()
  const fetcher = new MockContinuationFetcher(pages)
  const feed = service(repository, fetcher)
  const first = await feed.restart([zhihu, twitter], 4)
  fetcher.failNext(zhihu.name, 'z-next')

  const partial = await feed.continue(first.session.metadata.name, 4)
  expect(partial.page.spec.failedSources).toEqual([zhihu.name])
  expect(partial.page.spec.messageRefs).toEqual(['t3'])
  expect(partial.session.status.sourceStates[zhihu.name].nextCursor).toBe('z-next')
  expect(partial.session.status.sourceStates[twitter.name].hasMore).toBe(false)
  expect(partial.session.status.hasMore).toBe(true)

  const retry = await feed.continue(first.session.metadata.name, 4)
  expect(retry.page.spec.failedSources).toEqual([])
  expect(retry.page.spec.messageRefs).toEqual(['z3'])
  expect(retry.session.status.hasMore).toBe(false)
  expect(fetcher.calls.slice(-3).map(call => [call.source, call.cursor])).toEqual([
    [zhihu.name, 'z-next'],
    [twitter.name, 't-next'],
    [zhihu.name, 'z-next'],
  ])
})

test('all active sources failing leaves the committed aggregate state unchanged', async () => {
  const repository = new MemoryAggregateRepository()
  const fetcher = new MockContinuationFetcher(pages)
  const feed = service(repository, fetcher)
  const first = await feed.restart([zhihu, twitter], 4)
  fetcher.failNext(zhihu.name, 'z-next')
  fetcher.failNext(twitter.name, 't-next')

  await expect(feed.continue(first.session.metadata.name, 4)).rejects.toThrow(
    `aggregate feed page fetch failed: ${first.session.metadata.name}`,
  )
  expect(await repository.get(first.session.metadata.name)).toEqual(first.session)
  expect((await repository.listPages(first.session.metadata.name)).length).toBe(1)
})

test('archive failure aborts the aggregate transition instead of becoming a source fallback', async () => {
  const repository = new MemoryAggregateRepository()
  const fetcher = new MockContinuationFetcher(pages)
  const archiver = new MemoryArchiver()
  const feed = service(repository, fetcher, archiver)
  const first = await feed.restart([zhihu, twitter], 4)
  archiver.failSource = zhihu.name

  await expect(feed.continue(first.session.metadata.name, 4)).rejects.toThrow(`archive failed: ${zhihu.name}`)
  expect(await repository.get(first.session.metadata.name)).toEqual(first.session)
  expect((await repository.listPages(first.session.metadata.name)).length).toBe(1)
})

test('ranker follows source order and removes prior and cross-source duplicates', () => {
  expect(rankRoundRobin([
    { source: 'a', messageRefs: ['old', 'a1', 'shared', 'a2'] },
    { source: 'b', messageRefs: ['b1', 'shared', 'b2'] },
  ], new Set(['old']))).toEqual(['a1', 'b1', 'shared', 'b2', 'a2'])
})

test('aggregate source lists require at least two unique sources', async () => {
  const feed = service(new MemoryAggregateRepository(), new MockContinuationFetcher(pages))
  await expect(feed.restart([zhihu], 4)).rejects.toThrow('aggregate feed requires at least two sources')
  await expect(feed.restart([zhihu, zhihu], 4)).rejects.toThrow('aggregate feed sources must be unique')
})

test('aggregate source page HTTP projection hides platform cursors', async () => {
  const transition = await service(
    new MemoryAggregateRepository(),
    new MockContinuationFetcher(pages),
  ).restart([zhihu, twitter], 4)
  const projection = publicFeedSourcePage(transition.sourcePages[0])
  expect(projection.spec).not.toHaveProperty('inputCursor')
  expect(projection.spec).not.toHaveProperty('outputCursor')
  const sessionProjection = publicFeedSession(transition.session)
  expect(sessionProjection.status).not.toHaveProperty('nextCursor')
  expect(JSON.stringify(sessionProjection.status)).not.toContain('z-next')
  expect(JSON.stringify(sessionProjection.status)).not.toContain('t-next')
})
