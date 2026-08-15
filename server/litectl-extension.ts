import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let extracted: { directory: string; path: string } | null = null

export function litectlExtensionPath(): string {
  if (extracted) return extracted.path
  const directory = mkdtempSync(join(tmpdir(), 'refresh-litectl-ext-'))
  const path = join(directory, 'litectl-ext.so')
  const binary = process.env.LITECTL_BIN ?? 'litectl'
  const result = Bun.spawnSync([binary, 'extension', 'extract', '-o', path], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    rmSync(directory, { recursive: true })
    const detail = result.stderr.toString().trim() || `exit code ${result.exitCode}`
    throw new Error(`litectl extension extraction failed: ${detail}`)
  }
  extracted = { directory, path }
  process.once('exit', cleanupLitectlExtensionForTests)
  return path
}

export function cleanupLitectlExtensionForTests(): void {
  if (!extracted) return
  rmSync(extracted.directory, { recursive: true })
  extracted = null
}
