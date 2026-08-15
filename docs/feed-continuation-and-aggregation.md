# 连续获取与跨平台聚合 Feed

> 状态：产品与架构交接稿，2026-08-10。2026-08-15 已完成确定性 fetcher 契约、基于 litectl V2 的单 source FeedSession/FeedPage 持久化与 API 纵切，以及全部当前注册 source 的真实 cursor；聚合、updates 和 UI 尚未实现。

## 1. 产品目标

Refresh 最终不是单个平台的阅读器，而是所有个人信息流的统一入口：

- 平台包括 B 站、知乎、Twitter/X，以及以后接入的其他来源。
- `推荐`、`关注`是 source capability，不是某个平台的特殊页面逻辑。
- Refresh API 是产品核心；网页、RSS、agent 和其他应用都是 API 消费者。
- 当前聚合只是把各平台内容放在一起；未来会基于历史内容、新内容和用户行为做真正的跨平台推荐排序。

默认使用场景是连续向下浏览。用户通常不会反复刷新首页，而是希望在当前上下文中不断获取下一批内容。因此“获取更多”应是主路径，“重新开始”是显式切换到新一轮内容的动作。

## 2. 三种不同能力

这三个概念不能共用一个含糊的“刷新”按钮或 API 语义。

| 能力 | 是否访问平台 | 是否保持当前上下文 | 产品表现 |
| --- | --- | --- | --- |
| 浏览本地归档 | 否 | 是 | 分页读取已经进入 Refresh 的 Message |
| 获取更多 | 是 | 是 | 沿平台游标继续，向当前 feed 尾部追加新候选 |
| 重新开始 | 是 | 否 | 从平台 feed 头部建立新 generation，并回到顶部 |

### 获取更多

- 同一 generation 内继续使用每个平台的 continuation cursor。
- 新条目追加在当前有序结果后，不重排用户已经读过的部分。
- 重复内容仍经过 Message 全局去重，但本次 page/window 要保留完整 `messageRefs`。
- 某个平台暂时无更多内容，不应阻断聚合 feed 的其他平台。

### 重新开始

- 从各平台 feed 头部重新取样，创建新的 generation。
- 当前 generation 和阅读位置仍可保留，便于返回；不要覆盖历史档案。
- 后台发现新内容时，只显示“发现 N 条新内容”，不在用户阅读过程中把卡片插到顶部。
- 用户点击新内容提示或“重新开始”后，才切换 generation 并回到顶部。

## 3. 网页交互

已确认的主流程：

1. 打开“为你推荐”时读取当前 generation 的第一页。
2. 接近列表底部时自动触发获取更多；同一时刻只允许一个请求。
3. 成功后原位追加，保持滚动位置；失败时在底部明确展示错误并允许重试。
4. 后台刷新只更新新内容计数，显示悬浮的“发现 N 条新内容”。
5. 点击提示或“重新开始”后创建新 generation，回到顶部。
6. 切换聚合 feed 或单一 source 时，分别保存 generation、已加载页和阅读位置。

`收件箱`与`为你推荐`用途不同：

- `为你推荐`是连续消费和未来推荐算法的承载面。
- `收件箱`是本地归档视图，以未读、时间和来源筛选为主，不触发平台 continuation。

## 4. 当前代码实际具备什么

现有架构已经完成以下 continuation 地基：

- `POST /api/v1/feedsessions` 创建 generation 和第一页；`POST /feedsessions/{name}/pages` 从已提交 cursor 继续。
- `FeedSession` 保存已发布顺序与 cursor，`FeedPage` 保存不可变 page 审计记录并强关联 session/window。
- 每页都归档为不可变 `RefreshWindow`，Message 继续全局去重。
- session/page 的最终状态转换在一个 litectl 调用方事务内提交；fetch 或 archive 失败不推进 cursor。
- 服务重启后能恢复 session 并继续；同一 session 的并发 page 请求明确返回冲突。
- 平台 cursor 只保存在内部资源表示，FeedSession、FeedPage HTTP 响应均不返回 cursor。
- source 已按 `account × capability` 注册。
- 知乎 fetcher 会跟随 `paging.next`；B 站关注流会跟随 `offset`；B 站热门使用页码；Twitter 会滚动页面触发更多 GraphQL 响应。

