// 浏览器检测与过滤

import type { InteractiveNode } from './types';

/** 浏览器窗口类名特征 */
const BROWSER_WINDOW_CLASSES = [
  'Chrome_WidgetWin_1',   // Chrome, Edge, Chromium
  'MozillaWindowClass',   // Firefox
  'ApplicationFrameWindow', // UWP Edge
];

/** 浏览器地址栏 automation_id 特征 */
const URL_BAR_IDS = ['OmniboxViewViews', 'urlbar-input', 'view19282', 'editComponent'];

/** 浏览器外壳元素特征（不应学习的） */
const BROWSER_CHROME_ROLES = ['tab', 'tabitem', 'toolbar', 'menubar', 'scrollbar', 'titlebar', 'statusbar'];
const BROWSER_CHROME_IDS = [
  // 导航按钮
  'back', 'forward', 'reload', 'refresh', 'home', 'stop',
  // 地址栏相关（不包括地址栏本身）
  'bookmark', 'star', 'zoom',
  // 标签栏
  'tab-strip', 'tab-strip-region', 'new-tab', 'tab-close',
  // 窗口控制
  'minimize', 'maximize', 'close', 'caption', 'app-menu',
  // 工具栏
  'toolbar', 'menu-button', 'extensions', 'puzzle',
  // 侧边栏
  'sidebar', 'side-panel',
  // 下载栏
  'download', 'download-bar', 'download-shelf',
  // 通知
  'notification', 'permission',
];

/** 浏览器窗口标题特征 */
const BROWSER_TITLE_KEYWORDS = [
  'Google Chrome', 'Microsoft Edge', 'Firefox', 'Safari', 'Opera',
  'Brave', 'Vivaldi', 'Arc', 'Chromium',
];

/** 判断窗口是否是浏览器 */
export function isBrowserWindow(windowClass: string, nodes: InteractiveNode[], windowTitle?: string): boolean {
  // 方法0: 通过窗口标题判断（最可靠）
  if (windowTitle && BROWSER_TITLE_KEYWORDS.some(keyword => windowTitle.includes(keyword))) {
    return true;
  }

  // 方法1: 通过窗口类名判断
  if (BROWSER_WINDOW_CLASSES.some(cls => windowClass.includes(cls))) return true;

  // 方法2: 通过地址栏 ID 判断
  if (nodes.some(n => URL_BAR_IDS.some(id => n.automation_id?.includes(id)))) return true;

  // 方法3: 通过节点特征组合判断（有 tab + toolbar + edit 组合）
  const hasTab = nodes.some(n => n.role.toLowerCase().includes('tab'));
  const hasToolbar = nodes.some(n => n.role.toLowerCase().includes('toolbar'));
  const hasEdit = nodes.some(n => n.role.toLowerCase() === 'edit');
  if (hasTab && hasToolbar && hasEdit) return true;

  // 方法4: 通过名称特征判断（地址栏通常有 URL 相关的名称）
  const hasUrlLikeEdit = nodes.some(n => {
    if (n.role.toLowerCase() !== 'edit') return false;
    const name = (n.name || '').toLowerCase();
    return name.includes('http') || name.includes('www') || name.includes('.com') || name.includes('.cn');
  });
  if (hasUrlLikeEdit && hasTab) return true;

  return false;
}

/** 尝试将字符串解析为 URL，自动补全协议 */
function tryParseUrl(value: string): string | null {
  if (!value || value.length < 3) return null;

  // 已经是完整 URL
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      new URL(value);
      return value;
    } catch { return null; }
  }

  // 尝试补全 https://
  if (value.includes('.') && !value.includes(' ')) {
    try {
      const url = new URL(`https://${value}`);
      return url.href;
    } catch { /* not a URL */ }
  }

  return null;
}

/** 从浏览器 UIA 节点中提取 URL */
export function extractBrowserUrlFromNodes(nodes: InteractiveNode[]): string | null {
  // 方法1: 通过已知的地址栏 ID 查找
  for (const id of URL_BAR_IDS) {
    const bar = nodes.find(n => n.automation_id?.includes(id) && n.role.toLowerCase() === 'edit');
    if (bar?.name) {
      const url = tryParseUrl(bar.name);
      if (url) {
        return url;
      }
    }
  }

  // 方法2: 遍历所有 edit 节点，查找像 URL 的值
  for (const node of nodes) {
    if (node.role.toLowerCase() !== 'edit') continue;
    const val = node.name || '';
    const url = tryParseUrl(val);
    if (url) {
      return url;
    }
  }

  return null;
}

