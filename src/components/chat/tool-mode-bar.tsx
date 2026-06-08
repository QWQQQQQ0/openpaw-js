// 来源: lib/screens/chat_screen.dart (_ToolModeBar)

'use client';

import { Wrench } from 'lucide-react';
import { ToolMode } from '@/stores/chat-store';
import { useT } from '@/i18n/strings';

interface ToolModeBarProps {
  mode: ToolMode;
  selectedCount: number;
  onModeChanged: (mode: ToolMode) => void;
  onFavoritesDoubleClick?: () => void;
}

function ModeChip({ label, selected, onClick, onDoubleClick }: { label: string; selected: boolean; onClick: () => void; onDoubleClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors ${
        selected
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
      }`}
    >
      {label}
    </button>
  );
}

export function ToolModeBar({ mode, selectedCount, onModeChanged, onFavoritesDoubleClick }: ToolModeBarProps) {
  const t = useT();

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-zinc-200 dark:border-zinc-700 bg-white dark:bg-black">
      <Wrench size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
      <div className="flex items-center gap-1.5">
        <ModeChip
          label={t('toolmode.all')}
          selected={mode === ToolMode.all}
          onClick={() => onModeChanged(ToolMode.all)}
        />
        <ModeChip
          label={t('toolmode.none')}
          selected={mode === ToolMode.none}
          onClick={() => onModeChanged(ToolMode.none)}
        />
        <ModeChip
          label={t('toolmode.favorites')}
          selected={mode === ToolMode.favorites}
          onClick={() => onModeChanged(ToolMode.favorites)}
          onDoubleClick={onFavoritesDoubleClick}
        />
        <ModeChip
          label={
            mode === ToolMode.custom && selectedCount > 0
              ? `${t('toolmode.custom')} (${selectedCount})`
              : t('toolmode.custom')
          }
          selected={mode === ToolMode.custom}
          onClick={() => onModeChanged(ToolMode.custom)}
        />
      </div>
    </div>
  );
}
