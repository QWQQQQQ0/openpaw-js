# OpenPaw 通用底层原语设计

> 目标：让 OpenPaw AI 拥有类似 Claude Code 的自由度 —— 能执行任意 shell 命令、读写文件、搜索文件系统，而非仅限预定义的 UI 自动化工具。

## 1. 动机

### 当前局限

OpenPaw 的 AI 只能调用 Skill 系统中预定义的具名工具（~40个），每个工具只做一件特定的事：

```
desktop_click(x, y)     → 只做坐标点击
uia_click(role, name)   → 只做 UIA 元素点击
web_pw_navigate(url)    → 只做浏览器导航
```

AI 的创造力被工具菜单限制住了。它不能：
- 执行 PowerShell 命令操作 Windows 系统
- 读写本地文件（日志、配置、数据文件）
- 调用命令行工具（curl、git、python 脚本）
- 搜索文件系统中的文件
- 通过脚本批量处理数据

### 参照对象：Claude Code 的工具集

Claude Code 只用 6 个通用原语就能操作几乎所有电脑数据：

| 工具 | 能力 |
|------|------|
| Bash | 执行任意 shell 命令 |
| Read | 读取任意文件内容 |
| Write | 写入/创建文件 |
| Edit | 精确字符串替换 |
| Glob | 按模式查找文件 |
| Grep | 正则搜索文件内容 |

### 设计哲学

```
OpenPaw 当前:  AI → 从菜单选菜 → 吃到固定的菜
OpenPaw 目标:  AI → 有刀和锅 → 自己做什么都行

保留现有 UI 工具作为"预制菜"(快捷方式)，新增通用原语作为"生食材"(无限可能)。
```

## 2. 架构分层：编排者与执行者共存

### 核心原则：不是替代关系，而是上下级关系

`desktopAutomationFreeform` 不替代现有的专用 prompt 和 agent，它是一个**更上层的编排者**，负责理解用户意图、协调多个下级 agent 完成复杂任务。下级 agent（桌面自动化、Watcher、技能执行等）保持原有的执行逻辑、工具集和缓存策略不变。

```
┌───────────────────────────────────────────────────────┐
│ 编排层 (desktopAutomationFreeform)                      │
│ 角色: 局势把控者 — 理解全局目标，拆解为子任务，            │
│       协调下级 agent 执行，处理异常，汇报结果              │
│ 工具: shell_exec + file_* + 通用信息获取                  │
│ 特点: 不直接操作 UI，通过下级 agent 间接执行               │
│ 延迟容忍: 高 (用户等几秒无所谓)                            │
│ 调用频率: 用户每次对话 1-N 轮                              │
└────────────────────────┬──────────────────────────────┘
                         │ 调度/分发子任务
┌────────────────────────┴──────────────────────────────┐
│ 执行层 (下级 agent，各自独立，原有逻辑不变)                │
│                                                        │
│ ┌──────────────────────────────────────────────┐       │
│ │ DesktopAutomationAgent (desktopAutomation)    │       │
│ │ 桌面 UI 自动化: UIA 点击/输入/截图             │       │
│ │ 工具: uia_*, desktop_*, web_* 等 UI 工具      │       │
│ │ 缓存: L1/L2/L3 完整保留                       │       │
│ └──────────────────────────────────────────────┘       │
│ ┌──────────────────────────────────────────────┐       │
│ │ Watcher (纯视觉diff, 无 prompt)               │       │
│ │ 屏幕变化检测: 每 500ms 一次，token: 0          │       │
│ └──────────────────────────────────────────────┘       │
│ ┌──────────────────────────────────────────────┐       │
│ │ 其他专用子系统                                │       │
│ │ Region Discovery / Goal Decomposer /          │       │
│ │ Semantic Annotation / Intent Classifier /      │       │
│ │ Skill Generator                               │       │
│ │ 各自保持短 prompt + 固定输出格式                │       │
│ └──────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────┘
```

### 编排者 vs 执行者的职责边界

| | 编排层 (desktopAutomationFreeform) | 执行层 (下级 agent) |
|---|---|---|
| **职责** | 理解全局目标，拆解子任务，协调执行，处理异常 | 执行具体子任务（UI 操作、屏幕监控等） |
| **工具** | shell_exec + file_* + 通用信息获取 | UIA/桌面/Web 等专用工具 |
| **是否直接操作 UI** | 否，通过下级 agent 间接执行 | 是 |
| **Prompt 自由度** | 高（理解自然语言，自由编排） | 低（短 prompt + 约束输出） |
| **缓存** | 不涉及（编排层不缓存行动方案） | L1/L2/L3/L4 完整保留 |
| **调用关系** | 被用户对话触发 | 被编排层调度 |

