export type FeedSource = 'zhihu-recommend' | 'zhihu-follow' | 'twitter-recommend' | 'twitter-following' | 'follow' | 'recommend'

export type FeedCategory = 'follow' | 'recommend'

export interface TwitterMessage {
  type: 'twitter'
  id: string
  author: string
  url: string
  text: string
  likes: number
  retweets: number
  views: number
}

export interface ZhihuMessage {
  type: 'zhihu'
  id: string
  title: string
  excerpt: string
  url: string
  author: { name: string }
  stats: { voteup_count: number; comment_count: number }
}

export type Message = TwitterMessage | ZhihuMessage

export const FEED_SOURCES: Record<FeedCategory, { id: FeedSource; label: string; platform: 'twitter' | 'zhihu' }[]> = {
  follow: [
    { id: 'twitter-following', label: 'Twitter', platform: 'twitter' },
    { id: 'zhihu-follow', label: '知乎', platform: 'zhihu' },
  ],
  recommend: [
    { id: 'twitter-recommend', label: 'Twitter', platform: 'twitter' },
    { id: 'zhihu-recommend', label: '知乎', platform: 'zhihu' },
  ],
}
