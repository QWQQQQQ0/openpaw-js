# 多 Agent 协作开发架构

## 定位

多 Agent 协作体系是代码生成入口的**内部实现层**。当代码生成入口判断需求为"复杂"时（见 `docs/CODE_GENERATION_DESIGN.md`），移交到此体系。

```
代码生成入口 —复杂需求—→ 多 Agent 协作体系
                              │
                              ├── Orchestrator → Architect → Developers → Reviewer → Integrator
                              │
                              └── 产出 → register_skill → 可调用的方法
```

## 问题背景

LLM 在运行态生成代码时，上下文窗口有限。即使百万 token 的窗口，复杂项目的上下文也很快耗尽。必须设计多 Agent 协作架构，让每个 Agent 只关注自己的模块，通过契约和日志协同。

## 核心设计原则

### 1. 上下文隔离

每个 Agent 只加载自己模块的代码 + 依赖的接口契约。**永远不加载其他模块的实现代码。**

### 2. Append-Only 日志

所有 Agent 的所有操作写日志，按 `step_order` 递增。日志不可覆盖，不可删除，保证可以完整重放。

### 3. 环境可迁移

任务树 + 过程日志存 DB。换个环境，读取未完成节点 + 日志，从上次中断处继续。Agent 标识保持不变。

### 4. 递归可控

使用显式的"可以不拆"约束 + 深度硬限制 + 客观量化标准，防止 LLM 无限拆分。

---

## 数据模型

### 设计决策：不要独立项目表

- **项目隔离**：用 `task_tree.project_name` 字符串列就够了。查询带 `WHERE project_name = ?` 即可隔离。项目元数据可以存在根节点的 `contract_json` 里。比多一张 `projects` 表更重要的是**文件系统物理隔离**——每个项目的代码目录独立。

### task_tree（任务树）

```
blog-system (project=blog-system, depth=0)
├── frontend (project=blog-system, parent=root, depth=1)
│   ├── components (depth=2)
│   ├── pages (depth=2)
│   │   ├── HomePage (depth=3)
│   │   └── AboutPage (depth=3)
│   └── hooks (depth=2)
├── backend (depth=1)
└── database (depth=1)
```

```sql
CREATE TABLE IF NOT EXISTS task_tree (
  id TEXT PRIMARY KEY,                     -- UUID
  project_name TEXT NOT NULL,              -- 项目隔离键
  module_name TEXT NOT NULL,               -- 本模块名
  parent_module_id TEXT,                   -- NULL = 项目根节点
  module_path TEXT NOT NULL,               -- 完整路径: "frontend/pages/HomePage"
  agent_id TEXT,                           -- 分配的 agent 标识
  agent_type TEXT NOT NULL,                -- orchestrator | architect | developer | reviewer | integrator
  status TEXT DEFAULT 'pending',           -- pending | analyzing | coding | reviewing | done | failed
  depth INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  contract_json TEXT,                      -- 接口契约 JSON（根节点可放项目元数据）
  decision_json TEXT,                      -- 拆分决策
  output_files_json TEXT,                  -- 产出文件列表
  error_info TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### agent_process_log（过程日志）

```sql
CREATE TABLE IF NOT EXISTS agent_process_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,                   -- FK → task_tree.id
  agent_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,            -- 恢复时按此排序重放
  action TEXT NOT NULL,                    -- analyze | decide_split | code | write_file | read_file | review | fix | negotiate | shell_exec | done
  file_path TEXT,                          -- action=code 时必有，如 "frontend/pages/HomePage.tsx"
  input_summary TEXT,
  output_summary TEXT,
  full_input_path TEXT,                    -- 完整输入存文件系统
  full_output_path TEXT,                   -- 完整输出存文件系统
  decision_rationale TEXT,
  error_info TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### package_registry（可信包注册表）

```sql
CREATE TABLE IF NOT EXISTS package_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_name TEXT NOT NULL,              -- npm 包名 / pip 包名
  language TEXT NOT NULL,                  -- node | python
  approved_at TEXT DEFAULT (datetime('now'))
);
```

