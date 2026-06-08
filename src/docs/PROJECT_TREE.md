# OpenPaw-JS 项目目录树

> 每个文件一行说明，排除 node_modules/.next/out/dist/.git/target 等自动生成目录

---

## 根目录配置

```
openpaw-js/
├── package.json                  -- 项目依赖与脚本
├── vite.config.ts                -- Vite 构建配置
├── tsconfig.json                 -- TypeScript 配置
├── index.html                    -- SPA 入口
├── eslint.config.mjs             -- ESLint 配置
├── next.config.ts                -- Next.js 配置 (逐步废弃)
├── README.md                     -- 项目说明
├── AGENTS.md / CLAUDE.md         -- AI Agent 规则
```

---

## src/ -- 前端源码

### 入口

```
src/
├── main.tsx                      -- React 入口
├── router.tsx                    -- 路由表
├── index.css                     -- 全局 CSS
```

### src/app/ -- Next.js App Router 页面 (逐步迁移到 Vite SPA)

```
src/app/
├── layout.tsx                    -- 根布局
├── page.tsx                      -- 主聊天页面
├── loading.tsx                   -- 路由切换加载动画
├── globals.css                   -- 全局样式: Tailwind, 亮暗主题变量
├── desktop/page.tsx              -- 桌面自动化页面
├── float/page.tsx                -- 浮动助手窗口
├── models/page.tsx               -- 模型提供商配置
├── settings/page.tsx             -- 设置页面
├── skills/page.tsx               -- 技能浏览页面
├── web/page.tsx                  -- Web 自动化页面
```

### src/pages/ -- Vite SPA 页面

```
src/pages/
├── chat.tsx                      -- 聊天页
├── desktop.tsx                   -- 桌面自动化页
├── float/                        -- 浮窗模块 (Tauri 悬浮窗口)
│   ├── index.tsx                 -- 主壳：标题栏、tab 栏、模式路由
│   ├── utils.ts                  -- localStorage 工具函数
│   ├── types.ts                  -- 浮窗类型定义
│   ├── chat-mode.tsx             -- Chat 模式：LLM 流式对话
│   ├── task-mode.tsx             -- Task 模式：桌面自动化执行
│   ├── watcher-mode.tsx          -- Watcher 模式：屏幕监控
│   └── learn-mode.tsx            -- Learn 模式：UI 能力学习
├── web.tsx                       -- Web 自动化页
├── phone.tsx                     -- 手机控制页 (占位)
├── models.tsx                    -- 模型配置管理
├── skills.tsx                    -- 技能管理
├── settings.tsx                  -- 设置页：主题、语言
├── apps.tsx                      -- 应用页 (占位)
├── watchers.tsx                  -- Watcher 管理页
├── knowledge.tsx                 -- 页面知识库
```

### src/types/ -- 类型定义

```
src/types/
├── index.ts                      -- Barrel 导出
├── message.ts                    -- 消息类型
├── provider.ts                   -- LLM Provider 类型
├── skill.ts                      -- 技能类型
├── events.ts                     -- 事件总线类型
├── goal.ts                       -- 目标解析类型 (once/timer/screen_change)
├── cache.ts                      -- 缓存类型 (UI缓存/子目标缓存/技能模板)
├── scheduler.ts                  -- 调度器类型
├── watcher.ts                    -- Watcher 类型 (监控配置/差异策略/工作流)
├── automation-template.ts        -- 自动化模板类型
├── recording-session.ts          -- 录制会话类型
├── semantic-event.ts             -- 语义事件类型
├── unified-action.ts             -- 统一动作类型
├── unified-data.ts               -- 统一数据类型
├── unified-element.ts            -- 统一元素类型
├── page-component.ts             -- 页面组件类型
```

### src/adapters/ -- LLM 适配器 + 平台适配器

```
src/adapters/
├── types.ts                      -- LLMAdapter 接口
├── openai.ts                     -- OpenAI 适配器
├── anthropic.ts                  -- Anthropic 适配器
├── google.ts                     -- Google Gemini 适配器
├── model-call-service.ts         -- 向后兼容层 (委托到 LlmGateway)
├── platform-adapter.ts           -- 平台适配器接口 + 注册中心
├── dom-adapter.ts                -- 浏览器 DOM 适配器
├── uia-adapter.ts                -- Windows UIA 适配器
├── index.ts                      -- 桶文件
```

