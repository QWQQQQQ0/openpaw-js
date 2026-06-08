---
id: code_tools
name: Code Tools
name_cn: 代码工具
category: Code Generation
category_cn: 代码生成
description: Code generation, file I/O, and sandbox execution tools for Developer Agents.
description_cn: 开发者代理的代码生成、文件 I/O 和沙箱执行工具。
usage: |
  ## Quick Start

  1. **Write a file**: write_file({file_path, content}) — saves code to the project directory
  2. **Read a file**: read_file({file_path}) — loads file content from the project
  3. **Generate code**: generate_code({task, language, context?, constraints?}) — LLM generates code from a description
  4. **Execute code**: execute_code({code, language, timeout_ms?}) — runs code in a sandbox (JS/Python/SQL/HTML)
  5. **Iterate code**: iterate_code({task, code, language, max_iterations?}) — auto-fix errors up to 3 iterations
  6. **Save to registry**: save_code({name, code, language, description?, tags?}) — persist for reuse
  7. **Search registry**: list_code({search?, language?, tag?}) — find saved code snippets

  ## Execution Environment

  - JavaScript: sandboxed `new Function` with blocked globals (eval, setTimeout, etc.)
  - Python: sidecar python-engine
  - SQL: local SQLite via sql.js
  - HTML: (placeholder — not yet implemented)

  File I/O uses Tauri plugin-fs when available, falling back to in-memory cache.
usage_cn: |
  ## 快速开始

  1. **写入文件**：write_file({file_path, content}) — 将代码保存到项目目录
  2. **读取文件**：read_file({file_path}) — 从项目加载文件内容
  3. **生成代码**：generate_code({task, language, context?, constraints?}) — LLM 根据描述生成代码
  4. **执行代码**：execute_code({code, language, timeout_ms?}) — 在沙箱中运行代码（JS/Python/SQL/HTML）
  5. **迭代代码**：iterate_code({task, code, language, max_iterations?}) — 自动修复错误（最多 3 次）
  6. **保存到注册表**：save_code({name, code, language, description?, tags?}) — 持久化以供重用
  7. **搜索注册表**：list_code({search?, language?, tag?}) — 查找已保存的代码片段

  ## 执行环境

  - JavaScript：沙箱 `new Function`，阻止危险全局变量（eval、setTimeout 等）
  - Python：侧车 python-engine
  - SQL：通过 sql.js 的本地 SQLite
  - HTML：（占位 — 尚未实现）

  文件 I/O 优先使用 Tauri plugin-fs，回退到内存缓存。
---

Code generation, file I/O, and sandbox execution tools for Developer Agents.

## Tools

```json
[
  {
    "name": "write_file",
    "description": "Write code content to a file in the project directory",
    "name_cn": "写入文件",
    "description_cn": "将代码内容写入项目目录中的文件",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Relative file path within the project (e.g. src/utils/helper.ts)"
        },
        "content": {
          "type": "string",
          "description": "File content to write"
        }
      },
      "required": ["file_path", "content"]
    }
  },
  {
    "name": "read_file",
    "description": "Read file content from the project directory",
    "name_cn": "读取文件",
    "description_cn": "从项目目录读取文件内容",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Relative file path within the project"
        }
      },
      "required": ["file_path"]
    }
  },
  {
    "name": "generate_code",
    "description": "Generate code using the LLM for a given task description. Returns extracted code blocks.",
    "name_cn": "生成代码",
    "description_cn": "根据任务描述使用 LLM 生成代码，返回提取到的代码块",
    "parameters": {
      "type": "object",
      "properties": {
        "task": {
          "type": "string",
          "description": "Description of the code to generate"
        },
        "language": {
          "type": "string",
          "description": "Target programming language (javascript, python, typescript, etc.)"
        },
        "context": {
          "type": "string",
          "description": "Additional context or existing code to build upon"
        },
        "constraints": {
          "type": "string",
          "description": "Constraints or requirements the code must satisfy"
        }
      },
      "required": ["task", "language"]
    }
  },
  {
    "name": "execute_code",
    "description": "Execute code in a sandboxed environment and return the result",
    "name_cn": "执行代码",
    "description_cn": "在沙箱环境中执行代码并返回结果",
    "parameters": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "description": "Source code to execute"
        },
        "language": {
          "type": "string",
          "description": "Language (javascript, python, sql, html)",
          "enum": ["javascript", "python", "sql", "html"]
        },
        "timeout_ms": {
          "type": "number",
          "description": "Execution timeout in milliseconds (default 30000)"
        }
      },
      "required": ["code", "language"]
    }
  },
  {
    "name": "iterate_code",
    "description": "Execute code in a loop, fixing errors via LLM up to 3 iterations. Returns final result and fixed code.",
    "name_cn": "迭代代码",
    "description_cn": "循环执行代码，通过 LLM 修复错误（最多 3 次迭代），返回最终结果和修复后的代码",
    "parameters": {
      "type": "object",
      "properties": {
        "task": {
          "type": "string",
          "description": "Original task description"
        },
        "code": {
          "type": "string",
          "description": "Initial code to execute and iterate on"
        },
        "language": {
          "type": "string",
          "description": "Language (javascript, python, sql, html)",
          "enum": ["javascript", "python", "sql", "html"]
        },
        "max_iterations": {
          "type": "number",
          "description": "Maximum fix iterations (default 3)"
        }
      },
      "required": ["task", "code", "language"]
    }
  },
  {
    "name": "save_code",
    "description": "Save generated code to the code registry for future reuse",
    "name_cn": "保存代码",
    "description_cn": "将生成的代码保存到代码注册表以供将来重用",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Name for the saved code"
        },
        "code": {
          "type": "string",
          "description": "Source code to save"
        },
        "language": {
          "type": "string",
          "description": "Language (javascript, python, sql, html)",
          "enum": ["javascript", "python", "sql", "html"]
        },
        "description": {
          "type": "string",
          "description": "Optional description of the code"
        },
        "tags": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Optional tags for searching"
        }
      },
      "required": ["name", "code", "language"]
    }
  },
  {
    "name": "list_code",
    "description": "Search and list saved code entries from the code registry",
    "name_cn": "列出代码",
    "description_cn": "从代码注册表搜索并列出已保存的代码条目",
    "parameters": {
      "type": "object",
      "properties": {
        "search": {
          "type": "string",
          "description": "Optional search term for name or description"
        },
        "language": {
          "type": "string",
          "description": "Optional language filter"
        },
        "tag": {
          "type": "string",
          "description": "Optional tag filter"
        }
      }
    }
  }
]
```
