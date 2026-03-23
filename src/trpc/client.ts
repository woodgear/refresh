import { createTRPCReact } from '@trpc/react-query'
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../server/trpc'

// React hook 版本
export const trpc = createTRPCReact<AppRouter>()

// Vanilla client (用于 Zustand store 等非 React 上下文)
export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/trpc',
    }),
  ],
})
