import {
  isAggregateFeedSession,
  type FeedSessionResource,
} from './feed-sessions'
import { selectNewMessageNames } from './queries'

/**
 * 「有多少条新内容」：session 创建之后才抓到的、还没发布进该 session 的 message。
 * 走 SQL（sources + window 时间 + 已发布名单），不再把整表 message 读进内存 ——
 * 前端每 30 秒轮询一次，全量扫描会把 RSS 堆到 GB 级。
 */
export function feedUpdateMessageRefs(
  session: FeedSessionResource,
  publishedRefs: readonly string[],
): string[] {
  const startedAt = requiredTimestamp(
    session.metadata.creationTimestamp,
    `FeedSession/${session.metadata.name}`,
  )
  const sources = isAggregateFeedSession(session) ? session.spec.sources : [session.spec.source]
  return selectNewMessageNames(sources, startedAt, [...publishedRefs])
}

function requiredTimestamp(value: string | undefined, resource: string): number {
  if (!value) throw new Error(`${resource} is missing creationTimestamp`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${resource} has invalid creationTimestamp: ${value}`)
  return timestamp
}
