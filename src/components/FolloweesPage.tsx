import { useMemo, useState } from 'react'
import { Download, Loader2, RefreshCw, Save, Search, Users } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import {
  exportFollowees,
  getFolloweeWindow,
  patchFollowee,
  syncFollowees,
  useFollowees,
  type Followee,
} from '@/api/radar'

const platforms = [
  { value: 'all', label: '全部' },
  { value: 'zhihu', label: '知乎' },
  { value: 'twitter', label: '推特' },
  { value: 'bilibili', label: 'B站' },
]

export function FolloweesPage() {
  const qc = useQueryClient()
  const [platform, setPlatform] = useState('all')
  const [group, setGroup] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchGroup, setBatchGroup] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [page, setPage] = useState(0)
  const pageSize = 100
  const followees = useFollowees({ platform: platform === 'all' ? undefined : platform, limit: pageSize, offset: page * pageSize })

  const allItems = followees.data?.items ?? []
  const total = followees.data?.total ?? 0
  const groups = useMemo(() => {
    const out = new Set<string>()
    for (const f of allItems) {
      for (const g of groupList(f)) out.add(g)
    }
    return [...out].sort((a, b) => a.localeCompare(b))
  }, [allItems])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allItems.filter(f => {
      if (group !== 'all' && !groupList(f).includes(group)) return false
      if (!q) return true
      return [
        f.spec.displayName,
        f.spec.handle ?? '',
        f.spec.description ?? '',
        f.metadata.annotations?.['refresh/note'] ?? '',
      ].some(v => v.toLowerCase().includes(q))
    })
  }, [allItems, group, query])

  const selectedItems = items.filter(f => selected.has(f.metadata.name))
  const pageCount = Math.max(Math.ceil(total / pageSize), 1)

  const setPlatformAndReset = (value: string) => {
    setPlatform(value)
    setPage(0)
    setSelected(new Set())
  }

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['followees'] })
    void qc.invalidateQueries({ queryKey: ['followee-windows'] })
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const created = await syncFollowees()
      const names = new Set(created.items.map(w => w.metadata.name))
      for (let i = 0; i < 120; i++) {
        const windows = await Promise.all([...names].map(name => getFolloweeWindow(name)))
        const pending = windows.filter(w => w.status.phase === 'Running')
        if (pending.length === 0) break
        await new Promise(resolve => window.setTimeout(resolve, 1000))
      }
      invalidate()
    } finally {
      setSyncing(false)
    }
  }

  const handleExport = async () => {
    const data = await exportFollowees()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `refresh-followees-${data.exportedAt.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const applyBatchGroup = async () => {
    const token = batchGroup.trim()
    if (!token || selectedItems.length === 0) return
    await Promise.all(selectedItems.map(f => patchFollowee(f.metadata.name, { labels: { group: addGroup(f, token) } })))
    setBatchGroup('')
    setSelected(new Set())
    invalidate()
  }

  const toggleSelected = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-background px-4 py-3 md:px-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex min-w-0 items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">关注</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {total === 0 ? '0 / 0' : `${page * pageSize + 1}-${page * pageSize + items.length} / ${total}`}
            </span>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="flex items-center rounded-md border bg-muted/30 p-0.5">
              {platforms.map(p => (
                <button
                  key={p.value}
                  onClick={() => setPlatformAndReset(p.value)}
                  className={cn(
                    'rounded-sm px-2 py-1 text-xs transition-colors',
                    platform === p.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <select
              value={group}
              onChange={e => setGroup(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="all">全部分组</option>
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
            <div className="relative min-w-52 flex-1 md:max-w-xs">
              <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索"
                className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-sm"
              />
            </div>
            <button
              onClick={() => void handleSync()}
              disabled={syncing}
              className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs hover:bg-accent disabled:opacity-60"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
              同步
            </button>
            <div className="flex h-8 items-center gap-1 rounded-md border bg-background px-1 text-xs">
              <button
                onClick={() => setPage(p => Math.max(p - 1, 0))}
                disabled={page === 0}
                className="rounded px-2 py-1 hover:bg-accent disabled:opacity-40"
              >
                上一页
              </button>
              <span className="px-1 tabular-nums text-muted-foreground">{page + 1} / {pageCount}</span>
              <button
                onClick={() => setPage(p => Math.min(p + 1, pageCount - 1))}
                disabled={page >= pageCount - 1}
                className="rounded px-2 py-1 hover:bg-accent disabled:opacity-40"
              >
                下一页
              </button>
            </div>
            <button
              onClick={() => void handleExport()}
              className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs hover:bg-accent"
            >
              <Download className="h-3.5 w-3.5" />
              JSON
            </button>
          </div>
        </div>
        {selected.size > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
            <span className="text-muted-foreground tabular-nums">已选 {selected.size}</span>
            <input
              value={batchGroup}
              onChange={e => setBatchGroup(e.target.value)}
              placeholder="添加分组"
              className="h-8 w-40 rounded-md border bg-background px-2"
            />
            <button
              onClick={() => void applyBatchGroup()}
              className="flex h-8 items-center gap-1 rounded-md border bg-background px-3 hover:bg-accent"
            >
              <Save className="h-3.5 w-3.5" />
              应用
            </button>
            <button onClick={() => setSelected(new Set())} className="ml-auto h-8 rounded-md px-2 hover:bg-accent">
              清空
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-6">
        {followees.isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        {followees.error && (
          <p className="py-8 text-center text-sm text-destructive">加载失败: {(followees.error as Error).message}</p>
        )}
        {!followees.isLoading && items.length === 0 && (
          <div className="rounded-md border border-dashed bg-background py-12 text-center text-sm text-muted-foreground">
            暂无关注人
          </div>
        )}
        <div className="mx-auto max-w-6xl divide-y rounded-md border bg-background">
          {items.map(f => (
            <FolloweeRow
              key={f.metadata.name}
              followee={f}
              selected={selected.has(f.metadata.name)}
              onSelect={() => toggleSelected(f.metadata.name)}
              onSaved={invalidate}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function FolloweeRow({
  followee,
  selected,
  onSelect,
  onSaved,
}: {
  followee: Followee
  selected: boolean
  onSelect: () => void
  onSaved: () => void
}) {
  const [groups, setGroups] = useState(groupList(followee).join(','))
  const [note, setNote] = useState(followee.metadata.annotations?.['refresh/note'] ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await patchFollowee(followee.metadata.name, {
        labels: { group: normalizeGroups(groups) || null },
        annotations: { 'refresh/note': note.trim() || null },
      })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid grid-cols-[auto_1fr] gap-3 p-3 md:grid-cols-[auto_44px_1fr_320px] md:items-start">
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        className="mt-3 h-4 w-4"
        aria-label={`选择 ${followee.spec.displayName}`}
      />
      <a href={followee.spec.url} target="_blank" rel="noreferrer" className="hidden md:block">
        {followee.spec.avatar ? (
          <img src={followee.spec.avatar} alt="" className="h-11 w-11 rounded-md object-cover" />
        ) : (
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
            {followee.spec.displayName.slice(0, 1)}
          </div>
        )}
      </a>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a href={followee.spec.url} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
            {followee.spec.displayName}
          </a>
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {platformLabel(followee.metadata.labels?.platform)}
          </span>
          {followee.spec.handle && <span className="text-xs text-muted-foreground">@{followee.spec.handle}</span>}
        </div>
        {followee.spec.description && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{followee.spec.description}</p>
        )}
        {groupList(followee).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {groupList(followee).map(g => (
              <span key={g} className="rounded-sm border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {g}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="col-span-2 grid gap-2 md:col-span-1">
        <input
          value={groups}
          onChange={e => setGroups(e.target.value)}
          placeholder="group: ai,infra"
          className="h-8 rounded-md border bg-background px-2 text-sm"
        />
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="备注"
          className="min-h-16 resize-y rounded-md border bg-background px-2 py-1.5 text-sm"
        />
        <button
          onClick={() => void save()}
          disabled={saving}
          className="ml-auto flex h-8 items-center gap-1 rounded-md border bg-background px-3 text-xs hover:bg-accent disabled:opacity-60"
        >
          <Save className="h-3.5 w-3.5" />
          保存
        </button>
      </div>
    </div>
  )
}

function groupList(followee: Followee): string[] {
  return (followee.metadata.labels?.group ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

function normalizeGroups(value: string): string {
  return [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))].join(',')
}

function addGroup(followee: Followee, group: string): string {
  return normalizeGroups([...groupList(followee), group].join(','))
}

function platformLabel(platform: string | undefined): string {
  if (platform === 'zhihu') return '知乎'
  if (platform === 'twitter') return '推特'
  if (platform === 'bilibili') return 'B站'
  return platform ?? 'unknown'
}