### src/agents/ -- Agent API (各 Agent 独立接口，前端直接调用)

```
src/agents/
├── index.ts                      -- Barrel 导出
├── intent-classifier-api.ts      -- IntentClassifierAgent：意图分类
├── verification-api.ts           -- VerificationAgent：任务完成验证 (纯文本 YES/NO)
├── chat-api.ts                   -- ChatAgent：流式聊天 (SSE)
├── code-generation-api.ts        -- CodeGenerationAgent：代码生成/迭代修复 (SSE)
├── ui-vision-api.ts              -- UIVisionAgent：截图视觉分析、语义标注、OCR 分类
├── screen-analysis-api.ts        -- ScreenAnalysisAgent：差异检测、区域发现、工作流分析
```

Agent API 通过 `fetch` 调用后端 `/api/agent/{endpoint}`，后端由 Vite 中间件处理，统一走 `LlmGateway` → 外部模型。

### src/api/ -- 前端 API Client

```
src/api/
├── index.ts                      -- Barrel 导出
├── types.ts                      -- 共享协议类型：AgentEndpoint 枚举、请求/响应/SSE 类型
├── client.ts                     -- fetch 封装：apiPost(非流式)、apiStream(SSE 事件)、apiStreamCompat(兼容旧字符串流)
```

### src/backend/ -- 后端 API Server (Vite 中间件)

```
src/backend/
├── index.ts                      -- Barrel 导出
├── vite-plugin.ts                -- Vite 插件：configureServer 挂载中间件 (ssrLoadModule 加载)
├── middleware.ts                  -- 请求路由：URL → handler 分发 + JSON/SSE 响应
├── handlers.ts                   -- 14 个 Handler：每个 /api/agent/{name} 一个处理函数
├── llm-executor.ts               -- 统一 LLM 调用：executeCall(非流式) / executeStream(流式)，共用 LlmGateway
```

### src/db/ -- 数据库层 (双 SQLite 适配器)

```
src/db/
├── adapter.ts                    -- SQLiteAdapter 接口
├── types.ts                      -- DB 行类型
├── tauri.ts                      -- Tauri 原生 SQLite 适配器
├── wasm.ts                       -- Web SQLite 适配器 (sql.js WASM)
├── index.ts                      -- DB 工厂：平台检测、DDL、迁移
```

### src/stores/ -- Zustand 状态管理

```
src/stores/
├── chat-store.ts                 -- 聊天状态：会话、消息、流式、工具模式
├── settings-store.ts             -- 设置状态：主题、语言、工具偏好
├── model-config-store.ts         -- 模型配置状态：Provider CRUD、API Key 加密
├── skill-store.ts                -- 技能状态：DB CRUD、Markdown 同步
```

### src/skills/ -- 技能系统

```
src/skills/
├── skill.ts                      -- Skill 接口 + 工具格式化辅助
├── executor.ts                   -- SkillExecutor：注册、分发、构建 LLM 工具列表
├── loader.ts                     -- Markdown 技能解析器
├── builtin-executor.ts           -- 内置执行器工厂
├── desktop.ts                    -- 桌面视觉技能：截图、点击、拖拽、键盘、OCR、窗口管理
├── desktop_uia.ts                -- 桌面 UIA 技能：语义元素操作
├── web.ts                        -- Web 自动化技能
├── phone.ts                      -- 手机控制技能
├── app-builder.ts                -- 应用构建器技能
├── office-doc.ts                 -- Office 文档生成技能
├── code-tools.ts                 -- 代码生成与沙箱执行技能
├── user-defined.ts               -- 用户自定义技能 (沙盒 JS / 步骤回放)
```

### src/services/ -- 核心服务

