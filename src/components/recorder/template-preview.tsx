/**
 * 模板预览组件
 *
 * 功能：
 * 1. 显示 LLM 生成的自动化模板
 * 2. 显示数据流信息
 * 3. 显示模板步骤
 * 4. 支持模板保存
 */

import { useState, useCallback } from 'react';
import {
  Play,
  Save,
  Edit,
  X,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Mouse,
  Keyboard,
  Copy,
  Clipboard,
  Focus,
  Scroll,
  Repeat,
  GitBranch,
  Tag,
  Settings,
} from 'lucide-react';
import type { AutomationTemplate, TemplateStep, TemplateParameter } from '@/types/automation-template';
import type { DataFlow } from '@/types/unified-data';
import type { DetectedPattern } from '@/types/recording-session';

interface TemplatePreviewProps {
  template: AutomationTemplate;
  pattern?: DetectedPattern;
  onSave?: (template: AutomationTemplate) => void;
  onEdit?: (template: AutomationTemplate) => void;
  onTest?: (template: AutomationTemplate) => void;
  onClose?: () => void;
}

/**
 * 获取动作图标
 */
function getActionIcon(action: string) {
  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return <Mouse size={14} />;
    case 'type':
    case 'key':
    case 'hotkey':
      return <Keyboard size={14} />;
    case 'copy':
      return <Copy size={14} />;
    case 'paste':
      return <Clipboard size={14} />;
    case 'focus':
      return <Focus size={14} />;
    case 'scroll':
      return <Scroll size={14} />;
    case 'loop_start':
    case 'loop_end':
      return <Repeat size={14} />;
    case 'if':
    case 'break':
    case 'continue':
      return <GitBranch size={14} />;
    default:
      return <Mouse size={14} />;
  }
}

/**
 * 格式化置信度
 */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * 获取模式类型名称
 */
function getPatternTypeName(type: string): string {
  switch (type) {
    case 'linear':
      return '线性';
    case 'loop':
      return '循环';
    case 'conditional':
      return '条件';
    case 'mixed':
      return '混合';
    default:
      return '未知';
  }
}

/**
 * 模式信息组件
 */
function PatternInfo({ pattern }: { pattern: DetectedPattern }) {
  return (
    <div className="bg-blue-50 dark:bg-blue-950 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Repeat size={16} className="text-blue-500" />
        <h4 className="font-medium text-[14px] text-blue-700 dark:text-blue-300">
          检测到模式：{getPatternTypeName(pattern.type)}
        </h4>
        <span className="px-2 py-0.5 rounded-full text-[11px] bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400">
          置信度: {formatConfidence(pattern.confidence)}
        </span>
      </div>
      <p className="text-[13px] text-blue-600 dark:text-blue-400">
        {pattern.description}
      </p>
      {pattern.loopVariable && (
        <div className="mt-2 text-[12px] text-blue-500">
          循环变量: <code className="px-1 py-0.5 bg-blue-100 dark:bg-blue-900 rounded">{pattern.loopVariable}</code>
        </div>
      )}
    </div>
  );
}

/**
 * 数据流信息组件
 */
