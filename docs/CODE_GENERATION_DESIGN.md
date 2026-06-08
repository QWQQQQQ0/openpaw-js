# 代码生成 — 用户需求兜底入口

## 定位

代码生成是整个系统的**能力补全入口**。当用户提出一个需求，Admin Agent 发现现有工具无法满足时，触发代码生成——自动创建缺失的能力，然后执行，返回结果给用户。

用户只需要说一句话，感知不到后面的代码生成和 Agent 协作过程。

## 架构

```
用户: "帮我做 xxx"
  │
  ▼
┌─────────────────────────────────────────────┐
│ Admin Agent                                  │
│                                              │
│ 1. 理解用户意图                              │
│ 2. 检查现有工具/Skill 是否能满足              │
│    ├── 能 → 直接执行 → 返回结果               │
│    └── 不能 → 触发代码生成入口                │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ 代码生成入口（复杂度判断）                     │
│                                              │
│ LLM 判断需求复杂度：                          │
│                                              │
│ 简单 ────────────────────────────────────    │
│  · 单一功能，几行到几十行代码                  │
│  · 不需要协调多个模块                         │
│  · 不涉及数据库/外部系统                      │
│                                              │
│   → 单 Agent 路径                            │
│     generate_code → execute → (fix) → done   │
│                                              │
│ 复杂 ────────────────────────────────────    │
│  · 多模块，需要前后端+数据库                   │
│  · 预计代码量 > 200 行                        │
│  · 涉及多个独立功能                           │
│                                              │
│   → 多 Agent 协作路径                         │
│     移交 Code Agent 体系（见多 Agent 协作文档） │
└────────────────────┬────────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌─────────────────┐    ┌─────────────────────────┐
│ 单 Agent 路径    │    │ 多 Agent 协作路径         │
│                 │    │                         │
│ LLM 直接生成代码 │    │ Orchestrator             │
│ + 沙箱执行测试   │    │   → Architect 拆分       │
│ + 自动修复      │    │     → Developer 并行编码  │
│                 │    │       → Reviewer 审查     │
│                 │    │         → Integrator 组装 │
└────────┬────────┘    └───────────┬─────────────┘
         │                         │
         └───────────┬─────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│ register_skill                              │
│ 生成的方法注册为工具                          │
│ 下次用户提类似需求直接命中                     │
└────────────────────┬────────────────────────┘
                     ▼
               执行 → 返回结果给用户
```

## 复杂度判断

判断本身由 LLM 完成，不作为硬编码规则：

```
当前用户需求: {user_request}
已有可用工具: {existing_tools}

判断这个需求是否可以用单一代码片段解决，还是需要启动多 Agent 协作开发。

## 简单需求（走单 Agent 路径）
- 算法/数据处理函数
- 单个脚本/工具
- 简单的前端组件（一个页面/表单/列表）
- 数据库单表查询/操作
- 文件格式转换

## 复杂需求（走多 Agent 路径）
- 完整的前后端应用
- 需要多模块协调
- 涉及数据库建表 + API + 前端
- 预计代码文件数 >= 5
- 用户明确提到"项目"/"系统"/"应用"

## 输出
{
  "complexity": "simple" | "complex",
  "reason": "判断理由",
  "estimated_files": 2
}
```

## 单 Agent 路径工具

| 工具 | 功能 |
|---|---|
| `generate_code` | 调用 LLM 生成代码（子 prompt: codeGeneration） |
| `execute_code` | 沙箱执行代码，返回运行结果 |
| `iterate_code` | execute + LLM 调试循环，最多 3 轮自动修复 |
| `save_code` | 存入 code_registry 表，跨项目可复用 |

## 沙箱

单 Agent 路径共用同一套沙箱：

| 语言 | 实现 | 限制 |
|---|---|---|
| JavaScript | `new Function()` + 代理拦截 | 无 require/process，30s 超时 |
| Python | 桥接到 python-engine sidecar | 模块白名单 + 受限 builtins |
| SQL | 包装 getDB() | DDL 拦截，行数上限 1000 |

完整沙箱设计见 `docs/CODE_GENERATION_DESIGN.md` 旧版本安全机制部分。

## 多 Agent 路径

> 详见 `docs/MULTI_AGENT_COLLABORATION.md`

流程：
1. Orchestrator 接收需求，创建项目
2. Architect 递归拆分模块（不强制拆分，有反幻觉约束）
3. Developer 并行编码（每个文件一条日志，可恢复）
4. Reviewer 审查
5. Integrator 组装
6. 产出 → register_skill → 执行

## System Prompts 清单

新增到 `src/config/system-prompts.json`：

| Key | 用途 |
|---|---|
| `adminAgent` | Admin Agent：理解意图 + 检查现有工具 + 触发代码生成 |
| `complexityJudge` | 复杂度判断：简单走单 Agent，复杂走多 Agent |
| `codeGeneration` | 单 Agent 代码生成子 prompt |
| `codeIteration` | 单 Agent 调试循环 prompt |

多 Agent 体系所需的 prompt 见 `docs/MULTI_AGENT_COLLABORATION.md`。

## 数据表

单 Agent 路径相关：

| 表 | 用途 |
|---|---|
| `code_registry` | 生成的代码片段存储，跨项目复用 |

多 Agent 路径表见 `docs/MULTI_AGENT_COLLABORATION.md`（task_tree / agent_process_log / agent_messages / package_registry）。

## 新增文件

| 文件 | 作用 |
|---|---|
| `src/services/code-gateway.ts` | 代码生成入口：复杂度判断 + 分发单/多 Agent |
| `src/services/code-sandbox/sandbox-types.ts` | SandboxResult, SandboxConfig 类型 |
| `src/services/code-sandbox/sandbox-js.ts` | JS 沙箱 |
| `src/services/code-sandbox/sandbox-python.ts` | Python 沙箱 |
| `src/services/code-sandbox/sandbox-sql.ts` | SQL 沙箱 |
| `src/services/code-sandbox/index.ts` | CodeSandboxService 统一门面 |
| `src/services/code-registry/code-registry-db.ts` | code_registry 表 CRUD |

## 修改文件

| 文件 | 变更 |
|---|---|
| `src/config/system-prompts.json` | 新增 adminAgent / complexityJudge / codeGeneration / codeIteration |
| `src/db/index.ts` | DDL 新增 code_registry 表 |
