---
id: office_doc
name: Office Document Generator
name_cn: 办公文档生成器
category: Document
category_cn: 文档
description: Generate Word, Excel, and PowerPoint documents from structured content or Markdown. Supports creating professional documents with formatting, tables, and presentations.
description_cn: 从结构化内容或Markdown生成Word、Excel和PowerPoint文档。支持创建带有格式、表格和演示文稿的专业文档。
usage: |
  ## Quick Start

  ### Generate Word Document
  Use `generate_word` with title and Markdown content:
  ```
  generate_word({
    title: "项目报告",
    content: "## 第一章 概述\n\n这是项目概述...",
    author: "张三"
  })
  ```

  ### Generate Excel Spreadsheet
  Use `generate_excel` with title and sheet data:
  ```
  generate_excel({
    title: "销售报表",
    sheets: [{
      name: "Q1销售",
      headers: ["产品", "数量", "金额"],
      rows: [["产品A", 100, 5000], ["产品B", 200, 8000]]
    }]
  })
  ```

  ### Generate PowerPoint Presentation
  Use `generate_ppt` with title and slides:
  ```
  generate_ppt({
    title: "项目介绍",
    slides: [
      {title: "背景", content: "- 市场需求\n- 技术趋势"},
      {title: "方案", content: "- 架构设计\n- 实施计划"}
    ]
  })
  ```

  Or use Markdown format:
  ```
  generate_ppt({
    title: "项目介绍",
    markdown: "## 背景\n\n- 市场需求\n\n## 方案\n\n- 架构设计"
  })
  ```
usage_cn: |
  ## 快速开始

  ### 生成Word文档
  使用 `generate_word` 传入标题和Markdown内容：
  ```
  generate_word({
    title: "项目报告",
    content: "## 第一章 概述\n\n这是项目概述...",
    author: "张三"
  })
  ```

  ### 生成Excel表格
  使用 `generate_excel` 传入标题和表格数据：
  ```
  generate_excel({
    title: "销售报表",
    sheets: [{
      name: "Q1销售",
      headers: ["产品", "数量", "金额"],
      rows: [["产品A", 100, 5000], ["产品B", 200, 8000]]
    }]
  })
  ```

  ### 生成PowerPoint演示文稿
  使用 `generate_ppt` 传入标题和幻灯片：
  ```
  generate_ppt({
    title: "项目介绍",
    slides: [
      {title: "背景", content: "- 市场需求\n- 技术趋势"},
      {title: "方案", content: "- 架构设计\n- 实施计划"}
    ]
  })
  ```

  或使用Markdown格式：
  ```
  generate_ppt({
    title: "项目介绍",
    markdown: "## 背景\n\n- 市场需求\n\n## 方案\n\n- 架构设计"
  })
  ```
---

Generate Word, Excel, and PowerPoint documents from structured content or Markdown.
Supports professional formatting, tables, charts, and presentations.

## Tools

```json
[
  {
    "name": "generate_word",
    "description": "Generate a Word document (.docx) from Markdown content. Supports headings, paragraphs, bold/italic formatting, and lists. The document will be downloaded automatically.",
    "name_cn": "生成Word文档",
    "description_cn": "从Markdown内容生成Word文档(.docx)。支持标题、段落、粗体/斜体格式和列表。文档将自动下载。",
    "parameters": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Document title"
        },
        "content": {
          "type": "string",
          "description": "Markdown content for the document body"
        },
        "subtitle": {
          "type": "string",
          "description": "Optional subtitle"
        },
        "author": {
          "type": "string",
          "description": "Optional author name"
        }
      },
      "required": ["title", "content"]
    }
  },
  {
    "name": "generate_excel",
    "description": "Generate an Excel spreadsheet (.xlsx) with structured data. Supports multiple sheets, headers, and auto-formatted columns. The file will be downloaded automatically.",
    "name_cn": "生成Excel表格",
    "description_cn": "从结构化数据生成Excel表格(.xlsx)。支持多工作表、表头和自动格式化列。文件将自动下载。",
    "parameters": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Workbook title"
        },
        "sheets": {
          "type": "array",
          "description": "Array of sheet definitions",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Sheet name"
              },
              "headers": {
                "type": "array",
                "description": "Column headers",
                "items": { "type": "string" }
              },
              "rows": {
                "type": "array",
                "description": "Data rows, each row is an array of values",
                "items": {
                  "type": "array",
                  "items": {}
                }
              }
            },
            "required": ["name", "headers", "rows"]
          }
        },
        "author": {
          "type": "string",
          "description": "Optional author name"
        }
      },
      "required": ["title", "sheets"]
    }
  },
  {
    "name": "generate_ppt",
    "description": "Generate a PowerPoint presentation (.pptx). Accepts either structured slides or Markdown content (## headings become slides). Supports title slides, content slides, and two-column layouts. The file will be downloaded automatically.",
    "name_cn": "生成PPT演示文稿",
    "description_cn": "生成PowerPoint演示文稿(.pptx)。接受结构化幻灯片或Markdown内容（##标题成为幻灯片）。支持标题幻灯片、内容幻灯片和两栏布局。文件将自动下载。",
    "parameters": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Presentation title"
        },
        "slides": {
          "type": "array",
          "description": "Array of slide definitions (use this OR markdown)",
          "items": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string",
                "description": "Slide title"
              },
              "content": {
                "type": "string",
                "description": "Slide content (bullet points or text)"
              },
              "layout": {
                "type": "string",
                "description": "Slide layout: 'title', 'content', or 'two_column'",
                "enum": ["title", "content", "two_column"]
              }
            },
            "required": ["title"]
          }
        },
        "markdown": {
          "type": "string",
          "description": "Markdown content (use this OR slides). Each ## heading becomes a slide."
        },
        "author": {
          "type": "string",
          "description": "Optional author name"
        }
      },
      "required": ["title"]
    }
  }
]
```
