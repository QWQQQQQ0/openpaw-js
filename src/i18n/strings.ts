// 来源: lib/i18n/strings.dart

import { useSettingsStore } from '@/stores/settings-store';

const translations: Record<string, Record<string, string>> = {
  'app.title': { en: 'OpenPaw', zh: 'OpenPaw' },

  'nav.chat': { en: 'Chat', zh: '聊天' },
  'nav.models': { en: 'Models', zh: '模型' },
  'nav.skills': { en: 'Skills', zh: '技能' },
  'nav.apps': { en: 'Apps', zh: '应用' },
  'nav.desktop': { en: 'Desktop', zh: '桌面' },
  'nav.settings': { en: 'Settings', zh: '设置' },
  'nav.watchers': { en: 'Watchers', zh: '监控' },
  'nav.knowledge': { en: 'Knowledge', zh: '知识库' },

  'chat.title.new': { en: 'New Chat', zh: '新对话' },
  'chat.input.hint': { en: 'Send a message...', zh: '发送消息...' },
  'chat.empty.title': { en: 'Start a conversation', zh: '开始对话' },
  'chat.empty.subtitle': {
    en: 'Configure a model and start chatting.\nMarkdown, code highlighting, and multi-turn memory supported.',
    zh: '配置模型后开始聊天。\n支持 Markdown、代码高亮和多轮记忆。',
  },
  'chat.empty.action': { en: 'Add a Model', zh: '添加模型' },
  'chat.debug.title': { en: 'Tool Call Log', zh: '工具调用日志' },
  'chat.conversations': { en: 'Conversations', zh: '对话记录' },
  'chat.conversations.empty': { en: 'No conversations yet', zh: '暂无对话记录' },
  'chat.newchat': { en: 'New Chat', zh: '新建对话' },
  'chat.delete.title': { en: 'Delete conversation?', zh: '删除对话？' },
  'chat.delete.confirm': { en: '"{title}" will be permanently deleted.', zh: '"{title}" 将被永久删除。' },
  'chat.error.nomodel': { en: 'No model configured. Please add a model provider first.', zh: '未配置模型。请先添加模型提供商。' },
  'chat.error.max': { en: 'Max iterations reached', zh: '已达到最大迭代次数' },

  'modellist.title': { en: 'Model Providers', zh: '模型提供商' },
  'modellist.empty': { en: 'No models yet', zh: '暂无模型' },
  'modellist.empty.subtitle': { en: 'Add a model provider to start chatting.', zh: '添加模型提供商以开始聊天。' },
  'modellist.add': { en: 'Add Model', zh: '添加模型' },
  'modellist.edit': { en: 'Edit', zh: '编辑' },
  'modellist.setdefault': { en: 'Set as Default', zh: '设为默认' },
  'modellist.delete': { en: 'Delete', zh: '删除' },
  'modellist.default': { en: 'Default', zh: '默认' },
  'modellist.multimodal': { en: 'Vision', zh: '多模态' },

  'settings.title': { en: 'Settings', zh: '设置' },
  'settings.theme': { en: 'Theme', zh: '主题' },
  'settings.theme.auto': { en: 'Auto', zh: '自动' },
  'settings.theme.light': { en: 'Light', zh: '浅色' },
  'settings.theme.dark': { en: 'Dark', zh: '深色' },
  'settings.language': { en: 'Language', zh: '语言' },

  'skills.title': { en: 'Skills', zh: '技能' },
  'skills.empty': { en: 'No skills yet', zh: '暂无技能' },
  'skills.empty.subtitle': { en: 'Create or import a skill to get started.', zh: '创建或导入技能以开始使用。' },
  'skills.builtin': { en: 'Built-in', zh: '内置' },
  'skills.description': { en: 'Description', zh: '描述' },
  'skills.usage': { en: 'Usage Guide', zh: '使用指南' },
  'skills.tools': { en: 'Tools', zh: '工具' },
  'skills.noTools': { en: 'No tools exposed.', zh: '暂无暴露的工具。' },
  'skills.parameters': { en: 'Parameters', zh: '参数' },
  'skills.noParams': { en: 'No parameters', zh: '无参数' },
  'skills.test': { en: 'Test', zh: '测试' },
  'skills.execute': { en: 'Execute', zh: '执行' },
  'skills.close': { en: 'Close', zh: '关闭' },
  'skills.cancel': { en: 'Cancel', zh: '取消' },
  'skills.success': { en: 'Success', zh: '成功' },
  'skills.failed': { en: 'Failed', zh: '失败' },
  'skills.expose': { en: 'Expose to AI', zh: '暴露给 AI' },
  'skills.exposeOn': { en: 'Visible to AI for function calling.', zh: 'AI 可通过函数调用使用此工具。' },
  'skills.exposeOff': { en: 'Hidden from AI.', zh: '对 AI 隐藏。' },
  'skills.import': { en: 'Import', zh: '导入' },
  'skills.generate': { en: 'Generate', zh: 'AI 生成' },
  'skills.new': { en: 'New', zh: '新建' },
  'skills.createFirst': { en: 'Create First Skill', zh: '创建第一个技能' },
  'skills.selectHint': { en: 'Select a skill to view details', zh: '选择一个技能以查看详情' },
  'skills.id': { en: 'ID', zh: '标识' },
  'skills.missingParams': { en: 'Missing required parameters: {params}', zh: '缺少必填参数：{params}' },
  'skills.deleteTitle': { en: 'Delete "{name}"?', zh: '删除 "{name}"？' },
  'skills.deleteConfirm': { en: 'This cannot be undone.', zh: '此操作不可撤销。' },

  'toolmode.all': { en: 'All Tools', zh: '全部工具' },
  'toolmode.all.subtitle': { en: 'All enabled tools sent to AI', zh: '所有启用的工具发送给 AI' },
  'toolmode.none': { en: 'No Tools', zh: '无工具' },
  'toolmode.none.subtitle': { en: 'Pure chat, no tools', zh: '纯聊天，不携带工具' },
  'toolmode.favorites': { en: 'Favorites', zh: '常用工具' },
  'toolmode.favorites.subtitle': { en: 'Only favorite tools sent to AI', zh: '仅常用工具发送给 AI' },
  'toolmode.custom': { en: 'Custom...', zh: '自定义...' },
  'toolmode.custom.subtitle': { en: 'Choose which tools to send', zh: '选择要携带的工具' },
  'toolmode.selectAll': { en: 'All', zh: '全选' },
  'toolmode.clearAll': { en: 'Clear', zh: '清空' },

  'time.justnow': { en: 'Just now', zh: '刚刚' },
  'time.minutesAgo': { en: '{m}m ago', zh: '{m}分钟前' },
  'time.hoursAgo': { en: '{h}h ago', zh: '{h}小时前' },
  'time.daysAgo': { en: '{d}d ago', zh: '{d}天前' },

  'common.cancel': { en: 'Cancel', zh: '取消' },
  'common.confirm': { en: 'Confirm', zh: '确认' },
  'common.delete': { en: 'Delete', zh: '删除' },
  'common.dismiss': { en: 'Dismiss', zh: '关闭' },
  'common.error': { en: 'Error', zh: '错误' },
};

type Locale = 'en' | 'zh';

let currentLocale: Locale = 'zh';

export function setLocale(locale: Locale) {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function useT() {
  // Subscribe to store locale so components re-render on language switch
  const storeLocale = useSettingsStore((s) => s.locale);
  const locale = (storeLocale === 'zh' || storeLocale === 'en') ? storeLocale : currentLocale;

  function t(key: string, params?: Record<string, string>): string {
    const entry = translations[key];
    if (!entry) return key;
    let text = entry[locale] ?? entry['en'] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, v);
      }
    }
    return text;
  }
  return t;
}

export function formatRelativeTime(iso: string, locale: Locale = currentLocale): string {
  const dt = new Date(iso);
  const now = Date.now();
  const diffMs = now - dt.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return locale === 'zh' ? '刚刚' : 'Just now';
  if (diffHr < 1) return locale === 'zh' ? `${diffMin}分钟前` : `${diffMin}m ago`;
  if (diffDay < 1) return locale === 'zh' ? `${diffHr}小时前` : `${diffHr}h ago`;
  if (diffDay < 7) return locale === 'zh' ? `${diffDay}天前` : `${diffDay}d ago`;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
