import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { MediaPresentation } from '@/api/radar'
import { recordPerfSample } from '@/observability'

interface ProgressiveImageProps {
  src: string
  alt: string
  presentation?: MediaPresentation | null
  className?: string
  imgClassName?: string
  sizes?: string
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
  fallbackAspectRatio?: string
  perfTarget?: string
}

export function ProgressiveImage({
  src,
  alt,
  presentation,
  className,
  imgClassName,
  sizes = '(min-width: 768px) 360px, 100vw',
  loading = 'lazy',
  fetchPriority = 'auto',
  fallbackAspectRatio = '16 / 9',
  perfTarget = 'image',
}: ProgressiveImageProps) {
  const [loaded, setLoaded] = useState(false)
  const mountedAt = useRef(performance.now())
  const loadLogged = useRef(false)
  const variants = presentation?.variants ? Object.values(presentation.variants).sort((a, b) => a.width - b.width) : []
  const srcSet = variants.length > 0 ? variants.map(variant => `${variant.url} ${variant.width}w`).join(', ') : undefined
  const bestSrc = variants.find(variant => variant.width >= 640)?.url ?? variants.at(-1)?.url ?? src
  const mediaVariant = srcSet ? 'responsive-webp' : 'original'
  const aspectRatio =
    presentation?.width && presentation.height
      ? `${presentation.width} / ${presentation.height}`
      : fallbackAspectRatio

  return (
    <span
      className={cn('relative block overflow-hidden bg-muted', className)}
      style={{ aspectRatio }}
    >
      {presentation?.placeholder && (
        <img
          src={presentation.placeholder.url}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full scale-105 object-cover opacity-70 blur-lg"
          draggable={false}
        />
      )}
      <span
        className={cn(
          'absolute inset-0 bg-gradient-to-br from-muted via-muted/70 to-background transition-opacity duration-300',
          loaded ? 'opacity-0' : 'opacity-100',
        )}
        aria-hidden="true"
      />
      <img
        src={bestSrc}
        srcSet={srcSet}
        sizes={srcSet ? sizes : undefined}
        alt={alt}
        loading={loading}
        decoding="async"
        fetchPriority={fetchPriority}
        data-perf-target={perfTarget}
        data-media-variant={mediaVariant}
        data-loading={loading}
        data-fetch-priority={fetchPriority}
        onLoad={event => {
          setLoaded(true)
          if (loadLogged.current) return
          loadLogged.current = true
          recordPerfSample('progressive_image.loaded', performance.now() - mountedAt.current, {
            perf_target: perfTarget,
            media_variant: mediaVariant,
            loading,
            fetch_priority: fetchPriority,
            has_placeholder: !!presentation?.placeholder,
            natural_width: event.currentTarget.naturalWidth,
            natural_height: event.currentTarget.naturalHeight,
          })
        }}
        className={cn(
          'absolute inset-0 h-full w-full object-cover transition-opacity duration-300',
          loaded ? 'opacity-100' : 'opacity-0',
          imgClassName,
        )}
      />
    </span>
  )
}
