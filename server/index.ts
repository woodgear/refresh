import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter, scanAllSources } from './trpc'
import { spawn } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = new Hono()
app.use('*', cors())

// tRPC handler
app.use('/trpc/*', async (c) => {
  return fetchRequestHandler({
    endpoint: '/trpc',
    req: c.req.raw,
    router: appRouter,
    createContext: () => ({})
  })
})

// SSE endpoint for fetch with real-time logs
app.get('/api/fetch', async (c) => {
  // Get count parameter from URL query
  const countParam = c.req.query('count')
  const count = Math.min(Math.max(parseInt(countParam || '50'), 10), 200)

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
      }

      send('log', `Starting fetch (count: ${count})...`)

      const projectDir = join(__dirname, '..')
      const timestamp = Math.floor(Date.now() / 1000)

      const tasks = [
        { name: 'zhihu-follow', cmd: 'bb-browser', args: ['site', 'zhihu/follow', String(count), '--jq', '.'] },
        { name: 'zhihu-recommend', cmd: 'bb-browser', args: ['site', 'zhihu/recommend', String(count), '--jq', '.'] },
        { name: 'twitter-following', cmd: 'bb-browser', args: ['site', 'twitter/following', String(count), '--jq', '.'] },
        { name: 'twitter-recommend', cmd: 'bb-browser', args: ['site', 'twitter/recommend', String(count), '--jq', '.'] },
      ]

      for (const task of tasks) {
        send('log', `Fetching ${task.name}...`)

        try {
          const result = await new Promise<string>((resolve, reject) => {
            const proc = spawn(task.cmd, task.args, { cwd: projectDir })
            let stdout = ''
            let stderr = ''

            proc.stdout.on('data', (data) => {
              stdout += data.toString()
            })

            proc.stderr.on('data', (data) => {
              stderr += data.toString()
              send('log', `[${task.name}] ${data.toString().trim()}`)
            })

            proc.on('close', (code) => {
              if (code === 0) {
                resolve(stdout)
              } else {
                reject(new Error(`Exit code ${code}: ${stderr}`))
              }
            })

            proc.on('error', reject)
          })

          // 保存文件
          const fileName = `${task.name}-${timestamp}.json`
          const filePath = join(projectDir, 'data', fileName)
          await Bun.write(filePath, result)
          send('log', `✓ Saved ${fileName}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          send('log', `✗ Failed ${task.name}: ${msg}`)
          send('error', msg)
        }
      }

      // 重新扫描
      send('log', 'Scanning data files...')
      await scanAllSources()

      send('done', JSON.stringify({ timestamp, lastScanTime: new Date().toISOString() }))
      controller.close()
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  })
})

const port = 3001
Bun.serve({ fetch: app.fetch, port })
console.log(`Server running on http://localhost:${port}`)
