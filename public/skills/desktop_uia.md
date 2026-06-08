---
id: desktop_uia
name: Desktop UI Automation
name_cn: 桌面 UI 自动化
category: Device Automation
category_cn: 设备自动化
description: Access and manipulate Windows UI elements semantically via UI Automation — no coordinates needed. Use this as the primary interaction method for standard Windows applications.
description_cn: 通过 UI Automation 语义操作 Windows UI 元素 — 无需坐标。对标准 Windows 应用，优先使用此技能。
usage: |
  ## Quick Start

  **Discover elements**: uia_get_interactive → see all buttons/inputs/links.

  **Click a button**: uia_click({role: "Button", name: "搜索"}).

  **Type into a field**: uia_type({text: "hello", role: "Edit"}).

  **Find element details**: uia_find_element → get position, size, state.

  **Read a property**: uia_get_property({role: "Edit", property: "Value"}).

  **Structural overview**: uia_fingerprint → compact hierarchy of the UI tree.

  ## When to use

  Use UIA tools FIRST for standard Windows apps (Office, browsers, settings, file dialogs).
  If UIA returns empty (custom-drawn UIs like QQ音乐 or games), fall back to desktop_screen tools (screenshot + coordinate clicks).

  ## Tips

  - Always uia_get_interactive first — it shows what's available.
  - Use role and name filters to narrow results.
  - Pass window_hwnd to scope operations to a specific window.
  - After a UIA type, wait briefly with desktop_wait for the UI to update.
usage_cn: |
  ## 快速开始

  **发现元素**：uia_get_interactive → 查看所有按钮/输入框/链接。

  **点击按钮**：uia_click({role: "Button", name: "搜索"})。

  **输入文字**：uia_type({text: "你好", role: "Edit"})。

  **查找元素详情**：uia_find_element → 获取位置、大小、状态。

  **读取属性**：uia_get_property({role: "Edit", property: "Value"})。

  **结构概览**：uia_fingerprint → UI 树的紧凑层级摘要。

  ## 使用时机

  对标准 Windows 应用（Office、浏览器、设置、文件对话框）优先使用 UIA 工具。
  如果 UIA 返回空（自定义绘制的 UI，如 QQ 音乐或游戏），回退到 desktop_screen 工具（截图 + 坐标点击）。

  ## 使用技巧

  - 总是先调用 uia_get_interactive — 它能展示当前可用的所有元素。
  - 使用 role 和 name 过滤缩小结果范围。
  - 传入 window_hwnd 将操作限定到特定窗口。
  - UIA 输入后调用 desktop_wait 等待界面更新。
---

Interact with Windows UI elements via UI Automation (UIA). No coordinates needed — find and manipulate elements by their role, name, and properties.

## Tools

```json
[
  {
    "name": "uia_get_interactive",
    "description": "Get all interactive UI elements (buttons, inputs, links, etc.) from a window via UI Automation. Returns element roles, names, and properties. Use this FIRST before uia_click/uia_type to discover available elements.",
    "name_cn": "桌面获取可交互元素",
    "description_cn": "通过 UI Automation 获取窗口中所有可交互的 UI 元素（按钮、输入框、链接等），返回元素的角色、名称和属性。在使用 uia_click/uia_type 前优先调用此工具发现可用元素。",
    "parameters": {
      "type": "object",
      "properties": {
        "window_hwnd": { "type": "integer", "description": "Optional window handle to scope the search" }
      }
    }
  },
  {
    "name": "uia_click",
    "description": "Click a UI element by its role and name using UI Automation. No coordinates needed.",
    "name_cn": "语义点击",
    "description_cn": "通过 UI Automation 按角色和名称点击 UI 元素，无需坐标。",
    "parameters": {
      "type": "object",
      "properties": {
        "role": { "type": "string", "description": "Element role (e.g., Button, Edit, Link, CheckBox)" },
        "name": { "type": "string", "description": "Element name/label (partial match)" },
        "window_hwnd": { "type": "integer", "description": "Optional window handle" }
      },
      "required": ["role"]
    }
  },
  {
    "name": "uia_type",
    "description": "Type text into a UI element found by role/name using UI Automation. No coordinates needed.",
    "name_cn": "语义输入",
    "description_cn": "通过 UI Automation 按角色和名称找到元素并输入文字，无需坐标。",
    "parameters": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "Text to type" },
        "role": { "type": "string", "description": "Target element role (e.g., Edit, ComboBox)" },
        "name": { "type": "string", "description": "Target element name/label" },
        "window_hwnd": { "type": "integer", "description": "Optional window handle" }
      },
      "required": ["text"]
    }
  },
  {
    "name": "uia_find_element",
    "description": "Find a specific UI element by role and name. Returns detailed element info including bounding rectangle.",
    "name_cn": "查找元素",
    "description_cn": "通过角色和名称查找特定 UI 元素，返回详细信息（含边界矩形）。",
    "parameters": {
      "type": "object",
      "properties": {
        "role": { "type": "string", "description": "Element role to find" },
        "name": { "type": "string", "description": "Element name/label" },
        "window_hwnd": { "type": "integer", "description": "Optional window handle" }
      },
      "required": ["role"]
    }
  },
  {
    "name": "uia_get_property",
    "description": "Get a specific property value of a UI element (e.g., Value, Name, BoundingRectangle, IsEnabled).",
    "name_cn": "获取元素属性",
    "description_cn": "获取 UI 元素的特定属性值（如 Value、Name、BoundingRectangle、IsEnabled）。",
    "parameters": {
      "type": "object",
      "properties": {
        "role": { "type": "string", "description": "Element role" },
        "name": { "type": "string", "description": "Element name/label" },
        "property": { "type": "string", "description": "Property name to retrieve" },
        "window_hwnd": { "type": "integer", "description": "Optional window handle" }
      },
      "required": ["role", "property"]
    }
  },
  {
    "name": "uia_fingerprint",
    "description": "Get a structural fingerprint of a window's UI tree. Returns a compact summary of element hierarchy and types.",
    "name_cn": "UI 指纹",
    "description_cn": "获取窗口 UI 树的结构指纹，返回元素层级和类型的紧凑摘要。",
    "parameters": {
      "type": "object",
      "properties": {
        "window_hwnd": { "type": "integer", "description": "Optional window handle" }
      }
    }
  }
]
```