function DataFlowInfo({ dataFlow }: { dataFlow: DataFlow }) {
  return (
    <div className="bg-green-50 dark:bg-green-950 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <ArrowRight size={16} className="text-green-500" />
        <h4 className="font-medium text-[14px] text-green-700 dark:text-green-300">
          数据流
        </h4>
      </div>

      <div className="grid grid-cols-[1fr,auto,1fr] gap-3 items-start">
        {/* 源 */}
        <div>
          <div className="text-[11px] text-green-600 dark:text-green-400 mb-1">
            源: {dataFlow.source.type}
          </div>
          <div className="space-y-1">
            {dataFlow.source.fields.map(field => (
              <div
                key={field.name}
                className="px-2 py-1 bg-green-100 dark:bg-green-900 rounded text-[12px]"
              >
                {field.name}
              </div>
            ))}
          </div>
        </div>

        {/* 箭头 */}
        <div className="flex items-center pt-6">
          <ArrowRight size={20} className="text-green-500" />
        </div>

        {/* 目标 */}
        <div>
          <div className="text-[11px] text-green-600 dark:text-green-400 mb-1">
            目标: {dataFlow.target.type}
          </div>
          <div className="space-y-1">
            {dataFlow.target.fields.map(field => (
              <div
                key={field.name}
                className="px-2 py-1 bg-green-100 dark:bg-green-900 rounded text-[12px]"
              >
                {field.name}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 映射 */}
      {dataFlow.mapping.length > 0 && (
        <div className="mt-3 pt-3 border-t border-green-200 dark:border-green-800">
          <div className="text-[11px] text-green-600 dark:text-green-400 mb-2">
            字段映射
          </div>
          <div className="space-y-1">
            {dataFlow.mapping.map((m, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px]">
                <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 rounded">
                  {m.source}
                </span>
                <ArrowRight size={12} className="text-green-500" />
                <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900 rounded">
                  {m.target}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 参数列表组件
 */
function ParameterList({ parameters }: { parameters: TemplateParameter[] }) {
  if (parameters.length === 0) {
    return null;
  }

  return (
    <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Settings size={16} className="text-zinc-500" />
        <h4 className="font-medium text-[14px] text-zinc-700 dark:text-zinc-300">
          参数
        </h4>
      </div>

      <div className="space-y-2">
        {parameters.map(param => (
          <div
            key={param.name}
            className="flex items-center justify-between px-3 py-2 bg-white dark:bg-zinc-800 rounded-lg"
          >
            <div>
              <div className="flex items-center gap-2">
                <code className="text-[13px] font-mono">{param.name}</code>
                {param.required && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-100 dark:bg-red-900 text-red-600 dark:text-red-400">
                    必填
                  </span>
                )}
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-100 dark:bg-zinc-700 text-zinc-500">
                  {param.type}
                </span>
              </div>
              <div className="text-[12px] text-zinc-500 mt-0.5">
                {param.description}
              </div>
            </div>
            {param.defaultValue !== undefined && (
              <code className="text-[12px] text-zinc-400">
                默认: {String(param.defaultValue)}
              </code>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 步骤列表组件
 */
function StepList({ steps }: { steps: TemplateStep[] }) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const toggleStep = (stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  return (
    <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Play size={16} className="text-zinc-500" />
        <h4 className="font-medium text-[14px] text-zinc-700 dark:text-zinc-300">
          模板步骤
        </h4>
        <span className="text-[12px] text-zinc-400">
          ({steps.length} 步)
        </span>
      </div>

      <div className="space-y-2">
        {steps.map((step, index) => (
          <div
            key={step.id}
            className="bg-white dark:bg-zinc-800 rounded-lg overflow-hidden"
          >
            {/* 步骤头 */}
            <div
              className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-750"
              onClick={() => toggleStep(step.id)}
            >
              {/* 序号 */}
              <span className="text-[11px] text-zinc-400 w-6 text-right shrink-0">
                {index + 1}
              </span>

              {/* 图标 */}
              <span className="text-zinc-500 shrink-0">
                {getActionIcon(step.action)}
              </span>

              {/* 描述 */}
              <span className="text-[13px] text-zinc-700 dark:text-zinc-300 flex-1">
                {step.description}
              </span>

              {/* 展开按钮 */}
              <button className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400">
                {expandedSteps.has(step.id) ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
              </button>
            </div>

            {/* 步骤详情 */}
            {expandedSteps.has(step.id) && (
              <div className="px-3 pb-3 ml-10">
                <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3 text-[12px]">
                  {/* 动作类型 */}
                  <div className="mb-2">
                    <span className="text-zinc-500">动作:</span>{' '}
                    <code className="px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded">
                      {step.action}
                    </code>
                  </div>

                  {/* 目标 */}
                  {step.target && (
                    <div className="mb-2">
                      <span className="text-zinc-500">目标:</span>
                      {step.target.semantic && (
                        <span className="ml-2">
                          [{step.target.semantic.role}] "{step.target.semantic.name}"
                        </span>
                      )}
                      {step.target.path && (
                        <span className="ml-2 text-zinc-400">
                          path: {step.target.path}
                        </span>
                      )}
                      {step.target.coordinate && (
                        <span className="ml-2">
                          ({step.target.coordinate.x}, {step.target.coordinate.y})
                        </span>
                      )}
                    </div>
                  )}

                  {/* 参数 */}
                  {step.params && Object.keys(step.params).length > 0 && (
                    <div className="mb-2">
                      <span className="text-zinc-500">参数:</span>
                      <pre className="mt-1 p-2 bg-zinc-100 dark:bg-zinc-800 rounded overflow-x-auto">
                        {JSON.stringify(step.params, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* 流程控制 */}
                  {step.control && (
                    <div>
                      <span className="text-zinc-500">流程控制:</span>
                      <div className="mt-1 p-2 bg-zinc-100 dark:bg-zinc-800 rounded">
                        <div>类型: {step.control.type}</div>
                        {step.control.type === 'loop' && (
                          <>
                            <div>遍历: {step.control.over}</div>
                            <div>变量: {step.control.variable}</div>
                          </>
                        )}
                        {step.control.type === 'if' && (
                          <div>条件: {step.control.condition}</div>
                        )}
                        {step.control.type === 'goto' && (
                          <div>跳转: {step.control.stepId}</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 模板预览组件
 */
export function TemplatePreview({
  template,
  pattern,
  onSave,
  onEdit,
  onTest,
  onClose,
}: TemplatePreviewProps) {
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await onSave?.(template);
    } finally {
      setIsSaving(false);
    }
  }, [template, onSave]);

  return (
    <div className="flex flex-col bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h3 className="font-semibold text-[16px] text-zinc-900 dark:text-zinc-100">
            {template.name}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-0.5">
            {template.description}
          </p>
        </div>

        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
        >
          <X size={16} />
        </button>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 模式信息 */}
        {pattern && <PatternInfo pattern={pattern} />}

        {/* 数据流 */}
        {template.dataFlow && <DataFlowInfo dataFlow={template.dataFlow} />}

        {/* 参数 */}
        <ParameterList parameters={template.parameters} />

        {/* 步骤 */}
        <StepList steps={template.steps} />
      </div>

      {/* 操作按钮 */}
      <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex gap-2">
          {/* 测试按钮 */}
          <button
            onClick={() => onTest?.(template)}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 text-[13px] font-medium hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            <Play size={14} />
            测试运行
          </button>

          {/* 编辑按钮 */}
          <button
            onClick={() => onEdit?.(template)}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 text-[13px] font-medium hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            <Edit size={14} />
            编辑模板
          </button>

          {/* 保存按钮 */}
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            <Save size={14} />
            {isSaving ? '保存中...' : '保存为技能'}
          </button>
        </div>
      </div>
    </div>
  );
}
