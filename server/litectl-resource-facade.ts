import type { Database } from 'bun:sqlite'
import type { Resource } from './store'
import {
  ALL_RESOURCE_DEFINITIONS,
  AuthorResource,
  FolloweeResource,
  FolloweeWindowItemResource,
  FolloweeWindowResource,
  FeedPageResource,
  FeedSessionResource,
  MediaObjectResource,
  MessageResource,
  OverlayEntryResource,
  RefreshWindowItemResource,
  RefreshWindowResource,
  type ResourceDefinition,
  resourceDefinition,
  statusSchema,
} from './resource-definitions'
import {
  applyLitectlResource,
  litectlWriteTransaction,
  readLitectlIdentity,
  registerLitectlKind,
} from './litectl-runtime'

const CREATION_TIMESTAMP_ANNOTATION = 'refresh.internal/creationTimestamp'
const STATUS_CONTROLLER = 'refresh'

interface ResourceRow {
  api_version: string
  kind: string
  name: string
  annotations: string
  spec_json: string
  labels_json: string
  status_spec_json: string | null
}

interface StorageResource {
  spec: Record<string, unknown>
  labels: Record<string, string>
  annotations: Record<string, string>
}

const overlayTargets: Record<string, ResourceDefinition> = {
  messages: MessageResource,
  authors: AuthorResource,
  followees: FolloweeResource,
}

export function registerRefreshLitectlKinds(database: Database): void {
  for (const definition of ALL_RESOURCE_DEFINITIONS) {
    registerLitectlKind(database, definition.apiVersion, definition.storageKind, definition.schema)
    if (definition.statusStorageKind) {
      registerLitectlKind(database, definition.apiVersion, definition.statusStorageKind, statusSchema())
    }
  }
}

export function putRefreshResource(database: Database, resource: Resource): void {
  litectlWriteTransaction(database, () => applyRefreshResource(database, resource))
}

export function getRefreshResource(
  database: Database,
  definition: ResourceDefinition,
  name: string,
): Resource | null {
  const rows = readRows(database, definition, name)
  return rows.length === 0 ? null : fromStorageResource(definition, rows[0])
}

export function listRefreshResources(database: Database, definition: ResourceDefinition): Resource[] {
  return readRows(database, definition).map(row => fromStorageResource(definition, row))
}

function applyRefreshResource(database: Database, resource: Resource): void {
  const definition = resourceDefinition(resource.kind)
  const storage = toStorageResource(database, definition, resource)
  applyLitectlResource(database, {
    apiVersion: definition.apiVersion,
    kind: definition.storageKind,
    name: resource.metadata.name,
    spec: storage.spec,
    labels: storage.labels,
    annotations: storage.annotations,
  })

  if (!definition.statusStorageKind) {
    if (Object.keys(asObject(resource.status, `${resource.kind}/${resource.metadata.name}.status`)).length > 0) {
      throw new Error(`${resource.kind}/${resource.metadata.name} has status but no Status kind`)
    }
    return
  }

  const subject = readLitectlIdentity(database, definition.apiVersion, definition.storageKind, resource.metadata.name)
  applyLitectlResource(database, {
    apiVersion: definition.apiVersion,
    kind: definition.statusStorageKind,
    name: resource.metadata.name,
    spec: {
      subjectRef: {
        apiVersion: definition.apiVersion,
        kind: definition.storageKind,
        name: resource.metadata.name,
        uid: subject.uid,
      },
      controller: STATUS_CONTROLLER,
      observedGeneration: subject.generation,
      value: asObject(resource.status, `${resource.kind}/${resource.metadata.name}.status`),
    },
  })
}

function toStorageResource(
  database: Database,
  definition: ResourceDefinition,
  resource: Resource,
): StorageResource {
  const spec = { ...asObject(resource.spec, `${resource.kind}/${resource.metadata.name}.spec`) }
  const labels = { ...(resource.metadata.labels ?? {}) }
  const annotations = { ...(resource.metadata.annotations ?? {}) }
  if (CREATION_TIMESTAMP_ANNOTATION in annotations) {
    throw new Error(`${resource.kind}/${resource.metadata.name} uses reserved annotation ${CREATION_TIMESTAMP_ANNOTATION}`)
  }
  if (resource.metadata.creationTimestamp) {
    annotations[CREATION_TIMESTAMP_ANNOTATION] = resource.metadata.creationTimestamp
  }

  if (definition === MediaObjectResource) {
    delete labels.hash
  } else if (definition === RefreshWindowItemResource || definition === FolloweeWindowItemResource) {
    const windowName = stringField(spec, 'window', `${resource.kind}/${resource.metadata.name}.spec`)
    const windowDefinition = definition === RefreshWindowItemResource ? RefreshWindowResource : FolloweeWindowResource
    delete spec.window
    spec.windowRef = referenceTo(database, windowDefinition, windowName)
  } else if (definition === OverlayEntryResource) {
    const overlayKind = labels.overlayKind
    const targetName = labels.targetName
    const targetDefinition = overlayKind ? overlayTargets[overlayKind] : undefined
    if (!targetDefinition || !targetName) {
      throw new Error(`OverlayEntry/${resource.metadata.name} requires known overlayKind and targetName labels`)
    }
    delete labels.overlayKind
    delete labels.targetName
    labels.overlay_kind = overlayKind
    spec.targetRef = referenceTo(database, targetDefinition, targetName)
  } else if (definition === FeedPageResource) {
    const sessionName = stringField(spec, 'session', `${resource.kind}/${resource.metadata.name}.spec`)
    const windowName = stringField(spec, 'window', `${resource.kind}/${resource.metadata.name}.spec`)
    delete spec.session
    delete spec.window
    spec.sessionRef = referenceTo(database, FeedSessionResource, sessionName)
    spec.windowRef = referenceTo(database, RefreshWindowResource, windowName)
  }

  return { spec, labels, annotations }
}

