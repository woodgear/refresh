import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import {
  applyLitectlResource,
  litectlWriteTransaction,
  openLitectlDatabase,
  readLitectlIdentity,
  registerLitectlKind,
} from './litectl-runtime'
import {
  getRefreshResource,
  listRefreshResourcesLinkedTo,
  putRefreshResource,
  registerRefreshLitectlKinds,
} from './litectl-resource-facade'
import {
  MediaObjectResource,
  MessageResource,
  OverlayEntryResource,
  FeedPageResource,
  FeedSessionResource,
  RefreshWindowItemResource,
  RefreshWindowResource,
} from './resource-definitions'
import {
  detectRefreshDatabaseFormat,
  migrateCustomResourceStore,
  migrateCustomResourceStoreInPlace,
} from './litectl-migration'
import { litectlExtensionPath } from './litectl-extension'

const SUBJECT_SCHEMA = {
  type: 'object',
  required: ['body'],
  properties: { body: { type: 'string' } },
  additionalProperties: false,
}

const STATUS_SCHEMA = {
  type: 'object',
  'x-litectl-status': true,
  required: ['subjectRef', 'controller', 'observedGeneration', 'value'],
  properties: {
    subjectRef: {
      type: 'object',
      required: ['apiVersion', 'kind', 'name', 'uid'],
      properties: {
        apiVersion: { type: 'string' },
        kind: { type: 'string' },
        name: { type: 'string' },
        uid: { type: 'string' },
      },
      additionalProperties: false,
    },
    controller: { const: 'refresh' },
    observedGeneration: { type: 'integer', minimum: 0 },
    value: { type: 'object' },
  },
  additionalProperties: false,
}

const extensionPath = process.env.LITECTL_EXTENSION_PATH ?? litectlExtensionPath()

describe('litectl Bun runtime contract', () => {
  const directory = mkdtempSync(join(tmpdir(), 'refresh-litectl-contract-'))
  let database: Database

  beforeAll(() => {
    database = openLitectlDatabase(join(directory, 'contract.db'), extensionPath)
    registerLitectlKind(database, 'radar/v1', 'message', SUBJECT_SCHEMA)
    registerLitectlKind(database, 'radar/v1', 'message-status', STATUS_SCHEMA)
  })

  afterAll(() => {
    database.close()
    rmSync(directory, { recursive: true })
  })

  test('subject and Status join the caller transaction', () => {
    expect(() =>
      litectlWriteTransaction(database, () => {
        applyLitectlResource(database, {
          apiVersion: 'radar/v1',
          kind: 'message',
          name: 'twitter-1',
          spec: { body: 'one' },
        })
        const subject = readLitectlIdentity(database, 'radar/v1', 'message', 'twitter-1')
        applyLitectlResource(database, {
          apiVersion: 'radar/v1',
          kind: 'message-status',
          name: 'twitter-1',
          spec: {
            subjectRef: { apiVersion: 'radar/v1', kind: 'message', name: 'twitter-1', uid: subject.uid },
            controller: 'refresh',
            observedGeneration: subject.generation,
            value: { read: false },
          },
        })
        throw new Error('abort contract transaction')
      }),
    ).toThrow('abort contract transaction')

    const count = database.query<{ count: number }, []>('SELECT count(*) AS count FROM resources').get()
    expect(count?.count).toBe(0)
  })

  test('committed Status is linked to its subject and has an independent event', () => {
    litectlWriteTransaction(database, () => {
      applyLitectlResource(database, {
        apiVersion: 'radar/v1',
        kind: 'message',
        name: 'twitter-1',
        spec: { body: 'one' },
        labels: { platform: 'twitter' },
      })
      const subject = readLitectlIdentity(database, 'radar/v1', 'message', 'twitter-1')
      applyLitectlResource(database, {
        apiVersion: 'radar/v1',
        kind: 'message-status',
        name: 'twitter-1',
        spec: {
          subjectRef: { apiVersion: 'radar/v1', kind: 'message', name: 'twitter-1', uid: subject.uid },
          controller: 'refresh',
          observedGeneration: subject.generation,
          value: { read: false },
        },
      })
    })

    const link = database
      .query<{ relation: string; subjectKind: string; statusKind: string }, []>(
        `SELECT link.relation, subject.kind AS subjectKind, status.kind AS statusKind
         FROM resource_links link
         JOIN resources subject ON subject.id = link.to_id
         JOIN resources status ON status.id = link.from_id`,
      )
      .get()
    expect(link).toEqual({ relation: 'status', subjectKind: 'message', statusKind: 'message-status' })

    const events = database.query<{ kind: string }, []>('SELECT kind FROM events ORDER BY rv').all()
    expect(events.map(event => event.kind)).toEqual(['message', 'message-status'])
  })
})

