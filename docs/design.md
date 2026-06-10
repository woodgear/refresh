# Radar 设计文档

> 2026-06-10 定稿。本文档是 radar 重构的蓝图，由讨论收敛而来，实施期间以此为准。

## 1. 定位

Radar 的主体是一个**"我的账号能力" API 服务**：把知乎/推特等平台用我的账号推给我的内容，
变成结构化、可编程消费的资源。网页和 RSS 都只是这个 API 的消费者。

```
┌──────────────── 消费者 ────────────────────┐
│  聚合网页(手动刷新)   RSS 阅读器   脚本/agent  │
└──────┬──────────────┬─────────────┬───────┘
       │ JSON         │ XML         │ JSON
┌──────┴──────────────┴─────────────┴───────┐
│         radar core (Hono, :3001)          │
│   /api/v1/...(JSON)        /rss/...(XML)  │
│   ├─ 资源层 (k8s 风格对象)                  │
│   ├─ auth 管理 (检测 / QR 引导登录)         │
│   ├─ store (档案 + overlay + media)        │
│   ├─ scheduler (30min 低频补抓 controller)  │
│   └─ fetcher (bb-browser → 直连 CDP)       │
└────────────────────────────────────────────┘
```

本期范围：**知乎 + 推特**。B 站账号已登录、adapter 齐全（`bilibili/feed`、`bilibili/popular`），
作为第二批源接入，资源模型已为其留位。

## 2. 资源模型（k8s 风格）

所有对象遵循 `apiVersion/kind/metadata/spec/status` 信封。
刻意不抄 k8s 的部分：不做 namespace（platform/account 用 label 表达）、不做
resourceVersion/乐观锁（单用户单写者）、selector 只支持 `key=value` 逗号分隔。

### Message —— 平台推给我的一条内容（去重后的稳定对象）

```json
{
  "apiVersion": "radar/v1",
  "kind": "Message",
  "metadata": {
    "name": "twitter-2064681986749522045",
    "labels": { "platform": "twitter", "source": "twitter-main-following", "account": "twitter-main" },
    "creationTimestamp": "2026-06-10T12:12:00Z",
    "annotations": {
      "radar/firstSeenWindow": "twitter-main-following-1781234567",
      "radar/lastSeenWindow": "twitter-main-following-1781238167"
    }
  },
  "spec": {
    "raw": { "...adapter/API 原始 payload，原封不动..." },
    "title": "...",
    "text": "...",
    "url": "https://x.com/...",
    "author": { "ref": "twitter-geekbb", "name": "...", "handle": "...", "avatar": "/api/v1/media/<hash>" },
    "media": [
      { "type": "image", "originUrl": "https://pbs.twimg.com/...",
        "url": "/api/v1/media/<sha256>", "width": 1200, "height": 800 }
    ],
    "stats": { "likes": 19, "retweets": 3, "replies": 0, "views": 0 },
    "refs": { "quoted": "twitter-...", "replyTo": null },
    "content": null
  },
  "status": { "hydrated": false }
}
```

设计要点：
- **`spec.raw` 永远保留原始 payload**，normalized 字段全部由 raw 派生。normalize 逻辑改了
  可对历史档案重跑，不需要重抓。这是"信息不丢"的底线。
- **复刻标准**：以平台 feed 卡片为准——推文 = 全文+图+引用，知乎卡片 = 标题+摘要+封面，
  这些必须自包含。知乎正文是点击后内容，走 hydrate 按需补全（见 §6）。
- **可变性策略**：内容字段以首次入库为准冻结；互动数据（likes/views）在重复出现时允许更新，
  并刷新 `radar/lastSeenWindow`。平台删除内容时本地副本保留（存档是特性）。
- `metadata.name` 全局唯一，带平台前缀防撞；平台原生 id 放 spec/raw 里。

### RefreshWindow —— 一次刷新动作及其结果（语义 ≈ k8s Job）

```json
{
  "apiVersion": "radar/v1",
  "kind": "RefreshWindow",
  "metadata": { "name": "zhihu-main-recommend-1781234567" },
  "spec": { "source": "zhihu-main-recommend", "account": "zhihu-main",
            "count": 50, "trigger": "manual|scheduled|post-login" },
  "status": {
    "phase": "Pending|Running|Succeeded|Failed",
    "startedAt": "...", "finishedAt": "...",
    "messageRefs": ["...", "..."],
    "stats": { "fetched": 53, "new": 12, "duplicate": 41 },
    "error": null
  }
}
```

