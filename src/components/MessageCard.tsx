import type { Message, TwitterMessage, ZhihuMessage } from '@/types'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Heart, MessageCircle, Repeat2, Eye, ArrowUp, Clock } from 'lucide-react'

interface MessageCardProps {
  message: Message
  fetchedAt?: string | number | null
}

function isTwitter(msg: Message): msg is TwitterMessage {
  return msg.type === 'twitter'
}

function isZhihu(msg: Message): msg is ZhihuMessage {
  return msg.type === 'zhihu'
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatFetchedAt(timestamp: string | number | null | undefined): string {
  if (!timestamp) return ''
  // 如果是字符串形式的 Unix 时间戳，转换为数字
  const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp
  if (isNaN(ts)) return ''
  const date = new Date(ts * 1000)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

export function MessageCard({ message, fetchedAt }: MessageCardProps) {
  return (
    <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => window.open(message.url, '_blank')}>
      {isTwitter(message) && <TwitterCardContent message={message} fetchedAt={fetchedAt} />}
      {isZhihu(message) && <ZhihuCardContent message={message} fetchedAt={fetchedAt} />}
    </Card>
  )
}

function TwitterCardContent({ message, fetchedAt }: { message: TwitterMessage; fetchedAt?: string | number | null }) {
  return (
    <>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
              {message.author.slice(0, 2).toUpperCase()}
            </div>
            <span className="font-medium text-sm">@{message.author}</span>
          </div>
          {fetchedAt && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {formatFetchedAt(fetchedAt)}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pb-2">
        <p className="text-sm whitespace-pre-wrap line-clamp-6">{message.text}</p>
      </CardContent>
      <CardFooter className="text-muted-foreground text-xs gap-4">
        <span className="flex items-center gap-1">
          <Heart className="h-3 w-3" />
          {formatNumber(message.likes)}
        </span>
        <span className="flex items-center gap-1">
          <Repeat2 className="h-3 w-3" />
          {formatNumber(message.retweets)}
        </span>
        <span className="flex items-center gap-1">
          <Eye className="h-3 w-3" />
          {formatNumber(message.views)}
        </span>
      </CardFooter>
    </>
  )
}

function ZhihuCardContent({ message, fetchedAt }: { message: ZhihuMessage; fetchedAt?: string | number | null }) {
  return (
    <>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium text-sm line-clamp-2">{message.title}</h3>
          {fetchedAt && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <Clock className="h-3 w-3" />
              {formatFetchedAt(fetchedAt)}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {message.author.name}
        </div>
      </CardHeader>
      <CardContent className="pb-2">
        <p className="text-sm text-muted-foreground line-clamp-3">{message.excerpt}</p>
      </CardContent>
      <CardFooter className="text-muted-foreground text-xs gap-4">
        <span className="flex items-center gap-1">
          <ArrowUp className="h-3 w-3" />
          {formatNumber(message.stats.voteup_count)}
        </span>
        <span className="flex items-center gap-1">
          <MessageCircle className="h-3 w-3" />
          {formatNumber(message.stats.comment_count)}
        </span>
      </CardFooter>
    </>
  )
}
