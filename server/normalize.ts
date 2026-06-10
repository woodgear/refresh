// raw payload → Message spec / Author spec 的规范化。
// 原则（docs/design.md §2）：spec.raw 永远保留原样，normalized 字段全部由 raw 派生，
// 字段缺失要容忍（旧档案 schema 不全）。

export interface MediaRef {
  type: 'image' | 'video'
  originUrl: string
  /** 本地化后的服务地址 /api/v1/media/<hash>；媒体管道(M2.4)落地前为 null */
  url: string | null
  /** 视频：原始播放地址（不下载，originUrl 为 poster 图） */
  playUrl?: string
  width?: number
  height?: number
}

export interface AuthorSnapshot {
  ref: string | null
  name?: string
  handle?: string
  avatar?: string | null
  url?: string
}

export interface MessageSpec {
  raw: unknown
  title?: string
  text?: string
  url?: string
  author?: AuthorSnapshot
  media: MediaRef[]
  stats?: Record<string, number>
  refs?: { quoted?: string | null; replyTo?: string | null; replyToHandle?: string }
  /** 引用推文的轻量快照（复刻引用卡片用） */
  quotedSnapshot?: { id: string | null; author: string | null; text: string | null }
  /** 转推场景：转推者 handle（内容字段来自被转推文） */
  retweetedBy?: string
  /** hydrate 后的全文（知乎正文等），默认 null */
  content: string | null
}

export interface NormalizedMessage {
  name: string
  creationTimestamp: string | null
  spec: MessageSpec
}

export interface NormalizedAuthor {
  name: string
  spec: {
    authorId?: string
    handle?: string
    displayName?: string
    avatar?: string | null
    url?: string
  }
}

export interface NormalizedItem {
  message: NormalizedMessage
  author: NormalizedAuthor | null
}

type Raw = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

function normalizeTwitter(raw: Raw): NormalizedItem | null {
  // 两代 schema：CDP GraphQL 对象（rest_id+legacy） vs bb-browser adapter 扁平对象
  if (raw.rest_id && raw.legacy) return normalizeTwitterGraphql(raw)
  const id = str(raw.id)
  if (!id) return null
  const handle = str(raw.author)
  const authorName = handle ? `twitter-${handle}` : null
  const created = str(raw.created_at)
  return {
    message: {
      name: `twitter-${id}`,
      creationTimestamp: created ? new Date(created).toISOString() : null,
      spec: {
        raw,
        text: str(raw.text),
        url: str(raw.url),
        author: { ref: authorName, handle, name: handle },
        media: [],
        stats: {
          likes: num(raw.likes) ?? 0,
          retweets: num(raw.retweets) ?? 0,
          replies: num(raw.replies) ?? 0,
          views: num(raw.views) ?? 0,
        },
        refs: { quoted: null, replyTo: null },
        content: null,
      },
    },
    author: authorName
      ? {
          name: authorName,
          spec: { handle, displayName: handle, url: `https://x.com/${handle}` },
        }
      : null,
  }
}

// ---------- twitter GraphQL（CDP 拦截）schema ----------

interface TwitterUser {
  ref: string | null
  handle?: string
  displayName?: string
  avatar?: string
}

function graphqlUser(tweet: Raw): TwitterUser {
  const result = (((tweet.core ?? {}) as Raw).user_results as Raw | undefined)?.result as Raw | undefined
  if (!result) return { ref: null }
  const legacy = (result.legacy ?? {}) as Raw
  const core = (result.core ?? {}) as Raw
  const handle = str(legacy.screen_name) ?? str(core.screen_name)
  const avatarObj = (result.avatar ?? {}) as Raw
  return {
    ref: handle ? `twitter-${handle}` : null,
    handle,
    displayName: str(legacy.name) ?? str(core.name) ?? handle,
    avatar: str(legacy.profile_image_url_https) ?? str(avatarObj.image_url),
  }
}

function graphqlMedia(tweet: Raw): MediaRef[] {
  const legacy = (tweet.legacy ?? {}) as Raw
  const entities = (legacy.extended_entities ?? legacy.entities ?? {}) as Raw
  const media = (entities.media ?? []) as Raw[]
  return media.flatMap(m => {
    const originUrl = str(m.media_url_https)
    if (!originUrl) return []
    const info = (m.original_info ?? {}) as Raw
    const base: MediaRef = {
      type: m.type === 'photo' ? 'image' : 'video',
      originUrl,
      url: null,
      width: num(info.width),
      height: num(info.height),
    }
    if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = (((m.video_info ?? {}) as Raw).variants ?? []) as Raw[]
      const mp4 = variants
        .filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (num(b.bitrate) ?? 0) - (num(a.bitrate) ?? 0))[0]
      base.playUrl = str(mp4?.url)
    }
    return [base]
  })
}

