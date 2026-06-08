---
id: web_screen
name: Web Screen Control
name_cn: 网页浏览器控制
category: Device Automation
category_cn: 设备自动化
description: View and control web pages via Playwright (Chromium) with accessibility tree support. Supports navigation, semantic clicking by role/selector, form filling, scrolling, and legacy extension bridge fallback.
description_cn: 通过 Playwright（Chromium）查看和控制网页，支持无障碍树语义操作。支持页面导航、按角色/选择器点击、表单填写、滚动，以及旧版扩展桥接兜底。
usage: |
  ## Quick Start

  1. **Launch browser**: web_pw_launch（headless defaults to true）
  2. **Navigate**: web_pw_navigate({url:"https://example.com"})
  3. **Discover elements**: web_pw_get_interactive — returns DOM nodes + Accessibility Tree
  4. **Interact**: web_pw_click_selector / web_pw_click_role / web_pw_fill
  5. **Close**: web_pw_close

  ## Tool Categories

  | Priority | Tools | When |
  |----------|-------|------|
  | 1. Playwright | web_pw_launch, web_pw_navigate, web_pw_get_interactive, web_pw_click_selector, web_pw_click_role, web_pw_fill, web_pw_scroll, web_pw_close | Primary (recommended) |
  | 2. Legacy fallback | web_get_ui, web_screenshot, web_click, web_click_element, web_type, web_fill, web_scroll, web_navigate, web_extract, web_list_tabs, web_press_key, web_wait, web_done | When Playwright unavailable |

  ## Tips

  - Always call web_pw_launch FIRST before any other Playwright tool.
  - Use web_pw_get_interactive instead of screenshots — returns structured data.
  - Prefer CSS selectors and ARIA roles over coordinate-based clicking.
  - After navigation, wait briefly for page load.
usage_cn: |
  ## 快速开始

  1. **启动浏览器**：web_pw_launch（headless 默认为 true）
  2. **导航**：web_pw_navigate({url:"https://example.com"})
  3. **发现元素**：web_pw_get_interactive — 返回 DOM 节点 + 无障碍树
  4. **交互**：web_pw_click_selector / web_pw_click_role / web_pw_fill
  5. **关闭**：web_pw_close

  ## 工具分类

  | 优先级 | 工具 | 适用场景 |
  |--------|------|----------|
  | 1. Playwright | web_pw_launch, web_pw_navigate, web_pw_get_interactive, web_pw_click_selector, web_pw_click_role, web_pw_fill, web_pw_scroll, web_pw_close | 首选推荐 |
  | 2. 旧版兜底 | web_get_ui, web_screenshot, web_click, web_click_element, web_type, web_fill, web_scroll, web_navigate, web_extract, web_list_tabs, web_press_key, web_wait, web_done | Playwright 不可用时 |

  ## 使用技巧

  - 使用任何 Playwright 工具前，必须先调用 web_pw_launch。
  - 优先使用 web_pw_get_interactive 代替截图 — 返回结构化数据。
  - 优先使用 CSS 选择器和 ARIA 角色，而非坐标点击。
  - 导航后等待页面加载完成。
---

View and control web pages via browser extension or generated app iframe.
Supports DOM inspection, element interaction, form filling, navigation, and more.

## Tools