**统一触发模型**：所有抓取入口都是"创建一个 RefreshWindow"——网页刷新按钮、30 分钟调度器、
登录成功后的补抓，全是 `POST /refreshwindows`，区别只在 `spec.trigger`。
调度器就是"每 30 分钟 create 一个 RefreshWindow 的 controller"。
创建是异步的（返回 Pending），用 `?watch=1` (SSE) 或轮询跟踪。

`status.messageRefs` 保留"这一轮平台推了我什么"的完整快照，支持按 window 浏览和轮间对比。

### Account —— 我的平台账号（多账号的地基）

```json
{
  "apiVersion": "radar/v1",
  "kind": "Account",
  "metadata": { "name": "zhihu-main", "labels": { "platform": "zhihu" } },
  "spec": { "platform": "zhihu", "displayName": "主号", "profileDir": "profiles/zhihu-main" },
  "status": { "auth": "ok|logged_out|browser_down", "lastChecked": "...", "userInfo": { } }
}
```

- 每个账号独立浏览器 profile（独立 user-data-dir + CDP 端口，按需启动）。
- **当前默认账号复用 bb-browser 的受管 profile**（已登录三平台），新增账号才开新 profile。
- 现在每平台只有一个号，但 account 维度从第一天起写进所有命名和 label，避免日后迁移。
- 同一内容可能被推给不同账号，Message 的 `account` label 记录"推给谁"，本身是有价值的信息。

### Author —— 内容作者（归类管理的地基）

```json
{
  "apiVersion": "radar/v1",
  "kind": "Author",
  "metadata": { "name": "twitter-karpathy",
                "labels": { "platform": "twitter", "category": "ai-research" } },
  "spec": { "authorId": "...", "handle": "karpathy", "displayName": "...",
            "avatar": "/api/v1/media/<hash>", "url": "..." },
  "status": { "messageCount": 42, "lastSeenAt": "..." }
}
```

- 入库时从 Message 抽取作者建注册表；Message 的 `spec.author` = ref + 当时快照
  （作者会改名：快照保复刻，ref 保归类）。
- 归类 = 给 Author 打 label（`category` 等），用 selector 查消息。将来的自动归类是一个
  打 label 的 controller，模型不变。
- 潜在集成：bb-space 已有 `followings.yaml` / `follow-manager` 维护关注备注，可作为
  Author label 的导入源。

### LoginSession —— 一次登录引导

```json
{
  "apiVersion": "radar/v1",
  "kind": "LoginSession",
  "metadata": { "name": "login-zhihu-main-xxxx" },
  "spec": { "account": "zhihu-main", "mode": "qr|window" },
  "status": { "phase": "Pending|WaitingScan|Confirmed|Succeeded|Failed|Expired" }
}
```

## 3. API 端点

```
# 消息与作者
GET   /api/v1/messages?labelSelector=source=zhihu-main-recommend&limit=50
GET   /api/v1/messages/{name}
PATCH /api/v1/messages/{name}                # 只写 overlay（labels/status）
POST  /api/v1/messages/{name}/hydrate        # 按需补全正文（知乎答案/文章）
GET   /api/v1/authors?labelSelector=category=ai-research
PATCH /api/v1/authors/{name}
GET   /api/v1/messages?authorSelector=category=ai-research

# 刷新
POST  /api/v1/refreshwindows                 # 创建即触发，异步返回 Pending
GET   /api/v1/refreshwindows?source=...
GET   /api/v1/refreshwindows/{name}
GET   /api/v1/refreshwindows/{name}?watch=1  # SSE 跟踪 phase + 日志

# 账号与登录
GET   /api/v1/accounts                       # status.auth 一目了然
GET   /api/v1/accounts/{name}
POST  /api/v1/loginsessions                  # {spec:{account:"zhihu-main"}}
GET   /api/v1/loginsessions/{id}             # 轮询 phase
GET   /api/v1/loginsessions/{id}/qr          # PNG 子资源，前端 2~3 秒拉一次

# 媒体与 RSS
GET   /api/v1/media/{hash}                   # 本地化媒体静态服务
GET   /rss/{source}.xml                      # 例: /rss/zhihu-main-recommend.xml
GET   /rss/all.xml                           # 全源合并（可选）
```

