/**
 * 事件列表组件
 *
 * 功能：
 * 1. 显示录制的事件列表
 * 2. 支持事件标记
 * 3. 支持事件删除
 */

import { useState, useCallback } from 'react';
import {
  Mouse,
  Keyboard,
  Copy,
  Scissors,
  Clipboard,
  Focus,
  Scroll,
  Move,
  Trash2,
  Tag,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { SemanticEvent, EventTag } from '@/types/semantic-event';
import { EVENT_TAG } from '@/types/semantic-event';

interface EventListProps {
  events: SemanticEvent[];
  onTagEvent?: (eventId: string, tag: EventTag) => void;
  onUntagEvent?: (eventId: string, tag: EventTag) => void;
  onDeleteEvent?: (eventId: string) => void;
  selectedEventId?: string;
  onSelectEvent?: (eventId: string) => void;
}

/**
 * 获取动作图标
 */
function getActionIcon(actionType: string) {
  switch (actionType) {
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
    case 'cut':
      return <Scissors size={14} />;
    case 'paste':
      return <Clipboard size={14} />;
    case 'focus':
      return <Focus size={14} />;
    case 'scroll':
      return <Scroll size={14} />;
    case 'drag':
      return <Move size={14} />;
    default:
      return <Mouse size={14} />;
  }
}

/**
 * 获取动作描述
 */
function getActionDescription(event: SemanticEvent): string {
  const { action, element } = event;
  const elementName = element?.identity.name ? ` "${element.identity.name.substring(0, 20)}"` : '';

  switch (action.type) {
    case 'click':
      return `点击${elementName}`;
    case 'double_click':
      return `双击${elementName}`;
    case 'right_click':
      return `右键点击${elementName}`;
    case 'type':
      return `输入 "${(action.params?.text as string || '').substring(0, 20)}"`;
    case 'key':
      return `按键 ${action.params?.key}`;
    case 'hotkey':
      return `组合键 ${action.params?.key}`;
    case 'copy':
      return '复制';
    case 'cut':
      return '剪切';
    case 'paste':
      return '粘贴';
    case 'focus':
      return `聚焦${elementName}`;
    case 'scroll':
      return `滚动 ${action.params?.direction}`;
    case 'drag': {
      const p = action.params;
      if (p?.start_x !== undefined) {
        return `拖拽 (${p.start_x},${p.start_y}) → (${p.end_x},${p.end_y})`;
      }
      return `拖拽${elementName}`;
    }
    default:
      return action.type;
  }
}

/**
 * 获取标签颜色
 */
function getTagColor(tag: EventTag): string {
  switch (tag) {
    case EVENT_TAG.VARIABLE:
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
    case EVENT_TAG.FIXED:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300';
    case EVENT_TAG.SOURCE:
      return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
    case EVENT_TAG.TARGET:
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300';
    case EVENT_TAG.COPY:
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300';
    case EVENT_TAG.PASTE:
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300';
    case EVENT_TAG.IMPORTANT:
      return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
    case EVENT_TAG.SKIP:
      return 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

/**
 * 获取标签名称
 */
function getTagName(tag: EventTag): string {
  switch (tag) {
    case EVENT_TAG.VARIABLE:
      return '变量';
    case EVENT_TAG.FIXED:
      return '固定';
    case EVENT_TAG.SOURCE:
      return '源';
    case EVENT_TAG.TARGET:
      return '目标';
    case EVENT_TAG.COPY:
      return '复制';
    case EVENT_TAG.PASTE:
      return '粘贴';
    case EVENT_TAG.IMPORTANT:
      return '重要';
    case EVENT_TAG.SKIP:
      return '跳过';
    case EVENT_TAG.LOOP_START:
      return '循环开始';
    case EVENT_TAG.LOOP_END:
      return '循环结束';
    case EVENT_TAG.CONDITIONAL:
      return '条件';
    case EVENT_TAG.CUSTOM:
      return '自定义';
    default:
      return tag;
  }
}

/**
 * 事件项组件
 */
function EventItem({
  event,
  index,
  isSelected,
  onTag,
  onUntag,
  onDelete,
  onSelect,
}: {
  event: SemanticEvent;
  index: number;
  isSelected: boolean;
  onTag?: (tag: EventTag) => void;
  onUntag?: (tag: EventTag) => void;
  onDelete?: () => void;
  onSelect?: () => void;
}) {
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const availableTags: EventTag[] = [
    EVENT_TAG.VARIABLE,
    EVENT_TAG.FIXED,
    EVENT_TAG.SOURCE,
    EVENT_TAG.TARGET,
    EVENT_TAG.IMPORTANT,
    EVENT_TAG.SKIP,
  ];

  return (
    <div
      className={`border-b border-zinc-100 dark:border-zinc-800 ${
        isSelected ? 'bg-blue-50 dark:bg-blue-950' : ''
      }`}
    >
      {/* 主行 */}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
        onClick={onSelect}
      >
        {/* 序号 */}
        <span className="text-[11px] text-zinc-400 w-6 text-right shrink-0">
          {index + 1}
        </span>

        {/* 图标 */}
        <span className="text-zinc-500 shrink-0">
          {getActionIcon(event.action.type)}
        </span>

        {/* 来源标签 */}
        {event.context.platform === 'dom' ? (
          <span className="px-1 py-0.5 rounded text-[9px] bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-400 shrink-0">
            Web
          </span>
        ) : (
          <span className="px-1 py-0.5 rounded text-[9px] bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 shrink-0">
            全局
          </span>
        )}

        {/* 描述 */}
        <span className="text-[11px] text-zinc-700 dark:text-zinc-300 flex-1 truncate" title={getActionDescription(event)}>
          {getActionDescription(event)}
        </span>

        {/* 标签 */}
        {event.tags && event.tags.length > 0 && (
          <div className="flex gap-1 shrink-0">
            {event.tags.map(tag => (
              <span
                key={tag}
                className={`px-1.5 py-0.5 rounded text-[10px] ${getTagColor(tag)}`}
              >
                {getTagName(tag)}
              </span>
            ))}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-1 shrink-0">
          {/* 详情按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowDetails(!showDetails);
            }}
            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400"
          >
            {showDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          {/* 标记按钮 */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowTagMenu(!showTagMenu);
              }}
              className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400"
            >
              <Tag size={12} />
            </button>

            {/* 标记菜单 */}
            {showTagMenu && (
              <div className="absolute right-0 top-full mt-1 w-32 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg z-10">
                {availableTags.map(tag => (
                  <button
                    key={tag}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (event.tags?.includes(tag)) {
                        onUntag?.(tag);
                      } else {
                        onTag?.(tag);
                      }
                      setShowTagMenu(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                      event.tags?.includes(tag) ? 'font-medium' : ''
                    }`}
                  >
                    {getTagName(tag)}
                    {event.tags?.includes(tag) && ' ✓'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 删除按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete?.();
            }}
            className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900 text-zinc-400 hover:text-red-500"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* 详情面板 */}
      {showDetails && (
        <div className="px-2 pb-1.5 ml-8">
          <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-1.5 text-[10px]">
            {/* 元素信息 */}
            {event.element && (
              <div className="mb-2">
                <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                  元素信息
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <span className="text-zinc-500">角色:</span>
                  <span>{event.element.identity.role}</span>
                  <span className="text-zinc-500">名称:</span>
                  <span className="truncate" title={event.element.identity.name || '(无)'}>{event.element.identity.name || '(无)'}</span>
                  {event.element.structure?.container && (
                    <>
                      <span className="text-zinc-500">容器:</span>
                      <span>{event.element.structure.container.role}</span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* 坐标信息 */}
            {event.action.type === 'drag' && event.action.params?.start_x !== undefined ? (
              <div className="mb-2">
                <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                  拖动坐标
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <span className="text-zinc-500">起点:</span>
                  <span>({event.action.params.start_x}, {event.action.params.start_y})</span>
                  <span className="text-zinc-500">终点:</span>
                  <span>({event.action.params.end_x}, {event.action.params.end_y})</span>
                </div>
              </div>
            ) : event.action.target?.coordinate && (
              <div className="mb-2">
                <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                  坐标
                </div>
                <span>
                  ({event.action.target.coordinate.x}, {event.action.target.coordinate.y})
                </span>
              </div>
            )}

            {/* 上下文信息 */}
            <div>
              <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                上下文
              </div>
              <div className="grid grid-cols-2 gap-1">
                <span className="text-zinc-500">窗口:</span>
                <span className="truncate" title={event.context.windowTitle || '(未知)'}>{event.context.windowTitle || '(未知)'}</span>
                <span className="text-zinc-500">平台:</span>
                <span>{event.context.platform || '(未知)'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 事件列表组件
 */
export function EventList({
  events,
  onTagEvent,
  onUntagEvent,
  onDeleteEvent,
  selectedEventId,
  onSelectEvent,
}: EventListProps) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-zinc-400">
        <Mouse size={24} className="mb-1.5 opacity-30" />
        <p className="text-[12px]">等待录制事件...</p>
        <p className="text-[10px] mt-0.5">开始操作以录制事件</p>
      </div>
    );
  }

  return (
    <div>
      {events.map((event, index) => (
        <EventItem
          key={event.id}
          event={event}
          index={index}
          isSelected={event.id === selectedEventId}
          onTag={(tag) => onTagEvent?.(event.id, tag)}
          onUntag={(tag) => onUntagEvent?.(event.id, tag)}
          onDelete={() => onDeleteEvent?.(event.id)}
          onSelect={() => onSelectEvent?.(event.id)}
        />
      ))}
    </div>
  );
}
