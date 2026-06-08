---
id: app_builder
name: App Builder
name_cn: 应用构建器
category: Application
category_cn: 应用程序
description: Save, list, update, and delete generated applications. Generated apps run in a WebView with access to native device capabilities via the window.OpenPaw.call() JavaScript API.
description_cn: 保存、列出、更新和删除生成的应用。生成的应用在 WebView 中运行，可通过 window.OpenPaw.call() JavaScript API 访问原生设备能力。
usage: |
  ## Quick Start

  1. **Generate an app**: Use AI chat to describe the app you want — the LLM will generate HTML/CSS/JS code
  2. **Save**: save_app({name, code}) — persists the generated code
  3. **List**: list_apps — see all saved apps
  4. **Edit**: get_app({id}) → update_app({id, code}) — modify existing apps
  5. **Delete**: delete_app({id}) — remove unwanted apps

  ## Generated App Capabilities

  - Runs in a WebView sandbox
  - Access native APIs via `window.OpenPaw.call(method, params)`
  - Supports multi-page apps
  - Persistent storage per app
usage_cn: |
  ## 快速开始

  1. **生成应用**：在 AI 对话中描述你想要的应用 — LLM 将生成 HTML/CSS/JS 代码
  2. **保存**：save_app({name, code}) — 持久化生成的代码
  3. **列表**：list_apps — 查看所有已保存的应用
  4. **编辑**：get_app({id}) → update_app({id, code}) — 修改已有应用
  5. **删除**：delete_app({id}) — 移除不需要的应用

  ## 生成应用的能力

  - 在 WebView 沙箱中运行
  - 通过 `window.OpenPaw.call(method, params)` 访问原生 API
  - 支持多页面应用
  - 每个应用独立持久化存储
---

Save, list, update, and delete generated applications.
Generated apps run in a WebView with access to native device capabilities via the window.OpenPaw.call() JavaScript API.
Match the app complexity to what the user asks for.

## Tools

```json
[
  {
    "name": "save_app",
    "description": "Save a new generated application. The code should be complete, working HTML/CSS/JS. Native device capabilities (camera, GPS, storage, notifications, etc.) are available via the global window.OpenPaw.call() JavaScript function. Phone tools (tap, swipe, type, scroll) can be invoked via screen automations. The app uses phone screen monitoring and notifications to keep data fresh. Multi-page support is available. Include all required pages for complex apps. Make sure to use the full capabilities available.",
    "name_cn": "保存应用",
    "description_cn": "保存新生成的应用。代码应为完整可运行的 HTML/CSS/JS。原生设备能力（摄像头、GPS、存储、通知等）可通过 window.OpenPaw.call() JavaScript 函数调用。支持多页面应用，请为复杂应用包含所有必需页面。",
    "parameters": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "description": "App name" },
        "code": { "type": "string", "description": "HTML/CSS/JS source code" },
        "description": { "type": "string", "description": "Brief description" }
      },
      "required": ["name", "code"]
    }
  },
  {
    "name": "list_apps",
    "description": "List all saved applications. Returns app metadata (id, name, description, creation date).",
    "name_cn": "构建列出应用",
    "description_cn": "列出所有已保存的应用，返回应用元数据（ID、名称、描述、创建日期）。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "get_app",
    "description": "Get a saved application by ID. Returns full app data including the source code.",
    "name_cn": "获取应用",
    "description_cn": "通过 ID 获取已保存的应用，返回完整应用数据（含源代码）。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "App ID" }
      },
      "required": ["id"]
    }
  },
  {
    "name": "update_app",
    "description": "Update an existing application's code.",
    "name_cn": "更新应用",
    "description_cn": "更新已有应用的代码。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "App ID" },
        "code": { "type": "string", "description": "New HTML/CSS/JS source code" }
      },
      "required": ["id", "code"]
    }
  },
  {
    "name": "delete_app",
    "description": "Delete an application by ID.",
    "name_cn": "删除应用",
    "description_cn": "通过 ID 删除应用。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "App ID" }
      },
      "required": ["id"]
    }
  }
]
```