function graphqlText(tweet: Raw): string | undefined {
  const note = ((((tweet.note_tweet ?? {}) as Raw).note_tweet_results as Raw | undefined)?.result ?? {}) as Raw
  return str(note.text) ?? str(((tweet.legacy ?? {}) as Raw).full_text)
}

function unwrap(result: unknown): Raw | undefined {
  const r = result as Raw | undefined
  if (!r) return undefined
  if (r.__typename === 'TweetWithVisibilityResults' && r.tweet) return r.tweet as Raw
  return r
}

function normalizeTwitterGraphql(raw: Raw): NormalizedItem | null {
  const id = str(raw.rest_id)
  if (!id) return null
  const legacy = (raw.legacy ?? {}) as Raw

  // 转推：内容取被转推文，外层作者记为 retweetedBy（复刻 "xx 转推了" 卡片）
  const inner = unwrap(legacy.retweeted_status_result && (legacy.retweeted_status_result as Raw).result)
  const content = inner ?? raw
  const contentLegacy = (content.legacy ?? {}) as Raw
  const user = graphqlUser(content)
  const retweeter = inner ? graphqlUser(raw) : null

  // 引用推文：留 ref + 轻量快照
  const quotedRaw = unwrap((content.quoted_status_result as Raw | undefined)?.result)
  const quoted = quotedRaw
    ? {
        id: str(quotedRaw.rest_id) ?? null,
        author: graphqlUser(quotedRaw).handle ?? null,
        text: graphqlText(quotedRaw)?.slice(0, 200) ?? null,
      }
    : null

  const createdAt = str(legacy.created_at)
  const views = (raw.views ?? {}) as Raw

  return {
    message: {
      name: `twitter-${id}`,
      creationTimestamp: createdAt ? new Date(createdAt).toISOString() : null,
      spec: {
        raw,
        text: graphqlText(content),
        url: user.handle ? `https://x.com/${user.handle}/status/${str(content.rest_id) ?? id}` : undefined,
        author: { ref: user.ref, handle: user.handle, name: user.displayName, avatar: user.avatar ?? null },
        media: graphqlMedia(content),
        stats: {
          likes: num(contentLegacy.favorite_count) ?? 0,
          retweets: num(contentLegacy.retweet_count) ?? 0,
          replies: num(contentLegacy.reply_count) ?? 0,
          quotes: num(contentLegacy.quote_count) ?? 0,
          views: parseInt(str(views.count) ?? '0', 10) || 0,
        },
        refs: {
          quoted: quoted?.id ? `twitter-${quoted.id}` : null,
          replyTo: str(contentLegacy.in_reply_to_status_id_str) ? `twitter-${str(contentLegacy.in_reply_to_status_id_str)}` : null,
          ...(str(contentLegacy.in_reply_to_screen_name) ? { replyToHandle: str(contentLegacy.in_reply_to_screen_name) } : {}),
        },
        ...(quoted ? { quotedSnapshot: quoted } : {}),
        ...(retweeter?.handle ? { retweetedBy: retweeter.handle } : {}),
        content: null,
      } as MessageSpec,
    },
    author: user.ref
      ? {
          name: user.ref,
          spec: {
            handle: user.handle,
            displayName: user.displayName,
            avatar: user.avatar ?? null,
            url: `https://x.com/${user.handle}`,
          },
        }
      : null,
  }
}

