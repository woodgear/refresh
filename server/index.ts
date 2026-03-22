import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from './trpc'

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

const port = 3001
Bun.serve({ fetch: app.fetch, port })
console.log(`Server running on http://localhost:${port}`)
