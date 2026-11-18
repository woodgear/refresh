import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { httpInstrumentationMiddleware } from '@hono/otel'
import { extname, join, normalize } from 'node:path'
import { apiV1 } from './api'
import { rssApp } from './rss'
import { ensureDirs } from './store'
import { initMedia } from './media'
import { buildFolloweeIndex } from './followees'
import { initScheduler } from './scheduler'
import { rlog } from './logger'
import { metricsText, recordHttp } from './observability'
import { startTracing } from './tracing'

const webDistDir = join(import.meta.dir, '..', 'dist')

/**
 * 当前部署的前端构建号（dist/index.html 里 index-<hash>.js 的 hash）。
 *
 * 前端加载后跑的是**它加载那一刻**的代码，服务端更新了它不会自己变 —— 用户会一直
 * 对着旧 bundle 撞已经修好的 bug，只能靠手动硬刷新。有了这个标识，前端可以轮询
 * 对比、发现不一致就自己重载。
 */
let buildId = 'dev'
export function currentBuildId(): string {
  return buildId
}
async function detectBuildId(): Promise<void> {
  try {
    const html = await Bun.file(join(webDistDir, 'index.html')).text()
    const matched = /index-([A-Za-z0-9_-]+)\.js/.exec(html)
    if (matched) buildId = matched[1]
  } catch {
    buildId = 'dev'
  }
}
const staticContentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
])

async function staticFileResponse(pathname: string): Promise<Response | undefined> {
  const decodedPath = decodeURIComponent(pathname)
  const normalizedPath = normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '')
  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^\/+/, '')
  const filePath = join(webDistDir, relativePath)
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined

  const contentType = staticContentTypes.get(extname(filePath))
  return new Response(file, contentType ? { headers: { 'Content-Type': contentType } } : undefined)
}

const tracing = startTracing()
const app = new Hono()
app.use('*', httpInstrumentationMiddleware({
  serviceName: tracing.serviceName,
  serviceVersion: tracing.serviceVersion,
  captureRequestHeaders: ['traceparent', 'tracestate', 'user-agent', 'x-forwarded-for'],
  captureResponseHeaders: ['content-type'],
  spanNameFactory: c => `${c.req.method} ${c.req.path}`,
}))
app.use('*', cors())
app.use('*', async (c, next) => {
  const startedAt = performance.now()
  try {
    await next()
  } finally {
    recordHttp(c.req.method, c.req.path, c.res.status, performance.now() - startedAt)
  }
})
app.get('/metrics', () => new Response(metricsText(), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } }))

// 资源 API + RSS（docs/design.md）
await ensureDirs()
await initMedia()
await buildFolloweeIndex()
app.get('/api/v1/version', async () => {
  await detectBuildId()
  return Response.json({ build: currentBuildId() })
})
app.route('/api/v1', apiV1)
app.route('/rss', rssApp)
app.get('*', async c => {
  const staticResponse = await staticFileResponse(c.req.path)
  if (staticResponse) return staticResponse

  const index = Bun.file(join(webDistDir, 'index.html'))
  return new Response(index, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
})

await initScheduler()

// 启动时后台预热登录态（不阻塞启动；mock/测试环境下走 mock 分支，零开销）
if (process.env.RADAR_AUTH_PRECHECK !== 'off') {
  void (async () => {
    const { ACCOUNTS } = await import('./config')
    const { checkAuth } = await import('./auth')
    for (const a of ACCOUNTS) {
      const r = await checkAuth(a.name).catch(() => null)
      rlog('auth', `${a.name}: ${r?.auth ?? 'check failed'}`)
    }
  })()
}

const port = parseInt(process.env.PORT ?? '3001', 10)
// 有意全开（局域网设备直接访问 API/RSS）；无鉴权，勿在不可信网络运行
Bun.serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
rlog('server', `running on http://0.0.0.0:${port}`)
