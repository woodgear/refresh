# Refresh（radar）实施进度

> 实施日志（M1-M5 已全部完成，A5/A7/A8 为人工验收项）。每轮迭代的记录和踩坑见下方迭代日志。
> 状态: [ ] 未开始 / [~] 进行中 / [x] 完成 / [A] awaiting-user。后续功能迭代继续在"迭代日志（续）"追加。

## M1 core API + 存储

- [x] M1.1 存储层：data/windows + data/overlay 读写，window 档案不可变、overlay 可变分离
- [x] M1.2 资源信封与索引：Message/RefreshWindow/Account/Author 对象构建，启动时合并去重建索引
- [x] M1.3 REST 路由：GET messages（labelSelector/limit）、GET/PATCH authors、GET accounts、GET refreshwindows
- [x] M1.4 POST refreshwindows（异步，BbBrowserFetcher 先顶上）+ ?watch=1 SSE
- [x] M1.5 verify.sh 建立，A1/A9 断言通过
- [x] M1.6 旧 data/*.json 处理：迁为旧 schema 档案或弃用（择一，记录决定）

## M2 CdpFetcher + 媒体本地化

- [x] M2.1 CdpFetcher 骨架：连接受管 Chrome（CDP 19825），browser_down 自愈（daemon 重启 + /json/new 建 tab）
- [x] M2.2 推特：拦截 HomeTimeline GraphQL，产出含 created_at/media/引用结构的 Message
- [x] M2.3 知乎：页面上下文调 topstory API，产出含封面图的 Message
- [x] M2.4 媒体管道：下载到 data/media/<sha256>，GET /api/v1/media/{hash}，知乎带 referer
- [x] M2.5 verify.sh 扩展，A2/A3/A4 断言通过

## M3 登录闭环

- [x] M3.1 checkAuth：zhihu/me 401、x.com/home 重定向、bilibili/me 检测，写入 Account.status
- [x] M3.2 LoginSession 资源 + QR 子资源（二维码区域截图镜像）
- [x] M3.3 登录成功 → 关 tab → 自动补抓（post-login RefreshWindow）
- [A] M3.4 mock 开关（强制 logged_out）调通流程；真实扫码留给用户验收 → 完成后标 [A] A5

## M4 调度器

- [x] M4.1 30min controller 创建 scheduled RefreshWindow；logged_out 账号跳过并标记
- [x] M4.2 verify.sh 扩展（缩短间隔验证），A6 通过

## M5 网页迁移 + RSS

- [x] M5.1 前端迁 REST（react-query 直调 /api/v1），tRPC 退役
- [x] M5.2 登录状态点 + 未登录横幅 + QR 弹窗 + 手动刷新（watch 进度）
- [x] M5.3 按 window 浏览视图（stats.new）
- [x] M5.4 /rss/{source}.xml + /rss/all.xml，xmllint 校验通过
- [A] M5.5 实现完成后标 [A]：A7（网页人工过一遍）、A8（真实 RSS 阅读器确认）

## 完成条件

verify.sh 全绿（A1-A4, A6, A9）且 A5/A7/A8 均为 [A] awaiting-user → loop 结束，汇报并等用户验收。

## 迭代日志（续）

- 2026-08-15 / litectl V2 生产切换完成 / 经明确授权发布已探针的 V2 系统制品，`refresh.service` 首次启动自动迁移真实 61,466 条旧资源并保留完整旧库备份；V2 库完整性、资源/Status/业务 link/labels 计数、本地与公网 API、真实 Message/Followee/未读/Scheduler/RSS/metrics 均通过。第二次 V2 restart 保持资源和 link 计数、未改写备份。post-cutover 受限完整链继续为 30 unit / 104 断言、11 contracts / 34 断言、类型检查、构建和 `PASS=140 FAIL=0`；部署哈希与恢复事实以 devops SQLite 运维文档为准。

- 2026-08-15 / litectl V2 完成审计 / 补充“已创建 backup 后转换失败”的契约，要求旧库逐字节不变且清理 backup/tmp；受限复跑 litectl V1→V2 并发迁移、备份、生命周期/事件对账和只读 gate 全绿。Refresh 受限完整链为 30 unit / 104 断言、11 litectl contracts / 34 断言、类型检查、生产构建、`PASS=140 FAIL=0`，峰值 522.8MiB。迁移 commit 的业务 service/API 为零 diff，永久存储代码净增约 63 行但移除了等价自研 DDL/版本/索引/校验/写队列，没有触发复杂度停止条件。

- 2026-08-15 / litectl V2 生产切换准备 / 确认生产 `refresh.service` 直接监听 13002，当前 PATH 命中 `/usr/local/bin/litectl`；内存扩展探针证明系统制品仍创建 format 1，而 Maid 已验证制品创建 format 2，因此当前禁止直接重启。unit 显式固定 `LITECTL_BIN=/usr/local/bin/litectl`，Refresh 文档记录自动迁移与复杂度停止条件，实际二进制发布、停机迁移和回滚步骤由 devops SQLite 运维文档负责。真实数据库未修改。

- 2026-08-15 / 真实 FeedSession UI / React 首页不再查询 `/messages?limit=200` 作为 feed：`all` 显式创建知乎/Twitter/B站推荐聚合 generation，单 source 各自复用 session；本地分页耗尽后才触发平台 continuation，失败保留列表并可重试，重开创建新 generation。浏览器只持久化 session name 与 `{messageName, offset}`，硬刷新直接读取非零 offset 的有界窗口并恢复同一首个可见 Message；连续 feed 移除会破坏发布顺序的时间/未读重排。新增真实 updates API，以 source membership、未发布集合和 lastSeen RefreshWindow 时间计算。隔离 CDP 验证 StrictMode 单创建、触底、复用、重开及 390px 无溢出；30 unit、10 litectl contracts、受限 `PASS=140 FAIL=0`。

- 2026-08-15 / FeedSession 消息分页 / `GET /feedsessions/{name}/messages` 新增稳定的 append-only `offset + limit` 契约，默认 50、上限 200，返回 `total` 和 `nextOffset`。仍复用已测得 100k refs 为 56.6ms 的 typed immutable-page 顺序派生，不为当前没有证据的读瓶颈新增 litectl SQL/索引抽象。跨进程 continuation 追加后旧 offset 仍读取同一位置，受限验收 `PASS=139 FAIL=0`。

- 2026-08-15 / B 站个性化推荐 continuation / 新增独立 `bilibili-main-recommend`，在已登录页面上下文调用首页个性化推荐 API，只持久化经结构校验的四个 fresh counters，不保存 WBI 签名、认证 header 或 `last_showlist`。cursor 绑定 capability 并校验 `(n,n,n,3n+1)` 序列；mockup 不再把热门别名成推荐。受限真实只读 probe 取得 10→9 个有效 BVID、相邻页重叠 0，cursor 正确推进，未打开 Refresh 数据库。

- 2026-08-15 / 确定性跨源 FeedSession / `POST /feedsessions` 新增互斥的显式 `sources` 输入；FeedSession Status 保存各源 O(1) cursor，AggregateFeedPage 保存最终发布顺序，FeedSourcePage 强关联 session / aggregate page / 独立 RefreshWindow 并保留完整 source membership。v1 ranker 按请求 source 顺序 round-robin，单源 fetch 失败不推进其 cursor 且不阻断其他源，全部 fetch 失败不提交；archive 或 adapter 契约错误不降级。跨进程 mock 验证恢复两个 source cursor 后继续成功，HTTP 不暴露嵌套 cursor，`PASS=133 FAIL=0`。B 站热门没有被别名成个性化推荐。

- 2026-08-15 / FeedSession 十万量级顺序模型 / 受限 litectl V2 基准显示，把 100k refs 放进可变 Status 会在每次追加时重写 2.30 MiB JSON，中位数 160.7ms，并让数据库增长 5.18 MiB；因此删除 `orderedMessageRefs`，改为按 `page-of` 强 link 读取 immutable FeedPage、按 ordinal 校验并以首次出现规则派生顺序。100k refs / 5,000 pages 的完整读取与派生中位数 56.6ms，不在写入时复制历史。SQL 只在 ResourceStore facade 的通用 link 查询内，业务 service 保持 typed page 抽象；118 项受限验收全绿。

- 2026-08-15 / Twitter 真实 continuation / 替换不可跨进程恢复的 DOM 滚动采集：每次打开 x.com 后捕获当前 HomeTimeline/HomeLatestTimeline GraphQL GET 或 POST 模板，在同 tab 内注入持久化 bottom cursor 重放；临时 authorization/CSRF/transaction headers 不落盘。纯 payload 遍历器覆盖完整响应、跨响应去重、capability 绑定和损坏 payload；旧 RefreshWindow fetch 保持 count 上限。受限真实只读 probe：recommend 35→35（重叠 0），following 42→40（平台重复 2，session 发布层去重），均产生后续 cursor，未写数据库。

- 2026-08-15 / 知乎真实 continuation / recommend/follow 共用纯分页遍历器与 CDP loader，持久化经校验的 `paging.next` 相对 URL；cursor 绑定 capability，拒绝外部 origin、错误 API path 和损坏结构。广告过滤与 feed_group 拆分由新旧抓取共用，完整上游页不截断。受限真实只读 probe：recommend 6→6、follow 14→18，head/next 规范化 ref 重叠均为 0，未写数据库。

- 2026-08-15 / B 站真实 continuation / 将 B 站 CDP adapter 拆为纯分页遍历器与页面上下文 loader，follow cursor 持久化 offset，popular cursor 持久化下一页号；逻辑 page 始终保留完整上游页，`count` 是目标量而非截断上限，避免游标推进后丢弃页尾。损坏/跨 capability cursor 明确失败，旧 RefreshWindow fetch 仍保持 count 上限。受限真实只读 probe：follow 21→20、popular 20→20，head/next 规范化 ref 重叠均为 0，未写数据库。

- 2026-08-15 / FeedSession 单 source continuation / 在 litectl V2 ResourceStore 上新增 `FeedSession` + 独立 Status、不可变 `FeedPage`，由声明式 reference 自动物化 `page-of` / `page-window` link。新增 restart/page/messages API，平台 cursor 不出 HTTP；fetch/archive 失败不推进状态，跨页去重但保留完整 page membership，同 session 并发请求明确拒绝。mock 纵切跨进程重启后继续成功，真实平台 adapter 暂明确返回 501。受限 verify `PASS=118 FAIL=0`，CPU 3.524s、峰值 210.3MiB。

- 2026-08-15 / litectl V2 ResourceStore / 用 litectl V2 替换 750 行自研 SQLite runtime，public PascalCase kind 与 inline status 保持不变，facade 在单事务内拆装 lower-case subject + 独立业务 Status，并物化 window item/overlay link。旧 `refresh.db` 首次启动自动全量转换、逐资源对账、保留备份后原子替换。真实 61,466 资源副本迁移为 92,408 个 V2 资源，单核 36.6s、峰值 1.7GiB，integrity check 与真实数据短启动通过；发现并在 litectl 底层修复浮点 round-trip 导致的 raw 漂移。verify 105 断言全绿，真实数据库未切换。

- 2026-07-14 / 首页虚拟列表 / 首三张卡片的第一张内容图改为 `eager/high`，其余图片保持 `lazy/auto`；列表模式接入 `react-virtuoso@4.18.10`，由成熟库处理动态卡片高度、图片加载后的重测量和滚动窗口，grid 瀑布流保持原实现。线上探针仍取 200 条消息，但桌面/移动端只挂载 2-4 张卡片；OpenObserve 精确 probe 对比中，reload data-to-next-paint 从 361.1ms 降到 19.5ms，LCP 从 536ms 降到 240ms，105 项 verify 全绿。

- 2026-07-14 / LCP attribution 观测 / 前端新增 `web-vitals/attribution`，把 LCP 拆成 TTFB、resource load delay、resource load duration、element render delay 上报到 OpenObserve `refresh_perf` 日志；同时上报 FCP/TTFB/CLS/INP attribution。`ProgressiveImage` 增加 `data-perf-target` 与 `progressive_image.loaded` 聚合样本，区分 `message.grid_cover`、`message.list_media`、`message.author_avatar`、`followee.avatar` 等目标，后续可直接用 OpenObserve 判断 LCP 具体耗时归因。

- 2026-07-14 / 渐进式图片加载 / 媒体管道新增 `sharp` 变体生成与 `/api/v1/media-variants/:variant/:file`，对原图保留内容寻址 immutable 语义；API 返回 `presentation.placeholder` + `variants`，前端新增 `ProgressiveImage`，列表/网格媒体、作者头像、关注人头像改用 LQIP/skeleton + `srcSet/sizes`，全尺寸预览继续拉原图。verify 新增 WebP 变体断言，105 断言全绿。

- 2026-07-14 / OpenObserve 接入 / 前端自研 `/api/v1/rum` 退役，改用 `@openobserve/browser-rum` + `@openobserve/browser-logs` 直连 `https://openobserve.k2.woodgear.me`，启用 resources/long tasks/user interactions/session replay 和 W3C `traceparent` 注入；后端新增 `server/tracing.ts`，用 `@hono/otel` + OTLP HTTP exporter 发 Hono request spans 到本机 collector (`127.0.0.1:4318/v1/traces`)。`/api/v1/observability` 和 `/metrics` 保留为本地摘要/Prometheus scrape。verify 102 断言全绿。

- 2026-06-11 / 公网部署配置 / scripts/start-k2-tmux.sh 移除具体公网域名默认值，改为必填 REFRESH_PUBLIC_URL；README 整理项目用途、隐私边界、部署方式和 Chrome 启动说明；.gitignore 补充 .env*，准备将 repo 公开。

- 2026-06-11 / 推特中继登录 / login.ts 将推特 LoginSession 从 window 提示改为 password 中继模式: 服务端经 CDP 识别当前可见输入框(账号/密码/2FA 等), 前端渲染同一步表单并 POST /loginsessions/{id}/input 代填提交; 适配 x.com 当前 onboarding 登录页的隐藏 password 镜像和非 button “继续”。verify 新增推特 mock 两步中继断言, 81 断言全绿。

- 2026-06-11 / B站接入 / 架构通用性验证成功: 新增 cdp-bilibili.ts(动态流 polymer API + 热门 popular API,页面上下文 fetch) + normalizeBilibili(popular/dynamic 两形态,AV 用 bvid 命名与热门自动多源归属,封面图只取 cover 不采视频) + config/auth(nav API)/login(passport QR)/前端注册,其余全复用。坑: polymer pub_ts 是数字字符串。verify 67 断言全绿,实测两源各15条 Succeeded,封面/头像本地化,RSS 合法。

- 2026-06-10 / 日志落盘 / logger.ts: stdout + data/logs/radar-YYYY-MM-DD.log 按天滚动; RefreshWindow 执行日志双写(watch SSE+文件,scope=window名); scheduler/auth/index/login 全部走 rlog。GET /api/v1/logs(dates+tail)。UI 新增管理页(账号状态+重新检测+日志实时 tail/日期切换/跟随最新),侧栏 console 移除。verify 49 断言全绿。

（每轮迭代在此追加一行：日期 / 完成项 / 备注）

- 2026-06-10 / M5 / rss.ts(/rss/{source}.xml+all.xml, CDATA+媒体绝对地址, 正文内图也本地化重写) 前端整体迁REST(api/radar.ts hooks; Sidebar状态点+按源刷新+SSE日志; MessageCard头像/图/引用/转推/展开全文; LoginBanner QR弹窗3s镜像+2s轮询; windows浏览视图) tRPC/旧fetch.sh/server trpc.ts全部退役。启动预热checkAuth(RADAR_AUTH_PRECHECK)。UI经受管Chrome截图自检OK。verify 47断言全绿。A7/A8标[A]待用户验收。
- 2026-06-10 / M4 / scheduler.ts: 30min(RADAR_SCHEDULE_INTERVAL_MS可覆盖)每轮先checkAuth,ok账号按源串行创建scheduled window(waitWindowDone防并发tab),logged_out跳过;轮间互斥。RADAR_AUTH_MOCK新增ok档。verify 41断言全绿(A6: 登出跳过+周期创建)。
- 2026-06-10 / M3.1-M3.4 / auth.ts(checkAuth: zhihu /api/v4/me、twitter /home重定向、RADAR_AUTH_MOCK开关) login.ts(LoginSession: 知乎qr/推特window、QR区域截图镜像、TTL 10min、成功→关tab→翻状态→post-login补抓全源)。verify 38断言全绿(含mock登录闭环)。实测已登录态: 创建session即Succeeded并触发补抓。zhihu/follow adapter不稳→该源也切CDP(moments API,同schema)。真实扫码A5留用户验收[A]。
- 2026-06-10 / M2.1-M2.5 / cdp.ts(WS会话+自愈) cdp-twitter.ts(HomeTimeline/HomeLatestTimeline拦截,去广告,转推/引用结构) cdp-zhihu.ts(topstory API分页,自带全文content=天然hydrated) normalize 支持两代schema media.ts(sha256本地化+manifest+知乎referer+直连失败走代理RADAR_PROXY默认7890,Bun不读系统代理) /api/v1/media/{file}。实测: 两平台各15条 Succeeded,知乎封面/头像/推特图全部本地化,created_at齐。verify 31断言全绿。
- 2026-06-10 / M1.2-M1.6 / config.ts(账号/源注册表) normalize.ts(raw→spec,容忍缺字段) resources.ts(索引+selector) fetcher.ts(bb-browser/mock) refresh.ts(统一触发,Pending→Running→终态,watch事件) api.ts(REST信封) 挂入 index.ts(PORT 可配)。verify.sh 25 断言全绿(A1/A9+mock A2+重启持久性)。M1.6 决定: 52 个旧文件包装为 window 档案迁入(scripts/migrate-legacy.ts,幂等),原文件保留供旧 UI,M5 后删;真实数据索引 327 msgs/192 authors。
- 2026-06-10 / M1.1 / server/store.ts：window 档案（appendWindow 重名拒绝、updateWindowStatus 仅推进 status）+ overlay（浅合并、null 删 key、applyOverlay）+ 原子写；冒烟断言全过。RADAR_DATA_DIR 可覆盖供测试用。
