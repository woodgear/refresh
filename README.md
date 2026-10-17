# Refresh

Refresh 是一个自托管的个人账号 feed API：用你自己的浏览器登录态，把 X/Twitter、知乎、B 站推给你的内容采集成结构化资源，再通过网页、RSS 和 JSON API 消费。

它不是多用户托管服务，也不内置第三方账号凭据。登录态、抓取到的内容、媒体缓存和日志都属于本机运行态数据，不提交到仓库。

## 它做什么

- 通过 Chrome DevTools Protocol 操控一个独立的 Chrome profile。
- 使用你自己的登录态抓取平台推荐流：
  - X/Twitter home timeline GraphQL 响应
  - 知乎 topstory / moments API
  - B 站动态流 / 热门 API
- 每次抓取保存为不可变的 `RefreshWindow` 档案。
- 提供持久化 `FeedSession` / `FeedPage` API；当前已完成 mock continuation 纵切，真实平台 cursor adapter 仍在实现中。
- 将内容归一化为 `Message` / `Author` / `Account` 等 k8s 风格资源。
- 提供 React 阅读界面：按源过滤、未读追踪、登录恢复、手动刷新。
- 提供 RSS：`/rss/<source>.xml` 和 `/rss/all.xml`。
- 图片会本地化到 `data/media`，方便 RSS 阅读器稳定回源。

## 隐私边界

仓库只放应用代码。以下运行态路径已被 git 忽略：

- `profiles/`：Chrome profile、cookies、登录态
- `data/`：抓取内容、媒体、overlay、调度器状态、日志
- `.env` / `.env.*`：本地部署配置

公开仓库前不要把运行态目录、截图、导出的 cookie、本地环境变量文件或真实数据样例提交进来。

## 本地运行

依赖：

- Bun
- pnpm
- litectl（必须导出 storage format V2 扩展）
- Chrome / Chromium
- `jq`、`xmllint`（用于 `verify.sh`）

启动：

```bash
pnpm install
pnpm start
```

后端默认执行 PATH 中的 `litectl extension extract`。需要使用指定制品时设置 `LITECTL_BIN=/path/to/litectl`；旧扩展会在打开数据库前因 format version 不匹配而明确失败。

已有自研 SQLite `data/refresh.db` 会在首次 V2 启动时自动迁移。迁移先全量转换并对账，再原子替换主库，并保留 `data/refresh.db.pre-litectl-v2.sqlite`。迁移期间必须停止旧 Refresh writer。

默认地址：

- 后端 API：`http://localhost:3001`
- 前端网页：`http://localhost:5173`

首次使用时打开 `http://localhost:5173`。如果账号未登录，页面会提示登录；登录过程发生在受管 Chrome profile（默认 `profiles/main`）里。

## Chrome 启动与登录态

Refresh 不依赖外部浏览器自动化服务。后端需要访问平台时，会先检查本机 CDP：

```text
http://127.0.0.1:${RADAR_CDP_PORT}/json/version
```

如果 CDP 不可用，后端会自动拉起一个有窗口的 Chrome / Chromium：

- CDP 只监听本机 `127.0.0.1`。
- 默认 CDP 端口是 `19223`，可用 `RADAR_CDP_PORT` 修改。
- 默认 profile 是 `profiles/main`，可用 `RADAR_PROFILE_DIR` 修改。
- Chrome 路径会自动探测；找不到时用 `RADAR_CHROME_BIN` 指定。
- 启动参数包含 `--remote-debugging-port` 和 `--user-data-dir`，因此登录态会持久化在 profile 目录里。

登录、扫码和抓取都使用这个同一个 profile。不要把 `profiles/` 提交到仓库。

Linux 服务器部署时需要有可用的图形桌面会话，因为平台登录通常需要可见窗口。`scripts/start-k2-tmux.sh` 会在 tmux 进程里补齐常见桌面环境变量：

- `XDG_RUNTIME_DIR`
- `WAYLAND_DISPLAY`
- `DISPLAY`
- `DBUS_SESSION_BUS_ADDRESS`

如果检测到 `WAYLAND_DISPLAY`，后端启动 Chrome 时会默认追加 `--ozone-platform=wayland`。需要强制指定时可以设置：

```bash
export RADAR_CHROME_OZONE_PLATFORM=wayland
```

## 验证

```bash
bunx tsc --noEmit
./verify.sh
```

`verify.sh` 使用隔离的 mock 数据，不依赖真实平台登录态。

Continuation API：

