import {
  isAggregateFeedSession,
  type FeedSessionResource,
} from './feed-sessions'
import type { Resource } from './store'

export function feedUpdateMessageRefs(
  session: FeedSessionResource,
  publishedRefs: readonly string[],
  messages: readonly Resource[],
  getWindow: (name: string) => Resource | null,
): string[] {
  const startedAt = requiredTimestamp(
    session.metadata.creationTimestamp,
    `FeedSession/${session.metadata.name}`,
  )
  const sources = new Set(isAggregateFeedSession(session) ? session.spec.sources : [session.spec.source])
  const published = new Set(publishedRefs)
  const windowTimes = new Map<string, number>()

  return messages.flatMap(message => {
    if (published.has(message.metadata.name) || !messageBelongsTo(message, sources)) return []
    const windowName = message.metadata.annotations?.['radar/lastSeenWindow']
    if (!windowName) throw new Error(`Message/${message.metadata.name} is missing radar/lastSeenWindow`)
    let observedAt = windowTimes.get(windowName)
    if (observedAt === undefined) {
      const window = getWindow(windowName)
      if (!window) throw new Error(`Message/${message.metadata.name} references missing RefreshWindow/${windowName}`)
      observedAt = requiredTimestamp(window.metadata.creationTimestamp, `RefreshWindow/${windowName}`)
      windowTimes.set(windowName, observedAt)
    }
    return observedAt > startedAt ? [message.metadata.name] : []
  })
}

function messageBelongsTo(message: Resource, sources: ReadonlySet<string>): boolean {
  const memberships = (
    message.metadata.annotations?.['radar/sources']
    ?? message.metadata.labels?.source
    ?? ''
  ).split(',').filter(Boolean)
  return memberships.some(source => sources.has(source))
}

function requiredTimestamp(value: string | undefined, resource: string): number {
  if (!value) throw new Error(`${resource} is missing creationTimestamp`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${resource} has invalid creationTimestamp: ${value}`)
  return timestamp
}