```
src/services/
├── chat-service.ts               -- 聊天服务：LLM 流式编排、工具调用分发
├── desktop-service.ts            -- 桌面服务：Tauri API 封装
├── extension-bridge.ts           -- 浏览器扩展桥：Chrome 扩展通信
├── web-screen-service.ts         -- Web 屏幕服务
├── model-service-singleton.ts    -- 模型服务单例 (LlmGateway)
├── cache-service.ts              -- 缓存服务：L1(UI指纹)/L2(动作序列)/L3(技能模板)
├── cache-service-singleton.ts    -- 缓存服务单例
├── intent-classifier.ts          -- 意图分类器：向后兼容层，委托到 IntentClassifierAgent
├── task-builder.ts               -- 任务构建器
├── agent-task-service.ts         -- Agent 任务服务：顶层编排，分发给 Agent 或调度器

### src/services/llm-gateway/ -- 统一 LLM 调用入口

```
src/services/llm-gateway/
├── gateway.ts                    -- LlmGateway：适配器管理、提示构建、缓存、长度检查、chatStream/callWithTools
```

### src/services/ 续
├── desktop-automation-agent.ts   -- 桌面自动化 Agent：三级流水线 (L3→Plan→PerTurn)
├── web-automation-agent.ts       -- Web 自动化 Agent
├── semantic-annotation-service.ts -- 语义标注服务
├── capability-learner/           -- 能力学习器：自动探索应用 UI 能力
│   ├── index.ts                  -- 主入口：生命周期管理
│   ├── types.ts                  -- 类型定义
│   ├── state.ts                  -- 单例状态
│   ├── detection.ts              -- UIA 差异检测
│   ├── semi-auto.ts              -- 半自动学习
│   ├── browser-learn.ts          -- 受控浏览学习
│   ├── cascade.ts                -- 级联学习
│   ├── browser.ts                -- 浏览器检测
│   ├── vision.ts                 -- 视觉分析
│   ├── inference.ts              -- 能力推断
│   ├── storage.ts                -- 存储操作
│   └── classification.ts         -- LLM 分类
├── skill-agents/                 -- Skill-Agent 模块
│   ├── index.ts                  -- Barrel 导出
│   ├── types.ts                  -- 接口定义
│   └── chatbot-agent.ts          -- 聊天机器人
├── state-machine.ts              -- Agent 状态机
├── recovery-chain.ts             -- 失败恢复链
├── recorder.ts                   -- 自动化录制器
├── event-bus.ts                  -- 全局事件总线
├── app-logger.ts                 -- 应用日志器
├── global-listener.ts            -- 全局输入监听服务
├── unified-analyzer.ts           -- 统一分析器：数据流、坐标模式检测
├── unified-executor.ts           -- 统一执行引擎
├── unified-recorder.ts           -- 统一录制器
├── web-recorder.ts               -- Web 录制器 (Playwright DOM 采集)
├── page-knowledge.ts             -- 页面知识库服务
├── code-gateway.ts               -- 代码生成入口
├── code-sandbox/                 -- 代码沙箱模块
│   ├── sandbox-types.ts          -- 沙箱类型
│   ├── sandbox-js.ts             -- JS 沙箱
│   ├── sandbox-sql.ts            -- SQL 沙箱
│   ├── sandbox-python.ts         -- Python 沙箱
│   ├── python-bridge.ts          -- Python 桥接
│   └── index.ts                  -- 桶文件
├── code-registry/                -- 代码注册表模块
│   ├── code-registry-types.ts    -- 类型
│   ├── code-registry-db.ts       -- DB 操作
│   └── index.ts                  -- 桶文件
├── multi-agent/                  -- 多 Agent 协作模块
│   ├── types.ts                  -- 共享类型
│   ├── task-tree-db.ts           -- 任务树 DB
│   ├── process-log-db.ts         -- 过程日志 DB
│   ├── agent-message-db.ts       -- Agent 消息 DB
│   ├── package-registry-db.ts    -- 包注册表 DB
│   ├── recovery.ts               -- 断点恢复
│   ├── context-builder.ts        -- 上下文构建器
│   ├── agent-runner.ts           -- Agent 运行器
│   ├── orchestrator.ts           -- 编排器
│   └── index.ts                  -- 桶文件
```

