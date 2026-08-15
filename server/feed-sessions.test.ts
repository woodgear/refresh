import { expect, test } from 'bun:test'
import type { SourceConfig } from './config'
import {
  FeedSessionService,
  publicFeedSession,
  type FeedPageArchive,
  type FeedPageArchiver,
  type FeedPageResource,
  type FeedSessionRepository,
  type FeedSessionResource,
} from './feed-sessions'
import { MockContinuationFetcher, type ContinuationFetcher, type FetchPageResult, type MockPage } from './fetcher'

const source: SourceConfig = {
  name: 'zhihu-main-recommend',
  account: 'zhihu-main',
  platform: 'zhihu',
  capability: 'recommend',
}

const pages: readonly MockPage[] = [
  { inputCursor: null, rawItems: ['a', 'b'], nextCursor: 'cursor-1', fetchedAt: 1 },
  { inputCursor: 'cursor-1', rawItems: ['b', 'c'], nextCursor: 'cursor-2', fetchedAt: 2 },
  { inputCursor: 'cursor-2', rawItems: ['d'], nextCursor: null, fetchedAt: 3 },
]

class MemoryFeedSessionRepository implements FeedSessionRepository {
  readonly sessions = new Map<string, FeedSessionResource>()
  readonly pages = new Map<string, FeedPageResource>()

  async get(name: string): Promise<FeedSessionResource | null> {
    const session = this.sessions.get(name)
    return session ? structuredClone(session) : null
  }

  async list(): Promise<FeedSessionResource[]> {
    return [...this.sessions.values()].map(session => structuredClone(session))
  }

  async commit(session: FeedSessionResource, page: FeedPageResource): Promise<void> {
    if (this.pages.has(page.metadata.name)) throw new Error(`feed page already exists: ${page.metadata.name}`)
    this.sessions.set(session.metadata.name, structuredClone(session))
    this.pages.set(page.metadata.name, structuredClone(page))
  }
}

class MemoryArchiver implements FeedPageArchiver {
  readonly calls: FeedPageArchive[] = []
  failOrdinal: number | null = null

  async archive(input: FeedPageArchive): Promise<{ windowName: string; messageRefs: string[] }> {
    this.calls.push(structuredClone(input))
    if (input.ordinal === this.failOrdinal) {
      this.failOrdinal = null
      throw new Error('archive write failed')
    }
    return {
      windowName: `${input.sessionName}-window-${input.ordinal}-${this.calls.length}`,
      messageRefs: input.result.rawItems.map(String),
    }
  }
}

function service(
  repository: FeedSessionRepository,
  fetcher: ContinuationFetcher,
  archiver: FeedPageArchiver,
): FeedSessionService {
  return new FeedSessionService(repository, fetcher, archiver, () => 'generation-1', () => {})
}

test('a new service instance continues from the committed cursor and preserves order', async () => {
  const repository = new MemoryFeedSessionRepository()
  const fetcher = new MockContinuationFetcher({ [source.name]: pages })
  const archiver = new MemoryArchiver()

  const first = await service(repository, fetcher, archiver).restart(source, 2)
  expect(first.session.status.orderedMessageRefs).toEqual(['a', 'b'])
  expect(first.page.spec.mode).toBe('restart')

  const second = await service(repository, fetcher, archiver).continue(first.session.metadata.name, 2)
  expect(second.session.status.orderedMessageRefs).toEqual(['a', 'b', 'c'])
  expect(second.page.spec.messageRefs).toEqual(['b', 'c'])

  const third = await service(repository, fetcher, archiver).continue(first.session.metadata.name, 2)
  expect(third.session.status.orderedMessageRefs).toEqual(['a', 'b', 'c', 'd'])
  expect(third.session.status.hasMore).toBe(false)
  expect(fetcher.calls.map(call => call.cursor)).toEqual([null, 'cursor-1', 'cursor-2'])
})

test('archive failure leaves the committed cursor unchanged and retries the same page', async () => {
  const repository = new MemoryFeedSessionRepository()
  const fetcher = new MockContinuationFetcher({ [source.name]: pages })
  const archiver = new MemoryArchiver()
  const feed = service(repository, fetcher, archiver)
  const first = await feed.restart(source, 2)
  archiver.failOrdinal = 1

  await expect(feed.continue(first.session.metadata.name, 2)).rejects.toThrow('archive write failed')
  expect((await repository.get(first.session.metadata.name))?.status).toEqual(first.session.status)

  const retry = await feed.continue(first.session.metadata.name, 2)
  expect(retry.page.spec.inputCursor).toBe('cursor-1')
  expect(fetcher.calls.map(call => call.cursor)).toEqual([null, 'cursor-1', 'cursor-1'])
})

test('fetch failure does not expose the source cursor and retries from committed state', async () => {
  const repository = new MemoryFeedSessionRepository()
  const fetcher = new MockContinuationFetcher({ [source.name]: pages })
  const feed = service(repository, fetcher, new MemoryArchiver())
  const first = await feed.restart(source, 2)
  fetcher.failNext(source.name, 'cursor-1', new Error('platform failed at cursor-1'))

  await expect(feed.continue(first.session.metadata.name, 2)).rejects.toThrow(
    `feed page fetch failed: ${first.session.metadata.name}`,
  )
  expect((await repository.get(first.session.metadata.name))?.status).toEqual(first.session.status)

  const retry = await feed.continue(first.session.metadata.name, 2)
  expect(retry.page.spec.inputCursor).toBe('cursor-1')
  expect(fetcher.calls.map(call => call.cursor)).toEqual([null, 'cursor-1', 'cursor-1'])
})

test('raw platform cursors are omitted from the HTTP representation', async () => {
  const repository = new MemoryFeedSessionRepository()
  const feed = service(
    repository,
    new MockContinuationFetcher({ [source.name]: pages }),
    new MemoryArchiver(),
  )
  const { session } = await feed.restart(source, 2)

  expect(session.status.nextCursor).toBe('cursor-1')
  expect(publicFeedSession(session).status).not.toHaveProperty('nextCursor')
})

test('one session rejects overlapping page requests', async () => {
  const repository = new MemoryFeedSessionRepository()
  const baseFetcher = new MockContinuationFetcher({ [source.name]: pages })
  const archiver = new MemoryArchiver()
  const feed = service(repository, baseFetcher, archiver)
  const first = await feed.restart(source, 2)

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const blockingFetcher: ContinuationFetcher = {
    fetchHead: (...args) => baseFetcher.fetchHead(...args),
    async fetchNext(
      currentSource: SourceConfig,
      cursor: string,
      count: number,
      log: (line: string) => void,
    ): Promise<FetchPageResult> {
      await gate
      return baseFetcher.fetchNext(currentSource, cursor, count, log)
    },
  }
  const concurrentFeed = service(repository, blockingFetcher, archiver)
  const pending = concurrentFeed.continue(first.session.metadata.name, 2)

  await expect(concurrentFeed.continue(first.session.metadata.name, 2)).rejects.toThrow(
    `feed session page request already in progress: ${first.session.metadata.name}`,
  )
  release()
  await pending
})
