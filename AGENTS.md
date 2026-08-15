# Refresh — AGENTS 指南

**Refresh（原代号 radar）是一个"我的账号能力" API 服务**：用用户自己的登录态，把知乎/推特/B站推给 TA 的内容变成结构化、可编程消费的资源（k8s 风格）。网页和 RSS 都只是这个 API 的消费者。

四份文档的分工：
- **本文件**：当前架构、约定、常见任务的操作手册 —— 在这个 repo 干活先读这个；
- **docs/design.md**：原始设计蓝图（2026-06-10 定稿），讲清了每个设计决策的"为什么"，模型层面仍然有效；
- **docs/feed-continuation-and-aggregation.md**：获取更多、重新开始、跨平台聚合 feed 与 mockup 的交接真源；
- **docs/progress.md**：实施日志，每轮迭代的记录（含踩过的坑），查"这件事当时为什么这么做"用。

## 快速上手

```bash
pnpm install
pnpm start        # 后端(bun, :3001) + 前端(vite, :5173)，均监听 0.0.0.0
pnpm server       # 仅后端
./verify.sh       # 验收冒烟（105 断言，全 mock 隔离环境，~25s）——改完必跑，全绿才算完
bunx tsc --noEmit # 类型检查（vite build 不做类型检查）
```

本机需要安装 litectl V2；后端启动时通过 `litectl extension extract` 加载同一份 SQLite 扩展，并明确校验 storage format 2。依赖真实环境的部分：自管 Chrome（首次用时自动拉起，独立 profile 在 `profiles/main`，CDP 127.0.0.1:19223）里要有三个平台的登录态——掉登录会在网页上引导扫码。verify.sh 不需要真实登录态（全 mock）。

## 架构与文件地图

```
server/
  index.ts        # Hono 入口：/api/v1 + /rss；启动时建索引、预热登录态、起调度器
  config.ts       # 账号/源注册表（ACCOUNTS / SOURCES，account × capability）
  store.ts        # 业务存储原语：不可变 window 档案 + 可变 overlay
  resource-store.ts          # litectl-backed ResourceStore 与业务存储 helper
  resource-definitions.ts    # public kind → storage kind、schema、Status kind
  litectl-resource-facade.ts # public 信封与 subject/Status/link 的原子拆装
  litectl-migration.ts       # 旧自研 SQLite ResourceStore → litectl V2 一次性迁移
  resources.ts    # 内存索引（Message/Author/Window）、labelSelector 查询、未读计数
  normalize.ts    # raw → spec（每平台一个 normalizer，新旧 schema 都容忍）
  refresh.ts      # RefreshWindow 执行器：统一抓取入口，Pending→Running→终态，watch 事件
  fetcher.ts      # CdpFetcher（按平台路由）+ MockFetcher（verify 用）
  cdp.ts          # CDP 最小客户端 + Chrome 自管（找可执行文件、独立 profile、自拉起）
  cdp-twitter.ts  # 拦截 HomeTimeline/HomeLatestTimeline GraphQL 响应
  cdp-zhihu.ts    # 页面上下文调 topstory/moments API（分页）
  cdp-bilibili.ts # 页面上下文调 polymer 动态流 / popular API
  media.ts        # 媒体本地化（sha256+manifest）、直连失败走代理、流式 media-proxy
  auth.ts         # checkAuth（每平台一个检测分支；RADAR_AUTH_MOCK 可 mock）
  login.ts        # LoginSession：知乎/B站扫码镜像、推特中继输入，成功后自动补抓
  scheduler.ts    # 调度 controller：单例资源（GET/PATCH /api/v1/scheduler），落盘可开关
  logger.ts       # rlog(scope, msg)：stdout + data/logs/refresh 按天滚动
  rss.ts          # /rss/{source}.xml 只读视图
  api.ts          # /api/v1 全部路由
src/
  api/radar.ts    # REST 客户端 + react-query hooks + 前端源注册表（与 config.ts 对应）
  stores/uiStore.ts        # UI 偏好（zustand persist：排序/已读/布局等）
  components/Sidebar.tsx   # 源导航+未读badge+登录状态点+每源刷新；移动端做抽屉复用
  components/MessageCard.tsx # 卡片（list/grid 两形态、lightbox、视口自动已读）
  components/LoginBanner.tsx # 未登录横幅 + 扫码弹窗
  components/AdminPage.tsx   # 管理页：账号状态/调度器开关/日志 tail
  routes/index.tsx           # feed（工具条+已读管线）/ 刷新历史 / 管理 三个视图
scripts/migrate-legacy.ts    # 旧 data/*.json → window 档案（幂等，已跑过）
verify.sh                    # 回归套件（也是验收清单的可执行形式）
data/（gitignore）
  refresh.db       # litectl V2：资源、独立 Status、labels、links、events
  refresh.db.pre-litectl-v2.sqlite # 首次自动迁移保留的旧库备份
  media/<sha256>   # 本地化媒体 blob；元数据是 MediaObject 资源
  logs/radar-*.log # 按天滚动日志
```

## 核心约定（动代码前必读）

1. **资源信封**：API 对象都是 `{apiVersion: 'radar/v1', kind, metadata, spec, status}`。
   `radar/v1` 与 `radar/*` annotation 前缀是**内部标识符**，已落在历史档案里，改名需迁移，别轻动。
