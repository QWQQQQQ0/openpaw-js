// 能力推断：从 UIA 节点或视觉元素推断交互能力

import type { ElementCapability, InteractiveNode, VisionElement } from './types';

/** 从视觉分析结果推断能力 */
export function inferCapabilityFromVision(ve: VisionElement): ElementCapability | null {
  const label = (ve.label || '').toLowerCase();
  const desc = (ve.description || '').toLowerCase();
  const text = label + ' ' + desc;

  // 内容区域：可输入、可滚动、可拖动
  if (text.includes('输入') || text.includes('input') || text.includes('编辑') || text.includes('edit') || text.includes('聊天输入')) {
    return { interactionType: 'type', inputFormat: '任意文本', notes: ve.description };
  }
  if (text.includes('拖') || text.includes('drag') || text.includes('画布') || text.includes('canvas')) {
    return { interactionType: 'drag', notes: ve.description };
  }
  if (text.includes('滚动') || text.includes('scroll') || text.includes('列表') || text.includes('内容区')) {
    return { interactionType: 'select', notes: `可滚动区域: ${ve.description}` };
  }
  // 交互元素
  if (text.includes('按钮') || text.includes('button')) return { interactionType: 'click', notes: ve.description };
  if (text.includes('下拉') || text.includes('dropdown') || text.includes('选择')) return { interactionType: 'expand', notes: ve.description };
  if (text.includes('标签') || text.includes('tab')) return { interactionType: 'click', notes: `标签页: ${ve.description}` };
  if (text.includes('菜单') || text.includes('menu')) return { interactionType: 'click', notes: `菜单项: ${ve.description}` };
  // 默认可点击
  return { interactionType: 'click', notes: ve.description };
}

/** 从 UIA 节点推断能力 */
export function inferCapabilityFromInteraction(
  element: InteractiveNode,
  interactionType: string,
): ElementCapability | null {
  const role = element.role.toLowerCase();
  const name = element.name?.toLowerCase() ?? '';

  if (role === 'combobox' || role === 'dropdown' || name.includes('下拉') || name.includes('dropdown')) {
    return { interactionType: 'expand', notes: '点击展开下拉框，选项在弹出列表中' };
  }
  if (role === 'menuitem' || role === 'menu') {
    return { interactionType: 'click', notes: interactionType === 'rightClick' ? '右键菜单项' : '菜单项' };
  }
  if (role === 'listitem' || role === 'list') {
    return { interactionType: 'select', notes: '列表项，点击选择' };
  }
  if (role === 'button' || role === 'hyperlink') {
    return { interactionType: 'click' };
  }
  if (role === 'edit' || role === 'text' || role === 'textarea') {
    return { interactionType: 'type', inputFormat: '任意文本' };
  }
  if (role === 'checkbox') {
    return { interactionType: 'click', notes: '点击切换勾选状态' };
  }
  if (role === 'radiobutton') {
    return { interactionType: 'click', notes: '点击选择此选项' };
  }
  if (role === 'tabitem' || role === 'tab') {
    return { interactionType: 'click', notes: '点击切换标签页' };
  }
  if (role === 'treeitem' || role === 'tree') {
    return { interactionType: 'expand', notes: '树节点，点击展开' };
  }

  if (element.enabled && element.visible) {
    return { interactionType: 'click' };
  }
  return null;
}

/** 从 ExplorableElement 推断能力 */
export function inferCapabilityFromExplorable(el: { source: 'uia' | 'vision'; name: string; role: string; uiaNode?: InteractiveNode }): ElementCapability | null {
  if (el.source === 'uia' && el.uiaNode) {
    return inferCapabilityFromInteraction(el.uiaNode, 'click');
  }
  // 视觉元素：根据名称推断
  const name = el.name.toLowerCase();
  if (name.includes('按钮') || name.includes('button')) return { interactionType: 'click' };
  if (name.includes('输入') || name.includes('input') || name.includes('搜索')) return { interactionType: 'type', inputFormat: '任意文本' };
  if (name.includes('下拉') || name.includes('dropdown') || name.includes('选择')) return { interactionType: 'expand' };
  if (name.includes('标签') || name.includes('tab')) return { interactionType: 'click', notes: '切换标签页' };
  if (name.includes('菜单') || name.includes('menu')) return { interactionType: 'click', notes: '菜单项' };
  return { interactionType: 'click' };
}
