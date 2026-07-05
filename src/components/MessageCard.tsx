import { SOURCES, type Message, type MediaRef, type ResourceMeta } from '@/api/radar'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Heart, MessageCircle, Repeat2, Eye, ArrowUp, Clock, Repeat, ExternalLink, Circle, CheckCircle2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
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

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const sourceLabels = new Map(SOURCES.map(source => [source.name, source.label]))

type MediaPreview = { kind: 'media'; media: MediaRef }
type EmbedPreview = { kind: 'embed'; src: string; title: string }
type PreviewTarget = MediaPreview | EmbedPreview

function messageSourceLabels(metadata: ResourceMeta): string[] {
  const names = (metadata.annotations?.['radar/sources'] ?? metadata.labels?.source ?? '')
    .split(',')
    .filter(Boolean)

  return names.map(name => {
    const label = sourceLabels.get(name)
    if (!label) throw new Error(`unknown source on message ${metadata.name}: ${name}`)
    return label
  })
}

function bilibiliPlayerPreview(message: Message): EmbedPreview | null {
  if (message.metadata.labels?.platform !== 'bilibili') return null
  const bvid = message.metadata.name.match(/^bilibili-(BV[0-9A-Za-z]+)/)?.[1]
  if (!bvid) return null
  const params = new URLSearchParams({ bvid, autoplay: '0', danmaku: '0' })
  return {
    kind: 'embed',
    src: `https://player.bilibili.com/player.html?${params}`,
    title: message.spec.title ?? message.metadata.name,
  }
}

const embedPreviewResolvers = [bilibiliPlayerPreview]

function embedPreviewFor(message: Message): EmbedPreview | null {
  for (const resolve of embedPreviewResolvers) {
    const preview = resolve(message)
    if (preview) return preview
  }
  return null
}

function previewForMedia(message: Message, media: MediaRef, preferEmbed: boolean): PreviewTarget {
  if (preferEmbed) {
    const embed = embedPreviewFor(message)
    if (embed) return embed
  }
  return { kind: 'media', media }
}

function SourceChips({ sources, className }: { sources: string[]; className?: string }) {
  if (sources.length === 0) return null
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)}>
      {sources.map(source => (
        <span
          key={source}
          className="rounded-sm border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground"
        >
          {source}
        </span>
      ))}
    </span>
  )
}

function StatItem({ icon, value }: { icon: ReactNode; value: number | string }) {
  return (
    <span className="flex items-center gap-1 tabular-nums">
      {icon}
      {typeof value === 'number' ? formatNumber(value) : value}
    </span>
  )
}

interface MessageCardProps {
  message: Message
  /** 卡片在视口中停留足够久（自动已读用） */
  onSeen?: (name: string) => void
  onToggleRead?: (name: string, read: boolean) => void
  /** grid = 封面优先的紧凑卡片（B 站风格瀑布流用） */
  layout?: 'list' | 'grid'
}