### 为什么这样分层

**1. 工具不冲突**

编排层用 shell + 文件工具做信息收集和环境准备，执行层用 UI 工具做实际操作。两层工具集不重叠，不存在"LLM 倾向用万能工具"的问题。

**2. 缓存不受影响**

执行层的缓存策略（L1 UI 指纹、L2 步骤缓存、L3 技能模板、L4 LLM 调用缓存）完全不变。编排层只是多了一种"调用下级 agent"的方式，不改变下级 agent 的内部逻辑。

**3. 成本可控**

编排层只在用户对话时调用（不是每 500ms），token 消耗与普通对话相当。执行层的专用子系统保持原有的低成本运行。

**4. 复杂任务有全局视角**

现有 agent 只能看到自己的子任务。编排层能看到全局：需要先查日志定位问题，再操作 UI 修复，最后验证结果。这种多步骤、跨系统的能力是单个 agent 做不到的。

### 设计结论

- **编排层加能力**：`desktopAutomationFreeform` 作为编排者，拥有 shell + 文件工具，负责全局协调。它不直接操作 UI，而是调度下级 agent 完成具体操作。
- **执行层保持不变**：DesktopAutomationAgent、Watcher、Region Discovery 等下级 agent 保持原有的 prompt、工具集、缓存策略。它们是被调度的执行者，不需要知道编排层的存在。
- **工具隔离**：编排层用 shell + 文件工具，执行层用 UI 工具，互不干扰。
- **安全边界**：编排层的 shell 和文件操作受安全策略约束（见第 3 节），确保不会对用户系统造成不可逆损害。

## 3. 安全策略：用户授权与操作分级

### 核心原则

shell_exec 和 file_* 工具赋予 AI 完整的系统访问能力。必须在工具能力之上建立安全层，确保用户对系统变更有完全的知情权和控制权。

### 操作分级

| 级别 | 定义 | 处理方式 | 示例 |
|------|------|---------|------|
| **只读** | 不修改任何系统状态 | 自动执行，无需确认 | `Get-Process`, `dir`, `file_read`, `file_search` |
| **写入** | 创建或修改文件 | **告知用户操作内容，等待确认后执行** | `file_write`, `New-Item`, `Set-Content` |
| **可逆修改** | 修改可撤销的操作 | **告知用户操作内容，等待确认后执行** | `Copy-Item`, `Rename-Item`, `git commit` |
| **不可逆删除** | 删除文件/目录/注册表等 | **禁止执行，仅告知用户操作步骤** | `Remove-Item -Recurse`, `rm -rf`, `Format-Volume` |
| **系统级操作** | 影响系统全局状态 | **禁止执行，仅告知用户操作步骤** | `Stop-Process -Force`, `Restart-Computer`, `reg delete` |

### 实现机制

**1. 命令分类器（Rust 端）**

在执行 shell 命令前，通过正则匹配命令动词判断操作级别：

```rust
enum CommandRisk {
    ReadOnly,       // 自动执行
    Write,          // 需要确认
    Irreversible,   // 禁止执行
    SystemLevel,    // 禁止执行
}

fn classify_command(command: &str) -> CommandRisk {
    let cmd = command.trim().to_lowercase();
    // 不可逆删除
    if cmd.contains("remove-item") && cmd.contains("-recurse")
        || cmd.contains("rm ") && cmd.contains("-rf")
        || cmd.contains("rmdir") && cmd.contains("/s")
        || cmd.contains("format ")
        || cmd.contains("del /") { return CommandRisk::Irreversible; }
    // 系统级操作
    if cmd.contains("stop-process") && cmd.contains("-force")
        || cmd.contains("restart-computer")
        || cmd.contains("shutdown")
        || cmd.contains("reg delete")
        || cmd.contains("net user")
        || cmd.contains("disable-netadapter") { return CommandRisk::SystemLevel; }
    // 写入操作
    if cmd.starts_with("new-item") || cmd.starts_with("set-content")
        || cmd.starts_with("add-content") || cmd.starts_with("out-file")
        || cmd.starts_with("copy-item") || cmd.starts_with("move-item")
        || cmd.starts_with("rename-item") || cmd.starts_with("mkdir")
        || cmd.starts_with("git commit") || cmd.starts_with("git push")
        || cmd.starts_with("npm install") || cmd.starts_with("pip install") { return CommandRisk::Write; }
    // 默认只读
    CommandRisk::ReadOnly
}
```

