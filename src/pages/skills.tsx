import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowLeft, Monitor, Globe, Smartphone, AppWindow, Code, Eye, EyeOff, Play, CheckCircle, XCircle, Settings, Plus, Trash2, Pencil, Upload, Sparkles, Circle, Database, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useSkillStore } from '@/stores/skill-store';
import { useT } from '@/i18n/strings';
import { desktopService, type AppInfo } from '@/services/desktop-service';
import systemPrompts from '@/config/system-prompts.json';
import { SkillExecutor } from '@/skills/executor';
import { UserDefinedSkill } from '@/skills/user-defined';
import { parseSkillMarkdown } from '@/skills/loader';
import { initBuiltinExecutor, getBuiltinExecutor, getBuiltinSkill } from '@/skills/builtin-executor';
import type { SkillTool } from '@/skills/skill';
import type { Skill } from '@/skills/skill';
import type { UserSkillConfig, ToolDefinition } from '@/types/skill';
import type { UICacheRow, SkillTemplateRow, StepCacheRow, SubGoalCacheRow, LLMCallCacheRow } from '@/types/cache';
import { getAllUICacheRows, getAllSkillTemplateRows, getAllStepCacheRows, getAllSubGoalCacheRows, getAllLLMCallCacheRows, getAllGoalDecompositionRows, deleteUICache, deleteSkillTemplate, deleteStepCache, deleteSubGoalCache, deleteLLMCallCache, deleteGoalDecomposition, clearAllCache, testCacheHit } from '@/services/cache-service';
import type { SemanticAnnotation } from '@/types/cache';

const skillIconMap: Record<string, React.ReactNode> = {
  desktop_screen: <Monitor size={20} />,
  web_screen: <Globe size={20} />,
  phone_screen: <Smartphone size={20} />,
  app_builder: <AppWindow size={20} />,
};

// ── CategoryHeader ──

function CategoryHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-1">
      <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
        {title}
      </span>
      <span className="px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-[10px] text-blue-700 dark:text-blue-300">
        {count}
      </span>
    </div>
  );
}

// ── ParametersSection ──

