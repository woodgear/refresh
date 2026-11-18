export interface ResourceDefinition<K extends string = string> {
  apiVersion: 'radar/v1'
  kind: K
  storageKind: string
  schema: Record<string, unknown>
  statusStorageKind?: string
  /** 读路径从 spec 里摘掉的键（只是不出网，库里照旧保存） */
  apiOmitSpecKeys?: string[]
}

const OBJECT_SCHEMA = { type: 'object' } as const

const REFERENCE_SCHEMA = {
  type: 'object',
  required: ['apiVersion', 'kind', 'name', 'uid'],
  properties: {
    apiVersion: { type: 'string' },
    kind: { type: 'string' },
    name: { type: 'string' },
    uid: { type: 'string' },
  },
  additionalProperties: false,
} as const

function defineResource<K extends string>(
  kind: K,
  storageKind: string,
  options: {
    statusStorageKind?: string
    schema?: Record<string, unknown>
    /** litectl 机制声明；refresh 不需要事件流，显式写成 none */
    mechanisms?: { events?: 'none' | 'aggregate' | 'full' }
    /** 声明式索引：业务列，litectl 会强制加 (api_version, kind) 前缀建全局索引 */
    indexes?: { name: string; columns: string[]; sampleQuery?: string }[]
    /**
     * 读路径从 spec 里摘掉的键（只是不出网，库里照旧保存）。
     * message 的 raw 是平台原始 item（平均 5.9KB），前端一个字段都不用，
     * 带上它让 50 条响应胖 6 倍。
     */
    apiOmitSpecKeys?: string[]
  } = {},
): ResourceDefinition<K> {
  const schema: Record<string, unknown> = { ...(options.schema ?? OBJECT_SCHEMA) }
  schema['x-litectl-mechanisms'] = options.mechanisms ?? { events: 'none' }
  if (options.indexes && options.indexes.length > 0) {
    schema['x-litectl-indexes'] = options.indexes
  }
  return {
    apiVersion: 'radar/v1',
    kind,
    storageKind,
    schema,
    statusStorageKind: options.statusStorageKind,
    apiOmitSpecKeys: options.apiOmitSpecKeys,
  }
}

const windowItemSchema = (fieldPath: string) => ({
  type: 'object',
  required: ['windowRef', 'ordinal', 'raw'],
  properties: { windowRef: REFERENCE_SCHEMA, ordinal: { type: 'integer', minimum: 0 } },
  'x-litectl-links': [{ fieldPath, relation: 'item-of' }],
})

const feedPageSchema = {
  type: 'object',
  required: [
    'sessionRef',
    'windowRef',
    'ordinal',
    'mode',
    'inputCursor',
    'outputCursor',
    'hasMore',
    'fetchedAt',
    'messageRefs',
  ],
  properties: {
    sessionRef: REFERENCE_SCHEMA,
    windowRef: REFERENCE_SCHEMA,
    ordinal: { type: 'integer', minimum: 0 },
    mode: { enum: ['restart', 'continue'] },
    inputCursor: { type: ['string', 'null'] },
    outputCursor: { type: ['string', 'null'] },
    hasMore: { type: 'boolean' },
    fetchedAt: { type: 'number' },
    messageRefs: { type: 'array', items: { type: 'string' } },
  },
  'x-litectl-links': [
    { fieldPath: '/sessionRef', relation: 'page-of' },
    { fieldPath: '/windowRef', relation: 'page-window' },
  ],
  additionalProperties: false,
} as const

const aggregateFeedPageSchema = {
  type: 'object',
  required: ['sessionRef', 'ordinal', 'mode', 'messageRefs', 'failedSources'],
  properties: {
    sessionRef: REFERENCE_SCHEMA,
    ordinal: { type: 'integer', minimum: 0 },
    mode: { enum: ['restart', 'continue'] },
    messageRefs: { type: 'array', items: { type: 'string' } },
    failedSources: { type: 'array', items: { type: 'string' } },
  },
  'x-litectl-links': [{ fieldPath: '/sessionRef', relation: 'page-of' }],
  additionalProperties: false,
} as const

const feedSourcePageSchema = {
  type: 'object',
  required: [
    'sessionRef',
    'pageRef',
    'windowRef',
    'source',
    'inputCursor',
    'outputCursor',
    'hasMore',
    'fetchedAt',
    'messageRefs',
  ],
  properties: {
    sessionRef: REFERENCE_SCHEMA,
    pageRef: REFERENCE_SCHEMA,
    windowRef: REFERENCE_SCHEMA,
    source: { type: 'string' },
    inputCursor: { type: ['string', 'null'] },
    outputCursor: { type: ['string', 'null'] },
    hasMore: { type: 'boolean' },
    fetchedAt: { type: 'number' },
    messageRefs: { type: 'array', items: { type: 'string' } },
  },
  'x-litectl-links': [
    { fieldPath: '/sessionRef', relation: 'source-page-of' },
    { fieldPath: '/pageRef', relation: 'source-page-batch' },
    { fieldPath: '/windowRef', relation: 'source-page-window' },
  ],
  additionalProperties: false,
} as const

