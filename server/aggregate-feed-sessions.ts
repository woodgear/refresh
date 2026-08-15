import type { SourceConfig } from './config'
import { getSource } from './config'
import {
  ContinuationUnsupportedError,
  defaultContinuationFetcher,
  type ContinuationFetcher,
  type FetchPageResult,
} from './fetcher'
import {
  FeedPageFetchError,
  FeedSessionConflictError,
  FeedSessionExhaustedError,
  FeedSessionInputError,
  FeedSessionNotFoundError,
  StoredFeedPageArchiver,
  feedPageSize,
  validateFetchPageResult,
  type AggregateFeedSessionResource,
  type AggregateSourceState,
  type FeedPageArchive,
  type FeedPageArchiver,
  type FeedSessionResource,
} from './feed-sessions'
import { rlog } from './logger'
import { FeedSessionResource as FeedSessionDefinition } from './resource-definitions'
import {
  commitAggregateFeedPage,
  getStoredResource,
  listAggregateFeedPages,
  type Resource,
} from './store'

export interface AggregateFeedPageSpec {
  session: string
  ordinal: number
  mode: 'restart' | 'continue'
  messageRefs: string[]
  failedSources: string[]
}

export interface FeedSourcePageSpec {
  session: string
  page: string
  window: string
  source: string
  inputCursor: string | null
  outputCursor: string | null
  hasMore: boolean
  fetchedAt: number
  messageRefs: string[]
}

export type AggregateFeedPageResource = Resource<AggregateFeedPageSpec, Record<string, never>> & {
  kind: 'AggregateFeedPage'
}
export type FeedSourcePageResource = Resource<FeedSourcePageSpec, Record<string, never>> & {
  kind: 'FeedSourcePage'
}

export interface AggregateFeedSessionRepository {
  get(name: string): Promise<FeedSessionResource | null>
  listPages(name: string): Promise<AggregateFeedPageResource[]>
  commit(
    session: AggregateFeedSessionResource,
    page: AggregateFeedPageResource,
    sourcePages: FeedSourcePageResource[],
  ): Promise<void>
}

export interface AggregateFeedPageTransition {
  session: AggregateFeedSessionResource
  page: AggregateFeedPageResource
  sourcePages: FeedSourcePageResource[]
}

interface SourceSuccess {
  source: SourceConfig
  inputCursor: string | null
  result: FetchPageResult
  windowName: string
  messageRefs: string[]
}

