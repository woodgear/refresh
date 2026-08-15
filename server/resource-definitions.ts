export interface ResourceDefinition<K extends string = string> {
  apiVersion: 'radar/v1'
  kind: K
  storageKind: string
  schema: Record<string, unknown>
  statusStorageKind?: string
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
  options: { statusStorageKind?: string; schema?: Record<string, unknown> } = {},
): ResourceDefinition<K> {
  return {
    apiVersion: 'radar/v1',
    kind,
    storageKind,
    schema: options.schema ?? OBJECT_SCHEMA,
    statusStorageKind: options.statusStorageKind,
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

export const MessageResource = defineResource('Message', 'message', { statusStorageKind: 'message-status' })
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
