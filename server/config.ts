// 账号与源的静态注册表。多账号管理 UI 落地前，新增账号/源在此登记。

export interface AccountConfig {
  name: string
  platform: 'zhihu' | 'twitter' | 'bilibili'
  displayName: string
  /** 独立 Chrome profile 目录；undefined = 共用默认 profile（profiles/main） */
  profileDir?: string
}

export interface SourceConfig {
  /** 源名 = <account>-<capability>，也是 Message 的 source label 和 window 名前缀 */
  name: string
  account: string
  platform: AccountConfig['platform']
  capability: string
}

export const ACCOUNTS: AccountConfig[] = [
  { name: 'zhihu-main', platform: 'zhihu', displayName: '知乎主号' },
  { name: 'twitter-main', platform: 'twitter', displayName: '推特主号' },
  { name: 'bilibili-main', platform: 'bilibili', displayName: 'B站主号' },
]

export const SOURCES: SourceConfig[] = [
  { name: 'zhihu-main-recommend', account: 'zhihu-main', platform: 'zhihu', capability: 'recommend' },
  { name: 'zhihu-main-follow', account: 'zhihu-main', platform: 'zhihu', capability: 'follow' },
  { name: 'twitter-main-recommend', account: 'twitter-main', platform: 'twitter', capability: 'recommend' },
  { name: 'twitter-main-following', account: 'twitter-main', platform: 'twitter', capability: 'following' },
  { name: 'bilibili-main-recommend', account: 'bilibili-main', platform: 'bilibili', capability: 'recommend' },
  { name: 'bilibili-main-follow', account: 'bilibili-main', platform: 'bilibili', capability: 'follow' },
  { name: 'bilibili-main-popular', account: 'bilibili-main', platform: 'bilibili', capability: 'popular' },
]

export const DEFAULT_RECOMMENDATION_SOURCES = [
  'zhihu-main-recommend',
  'twitter-main-recommend',
  'bilibili-main-recommend',
] as const

export function getSource(name: string): SourceConfig | undefined {
  return SOURCES.find(s => s.name === name)
}

export function getAccount(name: string): AccountConfig | undefined {
  return ACCOUNTS.find(a => a.name === name)
}