export class AggregateFeedSessionService {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly repository: AggregateFeedSessionRepository,
    private readonly fetcher: ContinuationFetcher,
    private readonly archiver: FeedPageArchiver,
    private readonly newGeneration: () => string = () => crypto.randomUUID(),
    private readonly log: (scope: string, line: string) => void = rlog,
  ) {}

  async restart(sources: SourceConfig[], requestedCount: number): Promise<AggregateFeedPageTransition> {
    validateAggregateSources(sources)
    const count = feedPageSize(requestedCount)
    const generation = this.newGeneration()
    const sessionName = `aggregate-${generation}`
    const sourceStates = Object.fromEntries(
      sources.map(source => [source.name, initialSourceState()]),
    )
    return this.commitPage({
      sessionName,
      generation,
      sources,
      sourceStates,
      ordinal: 0,
      mode: 'restart',
      count,
      previous: null,
      published: new Set(),
    })
  }

  async continue(name: string, requestedCount: number): Promise<AggregateFeedPageTransition> {
    if (this.inFlight.has(name)) {
      throw new FeedSessionConflictError(`feed session page request already in progress: ${name}`)
    }
    this.inFlight.add(name)
    try {
      const current = await this.get(name)
      if (!current.status.hasMore) throw new FeedSessionExhaustedError(`feed session has no more pages: ${name}`)
      const count = feedPageSize(requestedCount)
      const sources = current.spec.sources.map(sourceName => {
        const source = getSource(sourceName)
        if (!source) throw new Error(`FeedSession/${name} references unknown source: ${sourceName}`)
        return source
      })
      const published = new Set(await this.messageRefs(name, current))
      return await this.commitPage({
        sessionName: name,
        generation: current.spec.generation,
        sources,
        sourceStates: current.status.sourceStates,
        ordinal: current.status.pageCount,
        mode: 'continue',
        count,
        previous: current,
        published,
      })
    } finally {
      this.inFlight.delete(name)
    }
  }

  async get(name: string): Promise<AggregateFeedSessionResource> {
    const session = await this.repository.get(name)
    if (!session) throw new FeedSessionNotFoundError(`feed session not found: ${name}`)
    if (session.spec.source !== 'aggregate') {
      throw new FeedSessionInputError(`feed session is not aggregate: ${name}`)
    }
    return session as AggregateFeedSessionResource
  }

  async messageRefs(name: string, loaded?: AggregateFeedSessionResource): Promise<string[]> {
    const session = loaded ?? await this.get(name)
    return deriveAggregatePublishedMessageRefs(session, await this.repository.listPages(name))
  }

  private async commitPage(input: {
    sessionName: string
    generation: string
    sources: SourceConfig[]
    sourceStates: Record<string, AggregateSourceState>
    ordinal: number
    mode: 'restart' | 'continue'
    count: number
    previous: AggregateFeedSessionResource | null
    published: Set<string>
  }): Promise<AggregateFeedPageTransition> {
    const active = input.sources.filter(source => {
      const state = input.sourceStates[source.name]
      if (!state) throw new Error(`FeedSession/${input.sessionName} is missing source state: ${source.name}`)
      return state.hasMore
    })
    if (active.length === 0) {
      throw new FeedSessionExhaustedError(`feed session has no more pages: ${input.sessionName}`)
    }
    const sourceCount = Math.max(1, Math.ceil(input.count / active.length))
    const nextStates = structuredClone(input.sourceStates)
    const successes: SourceSuccess[] = []
    const failedSources: string[] = []

    for (const source of active) {
      const state = input.sourceStates[source.name]
      if (!state) throw new Error(`FeedSession/${input.sessionName} is missing source state: ${source.name}`)
      const inputCursor = input.mode === 'restart' ? null : state.nextCursor
      if (input.mode === 'continue' && inputCursor === null) {
        throw new Error(`FeedSession/${input.sessionName} source ${source.name} hasMore=true without nextCursor`)
      }
      let result: FetchPageResult
      try {
        result = input.mode === 'restart'
          ? await this.fetcher.fetchHead(source, sourceCount, line => this.log(input.sessionName, line))
          : await this.fetcher.fetchNext(source, inputCursor!, sourceCount, line => this.log(input.sessionName, line))
      } catch (error) {
        if (error instanceof ContinuationUnsupportedError) throw error
        this.log(input.sessionName, `${source.name} failed: ${errorMessage(error)}`)
        failedSources.push(source.name)
        nextStates[source.name] = { ...state, lastError: `feed source failed: ${source.name}` }
        continue
      }
      validateFetchPageResult(result, source.name)
      const archiveInput: FeedPageArchive = {
        sessionName: input.sessionName,
        generation: input.generation,
        ordinal: input.ordinal,
        mode: input.mode,
        inputCursor,
        source,
        count: sourceCount,
        result,
      }
      const archive = await this.archiver.archive(archiveInput)
      successes.push({ source, inputCursor, result, ...archive })
      nextStates[source.name] = {
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        lastWindow: archive.windowName,
        lastError: null,
      }
    }

    if (successes.length === 0) {
      throw new FeedPageFetchError(`aggregate feed page fetch failed: ${input.sessionName}`)
    }

    const createdAt = new Date().toISOString()
    const pageName = `${input.sessionName}-${String(input.ordinal).padStart(6, '0')}`
    const messageRefs = rankRoundRobin(
      input.sources.map(source => ({
        source: source.name,
        messageRefs: successes.find(success => success.source.name === source.name)?.messageRefs ?? [],
      })),
      input.published,
    )
    const page: AggregateFeedPageResource = {
      apiVersion: 'radar/v1',
      kind: 'AggregateFeedPage',
      metadata: { name: pageName, creationTimestamp: createdAt },
      spec: {
        session: input.sessionName,
        ordinal: input.ordinal,
        mode: input.mode,
        messageRefs,
        failedSources,
      },
      status: {},
    }
    const sourcePages: FeedSourcePageResource[] = successes.map(success => ({
      apiVersion: 'radar/v1',
      kind: 'FeedSourcePage',
      metadata: {
        name: `${pageName}-${success.source.name}`,
        creationTimestamp: createdAt,
        labels: { source: success.source.name, platform: success.source.platform },
      },
      spec: {
        session: input.sessionName,
        page: pageName,
        window: success.windowName,
        source: success.source.name,
        inputCursor: success.inputCursor,
        outputCursor: success.result.nextCursor,
        hasMore: success.result.hasMore,
        fetchedAt: success.result.fetchedAt,
        messageRefs: success.messageRefs,
      },
      status: {},
    }))
    const session: AggregateFeedSessionResource = {
      apiVersion: 'radar/v1',
      kind: 'FeedSession',
      metadata: input.previous?.metadata ?? {
        name: input.sessionName,
        creationTimestamp: createdAt,
        labels: { source: 'aggregate' },
      },
      spec: {
        source: 'aggregate',
        sources: input.sources.map(source => source.name),
        generation: input.generation,
      },
      status: {
        hasMore: Object.values(nextStates).some(state => state.hasMore),
        pageCount: input.ordinal + 1,
        lastPage: pageName,
        failedSources,
        sourceStates: nextStates,
      },
    }
    await this.repository.commit(session, page, sourcePages)
    return { session, page, sourcePages }
  }
}