**2. 用户确认流程（前端）**

```
AI 调用 shell_exec("Remove-Item C:\\temp\\old.log")
  → Rust 分类: Irreversible
  → 返回前端: { blocked: true, reason: "不可逆删除操作", suggestion: "请手动执行: Remove-Item C:\\temp\\old.log" }
  → 前端展示: "AI 想要删除文件 C:\temp\old.log，此操作不可逆。建议您手动执行。"
  → 用户决定: 忽略 / 手动执行 / 强制放行(需二次确认)
```

```
AI 调用 file_write("C:\\config\\app.json", "{...}")
  → Rust 分类: Write
  → 返回前端: { needs_confirm: true, action: "写入文件", path: "C:\\config\\app.json", preview: "..." }
  → 前端展示: "AI 想要写入文件 C:\config\app.json [预览内容]"
  → 用户确认: 同意 / 拒绝
```

**3. 安全设置项**

```sql
-- settings 表新增
allow_shell_exec: 1          -- 总开关：是否允许 shell 执行
shell_auto_confirm_readonly: 1  -- 只读命令是否自动执行（默认是）
shell_require_confirm_write: 1  -- 写入命令是否需要确认（默认是）
shell_block_destructive: 1      -- 是否阻止不可逆操作（默认是）
```

**4. 编排层的安全约束（Prompt 层面）**

在 `desktopAutomationFreeform` 的 system prompt 中加入安全规则：

```
安全规则（必须遵守）：
- 只读命令（查询、搜索、信息获取）可以直接执行
- 写入/修改文件前，必须先告知用户要写入的内容和路径，等用户确认
- 删除文件/目录的操作禁止执行，改为告知用户具体操作步骤，由用户手动执行
- 系统级操作（杀进程、重启、修改注册表）禁止执行，仅提供操作建议
- 如果不确定操作是否安全，优先选择只读方案
```

## 4. 新增工具定义

### 2.1 shell_exec — 通用命令执行

核心工具。一个 shell_exec 等效于 Claude Code 的 Bash 工具，能调用系统上所有 CLI。

```json
{
  "name": "shell_exec",
  "description": "执行任意 shell/PowerShell 命令并返回 stdout、stderr、exit code。可在指定工作目录下执行。超时默认 120 秒。",
  "parameters": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "要执行的命令。Windows 上默认使用 PowerShell 执行。示例: 'Get-Process | Select-Object -First 5', 'dir C:\\\\Users', 'python script.py'"
      },
      "cwd": {
        "type": "string",
        "description": "工作目录（可选）。不指定则使用用户主目录。"
      },
      "timeout_ms": {
        "type": "integer",
        "description": "超时毫秒数（可选，默认 120000）。"
      }
    },
    "required": ["command"]
  }
}
```

**输出格式：**
```json
{
  "stdout": "命令的标准输出",
  "stderr": "错误输出",
  "exit_code": 0,
  "timed_out": false
}
```

### 2.2 file_read — 读取文件

```json
{
  "name": "file_read",
  "description": "读取文件内容。支持文本文件和图片（PNG/JPG/GIF/SVG）。大文件可指定行偏移和行数限制。",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "文件绝对路径。"
      },
      "offset": {
        "type": "integer",
        "description": "起始行号（可选，0-based）。"
      },
      "limit": {
        "type": "integer",
        "description": "读取行数（可选）。"
      }
    },
    "required": ["path"]
  }
}
```

### 2.3 file_write — 写入文件

```json
{
  "name": "file_write",
  "description": "创建或覆盖文件。会自动创建不存在的父目录。",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "文件绝对路径。"
      },
      "content": {
        "type": "string",
        "description": "要写入的内容。"
      }
    },
    "required": ["path", "content"]
  }
}
```

### 2.4 file_list — 列出目录

```json
{
  "name": "file_list",
  "description": "列出目录中的文件和子目录。",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "目录绝对路径。默认用户主目录。"
      },
      "pattern": {
        "type": "string",
        "description": "glob 过滤模式（可选）。如 '*.log', '**/*.js'。"
      }
    },
    "required": []
  }
}
```

### 2.5 file_search — 搜索文件内容

