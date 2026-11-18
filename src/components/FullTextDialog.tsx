import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * 全文弹窗。
 *
 * 之前「展开全文」是原地把卡片撑高 —— 瀑布流里一张卡变高，同列后面的内容全被推走，
 * 而旁边几列纹丝不动，读的时候视觉上一直在跳。全文是「另一个阅读场景」，
 * 该有自己的滚动容器，不该改动列表布局。
 *
 * 用 portal 挂到 body：虚拟列表的卡片带 transform，`position: fixed` 在那种祖先下
 * 会相对祖先定位，弹窗位置就跑偏了。
 */
export function FullTextDialog({
  open,
  title,
  html,
  onClose,
}: {
  open: boolean
  title: string
  html: string
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 pt-[6vh] backdrop-blur-sm sm:p-4 sm:pt-[8vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        onClick={event => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5 sm:px-5">
          <span className="truncate text-sm font-medium">{title}</span>
          <button
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {/* overscroll-contain：读到正文边界继续滚时不把滚动传给背后的列表 */}
        <div
          className="prose prose-sm min-h-0 max-w-none flex-1 overflow-y-auto overscroll-contain px-4 py-4 text-sm [&_img]:max-w-full [&_img]:rounded-md sm:px-5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>,
    document.body,
  )
}