### src/services/agent/ -- Agent 子模块

```
src/services/agent/
├── index.ts                      -- Barrel 导出
├── agent-types.ts                -- AgentContext、AgentDeps 等共享类型
├── goal-decomposer.ts            -- 目标分解器 (子目标拆分，当前流水线未使用)
├── plan-executor.ts              -- 计划执行器：LLM 规划 + 验证循环
├── cache-replayer.ts             -- 缓存回放器
├── skill-matcher.ts              -- 技能匹配器 (L3 模板匹配)
├── agent-cache.ts                -- Agent 缓存辅助
├── subgoal-executor.ts           -- 子目标执行器 (当前流水线未使用)
```

### src/services/scheduler/ -- 任务调度器

```
src/services/scheduler/
├── scheduler.ts                  -- TickLoop：1s 通用 tick 循环
├── trigger.ts                    -- Trigger 接口
├── base-watcher.ts               -- BaseWatcher 基类
├── screen-change-watcher.ts      -- 屏幕变化 Watcher
├── screen-change-trigger.ts      -- 屏幕变化触发器
├── timer-watcher.ts              -- 定时 Watcher
├── task-factory.ts               -- 任务工厂 + WatcherConfig 迁移
├── screen-change-source.ts       -- 屏幕变化事件源
├── action-executor.ts            -- 动作执行器
├── event-bridge.ts               -- 事件桥接
├── screen-change-task.ts         -- 屏幕变化任务
├── timer-task.ts                 -- 定时任务
├── watcher-runtime-state.ts      -- Watcher 运行时状态
```

### src/services/watcher/ -- 屏幕监控系统

```
src/services/watcher/
├── index.ts                      -- Barrel 导出
├── watcher-manager.ts            -- WatcherManager 单例
├── diff-detector.ts              -- 多阶段差异检测器
├── region-capture.ts             -- 区域截图
├── region-discovery.ts           -- 自动区域发现
├── region-from-ocr.ts            -- OCR 区域发现
├── region-quality.ts             -- 区域质量追踪
├── uia-compressor.ts             -- UIA 树压缩
├── workflow-recorder.ts          -- 工作流录制器
├── workflow-executor.ts          -- 工作流回放执行器
├── watcher-utils.ts              -- 工具函数
├── logger.ts                     -- 日志
```

### src/interfaces/ -- 服务接口

```
src/interfaces/
├── cache-service.ts              -- ICacheService
├── desktop-service.ts            -- IDesktopService
├── extension-bridge.ts           -- IExtensionBridge
├── model-service.ts              -- IModelService
├── skill-executor.ts             -- ISkillExecutor
├── web-screen-service.ts         -- IWebScreenService
```

### src/core/ -- 核心智能

```
src/core/
├── skill-resolver.ts             -- 目标→技能解析器
├── skill-learner.ts              -- 技能学习器 (L2→L3 提升)
```

### src/utils/ -- 工具函数

```
src/utils/
├── platform.ts                   -- 平台检测
├── content.ts                    -- 消息内容序列化
├── crypto.ts                     -- AES-GCM 加密 (API Key)
├── image.ts                      -- 图片压缩 (CompressedImage)
├── coordinate-scale.ts           -- 坐标转换工具：压缩比例还原、窗口偏移、SVG路径缩放
├── retry.ts                      -- 指数退避重试
├── save-images.ts                -- LLM 图片保存到磁盘
├── multimodal-provider.ts        -- 多模态自动切换
├── svg-path.ts                   -- SVG 路径生成工具
```

### src/i18n/ -- 国际化

```
src/i18n/
├── strings.ts                    -- 翻译字典 (en/zh)
```

### src/config/ -- 配置

```
src/config/
├── system-prompts.json           -- LLM 系统提示 (19 个场景)
```

### src/components/ -- React 组件