初始预填一批常用安全包（axios、lodash、express、react、vue、requests、pandas 等）。
Agent 装包后自动写入，以后同包名不用再确认。

### agent_messages（Agent 间通信记录）

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,                   -- FK → task_tree.id
  message_type TEXT NOT NULL,              -- contract_issue | question | proposal | ack
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to_id TEXT,
  resolved INTEGER DEFAULT 0,
  resolution TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## Agent 间通信协议

### 协商流程（Developer ↔ Architect）

```
Developer 开发时发现契约问题
   │
   ▼
发送 agent_message:
  type: contract_issue
  to: 负责本模块的 Architect Agent
  content: "契约声明 getUsers 返回 User[]，但实际需要分页，应返回 PaginatedResult<User>"

   ▼
Architect 收到消息：
  1. 评估影响范围（这个契约被哪些模块 import）
  2. 修改契约 JSON，更新 task_tree.contract_json
  3. 回复 ack 或 counter-proposal
  4. 如果影响其他 Developer，广播通知

   ▼
Developer 收到回复 → 按新契约继续开发
```

### 不上报原则

只有以下情况才上报 Orchestrator：
- Architect 和 Developer 协商两轮仍不一致（死锁）
- 契约变更影响的模块数 >= 3（跨模块重构需要全局协调）
- Agent 无法继续（超时、错误、资源不足）

---

## 递归拆分决策

### 拆分判断 Prompt（防无限拆分）

```
你是一个模块分析 Agent。你的任务：判断当前模块是否需要进一步拆分为子模块。

## 当前模块信息
- 模块名：{module_name}
- 模块路径：{module_path}
- 当前深度：{depth}
- 模块职责描述：{description}

## 拆分判断标准（累积分制）
+1 分: 预计代码量 > 200 行
+1 分: 包含 3 个以上可独立描述的功能
+1 分: 涉及多种技术栈（UI + 数据 + 路由等）
+1 分: 有明显的自然边界（不同页面、不同数据实体等）
-2 分: 模块深度 >= 3
-1 分: 已在一个文件内能清晰表达

## 重要：拆分是可选行为
当前模块可以不拆分。不拆分是正常且常见的决策。
只有在你确信拆分会带来明显好处时才拆。
不要为了拆分而拆分。

## 决策要求
1. 先列出拆分的利与弊
2. 给出评分
3. 评分 >= 2 → should_split = true
4. 评分 < 2  → should_split = false，写出保持现状的理由

## 输出格式（纯 JSON）
{
  "should_split": true/false,
  "score": 2,
  "pros": ["每部分可独立开发", "..."],
  "cons": ["增加协调成本", "..."],
  "reason": "综合判断理由",
  "sub_modules": [
    { "name": "HomePage", "description": "...", "files_estimate": 2 },
    ...
  ]   // 仅 should_split=true 时提供
}
```

### 反幻觉机制总结

| 手段 | 作用 |
|---|---|
| "不拆分是正常且常见的" | 消除 LLM 的"必须做点什么"偏差 |
| 评分制（非 is-hallucinating 描述） | 强制客观量化，减少模糊 |
| depth >= 3 减 2 分 | 硬边界（2 分 → 0 分 → 不拆） |
| 拆的利弊必须列出 | 强制正反两面思考 |
| 输出纯 JSON | 结构化输出减少发散 |

---

## 每个文件的日志粒度

一个 `code` action 对应一个文件：

```
task_id: "frontend-pages-001"
agent_id: "fe-005"
step_order: 3
action: "code"
file_path: "frontend/pages/HomePage.tsx"
input_summary: "根据契约 {contract_json} 生成 HomePage 组件"
output_summary: "生成了 85 行的 React 组件，包含 Hero + FeatureList 两个子组件"
full_input_path: "./logs/input/fe-005-step-003-in.json"
full_output_path: "./logs/output/fe-005-step-003-out.json"
```