/** 浏览器外壳名称特征（中英文） */
const BROWSER_CHROME_NAMES = [
  // 中文
  '后退', '返回', '前进', '刷新', '主页', '书签', '收藏', '下载', '设置', '菜单',
  '最小化', '最大化', '关闭', '全屏', '新标签', '搜索', '扩展', '插件',
  '地址', '搜索栏', '地址栏',
  // 英文
  'back', 'forward', 'reload', 'refresh', 'home', 'bookmark', 'favorite',
  'download', 'setting', 'menu', 'minimize', 'maximize', 'close', 'fullscreen',
  'new tab', 'search', 'extension', 'addon', 'puzzle', 'address',
];

/** 过滤掉浏览器外壳元素，只保留网页内容区域的节点 */
export function filterBrowserChromeNodes(nodes: InteractiveNode[]): InteractiveNode[] {
  return nodes.filter(n => {
    const role = n.role.toLowerCase();
    const id = (n.automation_id || '').toLowerCase();
    const name = (n.name || '').toLowerCase();

    // 过滤浏览器外壳角色
    if (BROWSER_CHROME_ROLES.some(r => role.includes(r))) return false;

    // 过滤浏览器外壳 ID
    if (BROWSER_CHROME_IDS.some(c => id.includes(c))) return false;

    // 过滤窗口控制按钮（按名称）
    if (BROWSER_CHROME_NAMES.some(k => name.includes(k))) return false;

    // 过滤地址栏本身（只保留网页内容）
    if (id.includes('omnibox') || id.includes('urlbar') || id.includes('address')) return false;

    return true;
  });
}

/** 从 URL 提取应用名（hostname） */
export function appNameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * 从窗口标题中提取应用名称
 *
 * 很多桌面应用的窗口标题格式为 "文档名 - 应用名" 或 "文档名 – 应用名"
 * 例如：
 *   "README.md - Visual Studio Code" → "Visual Studio Code"
 *   "document.docx - Word" → "Word"
 *   "无标题 - 记事本" → "无标题 - 记事本"（没有分隔符时返回原标题）
 *
 * @param windowTitle 窗口标题
 * @returns 提取的应用名称，如果无法提取则返回原标题
 */
export function extractAppNameFromTitle(windowTitle: string): string {
  if (!windowTitle || windowTitle.trim().length === 0) {
    return windowTitle;
  }

  // 尝试匹配 " - " 或 " – " 分隔符（英文和中文破折号）
  const separators = [' - ', ' – ', ' — '];

  for (const sep of separators) {
    const lastIndex = windowTitle.lastIndexOf(sep);
    if (lastIndex > 0 && lastIndex < windowTitle.length - sep.length) {
      const appPart = windowTitle.substring(lastIndex + sep.length).trim();
      // 确保提取的部分不是空的，且不是纯数字（可能是版本号）
      if (appPart.length > 0 && !/^\d+(\.\d+)*$/.test(appPart)) {
        return appPart;
      }
    }
  }

  // 没有找到分隔符，返回原标题
  return windowTitle;
}

/** 过滤浏览器视觉元素中的外壳部分 */
export function filterBrowserChromeVision(elements: import('./types').VisionElement[]): import('./types').VisionElement[] {
  return elements.filter(el => {
    const label = (el.label || '').toLowerCase();
    const desc = (el.description || '').toLowerCase();

    // 按名称过滤外壳元素
    if (BROWSER_CHROME_NAMES.some(k => label.includes(k) || desc.includes(k))) return false;

    // 过滤标签栏相关
    if (label.includes('tab') && !label.includes('table')) return false;
    if (desc.includes('标签页') || desc.includes('标签栏')) return false;

    // 过滤地址栏相关
    if (label.includes('地址') || label.includes('address') || label.includes('url')) return false;
    if (desc.includes('地址栏') || desc.includes('搜索栏')) return false;

    // 按位置过滤：浏览器外壳通常在窗口顶部 ~8% 区域
    // relativeY 是相对窗口高度的比例 (0-1)
    if (el.relativeY < 0.08) return false;

    return true;
  });
}