```
src/components/
├── app-shell.tsx                 -- 应用外壳
├── app-init.tsx                  -- 应用初始化 (Next.js)
├── app-init-wrapper.tsx          -- 应用初始化 (Vite)
├── error-boundary.tsx            -- 错误边界
├── theme-provider.tsx            -- 主题提供者
├── page-skeleton.tsx             -- 页面骨架
├── model-config-form.tsx         -- 模型配置表单
├── float-window-toggle.tsx       -- 浮窗开关
├── region-selector.tsx           -- 区域选择器
├── watcher-dialog.tsx            -- Watcher 对话框
├── bbox-overlay.tsx              -- 包围框叠加层
├── ui/switch.tsx                 -- Toggle 开关
├── chat/                         -- 聊天组件
│   ├── chat-bubble.tsx           -- 消息气泡
│   ├── markdown-body.tsx         -- Markdown 渲染
│   ├── message-input.tsx         -- 消息输入框
│   ├── model-switcher.tsx        -- 模型切换
│   ├── streaming-text.tsx        -- 流式文本
│   ├── tool-mode-bar.tsx         -- 工具模式栏
│   └── tool-selector-panel.tsx   -- 工具选择面板
├── recorder/                     -- 录制器组件
│   ├── index.tsx                 -- 桶文件
│   ├── recorder-mode.tsx         -- 录制流程控制
│   ├── recorder-panel.tsx        -- 录制面板
│   ├── event-list.tsx            -- 事件列表
│   ├── manual-recorder.tsx       -- 手动录制器
│   └── template-preview.tsx      -- 模板预览
```

### src/docs/ -- 内部文档

```
src/docs/
├── PROJECT_TREE.md               -- 项目目录树 (本文件)
├── GM_IMPLEMENTATION.md          -- GM Agent 设计
├── PERFORMANCE_PLAN.md           -- 性能优化计划
```

---

## src-tauri/ -- Tauri 桌面端

```
src-tauri/
├── Cargo.toml                    -- Rust 依赖与项目元信息
├── build.rs                      -- Tauri 构建脚本
├── tauri.conf.json               -- Tauri 窗口/插件/权限配置
├── capabilities/
│   └── default.json              -- 权限能力声明 (IPC、文件系统等)
```

### src-tauri/src/ -- Rust 后端源码

```
src-tauri/src/
├── main.rs                       -- Tauri 入口
├── lib.rs                        -- 应用构建器：命令注册、插件、托盘
├── commands/
│   ├── mod.rs                    -- 模块声明
│   ├── screenshot.rs             -- 截图：全屏、窗口、子区域
│   ├── capture.rs                -- 区域截图
│   ├── input.rs                  -- 输入模拟：鼠标、键盘
│   ├── window.rs                 -- 窗口管理
│   ├── app.rs                    -- 应用启动与管理
│   ├── app_index.rs              -- 应用索引 (开始菜单+注册表)
│   ├── bridge.rs                 -- Python 桥接
│   ├── gdi_utils.rs              -- GDI 工具
│   ├── image_process.rs          -- 图像处理
│   ├── file_util.rs              -- 文件工具
│   └── global_listener.rs        -- 全局输入钩子
```

---

## public/ -- 静态资源

```
public/
├── manifest.json                 -- PWA manifest
├── sw.js                         -- Service Worker
├── icons/                        -- PWA 图标
├── skills/                       -- 技能定义 (Markdown)
│   ├── desktop_screen.md         -- 桌面视觉控制
│   ├── desktop_uia.md            -- 桌面 UIA 控制
│   ├── web_screen.md             -- Web 屏幕控制
│   ├── phone_screen.md           -- 手机屏幕控制
│   ├── app_builder.md            -- 应用构建器
│   ├── office_doc.md             -- Office 文档生成
│   └── code_tools.md             -- 代码生成工具
```

---

## docs/ -- 架构文档

```
docs/
├── GENERAL_PRIMITIVES_DESIGN.md  -- Shell/文件工具设计
├── CODE_GENERATION_DESIGN.md     -- 代码生成设计
├── MULTI_AGENT_COLLABORATION.md  -- 多 Agent 协作
```

---

## python-engine/ -- Python 自动化后端

