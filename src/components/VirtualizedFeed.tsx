import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { Message } from '@/api/radar'
import { MessageCard } from '@/components/MessageCard'
import { cn } from '@/lib/utils'

type FeedLayout = 'list' | 'grid'

interface VirtualizedFeedProps {
  items: Message[]
  layout: FeedLayout
  onSeen?: (name: string) => void
  onToggleRead: (name: string, read: boolean) => void
  baseOffset?: number
  initialAnchor?: string
  onAnchorChange?: (name: string, offset: number) => void
  onEndReached?: () => void
  footer?: ReactNode
}

const gridBreakpoints = [
  { query: '(min-width: 1536px)', columns: 3 },
  { query: '(min-width: 768px)', columns: 2 },
] as const

function readGridColumnCount(): number {
  return gridBreakpoints.find(({ query }) => window.matchMedia(query).matches)?.columns ?? 1
}

function subscribeToGridColumnCount(onChange: () => void): () => void {
  const queries = gridBreakpoints.map(({ query }) => window.matchMedia(query))
  queries.forEach(query => query.addEventListener('change', onChange))
  return () => queries.forEach(query => query.removeEventListener('change', onChange))
}

export function VirtualizedFeed({
  items,
  layout,
  onSeen,
  onToggleRead,
  baseOffset = 0,
  initialAnchor,
  onAnchorChange,
  onEndReached,
  footer,
}: VirtualizedFeedProps) {
  const responsiveGridColumns = useSyncExternalStore(subscribeToGridColumnCount, readGridColumnCount, () => 1)

  if (layout === 'grid') {
    return (
      <MasonryFeed
        items={items}
        columns={responsiveGridColumns}
        onSeen={onSeen}
        onToggleRead={onToggleRead}
        baseOffset={baseOffset}
        initialAnchor={initialAnchor}
        onAnchorChange={onAnchorChange}
        onEndReached={onEndReached}
        footer={footer}
      />
    )
  }

  return (
    <ListFeed
      items={items}
      onSeen={onSeen}
      onToggleRead={onToggleRead}
      baseOffset={baseOffset}
      initialAnchor={initialAnchor}
      onAnchorChange={onAnchorChange}
      onEndReached={onEndReached}
      footer={footer}
    />
  )
}

interface ListFeedProps {
  items: Message[]
  onSeen?: (name: string) => void
  onToggleRead: (name: string, read: boolean) => void
  baseOffset: number
  initialAnchor?: string
  onAnchorChange?: (name: string, offset: number) => void
  onEndReached?: () => void
  footer?: ReactNode
}

function ListFeed({
  items,
  onSeen,
  onToggleRead,
  baseOffset,
  initialAnchor,
  onAnchorChange,
  onEndReached,
  footer,
}: ListFeedProps) {
  const initialRow = initialAnchor
    ? Math.max(0, items.findIndex(message => message.metadata.name === initialAnchor))
    : 0
  // 挂载首帧 virtuoso 会先报 startIndex 0，不能拿它覆盖已保存的位置
  const settled = useRef(false)

  return (
    <Virtuoso
      className="h-full"
      data={items}
      data-feed-layout="list"
      data-grid-columns={1}
      computeItemKey={(_, message) => `list:${message.metadata.name}`}
      initialTopMostItemIndex={initialRow}
      rangeChanged={range => {
        if (!settled.current) {
          settled.current = true
          return
        }
        const message = items[range.startIndex]
        if (message) onAnchorChange?.(message.metadata.name, baseOffset + range.startIndex)
      }}
      endReached={onEndReached}
      components={{
        Footer: () => footer ? <div className="px-3 pb-5 md:px-6 lg:px-8">{footer}</div> : null,
      }}
      itemContent={(rowIndex, message) => (
        <div className={cn('px-3 pb-3 md:px-6 lg:px-8', rowIndex === 0 && 'pt-4', rowIndex === items.length - 1 && 'pb-4')}>
          <div className="mx-auto max-w-5xl">
            <MessageCard
              message={message}
              priority={rowIndex < 3}
              layout="list"
              onToggleRead={onToggleRead}
              onSeen={onSeen}
            />
          </div>
        </div>
      )}
    />
  )
}

