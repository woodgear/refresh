import type { Message, MediaRef } from '@/api/radar'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Heart, MessageCircle, Repeat2, Eye, ArrowUp, Clock, Repeat, ExternalLink, Circle, CheckCircle2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

interface MessageCardProps {
  message: Message
  /** 卡片在视口中停留足够久（自动已读用） */
  onSeen?: (name: string) => void
  onToggleRead?: (name: string, read: boolean) => void
}

export function MessageCard({ message, onSeen, onToggleRead }: MessageCardProps) {
  const { spec, metadata } = message
  const platform = metadata.labels?.platform
  const read = !!message.status.read
  const [showContent, setShowContent] = useState(false)
  const [lightbox, setLightbox] = useState<MediaRef | null>(null)
  const author = spec.author
  const rootRef = useRef<HTMLDivElement>(null)
  const seenFired = useRef(false)

  // 视口自动已读：卡片 50% 可见持续 1.5s 触发一次
  useEffect(() => {
    if (!onSeen || read || seenFired.current || !rootRef.current) return
    let timer: number | null = null
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries[0]?.isIntersecting
        if (visible && timer === null) {
          timer = window.setTimeout(() => {
            if (!seenFired.current) {
              seenFired.current = true
              onSeen(metadata.name)
            }
          }, 1500)
        } else if (!visible && timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
      },
      { threshold: 0.5 },
    )
    observer.observe(rootRef.current)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [onSeen, read, metadata.name])

  return (
    <Card
      ref={rootRef}
      className={cn(
        'hover:shadow-md transition-all border-l-2',
        read ? 'border-l-transparent' : 'border-l-primary',
      )}
    >
      <CardHeader className="pb-2">
        {spec.retweetedBy && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Repeat className="h-3 w-3" />@{spec.retweetedBy} 转推
          </div>
        )}
        {spec.refs?.replyToHandle && (
          <div className="text-xs text-muted-foreground">↩ 回复 @{spec.refs.replyToHandle}</div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {author?.avatar ? (
              <img src={author.avatar} alt="" className="w-8 h-8 rounded-full shrink-0 object-cover" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
                {(author?.name ?? author?.handle ?? '?').slice(0, 2)}
              </div>
            )}
            <div className="min-w-0">
              <span className="font-medium text-sm truncate block">
                {author?.name ?? author?.handle ?? '未知'}
                {author?.handle && platform === 'twitter' && (
                  <span className="text-muted-foreground font-normal"> @{author.handle}</span>
                )}
              </span>
            </div>
          </div>
          <span className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
            <Clock className="h-3 w-3" />
            {formatTime(metadata.creationTimestamp)}
            {onToggleRead && (
              <button
                onClick={() => onToggleRead(metadata.name, !read)}
                title={read ? '标为未读' : '标为已读'}
                className="hover:text-foreground"
              >
                {read ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              </button>
            )}
          </span>
        </div>
        {spec.title && (
          <h3
            className="font-medium text-sm cursor-pointer hover:underline"
            onClick={() => spec.url && window.open(spec.url, '_blank')}
          >
            {spec.title}
          </h3>
        )}
      </CardHeader>

      <CardContent className="pb-2 space-y-2">
        {spec.text && <p className="text-sm whitespace-pre-wrap line-clamp-6">{spec.text}</p>}

        {spec.quotedSnapshot?.text && (
          <blockquote className="border-l-2 pl-3 text-xs text-muted-foreground">
            <span className="font-medium">@{spec.quotedSnapshot.author}</span>: {spec.quotedSnapshot.text}
          </blockquote>
        )}

        {spec.media.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {spec.media.slice(0, 4).map((m, i) => (
              <button key={i} onClick={() => setLightbox(m)} className="relative" title="点击预览">
                <img src={m.url ?? m.originUrl} alt="" loading="lazy" className="h-32 rounded-md object-cover border" />
                {m.type === 'video' && (
                  <span className="absolute inset-0 flex items-center justify-center text-white text-2xl bg-black/30 rounded-md">
                    ▶
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {spec.content && (
          <div>
            <button className="text-xs text-primary hover:underline" onClick={() => setShowContent(v => !v)}>
              {showContent ? '收起全文' : '展开全文'}
            </button>
            {showContent && (
              <>
                <div
                  className="prose prose-sm max-w-none mt-2 text-sm [&_img]:max-w-full [&_img]:rounded-md"
                  dangerouslySetInnerHTML={{ __html: spec.content }}
                />
                <button
                  className="text-xs text-primary hover:underline mt-2"
                  onClick={() => setShowContent(false)}
                >
                  ↑ 收起全文
                </button>
              </>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="text-muted-foreground text-xs gap-4">
        {platform === 'twitter' ? (
          <>
            <span className="flex items-center gap-1">
              <Heart className="h-3 w-3" />
              {formatNumber(spec.stats?.likes ?? 0)}
            </span>
            <span className="flex items-center gap-1">
              <Repeat2 className="h-3 w-3" />
              {formatNumber(spec.stats?.retweets ?? 0)}
            </span>
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {formatNumber(spec.stats?.views ?? 0)}
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <ArrowUp className="h-3 w-3" />
              {formatNumber(spec.stats?.voteup ?? 0)}
            </span>
            <span className="flex items-center gap-1">
              <MessageCircle className="h-3 w-3" />
              {formatNumber(spec.stats?.comments ?? 0)}
            </span>
          </>
        )}
        {spec.url && (
          <a
            href={spec.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 hover:text-foreground"
            title="打开原文"
          >
            <ExternalLink className="h-3 w-3" />
            原文
          </a>
        )}
        <span className="ml-auto">{metadata.labels?.source}</span>
      </CardFooter>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          {lightbox.type === 'video' && lightbox.playUrl ? (
            <video
              src={`/api/v1/media-proxy?url=${encodeURIComponent(lightbox.playUrl)}`}
              poster={lightbox.url ?? lightbox.originUrl}
              controls
              autoPlay
              className="max-h-full max-w-full rounded-md"
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <img
              src={lightbox.url ?? lightbox.originUrl}
              alt=""
              className="max-h-full max-w-full object-contain rounded-md"
            />
          )}
        </div>
      )}
    </Card>
  )
}