**关键语义**：GET 永远秒回缓存（响应带 fetchedAt，消费者自判新鲜度）；真实抓取只由
三个入口触发（手动 POST / 调度器 / 登录后补抓）。RSS 阅读器高频轮询不会打到平台。
"低频"约束在 core 层统一兜住。

RSS 对外暴露：局域网自用监听 `0.0.0.0` 即可；公网暴露加 `?token=` 简单鉴权（留口子，先不做）。

## 4. 登录机制

原则：**radar 负责把"登录"以最低摩擦递到用户手上，登录动作本身交给用户。**

失败分两层，处理不同：

| 状态 | 检测 | 处理 |
|------|------|------|
| `browser_down` | CLI/CDP 连接失败（如 Daemon 503: Chrome not connected） | **自愈**：重拉受管 Chrome（必要时 `daemon shutdown` + 经 CDP `/json/new` 建 tab），不打扰用户 |
| `logged_out` | 知乎 `zhihu/me` 返回 401；推特打开 `x.com/home` 被重定向回 `x.com/`；B 站 `bilibili/me` 报未登录 | 标记 needs_login，调度器跳过该账号（不空转重试），UI 引导登录 |

登录引导按平台能力分两种模式：

- **QR 模式（知乎/B站）**：创建 LoginSession → server 在受管浏览器后台 tab 打开登录页 →
  对二维码区域截图，经 `/loginsessions/{id}/qr` 提供 PNG → radar 网页弹窗显示，
  **每 2~3 秒重拉一次图**（镜像式，二维码过期刷新/扫码确认等页面状态自然同步，无需专门处理）→
  同时轮询账号 auth → 成功后关弹窗、关 tab、自动补抓一轮。
  实现：bb-browser eval 拿二维码元素 bounding box + 截图裁剪；不顺手就直接 CDP
  `Page.captureScreenshot` + clip。
- **window 模式（推特，账密+2FA 无扫码）**：受管浏览器窗口带到前台停在登录页，
  radar 显示"请在弹出的窗口中完成登录"，轮询检测成功。

调试开关：登录检测留 mock（强制返回 logged_out），调 UI 流程用，真实扫码只在最终验收做一次。

## 5. 抓取层（Fetcher）

```
Fetcher 接口: fetch(source, count) / checkAuth(account)
  ├─ BbBrowserFetcher   当前默认：spawn bb-browser site <adapter>
  └─ CdpFetcher         直连 CDP：自起/复用 Chrome，按 account 选 profile
```

bb-browser 是当前实现细节而非依赖锁定，受限就换直连 CDP。已知现状（2026-06-10 实测）：

- twitter adapter（本地 override，`~/.bb-browser/sites/`，已修复 following.js 的多余 `}`）
  **已能抓到 `created_at`**，但**没有媒体、引用推文、转推结构** → 不满足"复刻 feed 卡片"。
- 知乎 adapter 只有截断 excerpt，无封面图。

所以 CdpFetcher 仍是必做项（M2）：
- **推特**：拦截 HomeTimeline GraphQL 响应，原始 JSON 含完整 media entities（各尺寸图、
  视频 variants）、引用/转推结构、created_at。
- **知乎**：登录态下页面上下文调 `/api/v3/feed/topstory/recommend`，自带封面图与完整 excerpt。
- 多账号：CdpFetcher 按 `Account.spec.profileDir` 起独立 Chrome（bb-browser 单 profile
  做不到，这是直连 CDP 的另一硬理由）。

## 6. 媒体本地化与内容分级

媒体必须本地化（知乎 zhimg 有 referer 防盗链；外链会死，复刻会失效）：

- RefreshWindow 流水线抓取时顺手下载图片/头像到 `data/media/<sha256>.<ext>`
  （内容 hash 去重），下载带 referer/登录态。低频抓取，带宽无虞。
- **视频不下载**（体积失控）：存 poster 图 + 原始播放地址 + 跳转链接。
- RSS 输出用 `baseUrl + /api/v1/media/<hash>`，外部阅读器可回源。

内容分级：feed 卡片全量入库；知乎正文按需 `POST /messages/{id}/hydrate`
（用 `zhihu/question` / `zhihu/article` adapter，正文内图同样本地化），不在抓取轮全量做
（一轮 50 条 = 50 个页面，太重）。

## 7. 存储布局

不可变档案与可变用户态分离——重抓/重建索引/重跑 normalize 永不碰用户态：

