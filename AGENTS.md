# Radar 项目架构文档

## 项目概述

**Radar (信息雷达)** 是一个社交媒体信息流聚合 Web 应用，从 Twitter 和知乎获取"关注"和"推荐"内容，以卡片式界面统一展示。

## 技术栈

### 前端
- **框架**: React 18 + TypeScript 5.6
- **构建工具**: Vite 5.4
- **路由**: TanStack Router 1.59 (文件系统路由)
- **数据获取**: TanStack Query 5.59 + tRPC (类型安全 API)
- **状态管理**: Zustand 5.0 (UI 状态 + 实体缓存)
- **样式**: Tailwind CSS 3.4 + shadcn/ui (基于 Radix UI)
- **图标**: Lucide React

### 后端
- **运行时**: Bun
- **框架**: Hono + tRPC (类型安全 API)
- **端口**: 3001

## 目录结构

```
radar/
├── src/                        # 前端源码
│   ├── main.tsx                # React 应用入口
│   ├── App.tsx                 # 根组件 (配置 Query + Router + tRPC)
│   ├── routeTree.gen.ts        # 自动生成的路由树
│   │
│   ├── api/
│   │   └── client.ts           # API 客户端，数据获取和转换
│   │
│   ├── components/
│   │   ├── Layout.tsx          # 页面整体布局
│   │   ├── Sidebar.tsx         # 侧边栏导航菜单
│   │   ├── MessageCard.tsx     # 消息卡片展示组件
│   │   └── ui/                 # shadcn/ui 基础组件
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── scroll-area.tsx
│   │       └── separator.tsx
│   │
│   ├── lib/
│   │   └── utils.ts            # 工具函数 (cn 类名合并)
│   │
│   ├── routes/
│   │   ├── __root.tsx          # 根路由 (布局包装)
│   │   └── index.tsx           # 首页路由 (Feed 页面)
│   │
│   ├── stores/
│   │   ├── uiStore.ts          # UI 状态 (activeSource)
│   │   └── itemStore.ts        # 实体缓存 + refresh action
│   │
│   ├── styles/
│   │   └── globals.css         # 全局样式和 CSS 变量
│   │
│   ├── trpc/
│   │   └── client.ts           # tRPC 客户端配置
│   │
│   └── types/
│       └── index.ts            # 核心类型定义
│
├── server/
│   ├── index.ts                # Hono API 服务器入口
│   └── trpc.ts                 # tRPC 路由定义 (feedList, items)
│
├── data/                       # 静态数据存储
│   ├── twitter-following-*.json
│   ├── twitter-recommend-*.json
│   ├── zhihu-follow-*.json
│   └── zhihu-recommend-*.json
│
├── fetch.sh                    # 数据采集脚本
├── index.html                  # 应用入口 HTML
├── vite.config.ts              # Vite 配置 (API 代理到 3001)
├── tailwind.config.js          # Tailwind CSS 配置
├── tsconfig.json               # TypeScript 配置
└── components.json             # shadcn/ui 配置
```