2. **`spec.raw` 保真**：normalized 字段全部由 raw 派生。改 normalize 逻辑后重启即对全部历史数据生效（索引重建），不需要重抓。
3. **档案不可变 / 用户态走 overlay**：RefreshWindow 与 item 资源只追加；已读、分类 label 等只写 `OverlayEntry`，PATCH 即时生效。overlay 通过 `overlay-for` 强引用目标，文件系统只保存媒体 blob。
4. **统一抓取入口**：一切抓取 = `POST /refreshwindows`（手动/调度/登录后补抓只差 `spec.trigger`）。GET 永远秒回缓存。
5. **多源归属**：同一条内容被多个源推到时，归属是集合（`radar/sources` annotation），`source=` selector 按集合匹配。消息名带平台前缀全局唯一（`twitter-<id>` / `zhihu-<id>` / `bilibili-<bvid>`）。
6. **登录态在自管 Chrome 的 profile 里**（`profiles/main`，gitignore）：抓取/检测/登录引导全走 CDP，零外部工具依赖。
7. **媒体本地化**：图片下载到本地（`/api/v1/media/<hash>`），视频不下载（poster + `media-proxy` 流式代理播放）。直连失败自动走代理（`RADAR_PROXY`，默认 127.0.0.1:7890，Bun 不读系统代理）。

## API 速查

```
GET   /api/v1/messages?labelSelector=source=X&sort=unread-first&unread=true&limit=200
GET   /api/v1/messages?names=a,b,c | ?authorSelector=category=Y
PATCH /api/v1/messages/{name}            # overlay：labels/status（null 删 key）
POST  /api/v1/messages/mark-read         # {names:[...]} 或 {labelSelector:""}
GET   /api/v1/unread-counts
GET|PATCH /api/v1/authors/{name}
GET   /api/v1/accounts[/{name}?check=1]  # check=1 现场检测登录态
POST  /api/v1/loginsessions  GET /loginsessions/{id}[/qr]  POST /loginsessions/{id}/input
POST  /api/v1/refreshwindows  GET /refreshwindows/{name}[?watch=1]   # watch=SSE
GET|PATCH /api/v1/scheduler              # 单例：{spec:{enabled,intervalMs}}
GET   /api/v1/logs?date=&lines=          # 日志 tail
GET   /api/v1/media/{hash}  /api/v1/media-proxy?url=
GET   /rss/{source}.xml  /rss/all.xml
```

## 环境变量

| 变量 | 用途 | 默认 |
|------|------|------|
| `PORT` | 后端端口 | 3001 |
| `RADAR_DATA_DIR` | 数据根目录（测试隔离用） | `./data` |
| `LITECTL_BIN` | 用于导出 V2 SQLite 扩展的 litectl 二进制 | `litectl` |
| `RADAR_FETCHER` | `mock`（verify）/ `bb` / 默认按源路由 | 路由 |
| `RADAR_AUTH_MOCK` | `ok` / `logged_out` 强制登录态 | 真实检测 |
| `RADAR_SCHEDULER` / `RADAR_SCHEDULE_INTERVAL_MS` | 调度初始默认（落盘配置优先） | on / 30min |
| `RADAR_AUTH_PRECHECK` | `off` 跳过启动登录态预热 | on |
| `RADAR_PROXY` | 媒体下载代理 | http://127.0.0.1:7890 |
| `RADAR_BASE_URL` | RSS 内媒体绝对地址（局域网阅读器要设成本机 LAN IP） | http://localhost:PORT |
| `RADAR_CDP_PORT` | 自管 Chrome CDP 端口 | 19223 |
| `RADAR_PROFILE_DIR` | Chrome profile 目录 | `./profiles/main` |
| `RADAR_CHROME_BIN` | Chrome 可执行文件（找不到时手工指定） | 自动探测 |
| `RADAR_CHROME_OZONE_PLATFORM` | Chrome Ozone 平台（如 `wayland`） | 检测到 `WAYLAND_DISPLAY` 时为 `wayland` |
| `REFRESH_API_TARGET` | Vite dev server 反代的后端地址 | http://localhost:3001 |
| `REFRESH_ALLOWED_HOSTS` | Vite dev server 允许访问的公网 host（逗号分隔） | 未设置 |
| `REFRESH_PUBLIC_URL` | `scripts/start-k2-tmux.sh` 公网部署 URL，用于 RSS 回源地址和 Vite host 白名单 | 必填 |

## 常见任务怎么做

**新增平台**（B 站接入实测 ≈ 半天）：
1. `server/cdp-<platform>.ts`：开页面、页面上下文 fetch 或拦截网络响应，返回 raw items；
2. `normalize.ts`：加 normalizer（raw → spec，注意防御性取值，平台经常 number/string 混用）；
3. `config.ts` 加账号+源；`fetcher.ts` 路由分支；`auth.ts` 检测分支；`login.ts` 登录页配置；
4. `src/api/radar.ts` SOURCES + `Sidebar.tsx` platforms 数组；
5. `fetcher.ts` MockFetcher 加 mock 数据 + `verify.sh` 加断言。

**调试一次抓取**：管理页看实时日志，或 `curl -X POST :3001/api/v1/refreshwindows -d '{"spec":{"source":"...","count":5}}'` 然后 `GET /refreshwindows/<name>?watch=1`。

**已知坑**（详见 progress.md 迭代日志）：推特 GraphQL 的 user 字段在 legacy/core 两处都可能出现；知乎 moments 的 feed_advert 要丢、feed_group 要拆；B 站 polymer 的 `pub_ts` 是数字字符串；受管 Chrome 窗口被遮挡时 Chrome 会推迟一切媒体加载（影响验证视频播放）。

## 未做（二期候选）

- `POST /messages/{name}/hydrate`（知乎正文按需补全——topstory 已自带全文，目前需求不强）
- 关注流 fetch-until-overlap（长停机断层保险，平时流速 2 条/h 远低于容量，不急）
- 多账号管理 UI（模型已就绪：Account 资源 + 独立 profile 设计）
- 作者归类 UI / 自动归类 controller（API 已支持：PATCH author label + authorSelector）
- 公网暴露的 `?token=` 鉴权
