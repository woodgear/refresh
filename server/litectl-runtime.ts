import { Database } from 'bun:sqlite'

export const LITECTL_FORMAT_VERSION = '2'
export const LITECTL_EXTENSION_ENTRY = 'sqlite3_litectl_ext_init'

interface FormatVersionRow {
  value: string
}

interface ResourceIdentityRow {
  uid: string
  generation: number
  resource_version: number
}

export interface ApplyResourceInput {
  apiVersion: string
  kind: string
  name: string
  spec: Record<string, unknown>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  expectResourceVersion?: number
}

export interface ResourceIdentity {
  uid: string
  generation: number
  resourceVersion: number
}

export function openLitectlDatabase(path: string, extensionPath: string): Database {
  const database = new Database(path, { create: true, strict: true })
  try {
    database.loadExtension(extensionPath, LITECTL_EXTENSION_ENTRY)
    database.query('SELECT litectl_init()').get()
    const row = database.query<FormatVersionRow, []>("SELECT value FROM meta WHERE key = 'format_version'").get()
    if (!row || row.value !== LITECTL_FORMAT_VERSION) {
      throw new Error(`litectl storage format ${row?.value ?? 'missing'} is unsupported; expected ${LITECTL_FORMAT_VERSION}`)
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export function assertLitectlV2Extension(extensionPath: string): void {
  const database = openLitectlDatabase(':memory:', extensionPath)
  database.close()
}

export function registerLitectlKind(
  database: Database,
  apiVersion: string,
  kind: string,
  schema: Record<string, unknown>,
): void {
  database
    .query('SELECT litectl_register_kind(?, ?, ?)')
    .get(apiVersion, kind, JSON.stringify(schema))
}

export function applyLitectlResource(database: Database, input: ApplyResourceInput): number {
  const row = database
    .query<{ resourceVersion: number }, [string, string, string, string, string, number | null, string]>(
      'SELECT litectl_apply(?, ?, ?, ?, ?, ?, ?) AS resourceVersion',
    )
    .get(
      input.apiVersion,
      input.kind,
      input.name,
      JSON.stringify(input.spec),
      JSON.stringify(input.labels ?? {}),
      input.expectResourceVersion ?? null,
      JSON.stringify(input.annotations ?? {}),
    )
  if (!row) throw new Error(`litectl apply returned no resourceVersion for ${input.apiVersion}/${input.kind}/${input.name}`)
  return row.resourceVersion
}

export function readLitectlIdentity(
  database: Database,
  apiVersion: string,
  kind: string,
  name: string,
): ResourceIdentity {
  const row = database
    .query<ResourceIdentityRow, [string, string, string]>(
      `SELECT uid, generation, resource_version
       FROM resources
       WHERE api_version = ? AND kind = ? AND name = ?`,
    )
    .get(apiVersion, kind, name)
  if (!row) throw new Error(`litectl resource not found: ${apiVersion}/${kind}/${name}`)
  return { uid: row.uid, generation: row.generation, resourceVersion: row.resource_version }
}

export function litectlWriteTransaction<T>(database: Database, operation: () => T): T {
  if (database.inTransaction) return operation()
  database.run('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.run('COMMIT')
    return result
  } catch (error) {
    database.run('ROLLBACK')
    throw error
  }
}
