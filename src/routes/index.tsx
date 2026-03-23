import { createFileRoute } from '@tanstack/react-router'
import { useItemStore } from '@/stores/itemStore'
import { MessageCard } from '@/components/MessageCard'
import { Loader2 } from 'lucide-react'
import type { Message } from '@/types'

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
      author: { name: item.meta?.actor_name || item.author?.name || '未知' },
      stats: {
        voteup_count: item.meta?.voteup_count || item.stats?.voteup_count || 0,
        comment_count: item.meta?.comment_count || item.stats?.comment_count || 0,
      },
    }
  }
}

function FeedPage() {
  // 从 store 读取状态
  const ids = useItemStore((s) => s.ids)
  const items = useItemStore((s) => s.items)
  const fetchedAt = useItemStore((s) => s.fetchedAt)
  const isLoading = useItemStore((s) => s.isLoading)
  const error = useItemStore((s) => s.error)

  if (isLoading && ids.length === 0) {
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

  // 根据 ids 顺序获取 items
  const messages = ids
    .map(id => items.get(id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .map(convertToMessage)

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {messages.map((message) => (
        <MessageCard key={message.id} message={message} fetchedAt={fetchedAt} />
      ))}
      {messages.length === 0 && (
        <div className="text-center text-muted-foreground py-8">
          暂无内容
        </div>
      )}
    </div>
  )
}
