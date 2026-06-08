import { useEffect, useState, useRef, Suspense } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Plus, RefreshCw, MoreVertical, Sparkles, Brain, Lightbulb, Cpu } from 'lucide-react';
import { useModelConfigStore } from '@/stores/model-config-store';
import { useT } from '@/i18n/strings';
import { ModelConfigForm } from '@/components/model-config-form';
import type { ProviderConfig, ProviderType } from '@/types/provider';

const typeIcons: Record<ProviderType, React.ReactNode> = {
  openai: <Sparkles size={18} className="text-blue-500" />,
  anthropic: <Brain size={18} className="text-purple-500" />,
  google: <Lightbulb size={18} className="text-amber-500" />,
};

function ProviderCard({ config }: { config: ProviderConfig }) {
  const navigate = useNavigate();
  const t = useT();
  const { setDefault, remove } = useModelConfigStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="mx-3 mb-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-10 h-10 rounded-full bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center shrink-0">
          {typeIcons[config.type] ?? <Cpu size={18} className="text-zinc-400" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {config.name}
            </span>
            {config.isDefault && (
              <span className="px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-[10px] font-medium text-blue-600 dark:text-blue-400 shrink-0">
                {t('modellist.default')}
              </span>
            )}
            {config.supportsMultimodal !== false && (
              <span className="px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900 text-[10px] font-medium text-purple-600 dark:text-purple-400 shrink-0">
                {t('modellist.multimodal')}
              </span>
            )}
          </div>
          <p className="text-[12px] text-zinc-400 dark:text-zinc-500 truncate mt-0.5">
            {config.type} — {config.model}
          </p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate font-mono">
            {config.baseUrl}
          </p>
        </div>

        <div ref={menuRef} className="relative shrink-0">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <MoreVertical size={16} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg z-50 py-1">
              <button
                onClick={() => { setMenuOpen(false); navigate(`/models?edit=${config.id}`); }}
                className="w-full text-left px-3 py-2 text-[13px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                {t('modellist.edit')}
              </button>
              {!config.isDefault && (
                <button
                  onClick={() => { setMenuOpen(false); setDefault(config.id); }}
                  className="w-full text-left px-3 py-2 text-[13px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  {t('modellist.setdefault')}
                </button>
              )}
              <button
                onClick={() => {
                  setMenuOpen(false);
                  if (confirm(t('model.delete.confirm', { name: config.name }))) {
                    remove(config.id);
                  }
                }}
                className="w-full text-left px-3 py-2 text-[13px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
              >
                {t('modellist.delete')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelListView() {
  const t = useT();
  const { providers, loading, error, load } = useModelConfigStore();

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-[3px] border-zinc-200 dark:border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-400 dark:text-zinc-500 px-4">
        <div className="p-3 bg-red-50 dark:bg-red-950 rounded-full mb-4">
          <Sparkles size={32} className="text-red-400" />
        </div>
        <h2 className="text-[15px] font-semibold text-zinc-500 dark:text-zinc-400 mb-1">
          {t('modellist.loaderror')}
        </h2>
        <p className="text-[13px] text-red-400">{error}</p>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-400 dark:text-zinc-500 px-4">
        <Cpu size={56} className="mb-4 opacity-30" />
        <h2 className="text-lg font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
          {t('modellist.empty')}
        </h2>
        <p className="text-[13px] text-center max-w-xs mb-6">
          {t('modellist.empty.subtitle')}
        </p>
        <Link
          to="/models?new=true"
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-blue-600 text-white text-[14px] font-medium hover:bg-blue-700"
        >
          <Plus size={16} />
          {t('modellist.add')}
        </Link>
      </div>
    );
  }

  return (
    <div className="py-2">
      {providers.map((config) => (
        <ProviderCard key={config.id} config={config} />
      ))}
    </div>
  );
}

function ModelEditView({ editId }: { editId: string }) {
  const { providers, load } = useModelConfigStore();

  useEffect(() => { load(); }, [load]);

  const existing = editId ? providers.find((p) => p.id === editId) : undefined;

  if (!existing && editId) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <div className="w-8 h-8 border-[3px] border-zinc-200 dark:border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  return <ModelConfigForm existing={existing} />;
}

function ModelPageContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const t = useT();
  const { load } = useModelConfigStore();

  const editId = searchParams.get('edit');
  const isNew = searchParams.get('new') === 'true';

  useEffect(() => { load(); }, [load]);

  // Show add/edit form
  if (editId || isNew) {
    const title = editId ? t('model.edit') : t('model.add');
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <button
            onClick={() => navigate('/models')}
            className="p-1.5 mr-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            ←
          </button>
          <h1 className="text-[16px] font-bold text-zinc-900 dark:text-zinc-100">{title}</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          {editId ? (
            <ModelEditView editId={editId} />
          ) : (
            <ModelConfigForm />
          )}
        </div>
      </div>
    );
  }

  // Show list
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <h1 className="text-[16px] font-bold text-zinc-900 dark:text-zinc-100">
          {t('modellist.title')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load()}
            className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <RefreshCw size={18} />
          </button>
          <Link
            to="/models?new=true"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700"
          >
            <Plus size={16} />
            {t('modellist.add')}
          </Link>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <ModelListView />
      </div>
    </div>
  );
}

export default function ModelsPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-[3px] border-zinc-200 dark:border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
      </div>
    }>
      <ModelPageContent />
    </Suspense>
  );
}