```
data/
  windows/*.json           # RefreshWindow 档案，只追加不可变（含每条的 spec.raw）
                           # 文件名 = metadata.name = <account>-<capability>-<unix_ts>
  media/<sha256>.<ext>     # 本地化媒体
  overlay/authors.json     # Author 可变字段（labels 等）
  overlay/messages.json    # Message 可变字段（labels、将来的已读/收藏）
profiles/<account>/        # 新增账号的 Chrome user-data-dir（默认账号用 bb-browser 受管 profile）
```

读取时档案 + overlay 合并出完整对象；PATCH 只写 overlay。Message 索引启动时由
windows 合并构建（沿用现有去重逻辑）。本期维持 JSON 文件，数据量大或要做已读状态时再迁 SQLite。

## 8. 调度

- 30 分钟一轮；每轮先 checkAuth，`logged_out` 的账号跳过并标记，不空转。
- 触发方式 = 创建 RefreshWindow（`trigger: scheduled`）。
- 手动刷新和登录后补抓共用同一条路径。

## 9. 前端（聚合网页）

- 迁移到 REST（react-query 直调 `/api/v1`），**tRPC 退役**，避免双契约。
- 侧边栏：每账号登录状态点（绿 ok / 黄 browser_down / 红 logged_out）。
- 未登录：feed 区横幅 "[平台]未登录 → 去登录" → QR 弹窗 / window 引导。
- 手动刷新按钮 → POST refreshwindows → `?watch=1` 显示进度。
- 按时间流之外，支持按 window 浏览（"这一轮推了我什么"，展示 stats.new）。

## 10. 验收（Definition of Done）与推进 loop

**一句话判据：不碰代码、不开 devtools，仅通过 API/网页/RSS 三个出口能完整消费两个平台
推给我的内容，且断登录后系统能引导恢复。**

| # | 验收项 | 验证 |
|---|--------|------|
| A1 | 资源 API 就绪，k8s 信封 + labelSelector 可用 | 自动（verify.sh curl 断言） |
| A2 | POST refreshwindows → Succeeded，stats 正确，档案落盘 | 自动 |
| A3 | 推特 Message 有 created_at + media（CdpFetcher 生效标志） | 自动 |
| A4 | 知乎图经 /api/v1/media 可访问（防盗链已绕过） | 自动 |
| A5 | 登录恢复闭环：logged_out → LoginSession → 网页扫码 → ok → 自动补抓 | **人工**（扫一次码） |
| A6 | 调度器 30min 建 window；登出账号跳过且标记 | 自动（缩短间隔观察） |
| A7 | 网页：渲染/手动刷新/登录横幅+QR 弹窗 | 人工过一遍 |
| A8 | /rss/*.xml 通过校验，真实 RSS 阅读器加载成功、图片可见 | 半自动+人工 |
| A9 | PATCH author label → authorSelector 能筛消息 | 自动 |

**Loop**：`verify.sh`（起 server → curl 断言 → pass/fail）是判停条件，留在仓库作回归。

```
loop: 取 checklist 下一未通过项 → 实现 → 跑 verify.sh
      ├─ 有红 → 修复，不进下一项
      └─ 全绿 → 下一项
exit: verify.sh 全绿 + 人工项(A5/A7/A8)就绪，标记 awaiting-you，攒到最后一次性确认
```

**里程碑**：
- M1 core API + 存储（A1/A9）
- M2 CdpFetcher + 媒体本地化（A2/A3/A4）
- M3 登录闭环（A5）
- M4 调度器（A6）
- M5 网页迁移 + RSS（A7/A8）
- 二期：B 站接入、多账号管理 UI、作者归类 UI、自动归类 controller、SQLite 迁移、RSS token

## 11. 当前状态（2026-06-10）

- 三平台均已登录（受管 Chrome profile）：知乎 ✓（wu-cong-94）、B站 ✓、推特 ✓。
- 采集链路实测可用：zhihu/me、zhihu/recommend、bilibili/me、twitter/recommend、
  twitter/following（修复 `~/.bb-browser/sites/twitter/following.js` 末尾多余 `}` 后）。
- 已知坑：bb-browser daemon 可能卡在失效的 CDP 连接（`Chrome not connected`），
  `daemon shutdown` 重启后若无 page target，经 `PUT /json/new` 建 tab 可恢复——
  这两步就是 `browser_down` 自愈逻辑的雏形。
- 旧 `data/*.json` 是旧 schema（推特无 created_at/媒体），M1 时作为历史档案迁入或弃用，二选一。