当前 API 纵切接入了确定性 mock、知乎 `paging.next` URL、B 站关注流 offset / 热门流页码，以及 Twitter HomeTimeline bottom cursor。真实 adapter 的逻辑页把 `count` 视为目标数量并保留完整上游页，避免截断上游页后永久跳过尾部条目。知乎 next URL 会在 adapter 内校验为同源且与 capability 路径匹配。Twitter 每次从当前 x.com 页面捕获 fresh GET/POST GraphQL request 模板，在同一 tab 内注入持久化 bottom cursor；authorization、CSRF 和 transaction headers 只存在于该次内存请求，不进入资源。

另外：

- `GET /messages` 只有 `limit`，没有稳定的 cursor/offset 响应契约。
- B 站当前注册的是 `bilibili-main-popular`，调用热门 API；它不是登录用户首页的个性化“推荐”。
- Twitter 当前只保存 tweet，对 GraphQL timeline cursor 没有建模。
- 知乎和 B 站虽然能在一次函数调用里翻页，但 next cursor 没有进入资源层。

## 5. 目标架构

### 5.1 保留 RefreshWindow 的 Job 语义

`RefreshWindow` 继续表示一次可审计的抓取动作。建议把请求改成判别联合，而不是从可选字段猜行为：

```ts
type FetchRequest =
  | { mode: 'restart'; source: string; count: number }
  | { mode: 'continue'; source: string; session: string; count: number }
```

window 档案除 raw items 和 `messageRefs` 外，还应记录：

- `mode`
- 所属 feed session/generation
- 输入 cursor
- 输出 cursor
- `hasMore`

平台 cursor 对外保持 opaque。当前客户端只按 FeedSession 名请求下一页，完全不接收平台 cursor；后续即使增加 continuation token，也不能让客户端依赖知乎、Twitter 或 B 站的原始 cursor 结构。

### 5.2 增加 FeedSession

需要一个资源表达“用户正在连续浏览的这一轮 feed”。建议职责如下：

```text
FeedSession
  spec:
    source: 单一 source 或 aggregate
    generation: 稳定标识
  status:
    orderedMessageRefs: 当前已经发布给用户的顺序
    sourceStates: 每个底层 source 的 cursor / hasMore / lastWindow
    pendingNewCount: feed 头部新内容数
```

FeedSession 管连续上下文；RefreshWindow 管每次抓取的执行和档案。两者不要合并成一个不断被改写的大对象。

推荐的外部动作语义：

```text
POST /api/v1/feedsessions                     # 建立新 generation
GET  /api/v1/feedsessions/{name}/messages     # 读取已经发布的有序结果
POST /api/v1/feedsessions/{name}/pages        # 获取并追加下一页
GET  /api/v1/feedsessions/{name}/updates      # 查询头部新增数量
```

具体 URL 可以调整，但外部用户必须能只通过 API 完成网页中的全部动作。

### 5.3 Fetcher 契约

每个平台 adapter 应显式实现两种操作：

```ts
type FetchPageResult = {
  rawItems: unknown[]
  nextCursor: string | null
  hasMore: boolean
  fetchedAt: number
}

fetchHead(source, count): Promise<FetchPageResult>
fetchNext(source, cursor, count): Promise<FetchPageResult>
```

不支持 continuation 的 source 应明确报错，不能静默退化成从头刷新。cursor 只有在 window 成功归档后才能提交到 FeedSession，避免抓取或写盘失败后丢页。

### 5.4 聚合 Feed

聚合 session 持有多个 source state。获取下一页时：

1. 从本地未发布候选中先取数。
2. 候选不足时，仅向仍有 `hasMore` 的 source 请求下一页。
3. 归一化、去重后交给 ranker。
4. ranker 只决定尚未发布内容的顺序，不回排用户已经看到的卡片。
5. 将选中的 refs 追加到 session 的 `orderedMessageRefs`。

第一版 ranker 可以是有明确配额的确定性交错；它只是过渡实现。未来 ranker 的候选信号可包括来源、内容新鲜度、作者、主题、已读/点击/收藏/负反馈和历史相似内容。排序器应是独立接口，不能写进平台 adapter 或 React 组件。