const MASONRY_GAP = 12
/** 视口上下各多渲染一屏的卡片，避免滚动时出现空白 */
const MASONRY_OVERSCAN = 1.5

/** 没有测量值时先按大概版式估个高度（图片加载不会改变卡片高度，测量很快会覆盖它） */
function estimateCardHeight(message: Message, columnWidth: number): number {
  const { spec } = message
  const cover = spec.media.find(media => media.type === 'image' || media.url || media.originUrl)
  const ratio = cover?.width && cover?.height ? cover.height / cover.width : 9 / 16
  const coverHeight = cover ? columnWidth * Math.min(Math.max(ratio, 0.5), 1.6) : 0
  const titleLines = spec.title ? 2 : 0
  const textLines = spec.text ? Math.min(4, Math.ceil(spec.text.length / 46)) : 0
  return 88 + 40 + coverHeight + titleLines * 20 + textLines * 20
}

interface MasonryFeedProps {
  items: Message[]
  columns: number
  onSeen?: (name: string) => void
  onToggleRead: (name: string, read: boolean) => void
  baseOffset: number
  initialAnchor?: string
  onAnchorChange?: (name: string, offset: number) => void
  onEndReached?: () => void
  footer?: ReactNode
}

/** 窗口化的多列瀑布流：卡片按列独立堆叠、保持自身高度，只渲染视口附近的那一段。
 *
 * 列内卡片的高度由内容决定（图片用 aspect-ratio 占位，加载完不改变布局），
 * 用 ResizeObserver 量一次即可；量不到时先用估算高度，滚动、测到、再重算。
 * 视口外的卡片不挂载，DOM 数量只跟屏幕高度有关，跟会话里累积了多少条无关。
 */
