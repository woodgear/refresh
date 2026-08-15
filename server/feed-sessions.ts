import type { SourceConfig } from './config'
import { getSource } from './config'
import {
  defaultContinuationFetcher,
  ContinuationUnsupportedError,
  type ContinuationFetcher,
  type FetchPageResult,
} from './fetcher'
import { downloadAll } from './media'
import { rlog } from './logger'
import { collectMediaUrls, collectMessageRefs } from './page-content'
import { ingestWindow } from './resources'
import { FeedSessionResource as FeedSessionDefinition } from './resource-definitions'
import {
  appendWindow,
  commitFeedPage,
  getStoredResource,
  listStoredResources,
  type Resource,
  type WindowFile,
} from './store'

export interface FeedSessionSpec {
  source: string
  generation: string
}

export interface FeedSessionStatus {
  nextCursor: string | null
  hasMore: boolean
  orderedMessageRefs: string[]
  pageCount: number
  lastPage: string
  lastWindow: string
}

export interface FeedPageSpec {
  session: string
  window: string
  ordinal: number
  mode: 'restart' | 'continue'
  inputCursor: string | null
  outputCursor: string | null
  hasMore: boolean
  fetchedAt: number
  messageRefs: string[]
}

export type FeedSessionResource = Resource<FeedSessionSpec, FeedSessionStatus> & { kind: 'FeedSession' }
export type FeedPageResource = Resource<FeedPageSpec, Record<string, never>> & { kind: 'FeedPage' }

export interface FeedPageArchive {
  sessionName: string
  generation: string
  ordinal: number
  mode: 'restart' | 'continue'
  inputCursor: string | null
  source: SourceConfig
  count: number
  result: FetchPageResult
}

export interface FeedPageArchiver {
  archive(input: FeedPageArchive): Promise<{ windowName: string; messageRefs: string[] }>
}

export interface FeedSessionRepository {
  get(name: string): Promise<FeedSessionResource | null>
  list(): Promise<FeedSessionResource[]>
  commit(session: FeedSessionResource, page: FeedPageResource): Promise<void>
}

export interface FeedPageTransition {
  session: FeedSessionResource
  page: FeedPageResource
}

export class FeedSessionNotFoundError extends Error {}
export class FeedSessionConflictError extends Error {}
export class FeedSessionExhaustedError extends Error {}
export class FeedSessionInputError extends Error {}
export class FeedPageFetchError extends Error {}

export class FeedSessionService {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly repository: FeedSessionRepository,
    private readonly fetcher: ContinuationFetcher,
    private readonly archiver: FeedPageArchiver,
    private readonly newGeneration: () => string = () => crypto.randomUUID(),
    private readonly log: (scope: string, line: string) => void = rlog,
  ) {}

  async restart(source: SourceConfig, requestedCount: number): Promise<FeedPageTransition> {
    const count = pageSize(requestedCount)
    const generation = this.newGeneration()
    const sessionName = `${source.name}-${generation}`
    const result = await this.fetchHead(source, count, sessionName)
    validateFetchResult(result, source.name)
    return this.commitPage({
      sessionName,
      generation,
      ordinal: 0,
      mode: 'restart',
      inputCursor: null,
      source,
      count,
      result,
    }, null)
  }

  async continue(name: string, requestedCount: number): Promise<FeedPageTransition> {
    if (this.inFlight.has(name)) {
      throw new FeedSessionConflictError(`feed session page request already in progress: ${name}`)
    }
    this.inFlight.add(name)
    try {
      const current = await this.get(name)
      if (!current.status.hasMore) throw new FeedSessionExhaustedError(`feed session has no more pages: ${name}`)
      if (current.status.nextCursor === null) throw new Error(`FeedSession/${name} hasMore=true without nextCursor`)
      const source = getSource(current.spec.source)
      if (!source) throw new Error(`FeedSession/${name} references unknown source: ${current.spec.source}`)
      const count = pageSize(requestedCount)
      const inputCursor = current.status.nextCursor
      const result = await this.fetchNext(source, inputCursor, count, name)
      validateFetchResult(result, source.name)
      return await this.commitPage({
        sessionName: name,
        generation: current.spec.generation,
        ordinal: current.status.pageCount,
        mode: 'continue',
        inputCursor,
        source,
        count,
        result,
      }, current)
    } finally {
      this.inFlight.delete(name)
    }
  }

  async get(name: string): Promise<FeedSessionResource> {
    const session = await this.repository.get(name)
    if (!session) throw new FeedSessionNotFoundError(`feed session not found: ${name}`)
    return session
  }

  async list(): Promise<FeedSessionResource[]> {
    return this.repository.list()
  }

  private async fetchHead(source: SourceConfig, count: number, sessionName: string): Promise<FetchPageResult> {
    try {
      return await this.fetcher.fetchHead(source, count, line => this.log(sessionName, line))
    } catch (error) {
      if (error instanceof ContinuationUnsupportedError) throw error
      this.log(sessionName, `fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      throw new FeedPageFetchError(`feed page fetch failed: ${sessionName}`)
    }
  }

  private async fetchNext(
    source: SourceConfig,
    cursor: string,
    count: number,
    sessionName: string,
  ): Promise<FetchPageResult> {
    try {
      return await this.fetcher.fetchNext(source, cursor, count, line => this.log(sessionName, line))
    } catch (error) {
      if (error instanceof ContinuationUnsupportedError) throw error
      this.log(sessionName, `fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      throw new FeedPageFetchError(`feed page fetch failed: ${sessionName}`)
    }
  }

  private async commitPage(
    input: FeedPageArchive,
    previous: FeedSessionResource | null,
  ): Promise<FeedPageTransition> {
    const archive = await this.archiver.archive(input)
    const pageName = `${input.sessionName}-${String(input.ordinal).padStart(6, '0')}`
    const createdAt = new Date().toISOString()
    const page: FeedPageResource = {
      apiVersion: 'radar/v1',
      kind: 'FeedPage',
      metadata: {
        name: pageName,
        creationTimestamp: createdAt,
        labels: { source: input.source.name },
      },
      spec: {
        session: input.sessionName,
        window: archive.windowName,
        ordinal: input.ordinal,
        mode: input.mode,
        inputCursor: input.inputCursor,
        outputCursor: input.result.nextCursor,
        hasMore: input.result.hasMore,
        fetchedAt: input.result.fetchedAt,
        messageRefs: archive.messageRefs,
      },
      status: {},
    }
    const orderedMessageRefs = appendUnique(previous?.status.orderedMessageRefs ?? [], archive.messageRefs)
    const session: FeedSessionResource = {
      apiVersion: 'radar/v1',
      kind: 'FeedSession',
      metadata: previous?.metadata ?? {
        name: input.sessionName,
        creationTimestamp: createdAt,
        labels: { source: input.source.name, platform: input.source.platform },
      },
      spec: { source: input.source.name, generation: input.generation },
      status: {
        nextCursor: input.result.nextCursor,
        hasMore: input.result.hasMore,
        orderedMessageRefs,
        pageCount: input.ordinal + 1,
        lastPage: pageName,
        lastWindow: archive.windowName,
      },
    }
    await this.repository.commit(session, page)
    return { session, page }
  }
}