```json
{
  "name": "file_search",
  "description": "在文件中搜索匹配文本或正则表达式的内容，返回匹配行及上下文。",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "搜索模式（文本或正则表达式）。"
      },
      "path": {
        "type": "string",
        "description": "搜索目录（可选）。默认当前工作目录。"
      },
      "glob": {
        "type": "string",
        "description": "文件名过滤（可选）。如 '*.ts', '*.{js,ts}'。"
      },
      "max_results": {
        "type": "integer",
        "description": "最大结果数（可选，默认 50）。"
      }
    },
    "required": ["pattern"]
  }
}
```

## 5. 实现路径

### 5.1 阶段一：最小可用（核心 shell + 文件读写）

**文件改动：**

```
新增: public/skills/system.md               # 系统工具 Skill 定义（Markdown + JSON 工具定义）
新增: src/skills/system.ts                   # SystemSkill 类，实现 execute() 方法
新增: src-tauri/src/commands/system.rs       # Rust 命令：shell_exec, file_read, file_write + 命令分类器

修改: src/skills/builtin-executor.ts         # 注册 SystemSkill
修改: src-tauri/src/commands/mod.rs           # 声明 system 模块
修改: src-tauri/src/lib.rs                    # 注册新 Tauri 命令
修改: src/config/system-prompts.json         # desktopAutomationFreeform 中添加编排者角色说明 + 安全规则
```

**Rust 端实现要点：**

`shell_exec` 命令：
- 使用 `std::process::Command` 执行
- Windows: 默认通过 `powershell -Command` 包装执行
- 设置超时（`std::process::Child::wait_timeout` 或 tokio timeout）
- 捕获 stdout/stderr，限制输出大小（如 100KB），防止 AI 上下文溢出
- **执行前经过命令分类器**：根据操作级别决定自动执行 / 返回需确认 / 阻止执行
- 返回结构化结果：`{ stdout, stderr, exit_code, timed_out, risk_level, needs_confirm, blocked }`

`file_read` 命令：
- 使用 `std::fs::read_to_string` 或逐行读取
- 支持 `offset` + `limit` 行范围
- 如果是图片文件（按扩展名判断），读为 base64 data URL 返回
- 限制最大读取大小（如 1MB）

`file_write` 命令：
- 使用 `std::fs::write`
- 自动创建父目录（`std::fs::create_dir_all`）
- 需要安全考虑：禁止覆盖系统关键路径（白名单或警告）

**安全实现：**
- `shell_exec` 在 Rust 端经过命令分类器（见第 3 节），自动判断操作级别
- 只读命令直接执行，写入命令返回 `needs_confirm` 前端弹窗，删除/系统命令返回 `blocked` 阻止执行
- settings 中 `allow_shell_exec` 总开关，用户可随时关闭
- 所有命令执行在 UI 上可见（"正在执行命令: xxx"）

### 5.2 阶段二：文件搜索增强

```
新增: file_list  命令 → src-tauri/src/commands/system.rs
新增: file_search 命令 → src-tauri/src/commands/system.rs
```

`file_list` 使用 `glob` crate 或手动遍历 + 通配符匹配。
`file_search` 使用 `grep` crate（如 `ripgrep` 的库）或手动逐文件搜索。

### 5.3 阶段三：System Prompt 升级

`desktopAutomationFreeform` prompt 改为编排者角色：

**角色定义：**
```
你是一个桌面自动化编排者。你的职责是理解用户的全局目标，拆解为子任务，
调度下级 agent 执行具体操作。你拥有 shell 和文件工具用于信息收集和环境准备，
但不直接操作 UI —— UI 操作通过调度下级 agent 完成。
```

**工具使用引导：**
- shell_exec：用于信息收集（查进程、读日志、检查文件状态）、环境准备（创建目录、下载依赖）
- file_*：用于读取配置、检查日志、准备数据
- UI 操作：不直接调用 uia_*/desktop_* 工具，而是调度 DesktopAutomationAgent 执行

**安全规则（嵌入 prompt）：**
```
安全规则（必须遵守）：
- 只读命令（查询、搜索、信息获取）可以直接执行
- 写入/修改文件前，必须先告知用户要写入的内容和路径，等用户确认
- 删除文件/目录的操作禁止执行，改为告知用户具体操作步骤，由用户手动执行
- 系统级操作（杀进程、重启、修改注册表）禁止执行，仅提供操作建议
- 如果不确定操作是否安全，优先选择只读方案
```

## 6. 与现有系统的关系