完整输入/输出存文件系统，DB 只存摘要和路径。原因是：
- 代码可能有几万字符，DB 撑不住
- 摘要足够恢复时理解上下文
- 需要完整内容时按路径读取

---

## 恢复流程

### 场景：环境崩溃或迁移

```
Step 1: 查询未完成任务
  SELECT * FROM task_tree
  WHERE project_name = ? AND status NOT IN ('done', 'failed')
  ORDER BY depth ASC, sort_order ASC

Step 2: 对每个未完成节点：
  a. 读 agent_process_log，按 step_order 排序
  b. 找到最后一条记录 → 知道上次做到哪了
  c. 读 task_tree.output_files_json → 知道已生成的文件
  d. 文件系统验证文件是否真实存在
  e. 从最后一次 action 之后继续

Step 3: 恢复 Agent 上下文
  - 已生成的代码 → 加载进上下文
  - 最近的日志输入摘要 → 理解之前的意图
  - 契约 JSON → 重新加载
  - 继续执行

Step 4: 如果有未完成的 Agent 间消息
  - 查询 agent_messages WHERE resolved = 0
  - 重新触发协商流程
```

### 具体恢复示例

```
节点: frontend/pages (task_id: xyz-123)
状态: coding
agent_id: fe-005
已生成文件: ["HomePage.tsx", "AboutPage.tsx"]
日志最后一条: step_order=3, action="code", file_path="AboutPage.tsx"

恢复: 
  1. 加载 HomePage.tsx, AboutPage.tsx 到上下文
  2. 加载 pages 模块的 contract_json
  3. 确认已生成 2 个文件正确
  4. 继续生成剩余文件（如果契约里还有未生成的文件）
```

---

## 完整的多 Agent 协作流程

```
用户: "帮我做一个博客系统"
   │
   ▼
┌─────────────────────────────────────────────────────┐
│ Orchestrator (or-001)                               │
│ action: 创建项目 "blog-system"                       │
│ action: 创建根节点 task_tree                         │
│ action: 分配 Architect Agent                        │
└─────────────────────────┬───────────────────────────┘
                          │
              ┌───────────▼──────────────┐
              │  Architect (ar-001)       │
              │  task: blog-system (root) │
              │  action: analyze          │
              │  分析需求 → 需要拆分       │
              │  action: decide_split     │
              │  拆为 3 个子模块          │
              │  ├── frontend-web         │
              │  ├── backend-api          │
              │  └── database             │
              │  写入 task_tree × 3        │
              │  写入 contract_json × 3    │
              └───────────┬──────────────┘
                          │
      ┌───────────────────┼───────────────────┐
      ▼                   ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Architect    │  │ Architect    │  │ Architect    │
│ ar-002       │  │ ar-003       │  │ ar-004       │
│ frontend-web │  │ backend-api  │  │ database     │
│              │  │              │  │              │
│ analyze:     │  │ analyze:     │  │ analyze:     │
│ score=2      │  │ score=2      │  │ score=0      │
│ 拆: pages    │  │ 拆: routes   │  │ 不拆，直接    │
│ components   │  │ middleware   │  │ 转 Developer  │
│ hooks        │  │ services     │  └──────┬───────┘
└──────┬───────┘  └──────┬───────┘         │
       │                 │                 │
  ┌────┼────┐       ┌────┼────┐            │
  ▼    ▼    ▼       ▼    ▼    ▼            │
 ┌┐   ┌┐   ┌┐     ┌┐   ┌┐   ┌┐          │
 │Dev│ │Dev│ │Dev│  │Dev│ │Dev│ │Dev│      │Dev│
 │fe │ │fe │ │fe │  │be │ │be │ │be │      │db │
 │001│ │002│ │003│  │001│ │002│ │003│      │001│
 └───┘ └───┘ └───┘  └───┘ └───┘ └───┘     └───┘
   │      │     │      │     │     │         │
   │  [code] [code]   ...   ...   ...      ...  ← 每个文件一条日志
   │   │      │        │     │     │         │
   └───┴──────┴────────┴─────┴─────┴─────────┘
                    │
                    ▼
          ┌──────────────────┐
          │  Reviewer Agent  │  ← 每个模块独立 review
          │  review + ack    │
          └────────┬─────────┘
                    │
                    ▼
          ┌──────────────────┐
          │  Integrator      │  ← 组装全部代码
          │  验证 import      │
          │  验证契约一致性    │
          │  生成入口文件      │
          └──────────────────┘
```