class StoredFeedSessionRepository implements FeedSessionRepository {
  async get(name: string): Promise<FeedSessionResource | null> {
    return await getStoredResource(FeedSessionDefinition, name) as FeedSessionResource | null
  }

  async list(): Promise<FeedSessionResource[]> {
    return await listStoredResources(FeedSessionDefinition) as FeedSessionResource[]
  }

  async commit(session: FeedSessionResource, page: FeedPageResource): Promise<void> {
    await commitFeedPage(session, page)
  }
}

class StoredFeedPageArchiver implements FeedPageArchiver {
  async archive(input: FeedPageArchive): Promise<{ windowName: string; messageRefs: string[] }> {
    const now = new Date().toISOString()
    const windowName = `${input.source.name}-${crypto.randomUUID()}`
    const messageRefs = collectMessageRefs(input.source.platform, input.result.rawItems)
    const log = (line: string) => rlog(windowName, line)
    const win: WindowFile = {
      apiVersion: 'radar/v1',
      kind: 'RefreshWindow',
      metadata: {
        name: windowName,
        creationTimestamp: now,
        labels: {
          source: input.source.name,
          account: input.source.account,
          platform: input.source.platform,
        },
      },
      spec: {
        source: input.source.name,
        account: input.source.account,
        count: input.count,
        trigger: 'feed-session',
        mode: input.mode,
        feedSession: input.sessionName,
        generation: input.generation,
      },
      status: {
        phase: 'Succeeded',
        startedAt: now,
        finishedAt: now,
        messageRefs,
        stats: null,
        error: null,
      },
      rawItems: input.result.rawItems,
    }
    await downloadAll(collectMediaUrls(input.source.platform, input.result.rawItems), log)
    await appendWindow(win)
    await ingestWindow(win)
    return { windowName, messageRefs }
  }
}

let singleton: FeedSessionService | null = null

export function defaultFeedSessionService(): FeedSessionService {
  singleton ??= new FeedSessionService(
    new StoredFeedSessionRepository(),
    defaultContinuationFetcher(),
    new StoredFeedPageArchiver(),
  )
  return singleton
}

export function publicFeedSession(session: FeedSessionResource): Resource {
  const { nextCursor: _nextCursor, ...status } = session.status
  return { ...session, status }
}

export function publicFeedPage(page: FeedPageResource): Resource {
  const { inputCursor: _inputCursor, outputCursor: _outputCursor, ...spec } = page.spec
  return { ...page, spec }
}

function pageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new FeedSessionInputError(`feed page count must be an integer from 1 to 200: ${value}`)
  }
  return value
}

function validateFetchResult(result: FetchPageResult, source: string): void {
  if (result.hasMore !== (result.nextCursor !== null)) {
    throw new Error(`continuation fetcher returned inconsistent cursor state for ${source}`)
  }
}

function appendUnique(existing: readonly string[], incoming: readonly string[]): string[] {
  const result = [...existing]
  const seen = new Set(existing)
  for (const name of incoming) {
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}
