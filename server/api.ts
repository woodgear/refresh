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
  unreadCounts,
} from './resources'
import {
  createFolloweeWindows,
  exportFollowees,
  getFollowee,
  getFolloweeWindowResource,
  queryFollowees,
  listFolloweeWindowResources,
} from './followees'
import { createRefreshWindow, getRunningWindow, runningWindowResources, watchWindow } from './refresh'
import { patchOverlay, patchOverlayMany, type OverlayEntry } from './store'
import { mediaFilePath, MIME_BY_EXT, isAllowedMediaHost, proxyMediaFetch } from './media'
import { readFile } from 'fs/promises'
import { observabilitySummary, recordRum } from './observability'

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
    const namesParam = c.req.query('names')
    const items = await listMessages({
      labelSelector: c.req.query('labelSelector'),
      authorSelector: c.req.query('authorSelector'),
      names: namesParam ? namesParam.split(',').slice(0, 300) : undefined,
      limit: intParam(c.req.query('limit')),
      sort: c.req.query('sort') === 'unread-first' ? 'unread-first' : 'time',
      unreadOnly: c.req.query('unread') === 'true',
    })
    return c.json(list('Message', items))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// 批量已读（视口自动已读/一键全已读用）：names 指定，或 labelSelector 圈范围（'' = 全部）
apiV1.post('/messages/mark-read', async c => {
  let body: { names?: string[]; labelSelector?: string } = {}
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  let targets: string[]
  if (Array.isArray(body.names)) {
    targets = body.names.slice(0, 1000).filter(n => typeof n === 'string')
  } else if (typeof body.labelSelector === 'string') {
    const matched = await listMessages({ labelSelector: body.labelSelector || undefined, unreadOnly: true })
    targets = matched.map(m => m.metadata.name)
  } else {
    return c.json({ error: 'names or labelSelector required' }, 400)
  }
  const readAt = new Date().toISOString()
  await patchOverlayMany(
    'messages',
    Object.fromEntries(targets.map(n => [n, { status: { read: true, readAt } }])),
  )
  return c.json({ marked: targets.length })
})

apiV1.get('/unread-counts', async c => {
  return c.json({ apiVersion: 'radar/v1', kind: 'UnreadCounts', ...(await unreadCounts()) })
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

// ---------- followees ----------

apiV1.get('/followees', async c => {
  try {
    const page = await queryFollowees({
      labelSelector: c.req.query('labelSelector'),
      platform: c.req.query('platform'),
      includeNotFollowing: c.req.query('includeNotFollowing') === 'true',
      limit: intParam(c.req.query('limit')),
      offset: intParam(c.req.query('offset')),
    })
    return c.json({ ...list('Followee', page.items), total: page.total, offset: page.offset, limit: page.limit })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

apiV1.get('/followees/export', async c => c.json(await exportFollowees()))

apiV1.get('/followees/:name', async c => {
  const f = await getFollowee(c.req.param('name'))
  return f ? c.json(f) : c.json({ error: 'not found' }, 404)
})

apiV1.patch('/followees/:name', async c => {
  const name = c.req.param('name')
  if (!(await getFollowee(name))) return c.json({ error: 'not found' }, 404)
  const patch = (await c.req.json()) as OverlayEntry
  await patchOverlay('followees', name, patch)
  return c.json(await getFollowee(name))
})

apiV1.post('/followeewindows', async c => {
  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const spec = (body.spec ?? body) as Record<string, unknown>
  try {
    const items = await createFolloweeWindows({
      account: typeof spec.account === 'string' && spec.account ? spec.account : undefined,
      trigger: 'manual',
    })
    return c.json(list('FolloweeWindow', items), 202)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

apiV1.get('/followeewindows', async c => {
  return c.json(list('FolloweeWindow', listFolloweeWindowResources(c.req.query('account'))))
})

apiV1.get('/followeewindows/:name', async c => {
  const w = getFolloweeWindowResource(c.req.param('name'))
  return w ? c.json(w) : c.json({ error: 'not found' }, 404)
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

// password 模式：提交一步的字段值（用户名/密码、或后续 2FA/验证码）
apiV1.post('/loginsessions/:id/input', async c => {
  let body: { values?: Record<string, string> } = {}
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  if (!body.values || typeof body.values !== 'object') return c.json({ error: 'values required' }, 400)
  const { submitLoginInput } = await import('./login')
  try {
    const r = await submitLoginInput(c.req.param('id'), body.values)
    return r ? c.json(r) : c.json({ error: 'not found' }, 404)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// ---------- scheduler（单例资源） ----------

apiV1.get('/scheduler', async c => {
  const { schedulerResource } = await import('./scheduler')
  return c.json(schedulerResource())
})

apiV1.patch('/scheduler', async c => {
  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const spec = (body.spec ?? body) as Record<string, unknown>
  const { patchScheduler } = await import('./scheduler')
  try {
    return c.json(await patchScheduler(spec))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// ---------- logs ----------

apiV1.get('/logs', async c => {
  const { listLogDates, readLogTail } = await import('./logger')
  const [dates, tail] = await Promise.all([
    listLogDates(),
    readLogTail(c.req.query('date'), intParam(c.req.query('lines')) ?? 300),
  ])
  return c.json({ apiVersion: 'radar/v1', kind: 'LogTail', dates, date: tail.date, lines: tail.lines })
})

// ---------- observability ----------

apiV1.post('/rum', async c => {
  let body: { samples?: { name?: unknown; value?: unknown; at?: unknown; attrs?: unknown }[] } = {}
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  if (!Array.isArray(body.samples)) return c.json({ error: 'samples required' }, 400)
  recordRum(
    body.samples.map(sample => ({
      name: String(sample.name ?? 'unknown'),
      value: typeof sample.value === 'number' ? sample.value : Number(sample.value ?? 0),
      at: typeof sample.at === 'string' ? sample.at : new Date().toISOString(),
      attrs: sanitizeRumAttrs(sample.attrs),
    })),
  )
  return c.json({ accepted: body.samples.length })
})

apiV1.get('/observability', c => c.json(observabilitySummary()))

function sanitizeRumAttrs(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof item)) out[key] = item as string | number | boolean
  }
  return out
}

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

// 视频等大媒体不落盘，流式代理（透传 Range 支持拖进度条）；域名白名单防开放代理
apiV1.get('/media-proxy', async c => {
  const url = c.req.query('url')
  if (!url || !isAllowedMediaHost(url)) return c.json({ error: 'url missing or host not allowed' }, 400)
  try {
    const upstream = await proxyMediaFetch(url, c.req.header('range'))
    const headers = new Headers()
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    headers.set('Cache-Control', 'public, max-age=86400')
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    const { rlog } = await import('./logger')
    rlog('media-proxy', `${url.slice(0, 80)}: ${err instanceof Error ? err.message : err}`)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
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
        let closed = false
        const send = (event: string, data: string) => {
          if (closed) return
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)) } catch { closed = true }
        }
        const unsub = watchWindow(name, ev => {
          send(ev.type, ev.data)
          if (ev.type === 'done') {
            unsub?.()
            closed = true
            try { controller.close() } catch {}
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