function ParametersSection({ params, t }: { params: Record<string, unknown>; t: (key: string) => string }) {
  const properties = (params['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = (params['required'] as string[]) ?? [];

  if (Object.keys(properties).length === 0) {
    return <p className="text-[12px] text-zinc-400 dark:text-zinc-500">{t('skills.noParams')}</p>;
  }

  return (
    <div>
      <p className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase mb-1">{t('skills.parameters')}</p>
      <div className="space-y-1.5">
        {Object.entries(properties).map(([name, schema]) => {
          const isRequired = required.includes(name);
          const type = (schema['type'] as string) ?? 'any';
          const desc = (schema['description'] as string) ?? '';
          return (
            <div key={name} className="flex items-start gap-2">
              <code className="text-[12px] font-mono text-zinc-700 dark:text-zinc-300 min-w-[100px] shrink-0">
                {name}{isRequired && <span className="text-red-500 ml-0.5">*</span>}
              </code>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0">{type}</span>
              {desc && <span className="text-[12px] text-zinc-400 dark:text-zinc-500">{desc}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TestDialog ──

function TestDialog({ skillId, tool, onClose, isBuiltin }: { skillId: string; tool: SkillTool; onClose: () => void; isBuiltin: boolean }) {
  const t = useT();
  const storeLocale = useSettingsStore((s) => s.locale);
  const isZh = storeLocale === 'zh' || !storeLocale;
  const [values, setValues] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string; data?: Record<string, unknown> } | null>(null);

  const properties = (tool.parameters['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = (tool.parameters['required'] as string[]) ?? [];

  const handleExecute = async () => {
    // Validate required params
    const missing = required.filter(r => !values[r]?.trim());
    if (missing.length > 0) {
      setResult({ success: false, message: t('skills.missingParams', { params: missing.join(', ') }) });
      return;
    }
    setExecuting(true);
    setResult(null);
    const params: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(properties)) {
      const raw = values[key]?.trim();
      if (!raw) continue;
      const type = (schema['type'] as string) ?? 'string';
      if (type === 'integer') params[key] = parseInt(raw, 10);
      else if (type === 'number') params[key] = parseFloat(raw);
      else params[key] = raw;
    }
    try {
      let r;
      if (isBuiltin) {
        const executor = getBuiltinExecutor();
        r = await executor.executeToolCall(tool.name, params);
      } else {
        const configs = useSkillStore.getState().allConfigs;
        const cfg = configs.find((c) => c.id === skillId);
        if (cfg) {
          const skill = new UserDefinedSkill(cfg);
          const executor = getBuiltinExecutor();
          skill.setExecutor(executor);
          r = await skill.execute(tool.name, params);
        } else {
          r = { success: false, message: 'Skill not found' };
        }
      }
      setResult(r);
    } catch (e) {
      setResult({ success: false, message: String(e) });
    }
    setExecuting(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <h3 className="font-semibold text-[15px] text-zinc-900 dark:text-zinc-100">{t('skills.test')}: {(isZh && tool.nameCn) || tool.name}</h3>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">✕</button>
          </div>
          <div className="p-4 space-y-3">
            {Object.keys(properties).length === 0 ? (
              <p className="text-zinc-400 dark:text-zinc-500 text-[13px]">{t('skills.noParams')}</p>
            ) : (
              Object.entries(properties).map(([key, schema]) => {
                const isRequired = required.includes(key);
                const type = (schema['type'] as string) ?? 'string';
                const desc = (schema['description'] as string) ?? '';
                return (
                  <div key={key}>
                    <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                      {key}{isRequired && ' *'} <span className="text-zinc-400 font-normal">({type})</span>
                    </label>
                    <input
                      type="text" value={values[key] ?? ''}
                      onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      placeholder={desc}
                      className="w-full px-3 py-1.5 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
                    />
                  </div>
                );
              })
            )}
            {result && (
              <div className={`p-3 rounded-lg border ${result.success ? 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800'}`}>
                <div className="flex items-center gap-2">
                  {result.success ? <CheckCircle size={16} className="text-green-600 dark:text-green-400" /> : <XCircle size={16} className="text-red-600 dark:text-red-400" />}
                  <span className={`text-[13px] font-semibold ${result.success ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>{result.success ? t('skills.success') : t('skills.failed')}</span>
                </div>
                <p className="mt-1 text-[13px] text-zinc-600 dark:text-zinc-400">{result.message}</p>
                {result.data && <DataView data={result.data} />}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
            <button onClick={onClose} className="px-3 py-1.5 text-[13px] rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">{t('skills.close')}</button>
            <button onClick={handleExecute} disabled={executing} className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {executing ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Play size={14} />}
              {t('skills.execute')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── DataView: smart renderer for structured results ──

function DataView({ data }: { data: Record<string, unknown> }) {
  // Find any array that looks like a list of items (nodes, windows, apps, etc.)
  const arrayKeys = Object.entries(data).filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0);
  const bestKey = arrayKeys.find(([k]) => k === 'nodes' || k === 'windows' || k === 'apps' || k === 'texts')
    ?? arrayKeys[0];

  if (bestKey) {
    const [key, arr] = bestKey;
    const items = arr as Record<string, unknown>[];
    const columns = items.length > 0 ? Object.keys(items[0]).filter(c => c !== '__typename') : [];

    return (
      <div className="mt-2">
        <p className="text-[11px] text-zinc-500 dark:text-zinc-500 mb-1">{key} ({items.length})</p>
        <div className="max-h-48 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-700">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                {columns.map(c => (
                  <th key={c} className="px-2 py-1 text-left text-zinc-500 dark:text-zinc-400 font-medium whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 50).map((item, i) => (
                <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  {columns.map(c => {
                    const val = item[c];
                    const str = typeof val === 'object' && val !== null
                      ? JSON.stringify(val)
                      : String(val ?? '');
                    return (
                      <td key={c} className="px-2 py-0.5 text-zinc-700 dark:text-zinc-300 max-w-[200px] truncate" title={str}>{str}</td>
                    );
                  })}
                </tr>
              ))}
              {items.length > 50 && (
                <tr><td colSpan={columns.length} className="px-2 py-1 text-zinc-400 text-center">... and {items.length - 50} more items</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <pre className="mt-2 p-2 rounded bg-zinc-100 dark:bg-zinc-800 text-[11px] font-mono text-zinc-600 dark:text-zinc-400 overflow-x-auto max-h-48">{JSON.stringify(data, null, 2)}</pre>
  );
}

// ── ToolCard ──

function ToolCard({ skillId, tool, isBuiltin, skillConfig }: { skillId: string; tool: SkillTool; isBuiltin: boolean; skillConfig?: UserSkillConfig }) {
  const { disabledTools, disableTool, enableTool } = useSettingsStore();
  const t = useT();
  const storeLocale = useSettingsStore((s) => s.locale);
  const isZh = storeLocale === 'zh' || !storeLocale;
  // For user-defined skills: use exposedToAI from config; for built-in: use disabledTools
  const isDisabled = isBuiltin ? disabledTools.has(tool.name) : skillConfig?.exposedToAI === false;
  const [testOpen, setTestOpen] = useState(false);

  const displayName = (isZh && tool.nameCn) || tool.name;
  const displayDesc = (isZh && tool.descriptionCn) || tool.description;

  const handleToggleExpose = async () => {
    if (isBuiltin) {
      isDisabled ? enableTool(tool.name) : disableTool(tool.name);
    } else if (skillConfig) {
      const { updateSkill } = useSkillStore.getState();
      await updateSkill({ ...skillConfig, exposedToAI: isDisabled });
    }
  };

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Code size={16} className="text-blue-500 dark:text-blue-400 shrink-0 mt-0.5" />
          <div>
            <h4 className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-200">{displayName}</h4>
            {isZh && tool.nameCn && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">{tool.name}</p>}
          </div>
        </div>
        <button onClick={() => setTestOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-[12px] rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 shrink-0">
          <Play size={12} /> {t('skills.test')}
        </button>
      </div>
      <p className="text-[13px] text-zinc-500 dark:text-zinc-400 leading-relaxed">{displayDesc}</p>
      <ParametersSection params={tool.parameters} t={t} />
      <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800">
        <div>
          <p className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">{t('skills.expose')}</p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{isDisabled ? t('skills.exposeOff') : t('skills.exposeOn')}</p>
        </div>
        <button onClick={handleToggleExpose}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isDisabled ? 'bg-zinc-200 dark:bg-zinc-700' : 'bg-blue-600'}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isDisabled ? 'translate-x-1' : 'translate-x-6'}`} />
        </button>
      </div>
      {testOpen && <TestDialog skillId={skillId} tool={tool} onClose={() => setTestOpen(false)} isBuiltin={isBuiltin} />}
    </div>
  );
}

// ── SkillEditorDialog (new / edit) ──

function SkillEditorDialog({ config, onSave, onClose }: { config?: UserSkillConfig; onSave: (cfg: UserSkillConfig) => void; onClose: () => void }) {
  const [name, setName] = useState(config?.name ?? '');
  const [desc, setDesc] = useState(config?.description ?? '');
  const [toolsJson, setToolsJson] = useState(() => JSON.stringify(config?.tools ?? [{ name: '', description: '', parameters: { type: 'object', properties: {} } }], null, 2));
  const [impl, setImpl] = useState(config?.implementation ?? '');
  const [jsonError, setJsonError] = useState('');

  const handleSave = () => {
    try {
      const tools = JSON.parse(toolsJson) as ToolDefinition[];
      if (!Array.isArray(tools) || tools.length === 0) { setJsonError('Tools must be a non-empty array'); return; }
      setJsonError('');
      onSave({
        id: config?.id ?? crypto.randomUUID(),
        name: name || 'Untitled Skill',
        description: desc,
        category: config?.category ?? 'user',
        tools,
        builtin: config?.builtin ?? false,
        implementation: impl || undefined,
      });
    } catch (e) {
      setJsonError(`Invalid JSON: ${e}`);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
            <h3 className="font-semibold text-[15px] text-zinc-900 dark:text-zinc-100">{config ? 'Edit Skill' : 'New Skill'}</h3>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div>
              <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Skill" className="w-full px-3 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description</label>
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} placeholder="What this skill does..." className="w-full px-3 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500 resize-none" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">Tools (JSON Schema array)</label>
              <textarea value={toolsJson} onChange={(e) => { setToolsJson(e.target.value); setJsonError(''); }} rows={8} className="w-full px-3 py-2 text-[12px] font-mono rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500 resize-none" />
              {jsonError && <p className="text-[12px] text-red-500 mt-1">{jsonError}</p>}
            </div>
            <div>
              <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">Implementation (JS function body, optional)</label>
              <textarea value={impl} onChange={(e) => setImpl(e.target.value)} rows={6} placeholder="// params: the tool call arguments&#10;// skill: { ok(msg, data?), fail(msg, data?) }&#10;// executor: SkillExecutor for sub-calls&#10;return skill.ok('done', { result: params.x + params.y });" className="w-full px-3 py-2 text-[12px] font-mono rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0">
            <button onClick={onClose} className="px-3 py-1.5 text-[13px] rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancel</button>
            <button onClick={handleSave} className="px-3 py-1.5 text-[13px] rounded-lg bg-blue-600 text-white hover:bg-blue-700">Save Skill</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── GenerateSkillDialog (LLM) ──

function GenerateSkillDialog({ onClose, onGenerated }: { onClose: () => void; onGenerated: (cfg: UserSkillConfig) => void }) {
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<UserSkillConfig | null>(null);
  const [error, setError] = useState('');

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError('');
    try {
      const { useModelConfigStore } = await import('@/stores/model-config-store');
      await useModelConfigStore.getState().load();
      const config = useModelConfigStore.getState().defaultConfig();
      if (!config) throw new Error('No model configured');

      let apiKey = '';
      try { apiKey = await useModelConfigStore.getState().getApiKey(config.id, ''); } catch { /* ignore */ }
      if (!apiKey) throw new Error('API key not configured');

      const { ModelScenario } = await import('@/adapters/model-call-service');
      const { getModelService } = await import('@/services/model-service-singleton');
      const modelService = getModelService();

      const systemPrompt = systemPrompts.skillGenerator;

      const stream = modelService.chatStream({
        scenario: ModelScenario.chat,
        messages: [
          { role: 'user', content: systemPrompt },
          { role: 'user', content: `Generate a skill that: ${prompt}` },
        ],
        provider: config,
        apiKey,
      });

      let text = '';
      for await (const chunk of stream) {
        if (chunk.startsWith('__ERROR__:')) throw new Error(chunk.substring(10));
        if (chunk.startsWith('__TOOLS__:') || chunk.startsWith('__REASONING__:')) continue;
        text += chunk;
      }

      // Try to extract JSON from response
      const jsonMatch = /\{[\s\S]*\}/.exec(text);
      if (!jsonMatch) throw new Error('No JSON found in response');
      const parsed = JSON.parse(jsonMatch[0]);

      const cfg: UserSkillConfig = {
        id: crypto.randomUUID(),
        name: parsed.name || 'Generated Skill',
        description: parsed.description || '',
        category: parsed.category || 'user',
        tools: (parsed.tools || []).map((t: Record<string, unknown>) => ({
          name: t.name as string,
          description: t.description as string,
          parameters: (t.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
        })),
        builtin: false,
        implementation: parsed.implementation as string | undefined,
      };

      setPreview(cfg);
    } catch (e) {
      setError(String(e));
    }
    setGenerating(false);
  };

  if (preview) {
    return (
      <>
        <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
              <h3 className="font-semibold text-[15px] text-zinc-900 dark:text-zinc-100">Preview: {preview.name}</h3>
              <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-[13px] text-zinc-600 dark:text-zinc-400">{preview.description}</p>
              <p className="text-[12px] font-semibold text-zinc-500">Tools ({preview.tools.length})</p>
              {preview.tools.map((t, i) => (
                <div key={i} className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-700">
                  <code className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">{t.name}</code>
                  <p className="text-[12px] text-zinc-500 dark:text-zinc-400 mt-1">{t.description}</p>
                </div>
              ))}
              {preview.implementation && <pre className="p-3 rounded bg-zinc-100 dark:bg-zinc-800 text-[11px] font-mono text-zinc-600 dark:text-zinc-400 overflow-x-auto">{preview.implementation}</pre>}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0">
              <button onClick={() => setPreview(null)} className="px-3 py-1.5 text-[13px] rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">Back</button>
              <button onClick={() => onGenerated(preview)} className="px-3 py-1.5 text-[13px] rounded-lg bg-blue-600 text-white hover:bg-blue-700">Save Skill</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl w-full max-w-xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <h3 className="font-semibold text-[15px] text-zinc-900 dark:text-zinc-100">Generate Skill with AI</h3>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">✕</button>
          </div>
          <div className="p-4 space-y-3">
            <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300">Describe the skill you want</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="e.g., open Notepad, type hello world, take a screenshot" className="w-full px-3 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500 resize-none" />
            {error && <p className="text-[12px] text-red-500">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
            <button onClick={onClose} className="px-3 py-1.5 text-[13px] rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancel</button>
            <button onClick={handleGenerate} disabled={generating || !prompt.trim()} className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {generating ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Sparkles size={14} />}
              Generate
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── SkillDetail ──

function SkillDetail({ skillId, onBack }: { skillId: string; onBack?: () => void }) {
  const { allConfigs, deleteSkill } = useSkillStore();
  const t = useT();
  const storeLocale = useSettingsStore((s) => s.locale);
  const [showEditor, setShowEditor] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Check built-in first
  const builtinSkill = getBuiltinSkill(skillId);
  const cfg = allConfigs.find((c) => c.id === skillId);
  const isBuiltin = !!builtinSkill;
  const isZh = storeLocale === 'zh' || !storeLocale;
  const name = (isZh && (builtinSkill?.nameCn || cfg?.nameCn)) || builtinSkill?.name || cfg?.name || '';
  const description = (isZh && (builtinSkill?.descriptionCn || cfg?.descriptionCn)) || builtinSkill?.description || cfg?.description || '';
  const category = (isZh && (builtinSkill?.categoryCn || cfg?.categoryCn)) || builtinSkill?.category || cfg?.category || '';
  const usage = (isZh && (builtinSkill?.usageCn || cfg?.usageCn)) || builtinSkill?.usage || cfg?.usage || '';
  const tools = builtinSkill?.tools ?? cfg?.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, nameCn: t.nameCn, descriptionCn: t.descriptionCn })) ?? [];

  const handleDelete = async () => {
    await deleteSkill(skillId);
    setShowDeleteConfirm(false);
    onBack?.();
  };

  const handleUpdate = async (updated: UserSkillConfig) => {
    const { updateSkill } = useSkillStore.getState();
    await updateSkill({ ...updated, id: skillId });
    setShowEditor(false);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-3xl">
        {onBack && (
          <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 mb-4 lg:hidden">
            <ArrowLeft size={16} /> Back to list
          </button>
        )}

        <div className="flex items-start gap-4 mb-4">
          <div className="p-2.5 bg-blue-50 dark:bg-blue-950 rounded-xl">
            {skillIconMap[skillId] ?? <Settings size={28} className="text-blue-500" />}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{name}</h2>
              {isBuiltin && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400">{t('skills.builtin')}</span>}
              {!isBuiltin && (
                <div className="flex gap-1">
                  <button onClick={() => setShowEditor(true)} className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"><Pencil size={14} /></button>
                  <button onClick={() => setShowDeleteConfirm(true)} className="p-1 rounded text-zinc-400 hover:text-red-500"><Trash2 size={14} /></button>
                </div>
              )}
            </div>
            <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[11px] text-zinc-500 dark:text-zinc-400">{category}</span>
          </div>
        </div>

        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-2 font-mono">{t('skills.id')}: {skillId}</p>
        <h3 className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-200 mt-6 mb-2">{t('skills.description')}</h3>
        <p className="text-[14px] text-zinc-600 dark:text-zinc-400 leading-relaxed">{description}</p>

        {usage && (
          <>
            <h3 className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-200 mt-8 mb-2">{t('skills.usage')}</h3>
            <div className="prose prose-sm dark:prose-invert max-w-none text-[14px] text-zinc-600 dark:text-zinc-400 leading-relaxed whitespace-pre-wrap">{usage}</div>
          </>
        )}

        <h3 className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-200 mt-8 mb-3">{t('skills.tools')} ({tools.length})</h3>
        {tools.length === 0 ? (
          <p className="text-[13px] text-zinc-400 dark:text-zinc-500">{t('skills.noTools')}</p>
        ) : (
          <div className="space-y-3">
            {tools.map((tool: SkillTool) => <ToolCard key={tool.name} skillId={skillId} tool={tool} isBuiltin={isBuiltin} skillConfig={cfg} />)}
          </div>
        )}

        {/* Delete confirmation */}
        {showDeleteConfirm && (
          <>
            <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setShowDeleteConfirm(false)} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl w-full max-w-sm p-6">
                <p className="text-[14px] text-zinc-800 dark:text-zinc-200 mb-4">{t('skills.deleteTitle', { name })} {t('skills.deleteConfirm')}</p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setShowDeleteConfirm(false)} className="px-3 py-1.5 text-[13px] rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">{t('skills.cancel')}</button>
                  <button onClick={handleDelete} className="px-3 py-1.5 text-[13px] rounded-lg bg-red-600 text-white hover:bg-red-700">Delete</button>
                </div>
              </div>
            </div>
          </>
        )}

        {showEditor && cfg && (
          <SkillEditorDialog config={cfg} onSave={handleUpdate} onClose={() => setShowEditor(false)} />
        )}
      </div>
    </div>
  );
}

// ── CacheHitTester ──

function CacheHitTester() {
  const [goal, setGoal] = useState('');
  const [windowFP, setWindowFP] = useState('');
  const [results, setResults] = useState<{ level: string; detail: string; entry?: Record<string, unknown> }[] | null>(null);
  const [testing, setTesting] = useState(false);
  const handleTest = async () => {
    if (!goal.trim()) return;
    setTesting(true);
    try {
      const fp = windowFP.trim() || 'manual_test_fp';
      const res = await testCacheHit(goal.trim(), fp);
      setResults(res);
    } catch (e) {
      setResults([{ level: 'error', detail: String(e) }]);
    }
    setTesting(false);
  };

  const levelColors: Record<string, { bg: string; text: string; border: string }> = {
    l3: { bg: 'bg-purple-50 dark:bg-purple-950', text: 'text-purple-700 dark:text-purple-300', border: 'border-purple-200 dark:border-purple-800' },
    l2: { bg: 'bg-green-50 dark:bg-green-950', text: 'text-green-700 dark:text-green-300', border: 'border-green-200 dark:border-green-800' },
    l1: { bg: 'bg-blue-50 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-800' },
    miss: { bg: 'bg-zinc-50 dark:bg-zinc-900', text: 'text-zinc-500', border: 'border-zinc-200 dark:border-zinc-700' },
    error: { bg: 'bg-red-50 dark:bg-red-950', text: 'text-red-600', border: 'border-red-200 dark:border-red-800' },
  };

  return (
    <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 bg-amber-50 dark:bg-amber-950/50 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-amber-700 dark:text-amber-300">Cache Hit Tester</span>
        <span className="text-[11px] text-amber-500">Test which cache level would match</span>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex gap-2">
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Goal text (e.g. 打开qq音乐播放音乐)"
            className="flex-1 px-3 py-1.5 text-[12px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400"
            onKeyDown={(e) => e.key === 'Enter' && handleTest()}
          />
          <input
            value={windowFP}
            onChange={(e) => setWindowFP(e.target.value)}
            placeholder="Window fingerprint (optional)"
            className="w-48 px-3 py-1.5 text-[12px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400"
          />
          <button
            onClick={handleTest}
            disabled={testing || !goal.trim()}
            className="px-3 py-1.5 text-[12px] rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {testing ? 'Testing...' : 'Test'}
          </button>
        </div>

        {results && (
          <div className="space-y-2">
            {results.map((r, i) => {
              const c = levelColors[r.level] || levelColors.miss;
              const isHit = r.detail.startsWith('HIT') || r.detail.startsWith('Matched');
              return (
                <div key={i} className={`px-3 py-2 rounded-lg border ${c.border} ${c.bg}`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-[12px] font-bold uppercase ${c.text}`}>{r.level}</span>
                    {isHit && <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500 text-white">HIT</span>}
                    {!isHit && r.level !== 'error' && <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-300 dark:bg-zinc-600 text-zinc-600 dark:text-zinc-300">MISS</span>}
                  </div>
                  <p className={`text-[11px] mt-1 ${c.text}`}>{r.detail}</p>
                  {r.entry && (
                    <pre className="mt-2 p-2 rounded bg-black/5 dark:bg-white/5 text-[10px] text-zinc-600 dark:text-zinc-400 overflow-x-auto max-h-32 overflow-y-auto">
                      {JSON.stringify(r.entry, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── CacheViewer ──

function CacheViewer() {
  const [uiCache, setUICache] = useState<UICacheRow[]>([]);
  const [stepCache, setStepCache] = useState<StepCacheRow[]>([]);
  const [subgoalCache, setSubgoalCache] = useState<SubGoalCacheRow[]>([]);
  const [llmCallCache, setLlmCallCache] = useState<LLMCallCacheRow[]>([]);
  const [decompositionCache, setDecompositionCache] = useState<Array<{ normalized_goal: string; subgoals_json: string; hit_count: number; created_at: number }>>([]);
  const [savedApps, setSavedApps] = useState<AppInfo[]>([]);
  const [templates, setTemplates] = useState<SkillTemplateRow[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ l1: true, l2a: true, 'l2b': true, llm: true, gd: false, l3: true, apps: false });
  const [loading, setLoading] = useState(true);
  const [clearMsg, setClearMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ui, step, sg, llm, gd, tpl, apps] = await Promise.all([
        getAllUICacheRows(),
        getAllStepCacheRows(),
        getAllSubGoalCacheRows(),
        getAllLLMCallCacheRows(),
        getAllGoalDecompositionRows(),
        getAllSkillTemplateRows(),
        desktopService.listApps().catch(() => [] as AppInfo[]),
      ]);
      setUICache(ui);
      setStepCache(step);
      setSubgoalCache(sg);
      setLlmCallCache(llm);
      setDecompositionCache(gd);
      setTemplates(tpl);
      setSavedApps(apps);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleClearAll = async () => {
    if (!confirm('Clear all cache data? This cannot be undone.')) return;
    try {
      await clearAllCache();
      await loadAll();
      setClearMsg({ type: 'ok', text: 'All cache cleared.' });
    } catch (e) {
      setClearMsg({ type: 'err', text: `Clear failed: ${e}` });
      await loadAll();
    }
    setTimeout(() => setClearMsg(null), 4000);
  };

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const fmtTime = (ts: number) => {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleString();
  };

  // ── Pre-process rows for display (avoid JSON.parse in render loop) ──
  const uiCacheDisplay = useMemo(() => uiCache.map((row) => {
    let annotations: SemanticAnnotation[] = [];
    try { annotations = JSON.parse(row.semantic_annotations || '[]'); } catch { /* */ }
    const isVision = (row.interactive_nodes === '[]' || row.interactive_nodes === '') && annotations.length > 0;
    const nodesTotalLen = row.interactive_nodes_total_len ?? row.interactive_nodes.length;
    const annTotalLen = row.semantic_annotations_total_len ?? row.semantic_annotations.length;
    return { ...row, _annotations: annotations, _isVision: isVision, _nodesTotalLen: nodesTotalLen, _annTotalLen: annTotalLen };
  }), [uiCache]);

  const subgoalDisplay = useMemo(() => subgoalCache.map((row) => {
    let stepsSummary = '';
    try {
      const steps = JSON.parse(row.template_json) as Array<{ action: string; target?: { name?: string }; params?: Record<string, unknown> }>;
      stepsSummary = steps.map(s => {
        let label = s.action;
        if (s.target?.name) label += `("${s.target.name}")`;
        else if (s.params?.text) label += `("${String(s.params.text).substring(0, 15)}")`;
        return label;
      }).join(' → ');
    } catch { /* */ }
    let params: string[] = [];
    try { params = JSON.parse(row.params_json) as string[]; } catch { /* */ }
    return { ...row, _stepsSummary: stepsSummary, _params: params };
  }), [subgoalCache]);

  const templateDisplay = useMemo(() => templates.map((row) => {
    let templateSummary = '';
    try {
      const steps = JSON.parse(row.template_json) as Array<{ action: string; target?: { name?: string } }>;
      templateSummary = steps.map(s => s.target?.name ? `${s.action}("${s.target.name}")` : s.action).join(' → ');
    } catch { /* */ }
    return { ...row, _templateSummary: templateSummary };
  }), [templates]);

  const decompositionDisplay = useMemo(() => decompositionCache.map((row) => {
    let subgoalsSummary = '';
    try {
      const parsed = JSON.parse(row.subgoals_json) as { subgoals?: Array<{ key?: string; description?: string }> };
      subgoalsSummary = (parsed.subgoals ?? []).map(s => s.key ?? s.description ?? '?').join(' → ');
    } catch { /* */ }
    return { ...row, _subgoalsSummary: subgoalsSummary };
  }), [decompositionCache]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-zinc-400">
        <RefreshCw size={16} className="animate-spin mr-2" /> Loading cache...
      </div>
    );
  }

  const total = uiCache.length + stepCache.length + subgoalCache.length + llmCallCache.length + decompositionCache.length + templates.length + savedApps.length;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={18} className="text-blue-500" />
          <h2 className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-200">Cache</h2>
          <span className="px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[10px] text-zinc-500">{total} entries</span>
        </div>
        <div className="flex items-center gap-2">
          {clearMsg && (
            <span className={`text-[11px] ${clearMsg.type === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{clearMsg.text}</span>
          )}
          <button onClick={loadAll} className="flex items-center gap-1 px-2 py-1 text-[12px] rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <RefreshCw size={12} /> Refresh
          </button>
          <button onClick={handleClearAll} className="flex items-center gap-1 px-2 py-1 text-[12px] rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950">
            <Trash2 size={12} /> Clear All
          </button>
        </div>
      </div>

      {/* Cache Hit Tester */}
      <CacheHitTester />

      {/* L1: UI Cache */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <button onClick={() => toggle('l1')} className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded.l1 ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">L1 — UI Fingerprint Cache</span>
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400">{uiCache.length}</span>
        </button>
        {expanded.l1 && (
          <div className="max-h-64 overflow-y-auto">
            {uiCache.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-zinc-400">No UI cache entries</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                    <th className="px-3 py-1.5 text-left text-zinc-500">App</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Fingerprint</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Window FP</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Page FP</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Class</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Nodes (JSON)</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Annotations (JSON)</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Hits</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">TTL</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Created</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Last Hit</th>
                    <th className="px-3 py-1.5 text-center text-zinc-500">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {uiCacheDisplay.map((row) => (
                      <tr key={row.fingerprint} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
                          {row.app_name || '-'}
                          {row._isVision && <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400">Vision</span>}
                        </td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[100px] truncate" title={row.fingerprint}>{row.fingerprint}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[80px] truncate" title={row.window_fp}>{row.window_fp || '-'}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[80px] truncate" title={row.page_fp ?? ''}>{row.page_fp || '-'}</td>
                        <td className="px-3 py-1.5 text-zinc-500">{row.window_class || '-'}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[160px] truncate" title={row.interactive_nodes}>
                          {row._nodesTotalLen > 200
                            ? row.interactive_nodes + `...(${row._nodesTotalLen})`
                            : row.interactive_nodes || '-'}
                        </td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[160px] truncate" title={row.semantic_annotations}>
                          {row._annTotalLen > 200
                            ? row.semantic_annotations + `...(${row._annTotalLen})`
                            : row.semantic_annotations || '-'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.hit_count}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-500">{row.ttl_days}d</td>
                        <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.created_at)}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.last_hit_at)}</td>
                        <td className="px-3 py-1.5 text-center">
                          <button onClick={async () => { await deleteUICache(row.fingerprint); await loadAll(); }}
                            className="text-red-400 hover:text-red-600"><Trash2 size={11} /></button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* L2a: Sub-Goal Cache */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <button onClick={() => toggle('l2a')} className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded.l2a ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">L2a — Sub-Goal Cache</span>
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-400">{subgoalCache.length}</span>
        </button>
        {expanded.l2a && (
          <div className="max-h-64 overflow-y-auto">
            {subgoalCache.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-zinc-400">No sub-goal cache entries</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                    <th className="px-3 py-1.5 text-left text-zinc-500">Sub-Goal Key</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">App</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Window FP</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Params</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Template Steps</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Source Goal</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Hits</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Last Used</th>
                    <th className="px-3 py-1.5 text-center text-zinc-500">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {subgoalDisplay.map((row) => (
                      <tr key={row.id} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300 font-semibold">{row.subgoal_key}</td>
                        <td className="px-3 py-1.5 text-zinc-500">{row.app_name || <span className="text-zinc-400 italic">any</span>}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[80px] truncate" title={row.window_fp ?? ''}>{row.window_fp || '-'}</td>
                        <td className="px-3 py-1.5 text-zinc-500">{row._params.length > 0 ? row._params.join(', ') : <span className="text-zinc-400 italic">none</span>}</td>
                        <td className="px-3 py-1.5 text-zinc-600 dark:text-zinc-400 max-w-[240px] truncate" title={row._stepsSummary}>{row._stepsSummary || <span className="text-zinc-400 italic">empty</span>}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[140px] truncate" title={row.source_goal}>{row.source_goal}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.hit_count}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.last_used_at)}</td>
                        <td className="px-3 py-1.5 text-center">
                          <button onClick={async () => { await deleteSubGoalCache(row.id); await loadAll(); }}
                            className="text-red-400 hover:text-red-600"><Trash2 size={11} /></button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* L2b: Step Cache */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <button onClick={() => toggle('l2b')} className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded['l2b'] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">L2b — Step Cache (goal fragment → element)</span>
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 dark:bg-emerald-900 text-emerald-600 dark:text-emerald-400">{stepCache.length}</span>
        </button>
        {expanded['l2b'] && (
          <div className="max-h-64 overflow-y-auto">
            {stepCache.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-zinc-400">No step cache entries</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                    <th className="px-3 py-1.5 text-left text-zinc-500">Goal Fragment</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Role</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Name</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">App</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Window FP</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Bounds</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Hits</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Last Used</th>
                    <th className="px-3 py-1.5 text-center text-zinc-500">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {stepCache.map((row) => (
                    <tr key={row.id} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{row.goal_fragment}</td>
                      <td className="px-3 py-1.5 text-zinc-500">{row.role}</td>
                      <td className="px-3 py-1.5 text-zinc-500">{row.name}</td>
                      <td className="px-3 py-1.5 text-zinc-500">{row.app_name || '-'}</td>
                      <td className="px-3 py-1.5 text-zinc-500 max-w-[80px] truncate" title={row.window_fp || ''}>{row.window_fp || '-'}</td>
                      <td className="px-3 py-1.5 text-zinc-500 max-w-[120px] truncate" title={row.bounds_json || ''}>{row.bounds_json || '-'}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.hit_count}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.last_used_at)}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button onClick={async () => { await deleteStepCache(row.id); await loadAll(); }}
                          className="text-red-400 hover:text-red-600"><Trash2 size={11} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* LLM Call Cache */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <button onClick={() => toggle('llm')} className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded.llm ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">LLM — Call Cache</span>
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-cyan-100 dark:bg-cyan-900 text-cyan-600 dark:text-cyan-400">{llmCallCache.length}</span>
        </button>
        {expanded.llm && (
          <div className="max-h-64 overflow-y-auto">
            {llmCallCache.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-zinc-400">No LLM call cache entries</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                    <th className="px-3 py-1.5 text-left text-zinc-500">Hash</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Model</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Provider</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Msgs</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Tools</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Request</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Response</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Hits</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Created</th>
                    <th className="px-3 py-1.5 text-center text-zinc-500">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {llmCallCache.map((row) => (
                    <tr key={row.id} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <td className="px-3 py-1.5 text-zinc-500 max-w-[80px] truncate" title={row.request_hash}>{row.request_hash}</td>
                      <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{row.model}</td>
                      <td className="px-3 py-1.5 text-zinc-500">{row.provider_type}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.message_count}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.tool_count}</td>
                      <td className="px-3 py-1.5 text-zinc-500 max-w-[200px] truncate" title={row.request_text || '(not stored)'}>
                        {row.request_text ? `${row.request_text.substring(0, 150)}${row.request_text.length > 150 ? `...(${row.request_text.length})` : ''}` : <span className="text-zinc-400 italic">-</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right text-zinc-500">{row.response_size ?? row.response_text?.length ?? 0} chars</td>
                      <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.hit_count}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.created_at)}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button onClick={async () => { await deleteLLMCallCache(row.id); await loadAll(); }}
                          className="text-red-400 hover:text-red-600"><Trash2 size={11} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Goal Decomposition Cache */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <button onClick={() => toggle('gd')} className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded.gd ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">L2a Helper — Goal Decomposition Cache</span>
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-teal-100 dark:bg-teal-900 text-teal-600 dark:text-teal-400">{decompositionCache.length}</span>
        </button>
        {expanded.gd && (
          <div className="max-h-64 overflow-y-auto">
            {decompositionCache.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-zinc-400">No goal decomposition entries</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                    <th className="px-3 py-1.5 text-left text-zinc-500">Normalized Goal</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Sub-Goals</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Hits</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Created</th>
                    <th className="px-3 py-1.5 text-center text-zinc-500">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {decompositionDisplay.map((row) => (
                      <tr key={row.normalized_goal} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300 max-w-[200px] truncate" title={row.normalized_goal}>{row.normalized_goal}</td>
                        <td className="px-3 py-1.5 text-zinc-600 dark:text-zinc-400 max-w-[300px] truncate" title={row._subgoalsSummary}>{row._subgoalsSummary || <span className="text-zinc-400 italic">empty</span>}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.hit_count}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.created_at)}</td>
                        <td className="px-3 py-1.5 text-center">
                          <button onClick={async () => { await deleteGoalDecomposition(row.normalized_goal); await loadAll(); }}
                            className="text-red-400 hover:text-red-600"><Trash2 size={11} /></button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* L3: Skill Templates */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <button onClick={() => toggle('l3')} className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded.l3 ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">L3 — Learned Skill Templates</span>
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-400">{templates.length}</span>
        </button>
        {expanded.l3 && (
          <div className="max-h-64 overflow-y-auto">
            {templates.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-zinc-400">No learned templates</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                    <th className="px-3 py-1.5 text-left text-zinc-500">Name</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Description</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Params</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Template</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Preconditions</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Learned</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Created</th>
                    <th className="px-3 py-1.5 text-right text-zinc-500">Last Success</th>
                    <th className="px-3 py-1.5 text-center text-zinc-500">Enabled</th>
                    <th className="px-3 py-1.5 text-center text-zinc-500">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {templateDisplay.map((row) => (
                      <tr key={row.id} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300 font-semibold">{row.name}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[160px] truncate" title={row.description}>{row.description || '-'}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[100px] truncate" title={row.params_json}>{row.params_json || '-'}</td>
                        <td className="px-3 py-1.5 text-zinc-600 dark:text-zinc-400 max-w-[200px] truncate" title={row._templateSummary}>{row._templateSummary || <span className="text-zinc-400 italic">-</span>}</td>
                        <td className="px-3 py-1.5 text-zinc-500 max-w-[120px] truncate" title={row.preconditions_json}>{row.preconditions_json || '-'}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">{row.learned_from}x</td>
                        <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.created_at)}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-500">{fmtTime(row.last_success_at ?? 0)}</td>
                        <td className="px-3 py-1.5 text-center">{row.enabled ? <span className="text-green-500">Y</span> : <span className="text-red-400">N</span>}</td>
                        <td className="px-3 py-1.5 text-center">
                          <button onClick={async () => { await deleteSkillTemplate(row.id); await loadAll(); }}
                            className="text-red-400 hover:text-red-600"><Trash2 size={11} /></button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* App Index */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <button onClick={() => toggle('apps')} className="w-full flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {expanded.apps ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">App Index (Desktop)</span>
          <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-cyan-100 dark:bg-cyan-900 text-cyan-600 dark:text-cyan-400">{savedApps.length}</span>
        </button>
        {expanded.apps && (
          <div className="max-h-64 overflow-y-auto">
            {savedApps.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-zinc-400">No apps indexed</p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 sticky top-0">
                    <th className="px-3 py-1.5 text-left text-zinc-500">Name</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Source</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">Path</th>
                    <th className="px-3 py-1.5 text-left text-zinc-500">App ID</th>
                  </tr>
                </thead>
                <tbody>
                  {savedApps.map((app, i) => (
                    <tr key={`${app.name}-${i}`} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300 font-semibold">{app.name}</td>
                      <td className="px-3 py-1.5 text-zinc-500">
                        <span className={`px-1 py-0.5 rounded text-[9px] ${
                          app.source === 'registry' ? 'bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400'
                          : app.source === 'shortcut' ? 'bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-400'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
                        }`}>{app.source}</span>
                      </td>
                      <td className="px-3 py-1.5 text-zinc-500 max-w-[250px] truncate" title={app.path}>{app.path || '-'}</td>
                      <td className="px-3 py-1.5 text-zinc-500 max-w-[100px] truncate" title={app.app_id}>{app.app_id || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main SkillsPage ──

export default function SkillsPage() {
  const t = useT();
  const { loaded, allConfigs, userSkills, initializeSkills, createSkill, updateSkill } = useSkillStore();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [executorReady, setExecutorReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      await initializeSkills();
      // Pass DB configs (allConfigs) to executor — DB is the single source of truth
      const configs = useSkillStore.getState().allConfigs;
      if (configs.length > 0) {
        await initBuiltinExecutor(configs);
        setExecutorReady(true);
      }
    })();
  }, [initializeSkills]);

  // Build combined list: built-in skills from executor + user skills from store
  const storeLocale = useSettingsStore((s) => s.locale);
  const isZh = storeLocale === 'zh' || !storeLocale;
  const builtinSkills = getBuiltinExecutor().allSkills;
  const userSkillList = [...userSkills.values()];

  // Group by category
  const allItems: Array<{ id: string; name: string; category: string; toolsLen: number; isBuiltin: boolean }> = [
    ...builtinSkills.map((s) => ({ id: s.id, name: (isZh && s.nameCn) || s.name, category: (isZh && s.categoryCn) || s.category, toolsLen: s.tools.length, isBuiltin: true })),
    ...userSkillList.map((s) => ({ id: s.id, name: (isZh && s.nameCn) || s.name, category: (isZh && s.categoryCn) || s.category, toolsLen: s.tools.length, isBuiltin: false })),
  ];

  const grouped = new Map<string, typeof allItems>();
  for (const item of allItems) {
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }

  const selectedSkill = selectedSkillId ? (getBuiltinSkill(selectedSkillId) ?? userSkills.get(selectedSkillId)) : null;

  const handleCreate = async (cfg: UserSkillConfig) => {
    await createSkill(cfg);
    const executor2 = getBuiltinExecutor();
    const userDef = new UserDefinedSkill(cfg);
    userDef.setExecutor(executor2);
    setShowNewDialog(false);
  };

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      let cfg: UserSkillConfig;
      if (file.name.endsWith('.json')) {
        const parsed = JSON.parse(text);
        cfg = { id: crypto.randomUUID(), ...parsed, builtin: false, tools: parsed.tools ?? [] };
      } else {
        const mdCfg = parseSkillMarkdown(text);
        cfg = { ...mdCfg, id: crypto.randomUUID(), builtin: false, tools: mdCfg.tools ?? [] };
      }
      await createSkill(cfg);
      const executor2 = getBuiltinExecutor();
      const userDef = new UserDefinedSkill(cfg);
      userDef.setExecutor(executor2);
    } catch { /* ignore */ }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [createSkill]);

  if (!loaded || !executorReady) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500">
        <Settings size={56} className="mb-4 opacity-30" />
        <p className="text-[13px]">Loading skills...</p>
      </div>
    );
  }

  if (allItems.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500">
        <Settings size={56} className="mb-4 opacity-30" />
        <h2 className="text-lg font-semibold text-zinc-500 dark:text-zinc-400 mb-2">{t('skills.empty')}</h2>
        <p className="text-[13px] text-center max-w-xs mb-4">{t('skills.empty.subtitle')}</p>
        <button onClick={() => setShowNewDialog(true)} className="flex items-center gap-2 px-4 py-2 rounded-full bg-blue-600 text-white text-[14px] font-medium hover:bg-blue-700">
          <Plus size={16} /> {t('skills.createFirst')}
        </button>
        {showNewDialog && <SkillEditorDialog onSave={handleCreate} onClose={() => setShowNewDialog(false)} />}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <h1 className="flex-1 text-[14px] font-semibold text-zinc-800 dark:text-zinc-200">{t('skills.title')}</h1>
        <input ref={fileInputRef} type="file" accept=".md,.json" onChange={handleImport} className="hidden" />
        <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <Upload size={13} /> {t('skills.import')}
        </button>
        <button onClick={() => setShowGenerateDialog(true)} className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] rounded-lg border border-purple-200 dark:border-purple-800 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950">
          <Sparkles size={13} /> {t('skills.generate')}
        </button>
        <button onClick={() => setShowNewDialog(true)} className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] rounded-lg bg-blue-600 text-white hover:bg-blue-700">
          <Plus size={13} /> {t('skills.new')}
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <div className={`${selectedSkillId ? 'hidden lg:block' : 'flex-1'} w-[280px] border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto shrink-0`}>
          {[...grouped.entries()].map(([category, items]) => (
            <div key={category}>
              <CategoryHeader title={category} count={items.length} />
              {items.map((item) => (
                <button key={item.id} onClick={() => setSelectedSkillId(item.id)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${item.id === selectedSkillId ? 'bg-blue-50 dark:bg-blue-950' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}>
                  <span className={item.id === selectedSkillId ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400 dark:text-zinc-500'}>
                    {skillIconMap[item.id] ?? <Settings size={20} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className={`text-[13px] font-medium truncate ${item.id === selectedSkillId ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-700 dark:text-zinc-300'}`}>{item.name}</p>
                      {item.isBuiltin && <span className="shrink-0 px-1 py-0.5 rounded text-[9px] bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400">{t('skills.builtin')}</span>}
                    </div>
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('skills.tools')} ({item.toolsLen})</p>
                  </div>
                </button>
              ))}
              <div className="border-b border-zinc-100 dark:border-zinc-800 mx-4" />
            </div>
          ))}
          {/* Cache entry */}
          <div className="border-b border-zinc-100 dark:border-zinc-800 mx-4" />
          <button onClick={() => setSelectedSkillId('__cache__')}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${selectedSkillId === '__cache__' ? 'bg-blue-50 dark:bg-blue-950' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}>
            <span className={selectedSkillId === '__cache__' ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400 dark:text-zinc-500'}>
              <Database size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-[13px] font-medium truncate ${selectedSkillId === '__cache__' ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-700 dark:text-zinc-300'}`}>Cache</p>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">L1 / L2 / L3</p>
            </div>
          </button>
        </div>

        {/* Detail */}
        {selectedSkillId === '__cache__' ? (
          <div className="flex-1 overflow-y-auto">
            <CacheViewer />
          </div>
        ) : selectedSkill ? (
          <SkillDetail skillId={selectedSkill.id} onBack={() => setSelectedSkillId(null)} />
        ) : (
          <div className="hidden lg:flex flex-1 items-center justify-center text-zinc-400 dark:text-zinc-500">
            <div className="text-center">
              <ArrowLeft size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-[14px]">{t('skills.selectHint')}</p>
            </div>
          </div>
        )}
      </div>

      {/* Dialogs */}
      {showNewDialog && <SkillEditorDialog onSave={handleCreate} onClose={() => setShowNewDialog(false)} />}
      {showGenerateDialog && <GenerateSkillDialog onClose={() => setShowGenerateDialog(false)} onGenerated={handleCreate} />}
    </div>
  );
}
