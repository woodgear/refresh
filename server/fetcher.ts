// Fetcher 抽象（docs/design.md §5）。
// BbBrowserFetcher 是当前默认；CdpFetcher 在 M2 落地；MockFetcher 供 verify.sh 确定性测试。

import { spawn } from 'child_process'
import type { SourceConfig } from './config'

export interface FetchResult {
  rawItems: unknown[]
  fetchedAt: number
}

export interface Fetcher {
  fetch(source: SourceConfig, count: number, log: (line: string) => void): Promise<FetchResult>
}

export class BbBrowserFetcher implements Fetcher {
  async fetch(source: SourceConfig, count: number, log: (line: string) => void): Promise<FetchResult> {
    const args = ['site', source.adapter, String(count), '--jq', '.']
    log(`bb-browser ${args.join(' ')}`)
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn('bb-browser', args)
      let out = ''
      let err = ''
      proc.stdout.on('data', d => { out += d.toString() })
      proc.stderr.on('data', d => {
        err += d.toString()
        for (const line of d.toString().split('\n')) if (line.trim()) log(`[stderr] ${line.trim()}`)
      })
      proc.on('close', code => {
        if (code === 0) resolve(out)
        else reject(new Error(`bb-browser exit ${code}: ${err.slice(-500)}`))
      })
      proc.on('error', reject)
    })
    const data = JSON.parse(stdout) as { items?: unknown[]; fetchedAt?: number }
    return {
      rawItems: data.items ?? [],
      fetchedAt: data.fetchedAt ?? Math.floor(Date.now() / 1000),
    }
  }
}

/** 确定性假数据，verify.sh 用（RADAR_FETCHER=mock 启用）。
 *  twitter 用 GraphQL 形态（覆盖 CDP 路线的 normalize + 媒体管道），图片用 data URL 避免外网依赖。 */
export class MockFetcher implements Fetcher {
  async fetch(source: SourceConfig, count: number, log: (line: string) => void): Promise<FetchResult> {
    log(`mock fetch ${source.name} count=${count}`)
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const tweet = (id: string, text: string, hour: string) => ({
      __typename: 'Tweet',
      rest_id: id,
      core: { user_results: { result: { legacy: { screen_name: 'mockuser', name: 'Mock User', profile_image_url_https: PNG } } } },
      legacy: {
        full_text: text,
        created_at: `Wed Jun 10 ${hour}:00:00 +0000 2026`,
        favorite_count: 5, retweet_count: 1, reply_count: 0, quote_count: 0,
        extended_entities: { media: [{ type: 'photo', media_url_https: PNG, original_info: { width: 1, height: 1 } }] },
      },
      views: { count: '100' },
    })
    const items =
      source.platform === 'twitter'
        ? [tweet('9001', 'mock tweet one', '01'), tweet('9002', 'mock tweet two', '02')]
        : source.platform === 'bilibili'
          ? [
              { bvid: 'BVmock0001', title: 'mock bili video', desc: 'mock bili desc', pic: PNG, pubdate: 1781110000, owner: { mid: 42, name: '测试UP', face: PNG }, stat: { view: 100, like: 5, danmaku: 2 } },
            ]
          : [
            { id: '8001', title: 'mock zhihu answer', excerpt: 'mock excerpt one', created_time: 1781100000, url: 'https://www.zhihu.com/question/1/answer/8001', author: { name: '测试作者', url: 'https://www.zhihu.com/people/mock-author' } },
            { id: '8002', title: 'mock zhihu answer 2', excerpt: 'mock excerpt two', created_time: 1781103600, url: 'https://www.zhihu.com/question/1/answer/8002', author: { name: '测试作者', url: 'https://www.zhihu.com/people/mock-author' } },
            // 广告：必须被整条丢弃
            { id: 'AD_999_123', type: 'feed_advert', ad: {}, brief: 'ad' },
            // 聚合卡：必须拆出内含的真实条目（zhihu-8003）
            {
              id: '2_999_1', type: 'feed_group', group_text: '都赞了',
              list: [
                {
                  id: 'g1', type: 'feed', verb: 'MEMBER_VOTEUP_ANSWER',
                  target: {
                    type: 'answer', id: '8003', excerpt: 'mock group inner', created_time: 1781107200,
                    question: { title: 'mock group question', id: '77' },
                    author: { name: '测试作者', url_token: 'mock-author' },
                    voteup_count: 1, comment_count: 0,
                  },
                },
              ],
            },
          ]
    return { rawItems: items.slice(0, count), fetchedAt: 1781110000 }
  }
}

export function defaultFetcher(): Fetcher {
  if (process.env.RADAR_FETCHER === 'mock') return new MockFetcher()
  if (process.env.RADAR_FETCHER === 'bb') return new BbBrowserFetcher()
  return new RoutingFetcher()
}

/** 按源路由：fetchVia=cdp 走直连 CDP（推特拿 GraphQL 全量结构），其余走 bb-browser adapter */
export class RoutingFetcher implements Fetcher {
  private bb = new BbBrowserFetcher()

  async fetch(source: SourceConfig, count: number, log: (line: string) => void): Promise<FetchResult> {
    if (source.fetchVia === 'cdp' && source.platform === 'twitter') {
      const { fetchTwitterTimeline } = await import('./cdp-twitter')
      return fetchTwitterTimeline(source.capability as 'recommend' | 'following', count, log)
    }
    if (source.fetchVia === 'cdp' && source.platform === 'zhihu') {
      const { fetchZhihuFeed } = await import('./cdp-zhihu')
      return fetchZhihuFeed(source.capability as 'recommend' | 'follow', count, log)
    }
    if (source.fetchVia === 'cdp' && source.platform === 'bilibili') {
      const { fetchBilibiliFeed } = await import('./cdp-bilibili')
      return fetchBilibiliFeed(source.capability as 'follow' | 'popular', count, log)
    }
    return this.bb.fetch(source, count, log)
  }
}