const feedSessionSchema = {
  type: 'object',
  required: ['source', 'generation'],
  properties: {
    source: { type: 'string' },
    sources: { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'string' } },
    generation: { type: 'string' },
  },
  additionalProperties: false,
} as const

// 不再有 status：hydrated/read 都是 message 自己的字段，落在 spec 上（可索引）
export const MessageResource = defineResource('Message', 'message', {
  apiOmitSpecKeys: ['raw'],
  indexes: [
    // 前端主查询：未读优先 + 按内容时间倒序。
    // sampleQuery 给 `litectl admin stats` 做 EXPLAIN 抽查用 —— 表达式索引的写法
    // 差一个引号就会静默退化成全表排序，只有真跑一遍计划才看得出来。
    {
      name: 'feed',
      columns: ['spec.read', 'annotations.refresh.internal/creationTimestamp DESC'],
      sampleQuery: `SELECT name FROM resources WHERE api_version = 'radar/v1' AND kind = 'message' ORDER BY json_extract(spec_json, '$."read"') ASC, json_extract(annotations, '$."refresh.internal/creationTimestamp"') DESC LIMIT 50`,
    },
    // 默认排序：按内容时间倒序
    {
      name: 'by_time',
      columns: ['annotations.refresh.internal/creationTimestamp DESC'],
      sampleQuery: `SELECT name FROM resources WHERE api_version = 'radar/v1' AND kind = 'message' ORDER BY json_extract(annotations, '$."refresh.internal/creationTimestamp"') DESC LIMIT 50`,
    },
    // 按源过滤（source 是多值 annotation，用不上 labels 索引）
    { name: 'by_source', columns: ['annotations.radar/sources'] },
  ],
})
export const AuthorResource = defineResource('Author', 'author', { statusStorageKind: 'author-status' })
export const FolloweeResource = defineResource('Followee', 'followee', { statusStorageKind: 'followee-status' })
export const RefreshWindowResource = defineResource('RefreshWindow', 'refresh-window', {
  statusStorageKind: 'refresh-window-status',
})
export const RefreshWindowItemResource = defineResource('RefreshWindowItem', 'refresh-window-item', {
  schema: windowItemSchema('/windowRef'),
})
export const FolloweeWindowResource = defineResource('FolloweeWindow', 'followee-window', {
  statusStorageKind: 'followee-window-status',
})
export const FolloweeWindowItemResource = defineResource('FolloweeWindowItem', 'followee-window-item', {
  schema: windowItemSchema('/windowRef'),
})
export const OverlayEntryResource = defineResource('OverlayEntry', 'overlay-entry', {
  schema: {
    type: 'object',
    required: ['entry', 'targetRef'],
    properties: { entry: { type: 'object' }, targetRef: REFERENCE_SCHEMA },
    'x-litectl-links': [{ fieldPath: '/targetRef', relation: 'overlay-for' }],
  },
})
export const SchedulerResource = defineResource('Scheduler', 'scheduler')
export const MediaObjectResource = defineResource('MediaObject', 'media-object', {
  statusStorageKind: 'media-object-status',
})
export const AccountStatusResource = defineResource('AccountStatus', 'account', {
  statusStorageKind: 'account-status',
})
export const FeedSessionResource = defineResource('FeedSession', 'feed-session', {
  statusStorageKind: 'feed-session-status',
  schema: feedSessionSchema,
})
export const FeedPageResource = defineResource('FeedPage', 'feed-page', {
  schema: feedPageSchema,
})
export const AggregateFeedPageResource = defineResource('AggregateFeedPage', 'aggregate-feed-page', {
  schema: aggregateFeedPageSchema,
})
export const FeedSourcePageResource = defineResource('FeedSourcePage', 'feed-source-page', {
  schema: feedSourcePageSchema,
})

export const ALL_RESOURCE_DEFINITIONS = [
  MessageResource,
  AuthorResource,
  FolloweeResource,
  RefreshWindowResource,
  RefreshWindowItemResource,
  FolloweeWindowResource,
  FolloweeWindowItemResource,
  OverlayEntryResource,
  SchedulerResource,
  MediaObjectResource,
  AccountStatusResource,
  FeedSessionResource,
  FeedPageResource,
  AggregateFeedPageResource,
  FeedSourcePageResource,
] as const

export type ResourceKind = (typeof ALL_RESOURCE_DEFINITIONS)[number]['kind']

const definitionsByKind = new Map<string, ResourceDefinition>(
  ALL_RESOURCE_DEFINITIONS.map(definition => [definition.kind, definition]),
)

export function resourceDefinition(kind: string): ResourceDefinition {
  const definition = definitionsByKind.get(kind)
  if (!definition) throw new Error(`unknown resource kind: ${kind}`)
  return definition
}

export function statusSchema(): Record<string, unknown> {
  return {
    type: 'object',
    'x-litectl-status': true,
    required: ['subjectRef', 'controller', 'observedGeneration', 'value'],
    properties: {
      subjectRef: REFERENCE_SCHEMA,
      controller: { const: 'refresh' },
      observedGeneration: { type: 'integer', minimum: 0 },
      value: { type: 'object' },
    },
    additionalProperties: false,
  }
}