describe('Refresh resource facade contract', () => {
  const directory = mkdtempSync(join(tmpdir(), 'refresh-litectl-facade-'))
  let database: Database

  beforeAll(() => {
    database = openLitectlDatabase(join(directory, 'facade.db'), extensionPath)
    registerRefreshLitectlKinds(database)
  })

  afterAll(() => {
    database.close()
    rmSync(directory, { recursive: true })
  })

  test('public kind, timestamp, annotations, and inline status round trip through subject and Status', () => {
    const message = {
      apiVersion: 'radar/v1' as const,
      kind: 'Message',
      metadata: {
        name: 'twitter-2',
        labels: { platform: 'twitter', source: 'twitter-main-following' },
        annotations: { 'radar/firstSeenWindow': 'window-1' },
        creationTimestamp: '2026-08-15T00:00:00.000Z',
      },
      spec: { text: 'two', raw: { id: '2' } },
      status: { hydrated: false, read: true },
    }
    putRefreshResource(database, message)
    expect(getRefreshResource(database, MessageResource, 'twitter-2')).toEqual(message)
  })

  test('64-character media hash remains public without becoming a litectl label', () => {
    const hash = 'a'.repeat(64)
    const media = {
      apiVersion: 'radar/v1' as const,
      kind: 'MediaObject',
      metadata: { name: `${hash}.jpg`, labels: { hash, ext: 'jpg' } },
      spec: { hash, ext: 'jpg', originUrl: 'https://example.test/image.jpg', file: `${hash}.jpg`, bytes: 10 },
      status: { phase: 'Available' },
    }
    putRefreshResource(database, media)
    expect(getRefreshResource(database, MediaObjectResource, media.metadata.name)).toEqual(media)
    const storedHashLabel = database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM labels WHERE key = 'hash'")
      .get()
    expect(storedHashLabel?.count).toBe(0)
  })

  test('window items and overlays materialize links while preserving public specs and labels', () => {
    const window = {
      apiVersion: 'radar/v1' as const,
      kind: 'RefreshWindow',
      metadata: { name: 'twitter-main-following-1', labels: { source: 'twitter-main-following' } },
      spec: { source: 'twitter-main-following', count: 1 },
      status: { phase: 'Succeeded' },
    }
    putRefreshResource(database, window)

    const item = {
      apiVersion: 'radar/v1' as const,
      kind: 'RefreshWindowItem',
      metadata: { name: 'twitter-main-following-1-000000', labels: { window: window.metadata.name } },
      spec: { window: window.metadata.name, ordinal: 0, raw: { id: '2' } },
      status: {},
    }
    putRefreshResource(database, item)
    expect(getRefreshResource(database, RefreshWindowItemResource, item.metadata.name)).toEqual(item)

    const overlay = {
      apiVersion: 'radar/v1' as const,
      kind: 'OverlayEntry',
      metadata: {
        name: 'messages-twitter-2',
        labels: { overlayKind: 'messages', targetName: 'twitter-2' },
      },
      spec: { entry: { status: { read: true } } },
      status: {},
    }
    putRefreshResource(database, overlay)
    expect(getRefreshResource(database, OverlayEntryResource, overlay.metadata.name)).toEqual(overlay)

    const links = database
      .query<{ relation: string }, []>(
        "SELECT relation FROM resource_links WHERE relation IN ('item-of', 'overlay-for') ORDER BY relation",
      )
      .all()
    expect(links.map(link => link.relation)).toEqual(['item-of', 'overlay-for'])
    expect(getRefreshResource(database, RefreshWindowResource, window.metadata.name)).toEqual(window)
  })

  test('feed page commit preserves public resources and materializes session and window links', () => {
    const window = {
      apiVersion: 'radar/v1' as const,
      kind: 'RefreshWindow',
      metadata: { name: 'feed-window-1' },
      spec: { source: 'twitter-main-following', count: 2 },
      status: { phase: 'Succeeded' },
    }
    const session = {
      apiVersion: 'radar/v1' as const,
      kind: 'FeedSession',
      metadata: { name: 'feed-1', labels: { source: 'twitter-main-following' } },
      spec: { source: 'twitter-main-following', generation: 'generation-1' },
      status: {
        nextCursor: 'cursor-1',
        hasMore: true,
        pageCount: 1,
        lastPage: 'feed-1-000000',
        lastWindow: 'feed-window-1',
      },
    }
    const page = {
      apiVersion: 'radar/v1' as const,
      kind: 'FeedPage',
      metadata: { name: 'feed-1-000000' },
      spec: {
        session: 'feed-1',
        window: 'feed-window-1',
        ordinal: 0,
        mode: 'restart',
        inputCursor: null,
        outputCursor: 'cursor-1',
        hasMore: true,
        fetchedAt: 1,
        messageRefs: ['twitter-2'],
      },
      status: {},
    }

    litectlWriteTransaction(database, () => {
      putRefreshResource(database, window)
      putRefreshResource(database, session)
      putRefreshResource(database, page)
    })

    expect(getRefreshResource(database, FeedSessionResource, session.metadata.name)).toEqual(session)
    expect(getRefreshResource(database, FeedPageResource, page.metadata.name)).toEqual(page)
    expect(listRefreshResourcesLinkedTo(
      database,
      FeedPageResource,
      'page-of',
      FeedSessionResource,
      session.metadata.name,
    )).toEqual([page])
    const links = database.query<{ relation: string }, []>(
      `SELECT link.relation
         FROM resource_links link
         JOIN resources page ON page.id = link.from_id
        WHERE page.kind = 'feed-page'
          AND page.name = 'feed-1-000000'
        ORDER BY link.relation`,
    ).all()
    expect(links.map(link => link.relation)).toEqual(['page-of', 'page-window'])
  })

  test('feed session and page roll back together when their caller transaction fails', () => {
    expect(() => litectlWriteTransaction(database, () => {
      putRefreshResource(database, {
        apiVersion: 'radar/v1',
        kind: 'FeedSession',
        metadata: { name: 'feed-aborted' },
        spec: { source: 'twitter-main-following', generation: 'aborted' },
        status: {
          nextCursor: null,
          hasMore: false,
          pageCount: 0,
          lastPage: '',
          lastWindow: '',
        },
      })
      putRefreshResource(database, {
        apiVersion: 'radar/v1',
        kind: 'FeedPage',
        metadata: { name: 'feed-aborted-000000' },
        spec: {
          session: 'feed-aborted',
          window: 'feed-window-1',
          ordinal: 0,
          mode: 'restart',
          inputCursor: null,
          outputCursor: null,
          hasMore: false,
          fetchedAt: 1,
          messageRefs: [],
        },
        status: {},
      })
      throw new Error('abort feed page commit')
    })).toThrow('abort feed page commit')
    expect(getRefreshResource(database, FeedSessionResource, 'feed-aborted')).toBeNull()
    expect(getRefreshResource(database, FeedPageResource, 'feed-aborted-000000')).toBeNull()
  })
})