```
python-engine/
├── main.py                       -- 引擎入口 (JSON Line 协议)
├── protocol.py                   -- 协议定义
├── requirements.txt              -- Python 依赖
└── engine/
    ├── __init__.py                -- 包标记
    ├── screenshot.py             -- 截图
    ├── browser.py                -- Playwright 浏览器自动化
    ├── desktop_uia.py            -- 桌面 UIA 自动化
    ├── ocr.py                    -- OCR 文字识别
    ├── global_listener.py        -- 全局输入监听
    └── office/                   -- Office 文档生成
        ├── __init__.py
        ├── word_doc.py           -- Word 文档
        ├── excel_doc.py          -- Excel 文档
        └── ppt_doc.py            -- PPT 文档
```

---

## Task 模式执行流水线

```
用户输入
  ↓
IntentClassifierAgent.classify()  ──fetch──→ POST /api/agent/intent-classifier
  │                                              └── LlmExecutor → LlmGateway → 外部模型
  ├── once → DesktopAutomationAgent
  │         L3 模板匹配 → Plan-and-Execute → PerTurn LLM 循环
  │         │                  │                    │
  │         │                  └── apiPost() ───→ POST /api/agent/desktop-automation/tools
  │         │                  └── apiPost() ───→ POST /api/agent/desktop-automation/tools (验证轮)
  │         │
  │         │                  ┌── apiStreamCompat() ──→ POST /api/agent/desktop-automation (SSE)
  │         └── PerTurn ───────┤
  │                            └── VerificationAgent.verify() ──→ POST /api/agent/verification
  │
  └── timer/screen_change → Watcher → TickLoop → ScreenChangeWatcher
                              → executeAction() → DesktopAutomationAgent
```

## Agent API 架构

```
前端 Agent API (src/agents/)
    │
    │  fetch('/api/agent/{name}')
    ▼
┌─────────────────────────────────────────┐
│  Vite 中间件 (src/backend/)              │
│                                          │
│  /api/agent/intent-classifier           │
│  /api/agent/verification                │
│  /api/agent/chat               (SSE)    │
│  /api/agent/code-generation    (SSE)    │
│  /api/agent/code-iteration     (SSE)    │
│  /api/agent/ui-vision/analyze-screenshot│
│  /api/agent/ui-vision/annotate-elements │
│  /api/agent/ui-vision/ocr-classify      │
│  /api/agent/screen-analysis/diff        │
│  /api/agent/screen-analysis/regions     │
│  /api/agent/screen-analysis/ocr         │
│  /api/agent/screen-analysis/interruption│
│  /api/agent/desktop-automation (SSE)    │
│  /api/agent/desktop-automation/tools    │
│         │                                │
│         ▼                                │
│  LlmExecutor (统一 LLM 入口)             │
│  └── LlmGateway → Adapter               │
│         │                                │
└─────────┼────────────────────────────────┘
          │
   ┌──────┼──────┐
   ▼      ▼      ▼
 OpenAI Anthropic Google
```

## 坐标变换流水线

LLM 输出的坐标经过两层修正后才执行，返回值还原为 LLM 原始坐标，避免坐标反馈循环。

```
LLM 坐标 (压缩截图空间, 窗口相对)
  │
  ├─① 压缩比例还原──→ applyCoordinateScale()    × scaleX/scaleY
  │   将压缩截图坐标还原到原始截图空间
  │
  └─② 窗口偏移──────→ addWindowOffset()         + window.left/top
      窗口相对坐标 → 屏幕绝对坐标
      执行工具
```

返回值通过 `snapshotCoords / restoreOriginalCoords` 还原为 LLM 原始坐标。

## 区域验证截图

每个坐标操作（click/drag/move_cursor 等）执行后在目标点周围抓取 150×150 区域图，通过 1:1 像素映射让 LLM 直接看图验证和修正坐标，消除盲点重试循环。

```
执行坐标操作
  ↓
captureRegionAround(screenX, screenY, 150, scaleX, scaleY)
  抓取 150×scale × 150×scale 屏幕像素 → resize 到 150×150
  → 输出图中 1px = LLM 坐标空间 1 单位
  ↓
Agent 层剥离 region_screenshot → 转为多模态 user 消息
  → LLM 看到图片 + "中心即你的点击坐标，像素偏移直接加减"
```
