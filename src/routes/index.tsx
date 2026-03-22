import { createFileRoute } from '@tanstack/react-router'
import { useUIStore } from '@/stores/uiStore'
import { trpc } from '@/trpc/client'
import { MessageCard } from '@/components/MessageCard'
import { Loader2 } from 'lucide-react'
import type { Message } from '@/types'
import { FEED_SOURCES } from '@/types'

export const Route = createFileRoute('/')({
  component: FeedPage,
})

const convertToMessage = (item: any): Message => {
  if (item.type === 'tweet') {
    return {
      type: 'twitter' as const,
      id: item.id,
      author: item.author,
      url: item.url,
      text: item.text,
      likes: item.likes || 0,
      retweets: item.retweets || 0,
      views: item.views || 0,
    }
  } else {
    return {
      type: 'zhihu' as const,
      id: item.id,
      title: item.title,
      excerpt: item.excerpt,
      url: item.url,
      author: { name: item.meta?.actor_name || '未知' },
      stats: {
        voteup_count: item.meta?.voteup_count || 0,
        comment_count: item.meta?.comment_count || 0,
      },
    }
  }
}

function FeedPage() {
  const activeSource = useUIStore((s) => s.activeSource)

  // 判断是分类还是单个源
  const isCategory = activeSource === 'follow' || activeSource === 'recommend'
  const sources = isCategory
    ? FEED_SOURCES[activeSource].map(s => s.id)
    : [activeSource]

  // 获取所有需要的数据
  const queries = sources.map(source => trpc.feed.useQuery({ source }))

  const isLoading = queries.some(q => q.isLoading)
  const error = queries.find(q => q.error)?.error

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-destructive">
        <p>加载失败: {error.message}</p>
      </div>
    )
  }

  // 合并所有数据，按 id 去重
  const seenIds = new Set<string>()
  const allMessages: Message[] = []
  let latestFetchedAt: string | null = null

  for (const query of queries) {
    const data = query.data
    if (!data?.items) continue

    if (data.fetchedAt && (!latestFetchedAt || data.fetchedAt > latestFetchedAt)) {
      latestFetchedAt = data.fetchedAt
    }

    for (const item of data.items) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id)
        allMessages.push(convertToMessage(item))
      }
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {allMessages.map((message) => (
        <MessageCard key={message.id} message={message} fetchedAt={latestFetchedAt} />
      ))}
      {allMessages.length === 0 && (
        <div className="text-center text-muted-foreground py-8">
          暂无内容
        </div>
      )}
    </div>
  )
}
