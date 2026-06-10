# Radar 实施进度

> loop 每轮迭代读取此文件，取第一个未完成项推进；完成后更新状态并 commit。
> 设计蓝图见 docs/design.md（以其为准）。状态: [ ] 未开始 / [~] 进行中 / [x] 完成 / [A] awaiting-user

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

- [ ] M4.1 30min controller 创建 scheduled RefreshWindow；logged_out 账号跳过并标记
- [ ] M4.2 verify.sh 扩展（缩短间隔验证），A6 通过

## M5 网页迁移 + RSS

- [ ] M5.1 前端迁 REST（react-query 直调 /api/v1），tRPC 退役
- [ ] M5.2 登录状态点 + 未登录横幅 + QR 弹窗 + 手动刷新（watch 进度）
- [ ] M5.3 按 window 浏览视图（stats.new）
- [ ] M5.4 /rss/{source}.xml + /rss/all.xml，xmllint 校验通过
- [ ] M5.5 实现完成后标 [A]：A7（网页人工过一遍）、A8（真实 RSS 阅读器确认）

## 完成条件

verify.sh 全绿（A1-A4, A6, A9）且 A5/A7/A8 均为 [A] awaiting-user → loop 结束，汇报并等用户验收。

## 迭代日志

（每轮迭代在此追加一行：日期 / 完成项 / 备注）

- 2026-06-10 / M3.1-M3.4 / auth.ts(checkAuth: zhihu /api/v4/me、twitter /home重定向、RADAR_AUTH_MOCK开关) login.ts(LoginSession: 知乎qr/推特window、QR区域截图镜像、TTL 10min、成功→关tab→翻状态→post-login补抓全源)。verify 38断言全绿(含mock登录闭环)。实测已登录态: 创建session即Succeeded并触发补抓。zhihu/follow adapter不稳→该源也切CDP(moments API,同schema)。真实扫码A5留用户验收[A]。
- 2026-06-10 / M2.1-M2.5 / cdp.ts(WS会话+自愈) cdp-twitter.ts(HomeTimeline/HomeLatestTimeline拦截,去广告,转推/引用结构) cdp-zhihu.ts(topstory API分页,自带全文content=天然hydrated) normalize 支持两代schema media.ts(sha256本地化+manifest+知乎referer+直连失败走代理RADAR_PROXY默认7890,Bun不读系统代理) /api/v1/media/{file}。实测: 两平台各15条 Succeeded,知乎封面/头像/推特图全部本地化,created_at齐。verify 31断言全绿。
- 2026-06-10 / M1.2-M1.6 / config.ts(账号/源注册表) normalize.ts(raw→spec,容忍缺字段) resources.ts(索引+selector) fetcher.ts(bb-browser/mock) refresh.ts(统一触发,Pending→Running→终态,watch事件) api.ts(REST信封) 挂入 index.ts(PORT 可配)。verify.sh 25 断言全绿(A1/A9+mock A2+重启持久性)。M1.6 决定: 52 个旧文件包装为 window 档案迁入(scripts/migrate-legacy.ts,幂等),原文件保留供旧 UI,M5 后删;真实数据索引 327 msgs/192 authors。
- 2026-06-10 / M1.1 / server/store.ts：window 档案（appendWindow 重名拒绝、updateWindowStatus 仅推进 status）+ overlay（浅合并、null 删 key、applyOverlay）+ 原子写；冒烟断言全过。RADAR_DATA_DIR 可覆盖供测试用。