```text
POST /api/v1/feedsessions
GET  /api/v1/feedsessions/{name}
GET  /api/v1/feedsessions/{name}/messages?offset=0&limit=50
GET  /api/v1/feedsessions/{name}/updates
POST /api/v1/feedsessions/{name}/pages
```

创建单 source session 时提交 `{"spec":{"source":"zhihu-main-recommend","count":20}}`；聚合 session 提交显式有序列表，例如 `{"spec":{"sources":["zhihu-main-recommend","twitter-main-recommend"],"count":20}}`。聚合 v1 按 source 顺序确定性交错，单源 fetch 失败不推进该源 cursor，其他源仍可提交。

客户端按 session 名继续，不接触平台原始 cursor。当前注册的知乎、B 站和 Twitter source 均已支持真实 continuation；未来未实现的平台或 capability 会明确返回 `501`，不会退化成从头抓取。B 站热门与登录首页个性化推荐分别注册为 `bilibili-main-popular` 和 `bilibili-main-recommend`，不互相别名。
FeedSession 只保存 O(1) continuation 状态；消息顺序由关联的不可变 FeedPage / AggregateFeedPage 按 ordinal 派生，避免长 session 在每次追加时重写全部历史。
消息读取返回稳定的 append-only offset 分页以及 `total` / `nextOffset`；`limit` 默认为 50、最大 200。
网页首页直接消费这些接口：“为你推荐”使用知乎、Twitter、B 站的显式推荐 source 列表；接近底部时先读本地分页，再继续平台 cursor。每个 feed 的 session 名和 `{messageName, offset}` 阅读位置保存在浏览器本地，重载时直接读取该 offset 的有界窗口；重新开始会创建新 generation，后台归档的新内容通过真实 updates 计数提示。

## 部署

Refresh 运行两个进程：

- 后端：`bun server/index.ts`
- 前端/Vite 反代：`bunx vite`

公网部署时，把公网地址放进环境变量，然后用反向代理或 tunnel 暴露 Vite 端口。

示例：

```bash
export REFRESH_PUBLIC_URL="https://refresh.example.com"
export SERVER_PORT=13001
export WEB_PORT=13002

scripts/start-k2-tmux.sh
```

`scripts/start-k2-tmux.sh` 会：

- 在 tmux session 中启动后端和前端；
- 用 `REFRESH_PUBLIC_URL` 设置 `RADAR_BASE_URL`，保证 RSS 里的媒体地址能回源；
- 从 `REFRESH_PUBLIC_URL` 推导 Vite allowed host；
- 将进程日志写入 `data/logs/`。

公网代理或 tunnel 指向：

```text
http://127.0.0.1:${WEB_PORT}
```

后端通过 Vite proxy 访问，因此通常只需要暴露 Web 端口。

## 常用环境变量

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `PORT` | 后端端口 | `3001` |
| `RADAR_DATA_DIR` | 数据根目录 | `./data` |
| `LITECTL_BIN` | 导出 litectl V2 SQLite 扩展的二进制 | `litectl` |
| `RADAR_BASE_URL` | RSS 媒体绝对地址 | `http://localhost:$PORT` |
| `RADAR_CDP_PORT` | 受管 Chrome CDP 端口 | `19223` |
| `RADAR_PROFILE_DIR` | 受管 Chrome profile 目录 | `./profiles/main` |
| `RADAR_CHROME_BIN` | Chrome 可执行文件 | 自动探测 |
| `RADAR_CHROME_OZONE_PLATFORM` | Chrome Ozone 平台，例如 `wayland` | 检测到 `WAYLAND_DISPLAY` 时为 `wayland` |
| `RADAR_CHROME_HEADLESS` | 自管 Chrome 是否使用 headless CDP（服务器默认 `1`；可见登录时设为 `0`） | `0` |
| `RADAR_PROXY` | 媒体下载代理 | `http://127.0.0.1:7890` |
| `REFRESH_API_TARGET` | Vite 反代的后端地址 | `http://localhost:3001` |
| `REFRESH_ALLOWED_HOSTS` | Vite 允许访问的 host，逗号分隔 | 未设置 |
| `REFRESH_PUBLIC_URL` | 公网部署 URL，供 `scripts/start-k2-tmux.sh` 使用 | 脚本必填 |

## 文档

| 文件 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 当前架构、约定、API 速查、常见任务操作手册 |
| [docs/design.md](docs/design.md) | 原始设计蓝图和设计取舍 |
| [docs/feed-continuation-and-aggregation.md](docs/feed-continuation-and-aggregation.md) | 获取更多、重新开始、跨平台聚合与 mockup 交接 |
| [docs/progress.md](docs/progress.md) | 实施日志、踩坑记录和后续候选项 |