---

## Agent 类型清单

| Agent 类型 | 角色 | 输入 | 输出 |
|---|---|---|---|
| **Orchestrator** | 项目级调度 | 用户需求 | 项目创建 + 根任务分配 |
| **Architect** | 模块分析与拆分 | 模块描述 + 上下文 | 拆分决策 + 子模块列表 + 契约 |
| **Developer** | 具体编码 | 契约 + 模块职责 | 代码文件 |
| **Reviewer** | 代码审查 | 代码 + 契约 | 通过/不通过 + 修改建议 |
| **Integrator** | 项目组装 | 所有模块输出 | 完整项目代码 + 集成验证 |

---

---

## 外部依赖与命令执行

### 执行流程

```
Agent 要执行 shell 命令
       │
       ▼
┌──────────────┐
│ 高风险模式    │ → 命中 → 拒绝执行，告知用户手动操作步骤
└──────┬───────┘
       │ 未命中
       ▼
┌──────────────────┐
│ 是否 pip/npm     │
│ install 装包？    │
└──────┬───────────┘
       │ 是              否 (普通开发命令)
       ▼                 ▼
┌──────────────┐    ┌──────────────┐
│ 查 package    │    │ 用户确认     │ ← 每次询问
│ registry     │    └──────────────┘
└──────┬───────┘
       │
   ┌───┴───┐
   │       │
 在册    不在册
   │       │
   ▼       ▼
直接装   弹窗问用户
         │
     ┌───┴───┐
     │       │
   同意    拒绝
     │       │
     ▼       ▼
  安装    记录日志
  + 写入   Agent 收到拒绝
  registry
```

### 高风险命令清单

命中以下模式直接拒绝，产出操作步骤让用户决定：

- 破坏性文件操作：`rm -rf /`、`del /f /s C:\`、`format`
- 磁盘操作：`dd`、`mkfs`、`fdisk`
- 权限变更：`chmod 777 /`、`chown -R root /`
- 系统文件修改、注册表关键项、安全软件操作
- fork bomb、无限写磁盘
- 远程脚本直执行：`curl xxx | bash`、`wget xxx -O - | sh`

### 日志记录

所有命令执行记录到 `agent_process_log`，`action = 'shell_exec'`：

- `file_path`：命令文本
- `output_summary`：stdout 摘要
- `error_info`：stderr / 失败原因
- `input_summary`：用户是否同意（自动通过 / 用户确认 / 拒绝）

### 环境感知

每个 Developer Agent 启动时注入当前环境的能力清单：

```
## 当前环境
Node.js: v20.x（列出已装的全局包）
Python: 3.x（列出 pip freeze）
## 装包规则
- 需要新包直接用 npm install / pip install
- 安装前会检查可信注册表，在册直接装，不在册需用户确认
- 已装的包不需要重复安装
- 不要装已知有安全漏洞的包版本
```

---

---

## 文件生成机制

### 主路径：write_file 工具

不走 shell 重定向，提供一个专用工具：

```
write_file(file_path, content)
  → Tauri invoke → Rust std::fs::write(project_dir / file_path, content)