function MasonryFeed({
  items,
  columns,
  onSeen,
  onToggleRead,
  baseOffset,
  initialAnchor,
  onAnchorChange,
  onEndReached,
  footer,
}: MasonryFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(800)
  const [columnWidth, setColumnWidth] = useState(0)
  const [heightsVersion, setHeightsVersion] = useState(0)
  const [forcedAnchor, setForcedAnchor] = useState<{ name: string; lane: number; index: number } | null>(null)

  const heights = useRef(new Map<string, number>())
  const cardElements = useRef(new Map<string, HTMLElement>())
  const cardObserver = useRef<ResizeObserver | null>(null)
  const frame = useRef<number | null>(null)
  const restored = useRef(false)
  const pendingAnchor = useRef<{ name: string; lane: number; index: number } | null>(null)
  const programmaticScroll = useRef(false)
  const lastAnchor = useRef<string | null>(null)
  const anchorTimer = useRef<number | null>(null)
  const lastEndReachedLength = useRef(-1)

  const indexByName = useMemo(
    () => new Map(items.map((message, index) => [message.metadata.name, index])),
    [items],
  )

  const lanes = useMemo(() => {
    const next: Message[][] = Array.from({ length: columns }, () => [])
    items.forEach((message, index) => next[index % columns]!.push(message))
    return next
  }, [items, columns])

  // 容器尺寸：决定视口高度和列宽；列宽变了卡片高度全部作废（封面图按列宽缩放）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = () => {
      setViewportHeight(container.clientHeight)
      const lane = container.querySelector<HTMLElement>('[data-lane]')
      const width = lane?.getBoundingClientRect().width ?? 0
      if (width <= 0) return
      setColumnWidth(current => {
        if (Math.abs(current - width) <= 0.5) return current
        heights.current.clear()
        setHeightsVersion(version => version + 1)
        return width
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [columns])

  // 已渲染卡片的真实高度：每次渲染后同步量一遍（窗口内只有十几张），
  // ResizeObserver 兜住内容变化（展开全文、图片替换占位）。
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!cardObserver.current) {
      cardObserver.current = new ResizeObserver(entries => {
        let changed = false
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          const name = element.dataset.cardName
          if (!name) continue
          const height = element.getBoundingClientRect().height
          if (!height) continue
          const previous = heights.current.get(name)
          if (previous === undefined || Math.abs(previous - height) > 1) {
            heights.current.set(name, height)
            changed = true
          }
        }
        if (changed) setHeightsVersion(version => version + 1)
      })
    }
    const observer = cardObserver.current
    const present = new Set<string>()
    let changed = false
    for (const element of container.querySelectorAll<HTMLElement>('[data-card-name]')) {
      const name = element.dataset.cardName
      if (!name) continue
      present.add(name)
      if (cardElements.current.get(name) !== element) {
        const previous = cardElements.current.get(name)
        if (previous) observer.unobserve(previous)
        cardElements.current.set(name, element)
      }
      const height = element.getBoundingClientRect().height
      if (!height) continue
      const known = heights.current.get(name)
      if (known === undefined || Math.abs(known - height) > 1) {
        heights.current.set(name, height)
        changed = true
      }
      observer.observe(element)
    }
    for (const [name, element] of [...cardElements.current]) {
      if (present.has(name)) continue
      observer.unobserve(element)
      cardElements.current.delete(name)
    }
    if (changed) setHeightsVersion(version => version + 1)
  })

  // 恢复上次阅读位置：先把 anchor 卡片塞进渲染范围，等它被测量后再对齐
  useLayoutEffect(() => {
    if (restored.current || !initialAnchor) return
    const lane = lanes.findIndex(messages => messages.some(message => message.metadata.name === initialAnchor))
    if (lane < 0) return
    const index = lanes[lane]!.findIndex(message => message.metadata.name === initialAnchor)
    const target = { name: initialAnchor, lane, index }
    pendingAnchor.current = target
    setForcedAnchor(target)
  }, [initialAnchor, items, lanes])

  useLayoutEffect(() => {
    const pending = pendingAnchor.current
    if (!pending) return
    const element = cardElements.current.get(pending.name)
    const container = containerRef.current
    if (!element || !container) return
    if (!heights.current.has(pending.name)) return
    const top = element.getBoundingClientRect().top - container.getBoundingClientRect().top
    if (Math.abs(top - 8) > 2) {
      programmaticScroll.current = true
      container.scrollTop += top - 8
    }
    pendingAnchor.current = null
    restored.current = true
    setForcedAnchor(null)
  })

  const scheduleAnchor = useCallback(() => {
    if (anchorTimer.current !== null) window.clearTimeout(anchorTimer.current)
    anchorTimer.current = window.setTimeout(() => {
      anchorTimer.current = null
      // 位置还没恢复完（anchor 是被临时塞进来渲染的），此刻的顶部卡片不代表阅读位置
      if (!restored.current) {
        if (initialAnchor) return
        restored.current = true
      }
      const container = containerRef.current
      if (!container) return

      const containerTop = container.getBoundingClientRect().top
      let anchor: HTMLElement | null = null
      let anchorTop = -Infinity
      for (const element of cardElements.current.values()) {
        const top = element.getBoundingClientRect().top - containerTop
        if (top <= 8 && top > anchorTop) {
          anchorTop = top
          anchor = element
        }
      }
      const name = anchor?.dataset.cardName
      if (name && name !== lastAnchor.current) {
        lastAnchor.current = name
        onAnchorChange?.(name, baseOffset + (indexByName.get(name) ?? 0))
      }
    }, 400)
  }, [baseOffset, indexByName, onAnchorChange, initialAnchor])

  useEffect(() => () => {
    if (anchorTimer.current !== null) window.clearTimeout(anchorTimer.current)
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
  }, [])

  const handleScroll = useCallback(() => {
    if (frame.current !== null) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      const container = containerRef.current
      if (!container) return

      setScrollTop(container.scrollTop)
      if (programmaticScroll.current) programmaticScroll.current = false
      else scheduleAnchor()

      if (container.scrollHeight - container.scrollTop - container.clientHeight < 600) {
        if (lastEndReachedLength.current !== items.length) {
          lastEndReachedLength.current = items.length
          onEndReached?.()
        }
      } else {
        lastEndReachedLength.current = -1
      }
    })
  }, [items.length, onEndReached, scheduleAnchor])

  // 首次渲染 / 追加一页之后：如果仍然停在底部就继续加载
  useEffect(() => {
    scheduleAnchor()
    const container = containerRef.current
    if (!container) return
    if (container.scrollHeight - container.scrollTop - container.clientHeight >= 600) return
    if (lastEndReachedLength.current === items.length) return
    lastEndReachedLength.current = items.length
    onEndReached?.()
  }, [items.length, onEndReached, scheduleAnchor])

  const layout = useMemo(() => {
    const width = columnWidth || 320
    return lanes.map(lane => {
      const offsets: number[] = []
      const sizes: number[] = []
      let total = 0
      lane.forEach((message, index) => {
        const height = heights.current.get(message.metadata.name) ?? estimateCardHeight(message, width)
        offsets.push(total)
        sizes.push(height)
        total += height + (index < lane.length - 1 ? MASONRY_GAP : 0)
      })
      return { offsets, sizes, total }
    })
  }, [lanes, columnWidth, heightsVersion])

  const ranges = useMemo(() => {
    const top = Math.max(0, scrollTop - viewportHeight * MASONRY_OVERSCAN)
    const bottom = scrollTop + viewportHeight * (1 + MASONRY_OVERSCAN)
    return layout.map((lane, laneIndex) => {
      let start = 0
      let end = -1
      for (let index = 0; index < lane.offsets.length; index++) {
        const begin = lane.offsets[index]!
        const finish = begin + lane.sizes[index]!
        if (finish < top) {
          start = index + 1
          continue
        }
        if (begin > bottom) break
        end = index
      }
      if (end < start) {
        start = 0
        end = -1
      }
      const forced = forcedAnchor?.lane === laneIndex ? forcedAnchor.index : -1
      if (forced >= 0) {
        start = Math.min(start, forced)
        end = Math.max(end, forced)
      }
      return { start, end }
    })
  }, [layout, scrollTop, viewportHeight, forcedAnchor])

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto"
      data-feed-layout="grid"
      data-grid-columns={columns}
    >
      <div
        className={cn(
          'mx-auto grid items-start gap-3 px-3 pb-4 pt-4 md:px-6 lg:px-8',
          columns === 1 && 'max-w-5xl grid-cols-1',
          columns === 2 && 'max-w-7xl grid-cols-2',
          columns === 3 && 'max-w-7xl grid-cols-3',
        )}
      >
        {lanes.map((lane, laneIndex) => {
          const { offsets, total } = layout[laneIndex]!
          const { start, end } = ranges[laneIndex]!
          const visible = end >= start ? lane.slice(start, end + 1) : []
          const padTop = visible.length > 0 ? offsets[start]! : total
          const padBottom = visible.length > 0 && end < lane.length - 1
            ? Math.max(0, total - (offsets[end + 1] ?? total))
            : 0
          return (
            <div
              key={laneIndex}
              data-lane
              className="flex min-w-0 flex-col"
              style={{ paddingTop: padTop, paddingBottom: padBottom }}
            >
              {visible.map((message, offset) => {
                const index = start + offset
                return (
                  <div
                    key={message.metadata.name}
                    data-card-name={message.metadata.name}
                    style={{ marginBottom: index < lane.length - 1 ? MASONRY_GAP : 0 }}
                  >
                    <MessageCard
                      message={message}
                      priority={index < 3}
                      layout="grid"
                      onToggleRead={onToggleRead}
                      onSeen={onSeen}
                    />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {footer && <div className="px-3 pb-5 md:px-6 lg:px-8">{footer}</div>}
    </div>
  )
}
