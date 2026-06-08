'use client';

import { useState, useEffect } from 'react';
import type { SkillTool } from '@/skills/skill';
import { useSettingsStore } from '@/stores/settings-store';
import { useT } from '@/i18n/strings';

interface ToolSelectorPanelProps {
  tools: SkillTool[];
  selected: Set<string>;
  setSelected: (tools: Set<string>) => void;
  onClose: () => void;
}

export function ToolSelectorPanel({ tools, selected, setSelected, onClose }: ToolSelectorPanelProps) {
  const t = useT();
  const storeLocale = useSettingsStore((s) => s.locale);
  const isZh = storeLocale === 'zh' || !storeLocale;
  const { disabledTools } = useSettingsStore();

  const enabledTools = tools.filter((tool) => !disabledTools.has(tool.name));

  const [localSelected, setLocalSelected] = useState<Set<string>>(() => new Set(selected));
  useEffect(() => {
    setLocalSelected(new Set(selected));
  }, [selected]);

  const toggleLocal = (name: string) => {
    setLocalSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = () => setLocalSelected(new Set(enabledTools.map((t) => t.name)));
  const clearAll = () => setLocalSelected(new Set());

  const handleConfirm = () => {
    setSelected(localSelected);
    onClose();
  };

  if (enabledTools.length === 0) {
    return (
      <div className="px-3 py-2 text-[12px] text-zinc-400 dark:text-zinc-500 border-t border-zinc-100 dark:border-zinc-800">
        {t('skills.noTools')}
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-100 dark:border-zinc-800">
      <div className="flex items-center gap-2 px-3 py-1">
        <button
          onClick={selectAll}
          className="text-[11px] text-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {t('toolmode.selectAll') || 'All'}
        </button>
        <span className="text-zinc-300 dark:text-zinc-600">|</span>
        <button
          onClick={clearAll}
          className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {t('toolmode.clearAll') || 'Clear'}
        </button>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 ml-auto">
          {localSelected.size}/{enabledTools.length}
        </span>
        <button
          onClick={handleConfirm}
          className="ml-2 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500 transition-colors"
        >
          {t('common.confirm') || 'Confirm'}
        </button>
      </div>
      <div className="max-h-36 overflow-y-auto px-2 pb-1">
        {enabledTools.map((tool) => {
          const displayName = (isZh && tool.nameCn) || tool.name;
          const isChecked = localSelected.has(tool.name);
          return (
            <label
              key={tool.name}
              className="flex items-center gap-1.5 py-0.5 cursor-pointer text-[11px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => toggleLocal(tool.name)}
                className="w-3 h-3 rounded"
              />
              <span className="truncate">{displayName}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
