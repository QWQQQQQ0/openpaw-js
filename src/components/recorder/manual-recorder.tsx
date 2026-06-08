/**
 * 手动录制器 - 用于跨应用操作
 *
 * 用户手动描述操作步骤，系统生成模板
 */

import { useState, useCallback } from 'react';
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Mouse,
  Keyboard,
  Copy,
  Clipboard,
  Focus,
  Scroll,
  Save,
  Wand2,
} from 'lucide-react';
import type { AutomationStep } from '@/types/skill';

interface ManualRecorderProps {
  onSave?: (steps: AutomationStep[], description: string) => void;
  onCancel?: () => void;
}

/**
 * 预定义的操作类型
 */
const ACTION_TYPES = [
  { type: 'click', label: '点击', icon: Mouse, params: ['x', 'y', 'role', 'name'] },
  { type: 'double_click', label: '双击', icon: Mouse, params: ['x', 'y', 'role', 'name'] },
  { type: 'right_click', label: '右键点击', icon: Mouse, params: ['x', 'y', 'role', 'name'] },
  { type: 'type', label: '输入文本', icon: Keyboard, params: ['text'] },
  { type: 'key', label: '按键', icon: Keyboard, params: ['key'] },
  { type: 'hotkey', label: '组合键', icon: Keyboard, params: ['key'] },
  { type: 'copy', label: '复制', icon: Copy, params: [] },
  { type: 'paste', label: '粘贴', icon: Clipboard, params: [] },
  { type: 'focus', label: '聚焦窗口', icon: Focus, params: ['window_title'] },
  { type: 'scroll', label: '滚动', icon: Scroll, params: ['direction', 'amount'] },
  { type: 'wait', label: '等待', icon: Mouse, params: ['duration'] },
];

/**
 * 手动录制器组件
 */
