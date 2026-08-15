import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_RECOMMENDATION_SOURCES,
  continueFeedSession,
  createFeedSession,
  getFeedMessages,
  getFeedSession,
  type FeedMessagePage,
  type FeedSession,
  type Message,
} from '@/api/radar'
import { useUIStore } from '@/stores/uiStore'

type FailedAction = 'initial' | 'load-more' | 'restart' | null

interface FeedState {
  session: FeedSession | null
  items: Message[]
  total: number
  nextOffset: number | null
  baseOffset: number
  initialLoading: boolean
  loadingMore: boolean
  restarting: boolean
  error: string | null
  failedAction: FailedAction
}

const initialState: FeedState = {
  session: null,
  items: [],
  total: 0,
  nextOffset: null,
  baseOffset: 0,
  initialLoading: true,
  loadingMore: false,
  restarting: false,
  error: null,
  failedAction: null,
}

const sessionCreations = new Map<string, ReturnType<typeof createFeedSession>>()

function createSessionOnce(feedKey: string): ReturnType<typeof createFeedSession> {
  const existing = sessionCreations.get(feedKey)
  if (existing) return existing
  const pending = createFeedSession(feedKey)
  sessionCreations.set(feedKey, pending)
  void pending.then(
    () => sessionCreations.delete(feedKey),
    () => sessionCreations.delete(feedKey),
  )
  return pending
}

function assertSessionMatchesFeedKey(session: FeedSession, feedKey: string): void {
  if (feedKey !== 'all') {
    if (session.spec.source !== feedKey) {
      throw new Error(`FeedSession/${session.metadata.name} belongs to ${session.spec.source}, expected ${feedKey}`)
    }
    return
  }
  if (session.spec.source !== 'aggregate') {
    throw new Error(`FeedSession/${session.metadata.name} is not the aggregate recommendation feed`)
  }
  if (JSON.stringify(session.spec.sources) !== JSON.stringify(DEFAULT_RECOMMENDATION_SOURCES)) {
    throw new Error(`FeedSession/${session.metadata.name} has an unexpected recommendation source order`)
  }
}

function stateFromPage(
  session: FeedSession,
  page: FeedMessagePage,
  expectedOffset: number,
  expectedAnchor?: string,
): FeedState {
  if (page.offset !== expectedOffset) {
    throw new Error(`initial feed message page started at offset ${page.offset}, expected ${expectedOffset}`)
  }
  if (expectedAnchor && page.items[0]?.metadata.name !== expectedAnchor) {
    throw new Error(`FeedSession/${session.metadata.name} no longer has ${expectedAnchor} at offset ${expectedOffset}`)
  }
  return {
    session,
    items: page.items,
    total: page.total,
    nextOffset: page.nextOffset,
    baseOffset: page.offset,
    initialLoading: false,
    loadingMore: false,
    restarting: false,
    error: null,
    failedAction: null,
  }
}

export function useFeedSession(feedKey: string) {
  const [state, setState] = useState<FeedState>(initialState)
  const stateRef = useRef(state)
  const requestVersion = useRef(0)
  const busy = useRef(false)

  const commit = useCallback((update: (current: FeedState) => FeedState) => {
    setState(current => {
      const next = update(current)
      stateRef.current = next
      return next
    })
  }, [])

  const initialize = useCallback(async () => {
    const version = ++requestVersion.current
    busy.current = true
    commit(() => ({ ...initialState }))
    try {
      const savedName = useUIStore.getState().feedSessions[feedKey]
      const savedPosition = useUIStore.getState().feedPositions[feedKey]
      const transition = savedName ? null : await createSessionOnce(feedKey)
      const session = transition?.session ?? await getFeedSession(savedName)
      assertSessionMatchesFeedKey(session, feedKey)
      const offset = savedPosition?.offset ?? 0
      const page = await getFeedMessages(session.metadata.name, offset)
      if (version !== requestVersion.current) return
      if (!savedName) useUIStore.getState().setFeedSession(feedKey, session.metadata.name)
      commit(() => stateFromPage(session, page, offset, savedPosition?.messageName))
    } catch (error) {
      if (version !== requestVersion.current) return
      commit(current => ({
        ...current,
        initialLoading: false,
        error: error instanceof Error ? error.message : String(error),
        failedAction: 'initial',
      }))
    } finally {
      if (version === requestVersion.current) busy.current = false
    }
  }, [commit, feedKey])

  useEffect(() => {
    void initialize()
    return () => {
      requestVersion.current++
      busy.current = false
    }
  }, [initialize])

  const loadMore = useCallback(async () => {
    if (busy.current) return
    const current = stateRef.current
    if (!current.session || (current.nextOffset === null && !current.session.status.hasMore)) return
    const version = requestVersion.current
    busy.current = true
    commit(value => ({ ...value, loadingMore: true, error: null, failedAction: null }))
    try {
      let session = current.session
      if (current.nextOffset === null) {
        session = (await continueFeedSession(session.metadata.name)).session
      }
      const expectedOffset = current.nextOffset ?? current.total
      const page = await getFeedMessages(session.metadata.name, expectedOffset)
      if (version !== requestVersion.current) return
      if (page.offset !== expectedOffset) {
        throw new Error(`feed message page started at offset ${page.offset}, expected ${expectedOffset}`)
      }
      commit(value => ({
        ...value,
        session,
        items: [...value.items, ...page.items],
        total: page.total,
        nextOffset: page.nextOffset,
        loadingMore: false,
      }))
    } catch (error) {
      if (version !== requestVersion.current) return
      commit(value => ({
        ...value,
        loadingMore: false,
        error: error instanceof Error ? error.message : String(error),
        failedAction: 'load-more',
      }))
    } finally {
      if (version === requestVersion.current) busy.current = false
    }
  }, [commit])

  const restart = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    const version = requestVersion.current
    commit(value => ({ ...value, restarting: true, error: null, failedAction: null }))
    try {
      const { session } = await createSessionOnce(feedKey)
      assertSessionMatchesFeedKey(session, feedKey)
      const page = await getFeedMessages(session.metadata.name, 0)
      if (version !== requestVersion.current) return
      useUIStore.getState().setFeedSession(feedKey, session.metadata.name)
      useUIStore.getState().setFeedPosition(feedKey, null)
      commit(() => stateFromPage(session, page, 0))
    } catch (error) {
      if (version !== requestVersion.current) return
      commit(value => ({
        ...value,
        restarting: false,
        error: error instanceof Error ? error.message : String(error),
        failedAction: 'restart',
      }))
    } finally {
      if (version === requestVersion.current) busy.current = false
    }
  }, [commit, feedKey])

  const retry = useCallback(() => {
    const failedAction = stateRef.current.failedAction
    if (failedAction === 'initial') void initialize()
    else if (failedAction === 'load-more') void loadMore()
    else if (failedAction === 'restart') void restart()
  }, [initialize, loadMore, restart])

  const setRead = useCallback((names: string[], read: boolean) => {
    const targets = new Set(names)
    commit(value => ({
      ...value,
      items: value.items.map(message => targets.has(message.metadata.name)
        ? { ...message, status: { ...message.status, read } }
        : message),
    }))
  }, [commit])

  return {
    ...state,
    hasMore: state.nextOffset !== null || state.session?.status.hasMore === true,
    loadedThrough: state.baseOffset + state.items.length,
    loadMore,
    restart,
    retry,
    setRead,
  }
}