```json
[
  {
    "name": "web_get_ui",
    "description": "Get the DOM tree via browser extension (legacy). Prefer web_pw_get_interactive when Playwright is available.",
    "name_cn": "获取页面 UI",
    "description_cn": "通过浏览器扩展获取 DOM 树（旧版）。Playwright 可用时优先使用 web_pw_get_interactive。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "web_screenshot",
    "description": "Take a screenshot via browser extension (legacy).",
    "name_cn": "网页截图",
    "description_cn": "通过浏览器扩展截取网页截图（旧版）。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "web_click",
    "description": "Click at coordinates (legacy). Prefer web_pw_click_selector or web_pw_click_role.",
    "name_cn": "网页点击坐标",
    "description_cn": "在指定坐标处点击（旧版）。优先使用 web_pw_click_selector 或 web_pw_click_role。",
    "parameters": {
      "type": "object",
      "properties": {
        "x": { "type": "number" },
        "y": { "type": "number" }
      },
      "required": ["x", "y"]
    }
  },
  {
    "name": "web_click_element",
    "description": "Click by CSS selector (legacy). Prefer web_pw_click_selector.",
    "name_cn": "网页点击元素",
    "description_cn": "通过 CSS 选择器点击元素（旧版）。优先使用 web_pw_click_selector。",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string" }
      },
      "required": ["selector"]
    }
  },
  {
    "name": "web_type",
    "description": "Type text (legacy).",
    "name_cn": "网页输入文字",
    "description_cn": "在当前焦点元素中输入文字（旧版）。",
    "parameters": {
      "type": "object",
      "properties": {
        "text": { "type": "string" }
      },
      "required": ["text"]
    }
  },
  {
    "name": "web_fill",
    "description": "Fill input by selector (legacy). Prefer web_pw_fill.",
    "name_cn": "填写表单",
    "description_cn": "通过选择器填写输入框（旧版）。优先使用 web_pw_fill。",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string" },
        "text": { "type": "string" }
      },
      "required": ["selector", "text"]
    }
  },
  {
    "name": "web_scroll",
    "description": "Scroll page (legacy).",
    "name_cn": "网页滚动页面",
    "description_cn": "滚动页面（旧版）。",
    "parameters": {
      "type": "object",
      "properties": {
        "dx": { "type": "number" },
        "dy": { "type": "number" }
      },
      "required": ["dx", "dy"]
    }
  },
  {
    "name": "web_scroll_into_view",
    "description": "Scroll element into view (legacy).",
    "name_cn": "滚动到元素",
    "description_cn": "将指定元素滚动到可见区域（旧版）。",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string" }
      },
      "required": ["selector"]
    }
  },
  {
    "name": "web_press_key",
    "description": "Press a keyboard key.",
    "name_cn": "网页按键",
    "description_cn": "按下一个键盘按键。",
    "parameters": {
      "type": "object",
      "properties": {
        "key": { "type": "string" }
      },
      "required": ["key"]
    }
  },
  {
    "name": "web_navigate",
    "description": "Navigate to URL (legacy). Prefer web_pw_navigate.",
    "name_cn": "网页页面导航",
    "description_cn": "导航到指定 URL（旧版）。优先使用 web_pw_navigate。",
    "parameters": {
      "type": "object",
      "properties": {
        "url": { "type": "string" }
      },
      "required": ["url"]
    }
  },
  {
    "name": "web_extract",
    "description": "Extract text from element (legacy).",
    "name_cn": "提取文本",
    "description_cn": "从指定元素提取文本内容（旧版）。",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string" }
      },
      "required": ["selector"]
    }
  },
  {
    "name": "web_list_tabs",
    "description": "List browser tabs (legacy).",
    "name_cn": "列出标签页",
    "description_cn": "列出所有浏览器标签页（旧版）。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "web_wait",
    "description": "Wait for page load.",
    "name_cn": "等待加载",
    "description_cn": "等待页面加载完成。",
    "parameters": {
      "type": "object",
      "properties": {
        "durationMs": { "type": "integer" }
      },
      "required": ["durationMs"]
    }
  },
  {
    "name": "web_done",
    "description": "Mark task complete.",
    "name_cn": "网页完成任务",
    "description_cn": "标记任务已完成。",
    "parameters": {
      "type": "object",
      "properties": {
        "summary": { "type": "string" }
      },
      "required": ["summary"]
    }
  },
  {
    "name": "web_pw_launch",
    "description": "Launch a Playwright Chromium browser instance. Must be called FIRST before any other Playwright tool.",
    "name_cn": "启动浏览器",
    "description_cn": "启动 Playwright Chromium 浏览器实例。使用其他 Playwright 工具前必须先调用此工具。",
    "parameters": {
      "type": "object",
      "properties": {
        "headless": { "type": "boolean", "description": "Run in headless mode (default true)" }
      }
    }
  },
  {
    "name": "web_pw_navigate",
    "description": "Navigate to a URL via Playwright.",
    "name_cn": "Playwright页面导航",
    "description_cn": "通过 Playwright 导航到指定 URL。",
    "parameters": {
      "type": "object",
      "properties": {
        "url": { "type": "string", "description": "URL to navigate to" }
      },
      "required": ["url"]
    }
  },
  {
    "name": "web_pw_get_interactive",
    "description": "Get all interactive elements from the current page via Playwright accessibility tree. Returns DOM nodes with roles, names, and selectors. Use this to discover elements before clicking/typing.",
    "name_cn": "Playwright获取可交互元素",
    "description_cn": "通过 Playwright 无障碍树获取当前页面所有可交互元素，返回 DOM 节点的角色、名称和选择器。在点击/输入前优先调用此工具发现元素。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "web_pw_click_selector",
    "description": "Click an element by CSS selector via Playwright.",
    "name_cn": "选择器点击",
    "description_cn": "通过 Playwright 使用 CSS 选择器点击元素。",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string", "description": "CSS selector" }
      },
      "required": ["selector"]
    }
  },
  {
    "name": "web_pw_click_role",
    "description": "Click an element by ARIA role and optional name via Playwright.",
    "name_cn": "角色点击",
    "description_cn": "通过 Playwright 使用 ARIA 角色和可选名称点击元素。",
    "parameters": {
      "type": "object",
      "properties": {
        "role": { "type": "string", "description": "ARIA role (e.g., button, link, textbox)" },
        "name": { "type": "string", "description": "Accessible name (partial match)" }
      },
      "required": ["role"]
    }
  },
  {
    "name": "web_pw_fill",
    "description": "Fill an input field by CSS selector via Playwright.",
    "name_cn": "填写输入框",
    "description_cn": "通过 Playwright 使用 CSS 选择器填写输入框。",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string", "description": "CSS selector for the input" },
        "text": { "type": "string", "description": "Text to fill" }
      },
      "required": ["selector", "text"]
    }
  },
  {
    "name": "web_pw_scroll",
    "description": "Scroll the page via Playwright.",
    "name_cn": "Playwright滚动页面",
    "description_cn": "通过 Playwright 滚动页面。",
    "parameters": {
      "type": "object",
      "properties": {
        "delta_y": { "type": "number", "description": "Vertical scroll amount (positive = down)" }
      }
    }
  },
  {
    "name": "web_pw_close",
    "description": "Close the Playwright browser instance.",
    "name_cn": "关闭浏览器",
    "description_cn": "关闭 Playwright 浏览器实例。",
    "parameters": { "type": "object", "properties": {} }
  }
]
```
