export interface ResourceDefinition<K extends string = string> {
  apiVersion: 'radar/v1'
  kind: K
  schemaVersion: number
}

function defineResource<K extends string>(kind: K): ResourceDefinition<K> {
  return { apiVersion: 'radar/v1', kind, schemaVersion: 1 }
}

export const MessageResource = defineResource('Message')
export const AuthorResource = defineResource('Author')
export const FolloweeResource = defineResource('Followee')
export const RefreshWindowResource = defineResource('RefreshWindow')
export const RefreshWindowItemResource = defineResource('RefreshWindowItem')
export const FolloweeWindowResource = defineResource('FolloweeWindow')
export const FolloweeWindowItemResource = defineResource('FolloweeWindowItem')
export const OverlayEntryResource = defineResource('OverlayEntry')
export const SchedulerResource = defineResource('Scheduler')
export const MediaObjectResource = defineResource('MediaObject')
export const AccountStatusResource = defineResource('AccountStatus')

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
