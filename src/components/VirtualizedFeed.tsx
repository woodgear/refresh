import { useMemo, useSyncExternalStore } from 'react'
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

function groupIntoRows(items: Message[], columns: number): Message[][] {
  const rows: Message[][] = []
  for (let start = 0; start < items.length; start += columns) {
    rows.push(items.slice(start, start + columns))
  }
  return rows
}

export function VirtualizedFeed({ items, layout, onSeen, onToggleRead }: VirtualizedFeedProps) {
  const responsiveGridColumns = useSyncExternalStore(subscribeToGridColumnCount, readGridColumnCount, () => 1)
  const columns = layout === 'grid' ? responsiveGridColumns : 1
  const rows = useMemo(() => groupIntoRows(items, columns), [items, columns])

  return (
    <Virtuoso
      className="h-full"
      data={rows}
      data-feed-layout={layout}
      data-grid-columns={columns}
      computeItemKey={(_, row) => `${layout}:${columns}:${row[0].metadata.name}`}
      itemContent={(rowIndex, row) => (
        <div className={cn('px-3 pb-3 md:px-6 lg:px-8', rowIndex === 0 && 'pt-4', rowIndex === rows.length - 1 && 'pb-4')}>
          <div
            className={cn(
              'mx-auto grid items-stretch',
              layout === 'list' ? 'max-w-5xl grid-cols-1' : 'max-w-7xl gap-4',
              layout === 'grid' && columns === 1 && 'grid-cols-1',
              layout === 'grid' && columns === 2 && 'grid-cols-2',
              layout === 'grid' && columns === 3 && 'grid-cols-3',
            )}
          >
            {row.map((message, columnIndex) => {
              const itemIndex = rowIndex * columns + columnIndex
              return (
                <MessageCard
                  key={message.metadata.name}
                  message={message}
                  priority={itemIndex < 3}
                  layout={layout}
                  onToggleRead={onToggleRead}
                  onSeen={onSeen}
                />
              )
            })}
          </div>
        </div>
      )}
    />
  )
}