function zhihuAuthorToken(url: string | undefined): string | undefined {
  const m = url?.match(/\/people\/([^/?#]+)/)
  return m?.[1]
}

function normalizeZhihu(raw: Raw): NormalizedItem | null {
  // 广告与聚合卡不产出 Message（聚合卡应先经 expandRawItems 拆开）
  if (raw.type === 'feed_advert' || raw.type === 'feed_group') return null
  if (typeof raw.id === 'string' && raw.id.startsWith('AD_')) return null
  // 两代 schema：CDP topstory（含 target 包装）vs bb-browser adapter 扁平对象
  if (raw.target && typeof raw.target === 'object') return normalizeZhihuTopstory(raw)
  const id = str(raw.id) ?? (num(raw.id) !== undefined ? String(raw.id) : undefined)
  if (!id) return null
  let rawAuthor = (raw.author ?? {}) as Raw
  // 旧 zhihu-follow adapter schema：作者在 meta 里（answer→answerer_*，article/pin→author_*）
  const meta = (raw.meta ?? {}) as Raw
  const metaName = str(meta.answerer_name) ?? str(meta.author_name)
  const metaId = str(meta.answerer_id) ?? str(meta.author_id)
  if (!str(rawAuthor.name) && metaName) {
    rawAuthor = {
      name: metaName,
      url: metaId ? `https://www.zhihu.com/people/${metaId}` : undefined,
    }
  }
  const authorUrl = str(rawAuthor.url)
  const token = zhihuAuthorToken(authorUrl)
  const authorName = token ? `zhihu-${token}` : null
  const createdTime = num(raw.created_time)
  return {
    message: {
      name: `zhihu-${id}`,
      creationTimestamp: createdTime ? new Date(createdTime * 1000).toISOString() : null,
      spec: {
        raw,
        title: str(raw.title),
        text: str(raw.excerpt) ?? str(raw.content),
        url: str(raw.url),
        author: { ref: authorName, name: str(rawAuthor.name), url: authorUrl, avatar: str(rawAuthor.avatar) ?? null },
        media: [],
        stats: {
          voteup: num(raw.voteup_count) ?? num(meta.voteup_count) ?? 0,
          comments: num(raw.comment_count) ?? num(meta.comment_count) ?? 0,
        },
        content: null,
      },
    },
    author: authorName
      ? {
          name: authorName,
          spec: {
            authorId: token,
            displayName: str(rawAuthor.name),
            avatar: str(rawAuthor.avatar) ?? null,
            url: authorUrl,
          },
        }
      : null,
  }
}

// ---------- zhihu topstory（CDP）schema ----------

function normalizeZhihuTopstory(raw: Raw): NormalizedItem | null {
  const target = raw.target as Raw
  const id = str(target.id) ?? (num(target.id) !== undefined ? String(target.id) : undefined)
  if (!id) return null

  const type = str(target.type) // answer | article | zvideo | ...
  const question = (target.question ?? {}) as Raw
  const author = (target.author ?? {}) as Raw
  const token = str(author.url_token)
  const authorName = token ? `zhihu-${token}` : null

  const title = type === 'answer' ? str(question.title) : str(target.title)
  const qid = str(question.id) ?? (num(question.id) !== undefined ? String(question.id) : undefined)
  const url =
    type === 'answer' && qid
      ? `https://www.zhihu.com/question/${qid}/answer/${id}`
      : type === 'article'
        ? `https://zhuanlan.zhihu.com/p/${id}`
        : str(target.url)

  // 封面：thumbnail 单图或 thumbnails 多图
  const thumbs = Array.isArray(target.thumbnails) ? (target.thumbnails as unknown[]) : []
  const covers = [str(target.thumbnail), str(target.image_url), ...thumbs.map(t => (typeof t === 'string' ? t : str((t as Raw)?.url)))]
    .filter((u): u is string => !!u)
  const media: MediaRef[] = [...new Set(covers)].map(originUrl => ({ type: 'image', originUrl, url: null }))

  const createdTime = num(target.created_time) ?? num(target.created) ?? num(raw.created_time)
  const contentHtml = str(target.content)

  return {
    message: {
      name: `zhihu-${id}`,
      creationTimestamp: createdTime ? new Date(createdTime * 1000).toISOString() : null,
      spec: {
        raw,
        title,
        text: str(target.excerpt) ?? str(target.excerpt_new),
        url,
        author: {
          ref: authorName,
          name: str(author.name),
          url: token ? `https://www.zhihu.com/people/${token}` : undefined,
          avatar: str(author.avatar_url) ?? null,
        },
        media,
        stats: {
          voteup: num(target.voteup_count) ?? 0,
          comments: num(target.comment_count) ?? 0,
        },
        // topstory 直接带全文 HTML，等于天然 hydrated
        content: contentHtml ?? null,
      },
    },
    author: authorName
      ? {
          name: authorName,
          spec: {
            authorId: token,
            displayName: str(author.name),
            avatar: str(author.avatar_url) ?? null,
            url: `https://www.zhihu.com/people/${token}`,
          },
        }
      : null,
  }
}

const NORMALIZERS: Record<string, (raw: Raw) => NormalizedItem | null> = {
  twitter: normalizeTwitter,
  zhihu: normalizeZhihu,
}

/** 规范化一条 raw item；未知平台或缺 id 返回 null（跳过但不致命） */
export function normalizeItem(platform: string, raw: unknown): NormalizedItem | null {
  const fn = NORMALIZERS[platform]
  if (!fn || typeof raw !== 'object' || raw === null) return null
  return fn(raw as Raw)
}

/**
 * raw 预展开（ingest 前调用）：知乎 moments 的 feed_advert（广告）丢弃、
 * feed_group（"多人都赞了"聚合卡）拆成内含的真实 feed items。其他平台原样。
 */
export function expandRawItems(platform: string, rawItems: unknown[]): unknown[] {
  if (platform !== 'zhihu') return rawItems
  const out: unknown[] = []
  for (const raw of rawItems) {
    const r = raw as Raw
    if (!r || typeof r !== 'object') continue
    if (r.type === 'feed_advert') continue
    if (r.type === 'feed_group' && Array.isArray(r.list)) {
      out.push(...(r.list as unknown[]))
      continue
    }
    out.push(r)
  }
  return out
}