export function MessageCard({ message, onSeen, onToggleRead, layout = 'list' }: MessageCardProps) {
  const { spec, metadata } = message
  const platform = metadata.labels?.platform
  const read = !!message.status.read
  const [showContent, setShowContent] = useState(false)
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
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
          }, 500)
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

  const isGrid = layout === 'grid'
  const cover = isGrid ? spec.media.find(m => m.type === 'image' || m.url || m.originUrl) : undefined
  const sources = messageSourceLabels(metadata)
  const durationLabel = platform === 'bilibili' && spec.durationSec !== undefined ? formatDuration(spec.durationSec) : null
  const showPreviewText = !!spec.text && !(showContent && spec.content)
  const isBilibiliVideo = platform === 'bilibili' && /^bilibili-BV[0-9A-Za-z]+/.test(metadata.name)
  const isBilibiliDynamic = platform === 'bilibili' && !isBilibiliVideo

  return (
    <Card
      ref={rootRef}
      className={cn(
        'overflow-hidden rounded-md border bg-card/95 shadow-none transition-colors hover:border-foreground/20 hover:bg-background',
        read ? 'border-border/70' : 'border-foreground/25 bg-background',
        isGrid && 'mb-4 break-inside-avoid',
        isBilibiliDynamic && 'bg-muted/20',
      )}
    >
      <div className={cn('h-px', read ? 'bg-transparent' : 'bg-foreground/45')} />
      {isGrid && cover && (
        <button onClick={() => setPreview(previewForMedia(message, cover, true))} className="relative block w-full" title="点击预览">
          <img src={cover.url ?? cover.originUrl} alt="" loading="lazy" className="w-full aspect-video object-cover" />
          {durationLabel && (
            <span className="absolute bottom-2 right-2 rounded-sm bg-black/75 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-white shadow-sm">
              {durationLabel}
            </span>
          )}
        </button>
      )}
      <CardHeader className={cn('space-y-2 px-4 pb-2 pt-4 md:px-5', isGrid && 'px-3 pt-3 md:px-4')}>
        {spec.retweetedBy && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Repeat className="h-3 w-3" />@{spec.retweetedBy} 转推
          </div>
        )}
        {spec.refs?.replyToHandle && (
          <div className="text-xs text-muted-foreground">↩ 回复 @{spec.refs.replyToHandle}</div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {author?.avatar ? (
              <img src={author.avatar} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium">
                {(author?.name ?? author?.handle ?? '?').slice(0, 2)}
              </div>
            )}
            <div className="min-w-0">
              <span className="block truncate text-sm font-medium leading-5">
                {author?.name ?? author?.handle ?? '未知'}
                {author?.handle && platform === 'twitter' && (
                  <span className="text-muted-foreground font-normal"> @{author.handle}</span>
                )}
              </span>
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1 tabular-nums">
              <Clock className="h-3 w-3" />
              {formatTime(metadata.creationTimestamp)}
            </span>
            {onToggleRead && (
              <button
                onClick={() => onToggleRead(metadata.name, !read)}
                title={read ? '标为未读' : '标为已读'}
                className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {read ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              </button>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <SourceChips sources={sources} />
          {isBilibiliVideo && (
            <span className="rounded-sm border border-border/70 bg-background px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground">
              视频
            </span>
          )}
          {isBilibiliDynamic && (
            <span className="rounded-sm border border-border/70 bg-background px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground">
              动态
            </span>
          )}
        </div>
        {spec.title && (
          <h3
            className={cn(
              'cursor-pointer text-[15px] font-medium leading-6 hover:underline',
              isGrid && 'line-clamp-2 text-sm leading-5',
              isBilibiliDynamic && 'text-sm',
            )}
            onClick={() => spec.url && window.open(spec.url, '_blank')}
          >
            {spec.title}
          </h3>
        )}
      </CardHeader>

      <CardContent className={cn('space-y-2 px-4 pb-3 md:px-5', isGrid && 'px-3 md:px-4')}>
        {showPreviewText && (
          <p
            className={cn(
              'whitespace-pre-wrap text-sm leading-6',
              isGrid ? 'line-clamp-4 text-xs leading-5 text-muted-foreground' : 'line-clamp-6',
              isBilibiliDynamic && 'text-sm text-foreground',
            )}
          >
            {spec.text}
          </p>
        )}

        {spec.quotedSnapshot?.text && (
          <blockquote className="border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
            <span className="font-medium">@{spec.quotedSnapshot.author}</span>: {spec.quotedSnapshot.text}
          </blockquote>
        )}

        {spec.media.length > 0 && !(isGrid && cover && spec.media.length === 1) && (
          <div className="flex gap-2 flex-wrap">
            {(isGrid ? spec.media.filter(m => m !== cover) : spec.media).slice(0, 4).map((m, i) => (
              <button
                key={i}
                onClick={() => setPreview(previewForMedia(message, m, m === spec.media[0]))}
                className="relative"
                title="点击预览"
              >
                <img
                  src={m.url ?? m.originUrl}
                  alt=""
                  loading="lazy"
                  className={cn('rounded-md border object-cover', isGrid ? 'h-16' : 'h-32')}
                />
                {m.type === 'video' && (
                  <span className="absolute inset-0 flex items-center justify-center text-white text-2xl bg-black/30 rounded-md">
                    ▶
                  </span>
                )}
                {durationLabel && m === spec.media[0] && (
                  <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-black/75 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-white shadow-sm">
                    {durationLabel}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {spec.content && (
          <div>
            <button className="text-xs font-medium text-foreground hover:underline" onClick={() => setShowContent(v => !v)}>
              {showContent ? '收起全文' : '展开全文'}
            </button>
            {showContent && (
              <>
                <div
                  className="prose prose-sm max-w-none mt-2 text-sm [&_img]:max-w-full [&_img]:rounded-md"
                  dangerouslySetInnerHTML={{ __html: spec.content }}
                />
                <button
                  className="mt-2 text-xs font-medium text-foreground hover:underline"
                  onClick={() => setShowContent(false)}
                >
                  ↑ 收起全文
                </button>
              </>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground md:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {platform === 'twitter' ? (
            <>
              <StatItem icon={<Heart className="h-3 w-3" />} value={spec.stats?.likes ?? 0} />
              <StatItem icon={<Repeat2 className="h-3 w-3" />} value={spec.stats?.retweets ?? 0} />
              <StatItem icon={<Eye className="h-3 w-3" />} value={spec.stats?.views ?? 0} />
            </>
          ) : platform === 'bilibili' ? (
            <>
              {durationLabel && <StatItem icon={<Clock className="h-3 w-3" />} value={durationLabel} />}
              <StatItem icon={<Eye className="h-3 w-3" />} value={spec.stats?.views ?? 0} />
              <StatItem icon={<Heart className="h-3 w-3" />} value={spec.stats?.likes ?? 0} />
              <StatItem icon={<MessageCircle className="h-3 w-3" />} value={spec.stats?.danmaku ?? 0} />
            </>
          ) : (
            <>
              <StatItem icon={<ArrowUp className="h-3 w-3" />} value={spec.stats?.voteup ?? 0} />
              <StatItem icon={<MessageCircle className="h-3 w-3" />} value={spec.stats?.comments ?? 0} />
            </>
          )}
        </div>
        {spec.url && (
          <a
            href={spec.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex shrink-0 items-center gap-1 hover:text-foreground"
            title="打开原文"
          >
            <ExternalLink className="h-3 w-3" />
            原文
          </a>
        )}
      </CardFooter>

      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setPreview(null)}
        >
          {preview.kind === 'embed' ? (
            <div
              className="aspect-video w-full max-w-5xl overflow-hidden rounded-md bg-black shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <iframe
                src={preview.src}
                title={preview.title}
                allow="fullscreen; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                className="h-full w-full"
              />
            </div>
          ) : preview.media.type === 'video' && preview.media.playUrl ? (
            <video
              src={`/api/v1/media-proxy?url=${encodeURIComponent(preview.media.playUrl)}`}
              poster={preview.media.url ?? preview.media.originUrl}
              controls
              autoPlay
              className="max-h-full max-w-full rounded-md"
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <img
              src={preview.media.url ?? preview.media.originUrl}
              alt=""
              className="max-h-full max-w-full object-contain rounded-md"
            />
          )}
        </div>
      )}
    </Card>
  )
}