describe('Refresh custom ResourceStore migration contract', () => {
  const directory = mkdtempSync(join(tmpdir(), 'refresh-litectl-migration-'))
  const sourcePath = join(directory, 'legacy.db')
  const targetPath = join(directory, 'litectl.db')
  const inPlacePath = join(directory, 'legacy-in-place.db')

  beforeAll(() => {
    createLegacyFixture(sourcePath)
    createLegacyFixture(inPlacePath)
  })
  afterAll(() => rmSync(directory, { recursive: true }))

  test('converts and reconciles public envelopes, Status resources, and declared links', () => {
    expect(detectRefreshDatabaseFormat(sourcePath)).toBe('custom-resource-store')
    expect(migrateCustomResourceStore(sourcePath, targetPath, extensionPath)).toEqual({
      resources: 6,
      storageResources: 10,
      statusLinks: 4,
      businessLinks: 2,
    })
    expect(detectRefreshDatabaseFormat(targetPath)).toBe('litectl-v2')
  })

  test('preserves a custom database backup and atomically replaces the source path', () => {
    const result = migrateCustomResourceStoreInPlace(inPlacePath, extensionPath)
    expect(result.resources).toBe(6)
    expect(result.backupPath).toBe(`${inPlacePath}.pre-litectl-v2.sqlite`)
    expect(existsSync(result.backupPath)).toBe(true)
    expect(detectRefreshDatabaseFormat(result.backupPath)).toBe('custom-resource-store')
    expect(detectRefreshDatabaseFormat(inPlacePath)).toBe('litectl-v2')
  })
})