## 6. 各平台 continuation 工作

| 平台/source | 当前方式 | continuation 需要补什么 |
| --- | --- | --- |
| 知乎推荐/关注 | 已接入 `ContinuationFetcher` | [x] 校验、输出并恢复 next URL；真实 head→next 无重叠验证通过 |
| B 站关注 | 已接入 `ContinuationFetcher` | [x] 输出并恢复 offset；真实 head→next 无重叠验证通过 |
| B 站热门 | 已接入 `ContinuationFetcher` | [x] 输出下一页编号；它仍不是个性化推荐 |
| B 站个性化推荐 | 尚未注册 | 从真实首页网络请求确认接口和 cursor，新增独立 `recommend` capability |
| Twitter 推荐/关注 | 已接入 `ContinuationFetcher` | [x] 捕获 fresh GraphQL 模板，解析并恢复 bottom cursor；真实 head→next 验证通过 |

不能继续用 mockup 中 `bilibili-main-recommend → bilibili-main-popular` 的别名作为正式产品行为。

## 7. Mockup 交接

文件：`mockup-feed.html`。它直接读取运行中的 Refresh API（当前写死为 `http://127.0.0.1:13002/api/v1`），用于展示跨平台 feed 的视觉与交互方向。

### 已经真实连接的部分

- 从 `/messages` 读取真实归档内容。
- 分别渲染 B 站视频卡、知乎回答卡和 Twitter 图文卡。
- 支持聚合入口和单 source 筛选。
- 支持滚动位置记忆、自动触底、收件箱视图和响应式布局的交互演示。

### 仍是原型的部分

- 每个 source 启动时一次取 `limit=32`，之后的“下一页”只是把内存数组按 8 条切片，没有再次调用 API。
- 聚合排序是固定 `twitter / zhihu / bilibili` pattern，不是推荐算法。
- “发现 8 条新内容”在 3.2 秒后由定时器显示，数字不是 API 结果。
- “重新开始”只在本地移动两条数组元素并重新渲染，没有创建 RefreshWindow 或 FeedSession。
- source 数量、来源构成、关注方向和 generation 文案是静态演示数据。
- B 站“推荐”实际读取 `bilibili-main-popular`。
- 收件箱只展示当前样本的前 12 条，已读动作没有写回 overlay。

因此 mockup 目前验证的是产品布局和操作节奏，不是 continuation API 的实现证明。

## 8. 建议实施顺序

1. [x] 用确定性 mock fetcher 定义 `restart/continue`、cursor 提交和失败重试测试。
2. [x] 增加 FeedSession 与 page API，保留 RefreshWindow 作为底层 Job。
3. [x] 让单一 mock source 的获取更多端到端成立，包括跨进程重启续取。
4. [x] 为当前真实平台补齐可持久化 cursor：知乎、B 站和 Twitter 均完成。
5. 通过真实网络确认并接入 B 站个性化推荐 source。
6. 将 mockup 的本地切片替换为 page API，并将新内容提示接到真实 updates 状态。
7. 实现确定性聚合 ranker；个性化算法作为后续独立迭代。

## 9. 验收标准

- 同一 FeedSession 连续获取三页，页面之间不重复，重启服务后仍能继续。
- 抓取成功但归档失败时 cursor 不前移；重试能拿到同一页。
- “获取更多”不会创建新 generation，也不会改变已展示内容的顺序。
- “重新开始”创建新 generation，并能计算真实的新内容数量。
- 一个 source 到底或失败时，聚合 session 仍能从其他 source 继续。
- 网页所有操作都能由外部 API 消费者复现。
- B 站热门与个性化推荐是两个不同 source，不使用别名混淆。
- mock 测试覆盖 cursor、去重、并发加载锁、失败重试和聚合 source 耗尽。

## 10. 尚待确认

- FeedSession 的保留时间与清理规则。
- 每个平台默认 page size，以及聚合页的目标条数。
- 后台检查新内容的频率和是否复用 scheduler。
- 第一版聚合配额及未来推荐算法使用哪些行为信号。