```

路径自动拼接项目根目录，防止写出项目范围。

### 兜底：shell 重定向

复杂场景（追加内容、批量改名、chmod）用 shell_exec 补充。

### Developer Agent 完整工具集

```
Developer Agent 工具箱：
├── generate_code    → LLM 生成代码文本
├── write_file       → 写代码到文件系统（主路径）
├── read_file        → 读已有文件（恢复上下文、修改现有代码时用）
├── execute_code     → 沙箱跑一下验证
├── iterate_code     → 写错了自动改（execute + LLM 调试循环）
├── shell_exec       → 装包、跑脚本、追加文件等（用户确认）
└── agent_messages   → 跟 Architect 协商契约问题
```

---

## 与现有 Skill 系统的集成

不重新造一套工具分发机制。多 Agent 体系的工具注册进现有的 `SkillExecutor`。

### 第一层：代码工具以 built-in skill 注册

`write_file`、`read_file`、`generate_code` 等作为新的 built-in skill `code_tools`，走现有的注册流程：

```
public/skills/code_tools.md
  → skill-store 同步到 DB
  → builtin-executor 实例化
  → SkillExecutor.register()
  → buildToolsForLLM() 自动生成 function call 列表
  → Developer Agent 看到的工具和其他 skill 一样
```

### 第二层：Developer Agent 可以调其他 skill

生成的代码跑在沙箱里，可以通过 executor 回调触发系统现有的 skill。比如生成一个"截图分析"功能，代码里调用 `desktop_screen` 的截图工具。

```
Developer Agent → SkillExecutor
                    ├── code_tools (新)
                    │     ├── write_file
                    │     ├── read_file
                    │     ├── generate_code
                    │     ├── execute_code
                    │     └── iterate_code
                    ├── desktop_screen (已有)
                    ├── web_screen (已有)
                    ├── 用户自定义 skill (已有)
                    └── register_skill 动态注册的 (未来)
```

---

## 提示词系统（新增）

在 `system-prompts.json` 中新增：

| Prompt Key | 用途 |
|---|---|
| `agentOrchestrator` | Orchestrator 的调度逻辑 + 任务分配规则 |
| `agentArchitect` | 模块拆分决策 + 契约定义 + 防无限拆分约束 |
| `agentDeveloper` | 按契约写代码 + 可用工具清单 + 有问题找 Architect 协商 |
| `agentReviewer` | 代码 vs 契约一致性检查 + 安全审查 |
| `agentIntegrator` | 组装模块 + import 验证 + 入口生成 |
| `agentNegotiation` | Agent 间协商消息的格式规范 |

> `agentDeveloper` prompt 里会注入当前 SkillExecutor 中所有可用工具的列表（包括 code_tools + 现有的 desktop/web/用户 skill），Developer Agent 看到完整的工具箱。

---

## 实现文件清单

### 新增

| 文件 | 作用 |
|---|---|
| `src/services/multi-agent/orchestrator.ts` | Orchestrator Agent 入口 |
| `src/services/multi-agent/agent-runner.ts` | Agent 运行器（创建/恢复/调度单 Agent） |
| `src/services/multi-agent/task-tree-db.ts` | task_tree 表 CRUD |
| `src/services/multi-agent/process-log-db.ts` | agent_process_log 表读写 |
| `src/services/multi-agent/agent-message-db.ts` | agent_messages 表 CRUD |
| `src/services/multi-agent/recovery.ts` | 恢复流程（读取未完成任务 → 重放日志 → 继续） |
| `src/services/multi-agent/context-builder.ts` | 构建各类型 Agent 的上下文 |
| `src/services/multi-agent/prompts/architect.ts` | Architect 专用 prompt 模板 |
| `src/services/multi-agent/prompts/developer.ts` | Developer 专用 prompt 模板 |
| `src/services/multi-agent/prompts/reviewer.ts` | Reviewer 专用 prompt 模板 |
| `src/services/multi-agent/types.ts` | 共享类型 |
| `src/skills/code-tools.ts` | code_tools built-in skill（write_file / read_file / generate_code 等） |
| `public/skills/code_tools.md` | code_tools skill 的 YAML + JSON 定义 |

### 修改

| 文件 | 变更 |
|---|---|
| `src/config/system-prompts.json` | 新增 6 个 Agent prompt |
| `src/db/index.ts` | DDL 新增 task_tree / agent_process_log / agent_messages / package_registry 表 |
| `src/db/types.ts` | 新增对应 Row 类型 |