function createLegacyFixture(path: string): void {
  const database = new Database(path, { create: true, strict: true })
  database.run('CREATE TABLE resource_schemas (kind TEXT)')
  database.run('CREATE TABLE resource_index_terms (kind TEXT)')
  database.run('CREATE TABLE resource_index_values (kind TEXT)')
  database.run('CREATE TABLE store_migrations (id TEXT)')
  database.run(`
    CREATE TABLE resources (
      api_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      metadata TEXT NOT NULL,
      spec TEXT NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT
    )
  `)
  const insert = database.query(
    'INSERT INTO resources(api_version, kind, name, metadata, spec, status, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  )
  const add = (
    kind: string,
    name: string,
    metadata: Record<string, unknown>,
    spec: Record<string, unknown>,
    status: Record<string, unknown>,
  ) => insert.run('radar/v1', kind, name, JSON.stringify({ name, ...metadata }), JSON.stringify(spec), JSON.stringify(status))

  add(
    'Message',
    'twitter-legacy',
    { labels: { platform: 'twitter' }, creationTimestamp: '2026-08-14T00:00:00.000Z' },
    { text: 'legacy', raw: { id: 'legacy' } },
    { hydrated: false },
  )
  add(
    'RefreshWindow',
    'twitter-main-following-legacy',
    { labels: { source: 'twitter-main-following' } },
    { source: 'twitter-main-following', count: 1 },
    { phase: 'Succeeded' },
  )
  add(
    'RefreshWindowItem',
    'twitter-main-following-legacy-000000',
    { labels: { window: 'twitter-main-following-legacy' } },
    { window: 'twitter-main-following-legacy', ordinal: 0, raw: { id: 'legacy' } },
    {},
  )
  add(
    'OverlayEntry',
    'messages-twitter-legacy',
    { labels: { overlayKind: 'messages', targetName: 'twitter-legacy' } },
    { entry: { status: { read: true } } },
    {},
  )
  const hash = 'b'.repeat(64)
  add(
    'MediaObject',
    `${hash}.jpg`,
    { labels: { hash, ext: 'jpg' } },
    { hash, ext: 'jpg', file: `${hash}.jpg`, originUrl: 'https://example.test/legacy.jpg', bytes: 12 },
    { phase: 'Available' },
  )
  add('AccountStatus', 'twitter-main', {}, {}, { auth: 'ok', lastChecked: '2026-08-15T00:00:00.000Z' })
  database.close()
}
