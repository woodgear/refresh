# Radar 项目架构文档

## 项目概述

**Radar (信息雷达)** 是一个社交媒体信息流聚合 Web 应用，从 Twitter 和知乎获取"关注"和"推荐"内容，以卡片式界面统一展示。

## 技术栈

### 前端
- **框架**: React 18 + TypeScript 5.6
- **构建工具**: Vite 5.4
- **路由**: TanStack Router 1.59 (文件系统路由)
- **数据获取**: TanStack Query 5.59
- **状态管理**: Zustand 5.0
- **样式**: Tailwind CSS 3.4 + shadcn/ui (基于 Radix UI)
- **图标**: Lucide React

### 后端
- **运行时**: Bun
- **框架**: Hono
- **端口**: 3001

## 目录结构

```
radar/
├── src/                        # 前端源码
│   ├── main.tsx                # React 应用入口
│   ├── App.tsx                 # 根组件 (配置 Query + Router)
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
│   │   └── uiStore.ts          # UI 状态 (activeSource)
│   │
│   ├── styles/
│   │   └── globals.css         # 全局样式和 CSS 变量
│   │
│   └── types/
│       └── index.ts            # 核心类型定义
│
├── server/
│   └── index.ts                # Hono API 服务器
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
│     TanStack Query (服务端状态) + Zustand (UI 状态)          │
├─────────────────────────────────────────────────────────────┤
│                   API 客户端层 (API)                         │
│              api/client.ts → fetchFeed()                    │
├─────────────────────────────────────────────────────────────┤
│                    后端服务 (Server)                         │
│              Hono Server (localhost:3001)                   │
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

### API 端点 (`server/index.ts`)

| 端点 | 说明 |
|------|------|
| `GET /api/twitter/following` | Twitter 关注列表 |
| `GET /api/twitter/recommend` | Twitter 推荐内容 |
| `GET /api/zhihu/follow` | 知乎关注列表 |
| `GET /api/zhihu/recommend` | 知乎推荐内容 |

### 状态管理 (`src/stores/uiStore.ts`)

```typescript
interface UIStore {
  activeSource: FeedSource
  setActiveSource: (source: FeedSource) => void
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
┌─────────────┐     read      ┌─────────────┐
│   前端 UI    │ <──────────── │  data/*.json │
│             │               │  静态文件    │
└──────┬──────┘               └─────────────┘
       │ fetch                     ^
       v                           │ read
┌─────────────┐              ┌─────┴───────┐
│ api/client  │ ──────────── │    Hono     │
│ fetchFeed() │   HTTP       │   Server    │
└─────────────┘              │  :3001      │
       │                     └─────────────┘
       v useQuery
┌─────────────┐
│  uiStore    │ Zustand
│activeSource │
└──────┬──────┘
       │ 状态更新
       v
┌─────────────┐
│ MessageCard │ 渲染消息列表
└─────────────┘
```

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
2. 在 `server/index.ts` 添加新的 API 端点
3. 在 `src/api/client.ts` 添加数据转换逻辑
4. 在 `src/components/Sidebar.tsx` 添加导航项
5. 更新 `fetch.sh` 添加数据采集逻辑

### 添加新页面

1. 在 `src/routes/` 创建新的路由文件 (如 `about.tsx`)
2. 运行 `pnpm dev` 自动生成路由树
3. 在 `Sidebar.tsx` 添加导航链接