class StoredAggregateFeedSessionRepository implements AggregateFeedSessionRepository {
  async get(name: string): Promise<FeedSessionResource | null> {
    return await getStoredResource(
      FeedSessionDefinition,
      name,
    ) as FeedSessionResource | null
  }

  async listPages(name: string): Promise<AggregateFeedPageResource[]> {
    return await listAggregateFeedPages(name) as AggregateFeedPageResource[]
  }

  async commit(
    session: AggregateFeedSessionResource,
    page: AggregateFeedPageResource,
    sourcePages: FeedSourcePageResource[],
  ): Promise<void> {
    await commitAggregateFeedPage(session, page, sourcePages)
  }
}

let singleton: AggregateFeedSessionService | null = null

export function defaultAggregateFeedSessionService(): AggregateFeedSessionService {
  if (!singleton) {
    singleton = new AggregateFeedSessionService(
      new StoredAggregateFeedSessionRepository(),
      defaultContinuationFetcher(),
      new StoredFeedPageArchiver(),
    )
  }
  return singleton
}

export function rankRoundRobin(
  groups: Array<{ source: string; messageRefs: string[] }>,
  published: ReadonlySet<string> = new Set(),
): string[] {
  const seen = new Set(published)
  const offsets = groups.map(() => 0)
  const ranked: string[] = []
  while (groups.some((group, index) => offsets[index] < group.messageRefs.length)) {
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]
      while (offsets[index] < group.messageRefs.length) {
        const ref = group.messageRefs[offsets[index]++]
        if (seen.has(ref)) continue
        seen.add(ref)
        ranked.push(ref)
        break
      }
    }
  }
  return ranked
}

export function deriveAggregatePublishedMessageRefs(
  session: AggregateFeedSessionResource,
  pages: AggregateFeedPageResource[],
): string[] {
  pages.sort((left, right) => left.spec.ordinal - right.spec.ordinal)
  if (pages.length !== session.status.pageCount) {
    throw new Error(
      `FeedSession/${session.metadata.name} page count mismatch: status=${session.status.pageCount}, stored=${pages.length}`,
    )
  }
  const refs: string[] = []
  pages.forEach((page, ordinal) => {
    if (page.spec.session !== session.metadata.name || page.spec.ordinal !== ordinal) {
      throw new Error(
        `FeedSession/${session.metadata.name} has invalid AggregateFeedPage ordinal ${page.spec.ordinal} at index ${ordinal}`,
      )
    }
    refs.push(...page.spec.messageRefs)
  })
  return refs
}

export function publicAggregateFeedPage(page: AggregateFeedPageResource): Resource {
  return page
}

export function publicFeedSourcePage(page: FeedSourcePageResource): Resource {
  const { inputCursor: _inputCursor, outputCursor: _outputCursor, ...spec } = page.spec
  return { ...page, spec }
}

function validateAggregateSources(sources: SourceConfig[]): void {
  if (sources.length < 2) throw new FeedSessionInputError('aggregate feed requires at least two sources')
  const names = new Set(sources.map(source => source.name))
  if (names.size !== sources.length) throw new FeedSessionInputError('aggregate feed sources must be unique')
}

function initialSourceState(): AggregateSourceState {
  return { nextCursor: null, hasMore: true, lastWindow: null, lastError: null }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