export function ManualRecorder({ onSave, onCancel }: ManualRecorderProps) {
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<Array<{
    id: string;
    action: string;
    params: Record<string, string>;
    description: string;
  }>>([]);

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editingStep, setEditingStep] = useState<string | null>(null);

  // ── 添加步骤 ──
  const handleAddStep = useCallback((actionType: string) => {
    const action = ACTION_TYPES.find(a => a.type === actionType);
    if (!action) return;

    const newStep = {
      id: crypto.randomUUID(),
      action: actionType,
      params: {},
      description: action.label,
    };

    setSteps(prev => [...prev, newStep]);
    setEditingStep(newStep.id);
    setShowAddMenu(false);
  }, []);

  // ── 删除步骤 ──
  const handleDeleteStep = useCallback((stepId: string) => {
    setSteps(prev => prev.filter(s => s.id !== stepId));
  }, []);

  // ── 移动步骤 ──
  const handleMoveStep = useCallback((stepId: string, direction: 'up' | 'down') => {
    setSteps(prev => {
      const index = prev.findIndex(s => s.id === stepId);
      if (index === -1) return prev;

      const newSteps = [...prev];
      const newIndex = direction === 'up' ? index - 1 : index + 1;

      if (newIndex < 0 || newIndex >= newSteps.length) return prev;

      [newSteps[index], newSteps[newIndex]] = [newSteps[newIndex], newSteps[index]];
      return newSteps;
    });
  }, []);

  // ── 更新步骤参数 ──
  const handleUpdateParam = useCallback((stepId: string, key: string, value: string) => {
    setSteps(prev => prev.map(step => {
      if (step.id !== stepId) return step;

      return {
        ...step,
        params: { ...step.params, [key]: value },
        description: generateStepDescription(step.action, { ...step.params, [key]: value }),
      };
    }));
  }, []);

  // ── 生成步骤描述 ──
  const generateStepDescription = (action: string, params: Record<string, string>): string => {
    const actionDef = ACTION_TYPES.find(a => a.type === action);
    if (!actionDef) return action;

    switch (action) {
      case 'click':
        if (params.role && params.name) return `点击 [${params.role}] "${params.name}"`;
        if (params.x && params.y) return `点击 (${params.x}, ${params.y})`;
        return '点击';
      case 'double_click':
        if (params.role && params.name) return `双击 [${params.role}] "${params.name}"`;
        return '双击';
      case 'right_click':
        if (params.role && params.name) return `右键点击 [${params.role}] "${params.name}"`;
        return '右键点击';
      case 'type':
        return params.text ? `输入 "${params.text}"` : '输入文本';
      case 'key':
      case 'hotkey':
        return params.key ? `按键 ${params.key}` : '按键';
      case 'copy':
        return '复制';
      case 'paste':
        return '粘贴';
      case 'focus':
        return params.window_title ? `聚焦窗口 "${params.window_title}"` : '聚焦窗口';
      case 'scroll':
        return `滚动 ${params.direction || '下'} ${params.amount || '100'}px`;
      case 'wait':
        return `等待 ${params.duration || '1000'}ms`;
      default:
        return actionDef.label;
    }
  };

  // ── 保存 ──
  const handleSave = useCallback(() => {
    const automationSteps: AutomationStep[] = steps.map(step => ({
      toolName: step.action,
      arguments: step.params,
      description: step.description,
    }));

    onSave?.(automationSteps, description);
  }, [steps, description, onSave]);

  return (
    <div className="flex flex-col h-full">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <Keyboard size={14} className="text-blue-500" />
          <span className="text-[13px] font-medium">手动录制</span>
        </div>
      </div>

      {/* 描述输入 */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <label className="block text-[11px] text-zinc-500 mb-1">
          任务描述
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="描述这个自动化任务..."
          className="w-full px-2 py-1.5 text-[12px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 outline-none focus:border-blue-500"
        />
      </div>

      {/* 步骤列表 */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-3 py-2 space-y-2">
        {steps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400">
            <Keyboard size={32} className="mb-2 opacity-30" />
            <p className="text-[12px]">点击下方按钮添加操作步骤</p>
          </div>
        ) : (
          steps.map((step, index) => {
            const actionDef = ACTION_TYPES.find(a => a.type === step.action);
            const Icon = actionDef?.icon || Mouse;

            return (
              <div
                key={step.id}
                className={`bg-zinc-50 dark:bg-zinc-900 rounded-lg border ${
                  editingStep === step.id ? 'border-blue-500' : 'border-zinc-200 dark:border-zinc-800'
                }`}
              >
                {/* 步骤头 */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="text-[11px] text-zinc-400 w-5 text-right">{index + 1}</span>
                  <Icon size={14} className="text-zinc-500" />
                  <span className="flex-1 text-[12px]">{step.description}</span>

                  <button
                    onClick={() => handleMoveStep(step.id, 'up')}
                    disabled={index === 0}
                    className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-400 disabled:opacity-30"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    onClick={() => handleMoveStep(step.id, 'down')}
                    disabled={index === steps.length - 1}
                    className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-400 disabled:opacity-30"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    onClick={() => setEditingStep(editingStep === step.id ? null : step.id)}
                    className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-400"
                  >
                    <Keyboard size={12} />
                  </button>
                  <button
                    onClick={() => handleDeleteStep(step.id)}
                    className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900 text-zinc-400 hover:text-red-500"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* 参数编辑 */}
                {editingStep === step.id && (
                  <div className="px-3 pb-3 space-y-1.5">
                    {actionDef?.params.map(param => (
                      <div key={param} className="flex items-center gap-2">
                        <label className="text-[11px] text-zinc-500 w-20 text-right">{param}:</label>
                        <input
                          type="text"
                          value={step.params[param] || ''}
                          onChange={(e) => handleUpdateParam(step.id, param, e.target.value)}
                          placeholder={getParamPlaceholder(param)}
                          className="flex-1 px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 outline-none focus:border-blue-500"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 添加步骤按钮 */}
      <div className="px-3 py-2 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
        {showAddMenu ? (
          <div className="grid grid-cols-2 gap-1.5 max-h-[200px] overflow-y-auto scrollbar-hide">
            {ACTION_TYPES.map(action => {
              const Icon = action.icon;
              return (
                <button
                  key={action.type}
                  onClick={() => handleAddStep(action.type)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-[11px] hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Icon size={12} />
                  {action.label}
                </button>
              );
            })}
          </div>
        ) : (
          <button
            onClick={() => setShowAddMenu(true)}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 text-[12px] text-zinc-500 hover:text-blue-500 hover:border-blue-400"
          >
            <Plus size={14} />
            添加操作步骤
          </button>
        )}
      </div>

      {/* 保存按钮 */}
      <div className="px-3 py-2 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[12px]"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={steps.length === 0}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-blue-600 text-white text-[12px] font-medium disabled:opacity-50"
          >
            <Save size={12} />
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 获取参数占位符
 */
function getParamPlaceholder(param: string): string {
  switch (param) {
    case 'x': return 'X 坐标';
    case 'y': return 'Y 坐标';
    case 'role': return '元素角色 (button, cell...)';
    case 'name': return '元素名称';
    case 'text': return '要输入的文本';
    case 'key': return '按键 (Ctrl+C, Enter...)';
    case 'window_title': return '窗口标题';
    case 'direction': return '方向 (up/down)';
    case 'amount': return '数量';
    case 'duration': return '毫秒';
    default: return param;
  }
}