## 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    展示层 (Presentation)                     │
│     Layout.tsx → Sidebar.tsx → MessageCard.tsx              │
│              shadcn/ui 基础组件                              │
├─────────────────────────────────────────────────────────────┤
│                      路由层 (Routes)                         │
│              TanStack Router (文件系统路由)                  │
│         __root.tsx (布局) → index.tsx (首页)                │
├─────────────────────────────────────────────────────────────┤
│                   状态管理层 (State)                         │
│   Zustand: uiStore (UI状态) + itemStore (实体缓存+actions)  │
├─────────────────────────────────────────────────────────────┤
│                    API 层 (tRPC)                            │
│        feedList (ID列表) + items (批量获取详情)              │
├─────────────────────────────────────────────────────────────┤
│                    后端服务 (Server)                         │
│              Hono + tRPC (localhost:3001)                   │
├─────────────────────────────────────────────────────────────┤
│                      数据层 (Data)                           │
│                 data/*.json (静态文件)                       │
└─────────────────────────────────────────────────────────────┘
```

## 核心模块

### 类型系统 (`src/types/index.ts`)

```typescript
// 数据源类型
type FeedSource = 'twitter-following' | 'twitter-recommend' | 'zhihu-follow' | 'zhihu-recommend'
type FeedCategory = 'twitter' | 'zhihu'

// 消息类型 (discriminated union)
interface TwitterMessage {
  type: 'twitter'
  id: string
  content: string
  author: { name: string; handle: string; avatar: string }
  // ...
}

interface ZhihuMessage {
  type: 'zhihu'
  id: string
  title: string
  excerpt: string
  author: { name: string; avatar: string }
  // ...
}

type Message = TwitterMessage | ZhihuMessage
```

### tRPC 端点 (`server/trpc.ts`)

| 端点 | 说明 |
|------|------|
| `feedList({ source })` | 获取 feed 的 ID 列表（已按时间排序） |
| `items({ ids })` | 批量获取 items 详情（全局查找，自动去重） |
| `feed({ source })` | 兼容旧接口，返回完整数据 |
| `meta()` | 获取数据源元信息 |
| `refresh()` | 手动刷新缓存 |

### 状态管理 (`src/stores/`)

**uiStore.ts** - UI 状态
```typescript
interface UIStore {
  activeSource: FeedSource
  setActiveSource: (source: FeedSource) => void
}
```

**itemStore.ts** - 实体缓存 + 数据获取 action
```typescript
interface ItemStore {
  // State
  items: Map<string, any>    // normalized entity cache
  ids: string[]              // 当前显示的 ID 列表（保持顺序）
  fetchedAt: string | null   // 最新抓取时间
  isLoading: boolean
  error: Error | null

  // Actions
  refresh: (sourceOrCategory: string) => Promise<void>
  getMissingIds: (ids: string[]) => string[]
}
```

## 数据流

```
┌─────────────┐   bb-browser   ┌─────────────┐
│  Twitter    │ ────────────── │  fetch.sh   │
│  知乎       │                │  数据采集    │
└─────────────┘                └──────┬──────┘
                                      │ 保存
                                      v
                              ┌─────────────┐
                              │  data/*.json │
                              │  静态文件    │
                              └──────┬──────┘
                                     │ read
                                     v
                              ┌─────────────┐
                              │    Hono     │
                              │  + tRPC     │
                              │   :3001     │
                              └─────────────┘
                                     │ tRPC
                                     v
┌─────────────────────────────────────────────────────────────┐
│                        前端应用                              │
│                                                             │
│  ┌─────────────┐   onClick   ┌──────────────────────────┐  │
│  │   Sidebar   │ ──────────► │ itemStore.refresh()      │  │
│  │             │             │   1. fetch IDs           │  │
│  └─────────────┘             │   2. dedupe              │  │
│                              │   3. bulk fetch          │  │
│                              │   4. update store        │  │
│                              └──────────────────────────┘  │
│                                                             │
│  ┌─────────────┐     subscribe     ┌──────────────────┐   │
│  │  FeedPage   │ ◄──────────────── │    itemStore     │   │
│  │             │                   │  - ids[]         │   │
│  └─────────────┘                   │  - items Map     │   │
│                                    │  - isLoading     │   │
│                                    │  - refresh()     │   │
│                                    └──────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**数据获取流程：**

1. **用户点击**: Sidebar 调用 `itemStore.refresh(source)`
2. **获取 IDs**: `feedList` query 获取排序后的 ID 列表
3. **去重**: 与 `itemStore.items` 对比，过滤出缺失的 IDs
4. **批量获取**: `items` query 批量获取缺失的 items
5. **更新 Store**: 更新 `itemStore.ids` 和 `itemStore.items`
6. **UI 更新**: FeedPage 订阅 store，自动重渲染

## NPM Scripts

```bash
pnpm start    # 同时启动前端 (Vite) 和后端 (Hono)
pnpm dev      # 仅启动前端开发服务器
pnpm build    # 构建生产版本
pnpm server   # 仅启动后端服务器
pnpm fetch    # 执行数据采集脚本
```

## 开发注意事项

1. **路径别名**: `@/*` 映射到 `src/*` (在 tsconfig.json 中配置)
2. **API 代理**: Vite 开发服务器将 `/api` 请求代理到 `localhost:3001`
3. **自动生成**: TanStack Router 自动生成 `routeTree.gen.ts`，不要手动编辑
4. **类型安全**: 使用 `type` 字段作为 discriminated union 区分消息类型

## 扩展指南

### 添加新的数据源

1. 在 `src/types/index.ts` 添加新的 `FeedSource` 类型
2. 在 `server/trpc.ts` 的 `scanAllSources()` 添加新源前缀
3. 在 `src/components/Sidebar.tsx` 添加导航项
4. 更新 `fetch.sh` 添加数据采集逻辑

### 添加新页面

1. 在 `src/routes/` 创建新的路由文件 (如 `about.tsx`)
2. 运行 `pnpm dev` 自动生成路由树
3. 在 `Sidebar.tsx` 添加导航链接

## 架构设计决策

### 为什么用 Zustand 作为实体缓存？

TanStack Query 缓存是基于 query key 的，不是基于实体 ID 的。这意味着：
- `trpc.items.useQuery({ ids: ['1', '2'] })` 和 `trpc.items.useQuery({ ids: ['2'] })` 是两个独立的缓存条目
- 无法自动实现"已获取的 ID 不再请求"

解决方案：使用 Zustand 作为 normalized entity cache，按 ID 存储实体。

### 为什么分离 feedList 和 items 端点？

1. **排序**: 服务端统一按 `created_time > created_at > firstFetchedAt` 排序
2. **缓存**: 前端可以精确控制哪些 ID 需要获取详情
3. **按需加载**: ID 列表轻量，可以快速返回；详情按需批量获取

### 为什么不用 useEffect 触发数据获取？

`useEffect` 用于数据获取是反模式：
- 副作用难以追踪和调试
- 依赖数组容易出错
- 不符合"事件驱动"的理念

更好的方案：**事件驱动** - 用户点击时直接调用 `itemStore.refresh(source)`，状态变化自然触发 UI 更新。

```typescript
// Sidebar.tsx
const handleSourceChange = (source: FeedSource) => {
  setActiveSource(source)  // 更新 UI 状态
  refresh(source)          // 触发数据获取
}
```