function fromStorageResource(definition: ResourceDefinition, row: ResourceRow): Resource {
  const spec = JSON.parse(row.spec_json) as Record<string, unknown>
  const labels = JSON.parse(row.labels_json) as Record<string, string>
  const annotations = JSON.parse(row.annotations) as Record<string, string>
  const creationTimestamp = annotations[CREATION_TIMESTAMP_ANNOTATION]
  delete annotations[CREATION_TIMESTAMP_ANNOTATION]

  if (definition === MediaObjectResource) {
    const hash = spec.hash
    if (typeof hash === 'string') labels.hash = hash
  } else if (definition === RefreshWindowItemResource || definition === FolloweeWindowItemResource) {
    const windowRef = referenceField(spec, 'windowRef', `${definition.kind}/${row.name}.spec`)
    delete spec.windowRef
    spec.window = windowRef.name
  } else if (definition === OverlayEntryResource) {
    const targetRef = referenceField(spec, 'targetRef', `OverlayEntry/${row.name}.spec`)
    delete spec.targetRef
    labels.overlayKind = stringField(labels, 'overlay_kind', `OverlayEntry/${row.name}.labels`)
    labels.targetName = targetRef.name
    delete labels.overlay_kind
  } else if (definition === FeedPageResource) {
    const sessionRef = referenceField(spec, 'sessionRef', `FeedPage/${row.name}.spec`)
    const windowRef = referenceField(spec, 'windowRef', `FeedPage/${row.name}.spec`)
    delete spec.sessionRef
    delete spec.windowRef
    spec.session = sessionRef.name
    spec.window = windowRef.name
  }

  let status: Record<string, unknown> = {}
  if (definition.statusStorageKind) {
    if (!row.status_spec_json) {
      throw new Error(`${definition.kind}/${row.name} is missing ${definition.statusStorageKind}`)
    }
    const statusSpec = JSON.parse(row.status_spec_json) as Record<string, unknown>
    status = asObject(statusSpec.value, `${definition.statusStorageKind}/${row.name}.spec.value`)
  }

  return {
    apiVersion: definition.apiVersion,
    kind: definition.kind,
    metadata: {
      name: row.name,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      ...(creationTimestamp ? { creationTimestamp } : {}),
    },
    spec,
    status,
  }
}

function readRows(database: Database, definition: ResourceDefinition, name?: string): ResourceRow[] {
  const statusKind = definition.statusStorageKind ?? ''
  const namePredicate = name === undefined ? '' : 'AND subject.name = ?'
  return database
    .query<ResourceRow, string[]>(
      `SELECT subject.api_version,
              subject.kind,
              subject.name,
              subject.annotations,
              subject.spec_json,
              COALESCE((SELECT json_group_object(key, value) FROM labels WHERE resource_id = subject.id), '{}') AS labels_json,
              (SELECT status.spec_json
                 FROM resource_links link
                 JOIN resources status ON status.id = link.from_id
                WHERE link.to_id = subject.id
                  AND link.relation = 'status'
                  AND status.api_version = ?
                  AND status.kind = ?
                  AND json_extract(status.spec_json, '$.controller') = ?
                LIMIT 1) AS status_spec_json
         FROM resources subject
        WHERE subject.api_version = ?
          AND subject.kind = ?
          ${namePredicate}
        ORDER BY subject.name`,
    )
    .all(
      definition.apiVersion,
      statusKind,
      STATUS_CONTROLLER,
      definition.apiVersion,
      definition.storageKind,
      ...(name === undefined ? [] : [name]),
    )
}

function referenceTo(database: Database, definition: ResourceDefinition, name: string): Record<string, string> {
  const target = readLitectlIdentity(database, definition.apiVersion, definition.storageKind, name)
  return { apiVersion: definition.apiVersion, kind: definition.storageKind, name, uid: target.uid }
}

function referenceField(
  object: Record<string, unknown>,
  field: string,
  context: string,
): { name: string } {
  const reference = asObject(object[field], `${context}.${field}`)
  return { name: stringField(reference, 'name', `${context}.${field}`) }
}

function stringField(object: Record<string, unknown>, field: string, context: string): string {
  const value = object[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${context}.${field} must be a non-empty string`)
  return value
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}
