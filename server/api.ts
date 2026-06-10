// /api/v1 REST 路由（docs/design.md §3）。k8s 风格信封；GET 永远秒回缓存。

import { Hono } from 'hono'
import {
  accountResources,
  getAuthor,
  getMessage,
  getWindowResource,
  listAuthors,
  listMessages,
  listWindowResources,
} from './resources'
import { createRefreshWindow, getRunningWindow, runningWindowResources, watchWindow } from './refresh'
import { patchOverlay, type OverlayEntry } from './store'
import { mediaFilePath, MIME_BY_EXT } from './media'
import { readFile } from 'fs/promises'

export const apiV1 = new Hono()

function list(kind: string, items: unknown[]) {
  return { apiVersion: 'radar/v1', kind: `${kind}List`, items }
}

function intParam(v: string | undefined): number | undefined {
  const n = parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : undefined
}

// ---------- messages ----------

apiV1.get('/messages', async c => {
  try {
    const items = await listMessages({
      labelSelector: c.req.query('labelSelector'),
      authorSelector: c.req.query('authorSelector'),
      limit: intParam(c.req.query('limit')),
    })
    return c.json(list('Message', items))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

apiV1.get('/messages/:name', async c => {
  const m = await getMessage(c.req.param('name'))
  return m ? c.json(m) : c.json({ error: 'not found' }, 404)
})

apiV1.patch('/messages/:name', async c => {
  const name = c.req.param('name')
  if (!(await getMessage(name))) return c.json({ error: 'not found' }, 404)
  const patch = (await c.req.json()) as OverlayEntry
  await patchOverlay('messages', name, patch)
  return c.json(await getMessage(name))
})

// ---------- authors ----------

apiV1.get('/authors', async c => {
  try {
    const items = await listAuthors({
      labelSelector: c.req.query('labelSelector'),
      limit: intParam(c.req.query('limit')),
    })
    return c.json(list('Author', items))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

apiV1.get('/authors/:name', async c => {
  const a = await getAuthor(c.req.param('name'))
  return a ? c.json(a) : c.json({ error: 'not found' }, 404)
})

apiV1.patch('/authors/:name', async c => {
  const name = c.req.param('name')
  if (!(await getAuthor(name))) return c.json({ error: 'not found' }, 404)
  const patch = (await c.req.json()) as OverlayEntry
  await patchOverlay('authors', name, patch)
  return c.json(await getAuthor(name))
})

// ---------- accounts ----------

apiV1.get('/accounts', c => c.json(list('Account', accountResources())))

apiV1.get('/accounts/:name', async c => {
  const name = c.req.param('name')
  if (c.req.query('check') === '1') {
    const { checkAuth } = await import('./auth')
    await checkAuth(name)
  }
  const a = accountResources().find(r => r.metadata.name === name)
  return a ? c.json(a) : c.json({ error: 'not found' }, 404)
})

// ---------- loginsessions ----------

apiV1.post('/loginsessions', async c => {
  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const spec = (body.spec ?? body) as Record<string, unknown>
  const { createLoginSession } = await import('./login')
  try {
    return c.json(await createLoginSession(String(spec.account ?? '')), 202)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

apiV1.get('/loginsessions', async c => {
  const { listLoginSessions } = await import('./login')
  return c.json(list('LoginSession', listLoginSessions()))
})

apiV1.get('/loginsessions/:id', async c => {
  const { pollLoginSession } = await import('./login')
  const s = await pollLoginSession(c.req.param('id'))
  return s ? c.json(s) : c.json({ error: 'not found' }, 404)
})

apiV1.get('/loginsessions/:id/qr', async c => {
  const { loginSessionQr } = await import('./login')
  const png = await loginSessionQr(c.req.param('id'))
  if (!png) return c.json({ error: 'qr unavailable' }, 404)
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
  })
})

// ---------- media ----------

apiV1.get('/media/:file', async c => {
  const path = mediaFilePath(c.req.param('file'))
  if (!path) return c.json({ error: 'invalid media name' }, 400)
  try {
    const bytes = await readFile(path)
    const ext = c.req.param('file').split('.').pop() ?? ''
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        // 内容寻址（sha256 命名），可永久缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// ---------- refreshwindows ----------

apiV1.get('/refreshwindows', c => {
  const source = c.req.query('source')
  const items = [...runningWindowResources(), ...listWindowResources(source)].filter(
    w => !source || (w.spec as Record<string, unknown>).source === source,
  )
  return c.json(list('RefreshWindow', items))
})

apiV1.get('/refreshwindows/:name', c => {
  const name = c.req.param('name')

  if (c.req.query('watch') === '1') {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const send = (event: string, data: string) =>
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
        const unsub = watchWindow(name, ev => {
          send(ev.type, ev.data)
          if (ev.type === 'done') {
            unsub?.()
            controller.close()
          }
        })
        if (!unsub) {
          // 不在运行中：若已落盘则直接回放终态，否则 404 由 done 事件表达
          const done = getWindowResource(name)
          if (done) {
            const status = done.status as Record<string, unknown>
            send('done', JSON.stringify({ phase: status.phase, stats: status.stats ?? null, error: status.error ?? null }))
          } else {
            send('error', 'not found')
          }
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    })
  }

  const w = getRunningWindow(name) ?? getWindowResource(name)
  return w ? c.json(w) : c.json({ error: 'not found' }, 404)
})

apiV1.post('/refreshwindows', async c => {
  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const spec = (body.spec ?? body) as Record<string, unknown>
  const source = String(spec.source ?? '')
  const trigger = ['manual', 'scheduled', 'post-login'].includes(String(spec.trigger))
    ? (String(spec.trigger) as 'manual' | 'scheduled' | 'post-login')
    : 'manual'
  try {
    const resource = createRefreshWindow({ source, count: typeof spec.count === 'number' ? spec.count : undefined, trigger })
    return c.json(resource, 202)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
