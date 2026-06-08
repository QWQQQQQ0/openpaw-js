---
id: phone_screen
name: Phone Screen Control
name_cn: 手机屏幕控制
category: Device Automation
category_cn: 设备自动化
description: View and control an Android phone screen via accessibility service. Supports tapping, swiping, typing, scrolling, UI tree inspection, event polling, and AI-driven automation.
description_cn: 通过无障碍服务查看和控制 Android 手机屏幕。支持点击、滑动、输入、滚动、UI 树检查、事件轮询和 AI 驱动自动化。
usage: |
  ## Quick Start

  1. **See the screen**: phone_screenshot → view current phone state
  2. **Discover elements**: phone_get_ui → get UI tree with element positions
  3. **Tap**: phone_tap({x, y}) or phone_tap_element({selector})
  4. **Swipe**: phone_swipe({x1, y1, x2, y2})
  5. **Type**: phone_type({text})
  6. **Navigate**: phone_back / phone_home

  ## Tips

  - Phone features are stubs until native accessibility service is wired (Phase 7+).
  - Use phone_get_ui to find element coordinates before tapping.
  - phone_poll_events monitors screen changes and notifications.
  - phone_wait after each interaction for UI to settle.
usage_cn: |
  ## 快速开始

  1. **查看屏幕**：phone_screenshot → 查看当前手机状态
  2. **发现元素**：phone_get_ui → 获取 UI 树及元素位置
  3. **点击**：phone_tap({x, y}) 或 phone_tap_element({selector})
  4. **滑动**：phone_swipe({x1, y1, x2, y2})
  5. **输入**：phone_type({text})
  6. **导航**：phone_back / phone_home

  ## 使用技巧

  - 手机功能需等待原生无障碍服务接入（Phase 7+），当前为占位桩。
  - 点击前先用 phone_get_ui 获取元素坐标。
  - phone_poll_events 可监控屏幕变化和通知。
  - 每次交互后使用 phone_wait 等待界面稳定。
---

View and control the Android phone screen via accessibility service.
Supports tapping, swiping, typing, scrolling, and AI-driven automation.
Also provides event polling for screen change monitoring and notification listening.

## Tools

```json
[
  {
    "name": "phone_screenshot",
    "description": "Take a screenshot of the current phone screen. Returns a PNG image. Use this FIRST to understand the current state.",
    "name_cn": "手机截图",
    "description_cn": "截取当前手机屏幕截图，返回 PNG 图像。优先使用此工具了解当前状态。",
    "parameters": {
      "type": "object",
      "properties": {
        "quality": { "type": "integer", "description": "JPEG quality (1–100)" }
      }
    }
  },
  {
    "name": "phone_tap",
    "description": "Tap at screen coordinates (x, y). Use phone_get_ui first to find element positions.",
    "name_cn": "手机点击坐标",
    "description_cn": "在屏幕坐标 (x, y) 处点击。先用 phone_get_ui 获取元素位置。",
    "parameters": {
      "type": "object",
      "properties": {
        "x": { "type": "integer", "description": "X coordinate" },
        "y": { "type": "integer", "description": "Y coordinate" }
      },
      "required": ["x", "y"]
    }
  },
  {
    "name": "phone_tap_element",
    "description": "Tap a UI element by its accessibility selector or text.",
    "name_cn": "手机点击元素",
    "description_cn": "通过无障碍选择器或文本匹配点击 UI 元素。",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string", "description": "Accessibility selector or text match" }
      },
      "required": ["selector"]
    }
  },
  {
    "name": "phone_swipe",
    "description": "Swipe from (x1, y1) to (x2, y2). Use for scrolling, swiping between screens.",
    "name_cn": "滑动",
    "description_cn": "从 (x1, y1) 滑动到 (x2, y2)。用于滚动、切换屏幕等操作。",
    "parameters": {
      "type": "object",
      "properties": {
        "x1": { "type": "integer" }, "y1": { "type": "integer" },
        "x2": { "type": "integer" }, "y2": { "type": "integer" },
        "duration": { "type": "integer", "description": "Swipe duration in ms (default 300)" }
      },
      "required": ["x1", "y1", "x2", "y2"]
    }
  },
  {
    "name": "phone_type",
    "description": "Type text into the currently focused field.",
    "name_cn": "手机输入文字",
    "description_cn": "在当前聚焦的输入框中输入文字。",
    "parameters": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "Text to type" }
      },
      "required": ["text"]
    }
  },
  {
    "name": "phone_scroll",
    "description": "Scroll the screen by a delta amount.",
    "name_cn": "滚动屏幕",
    "description_cn": "按指定偏移量滚动屏幕。",
    "parameters": {
      "type": "object",
      "properties": {
        "x": { "type": "integer" }, "y": { "type": "integer" },
        "dx": { "type": "integer" }, "dy": { "type": "integer" },
        "duration": { "type": "integer" }
      },
      "required": ["x", "y", "dx", "dy"]
    }
  },
  {
    "name": "phone_back",
    "description": "Press the Android back button.",
    "name_cn": "返回",
    "description_cn": "按下 Android 返回键。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "phone_home",
    "description": "Press the Android home button.",
    "name_cn": "回到主页",
    "description_cn": "按下 Android 主页键。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "phone_get_ui",
    "description": "Get the UI tree (accessibility hierarchy) of the current screen with element positions.",
    "name_cn": "获取 UI 树",
    "description_cn": "获取当前屏幕的 UI 树（无障碍层级结构）及元素位置。",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "phone_poll_events",
    "description": "Poll for recent screen change events and notifications.",
    "name_cn": "轮询事件",
    "description_cn": "轮询最近的屏幕变化事件和通知。",
    "parameters": {
      "type": "object",
      "properties": {
        "since": { "type": "string", "description": "ISO timestamp to filter events from" }
      }
    }
  },
  {
    "name": "phone_wait",
    "description": "Wait for a specified duration for the UI to settle.",
    "name_cn": "手机等待",
    "description_cn": "等待指定时长，让 UI 稳定下来。",
    "parameters": {
      "type": "object",
      "properties": {
        "durationMs": { "type": "integer", "description": "Wait duration in milliseconds" }
      },
      "required": ["durationMs"]
    }
  },
  {
    "name": "phone_done",
    "description": "Mark the current automation task as complete.",
    "name_cn": "手机完成任务",
    "description_cn": "标记当前自动化任务已完成。",
    "parameters": {
      "type": "object",
      "properties": {
        "summary": { "type": "string", "description": "Summary of what was accomplished" }
      },
      "required": ["summary"]
    }
  }
]
```