```
编排层 (desktopAutomationFreeform)     执行层 (下级 agent，不受影响)
─────────────────────────────────     ─────────────────────────
shell_exec + file_* 工具               DesktopAutomationAgent (desktopAutomation)
全局目标理解与子任务拆解                 + 全部 UI 工具 (uia_*, desktop_*, web_*)
通过调度下级 agent 间接执行 UI 操作     + L1/L2/L3/L4 缓存完整保留
安全策略约束（用户授权/确认/禁止）       Watcher (纯视觉diff)
                                       Region Discovery / Goal Decomposer /
                                       Semantic Annotation / Intent Classifier /
                                       Skill Generator

关系：编排者与执行者，上下级共存
- 编排层理解全局目标，拆解为子任务，调度下级 agent 执行
- 下级 agent 保持原有执行逻辑、工具集、缓存策略，不受编排层影响
- 编排层用 shell + 文件工具做信息收集和环境准备，不直接操作 UI
- 下级 agent 不需要知道编排层的存在，按原有方式接收任务并执行
```

## 7. 缓存策略

### 执行层缓存：完全不变

编排层（desktopAutomationFreeform）不影响下级 agent 的缓存。下级 agent 仍然走原有的 L1/L2/L3/L4 缓存路径：

| 缓存层 | 状态 | 说明 |
|--------|------|------|
| L1 UI 指纹缓存 | 不变 | 窗口结构不随编排层引入而改变 |
| L2 步骤缓存 | 不变 | 下级 agent 的子任务执行路径不变 |
| L3 技能模板 | 不变 | 下级 agent 的技能匹配逻辑不变 |
| LLM 调用缓存 | 不变 | 精确请求→响应匹配仍然有效 |

### 编排层缓存：新增

编排层本身有独立的缓存需求，与执行层互不干扰：

| 缓存层 | 说明 |
|--------|------|
| **API Prompt Cache** | 在 Anthropic adapter 中加 `cache_control`，缓存 system prompt + tool definitions，每轮节省数千 token |
| **Shell 输出缓存（可选）** | 纯信息查询命令（Get-Process, dir 等）做短期 TTL 缓存，避免重复执行 |

**API Prompt Cache 实现位置**：`src/adapters/anthropic.ts` — 在 `body['system']` 和 `body['tools']` 中添加 `cache_control: { type: 'ephemeral' }` 标记。

## 8. 数据库变更

### skills 表新增行

系统启动时从 Markdown 同步到 DB：

```sql
INSERT OR REPLACE INTO skills (id, name, category, description, enabled, is_builtin)
VALUES ('system', 'System Tools', 'system', 'Shell command execution, file read/write, file search', 1, 1);
```

### settings 表新增配置项

```
allow_shell_exec: 1             -- 总开关：是否允许 shell 执行
shell_auto_confirm_readonly: 1  -- 只读命令是否自动执行（默认是）
shell_require_confirm_write: 1  -- 写入命令是否需要确认（默认是）
shell_block_destructive: 1      -- 是否阻止不可逆操作（默认是）
```

## 9. 测试要点

- [ ] shell_exec 执行简单命令（`echo hello`）正常返回 stdout
- [ ] shell_exec 执行错误命令（`exit 1`）正确返回 exit_code 和 stderr
- [ ] shell_exec 超时机制生效
- [ ] shell_exec 输出超过 100KB 时被截断
- [ ] file_read 读取文本文件正常
- [ ] file_read 读取不存在的文件返回错误
- [ ] file_write 创建新文件，自动创建父目录
- [ ] file_write 覆盖已存在文件
- [ ] AI 在 desktopAutomationFreeform prompt 下能正确选择和调用 shell_exec
- [ ] AI 能结合 shell_exec + 现有 UI 工具完成任务（如：用 shell 查进程 → 用 desktop_focus_window 切窗口）
- [ ] 只读命令（Get-Process, dir）自动执行，无需用户确认
- [ ] 写入命令（file_write）触发用户确认流程
- [ ] 删除命令（Remove-Item -Recurse）被阻止，返回操作建议
- [ ] 系统级命令（Stop-Process -Force）被阻止，返回操作建议
- [ ] 用户拒绝确认后，命令不执行，AI 收到拒绝信息
- [ ] allow_shell_exec=false 时，所有 shell 命令被拒绝

## 10. 参考

- Claude Code 工具定义：在其系统内部，Bash/Read/Write/Edit/Glob/Grep 为 6 个核心工具
- OpenPaw Skill 系统：`src/skills/skill.ts` (Skill 接口), `src/skills/executor.ts` (SkillExecutor)
- 现有技能定义格式：`public/skills/desktop_screen.md`
- System prompt 新增条目：`src/config/system-prompts.json` → `desktopAutomationFreeform`
