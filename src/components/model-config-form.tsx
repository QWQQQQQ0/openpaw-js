// 来源: lib/screens/model_config_screen.dart

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Brain, Lightbulb, Wifi, Save, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useModelConfigStore } from '@/stores/model-config-store';
import { useT } from '@/i18n/strings';
import type { ProviderType, ProviderConfig } from '@/types/provider';

const providerTypes: { value: ProviderType; label: string; icon: React.ReactNode }[] = [
  { value: 'openai', label: 'OpenAI', icon: <Sparkles size={16} /> },
  { value: 'anthropic', label: 'Anthropic', icon: <Brain size={16} /> },
  { value: 'google', label: 'Gemini', icon: <Lightbulb size={16} /> },
];

const defaultUrls: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};

export function ModelConfigForm({ existing }: { existing?: ProviderConfig }) {
  const navigate = useNavigate();
  const t = useT();
  const { load, save, remove, save: doSave } = useModelConfigStore();

  const isEditing = !!existing;

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<ProviderType>(existing?.type ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [model, setModel] = useState(existing?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [supportsTools, setSupportsTools] = useState(existing?.supportsTools ?? true);
  const [thinkingMode, setThinkingMode] = useState(existing?.thinkingMode ?? false);
  const [supportsMultimodal, setSupportsMultimodal] = useState(existing?.supportsMultimodal ?? true);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!existing?.baseUrl) {
      setBaseUrl(defaultUrls[type]);
    }
  }, [type, existing]);

  const handleTypeChange = (newType: ProviderType) => {
    setType(newType);
    if (!existing?.baseUrl || defaultUrls[existing.type] === existing.baseUrl) {
      setBaseUrl(defaultUrls[newType]);
    }
  };

  const handleTestConnection = async () => {
    if (!baseUrl.trim() || !model.trim()) {
      setTestResult({ success: false, message: '请先填写 Base URL 和模型名称' });
      return;
    }

    let key = apiKey.trim();
    if (!key && isEditing && existing) {
      try {
        key = await useModelConfigStore.getState().getApiKey(existing.id, '');
      } catch { /* ignore */ }
    }
    if (!key) {
      setTestResult({ success: false, message: '请填写 API Key' });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      let url: string;
      let headers: Record<string, string>;
      let body: string;

      const base = baseUrl.replace(/\/$/, '');

      if (type === 'anthropic') {
        // Anthropic: POST /v1/messages, x-api-key header
        url = `${base}/v1/messages`;
        headers = {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        };
        body = JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
        });
      } else if (type === 'google') {
        // Google Gemini: POST /v1beta/models/{model}:streamGenerateContent?key=...
        url = `${base}/v1beta/models/${model}:streamGenerateContent?key=${key}`;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        });
      } else {
        // OpenAI: POST /chat/completions, Authorization: Bearer
        url = `${base}/chat/completions`;
        headers = {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        };
        body = JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
          stream: false,
        });
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });

      const data = await res.json();

      if (type === 'anthropic') {
        if (data.content || data.type === 'message') {
          setTestResult({ success: true, message: `连通成功 ✓\n模型: ${model}\n端点: ${baseUrl}` });
        } else if (data.error) {
          const msg = typeof data.error === 'object' ? (data.error.message ?? JSON.stringify(data.error)) : String(data.error);
          setTestResult({ success: false, message: `API 错误: ${msg}` });
        } else {
          setTestResult({ success: false, message: `未知响应格式: ${JSON.stringify(data)}` });
        }
      } else if (type === 'google') {
        if (data.candidates || data.error) {
          if (data.error) {
            const msg = typeof data.error === 'object' ? (data.error.message ?? JSON.stringify(data.error)) : String(data.error);
            setTestResult({ success: false, message: `API 错误: ${msg}` });
          } else {
            setTestResult({ success: true, message: `连通成功 ✓\n模型: ${model}\n端点: ${baseUrl}` });
          }
        } else {
          setTestResult({ success: false, message: `未知响应格式: ${JSON.stringify(data)}` });
        }
      } else {
        // OpenAI
        if (data.choices) {
          setTestResult({ success: true, message: `连通成功 ✓\n模型: ${model}\n端点: ${baseUrl}` });
        } else if (data.error) {
          const msg = typeof data.error === 'object' ? (data.error.message ?? JSON.stringify(data.error)) : String(data.error);
          setTestResult({ success: false, message: `API 错误: ${msg}` });
        } else {
          setTestResult({ success: false, message: `未知响应格式: ${JSON.stringify(data)}` });
        }
      }
    } catch (e) {
      setTestResult({ success: false, message: `连接失败: ${e}` });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      alert(t('model.required'));
      return;
    }
    if (!baseUrl.trim()) {
      alert(t('model.required'));
      return;
    }
    if (!model.trim()) {
      alert(t('model.required'));
      return;
    }
    if (!isEditing && !apiKey.trim()) {
      alert(t('model.required'));
      return;
    }

    setSaving(true);
    try {
      await save({
        id: existing?.id,
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
        isDefault,
        supportsTools,
        thinkingMode,
        supportsMultimodal,
        password: '',
      });
      navigate('/models');
    } catch (e) {
      alert(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    const confirmed = confirm(t('model.delete.confirm', { name: existing.name }));
    if (!confirmed) return;
    try {
      await useModelConfigStore.getState().remove(existing.id);
      navigate('/models');
    } catch (e) {
      alert(`Failed to delete: ${e}`);
    }
  };

  return (
    <div>
      <div className="max-w-lg mx-auto p-4 space-y-5">
        {/* Provider type selector */}
        <div>
          <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-2">Provider Type</label>
          <div className="grid grid-cols-3 gap-2">
            {providerTypes.map((pt) => (
              <button
                key={pt.value}
                onClick={() => handleTypeChange(pt.value)}
                className={`flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border text-[13px] font-medium transition-colors ${
                  type === pt.value
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                {pt.icon}
                {pt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
            {t('model.name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('model.name.hint')}
            className="w-full px-3 py-2 text-[14px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
          />
        </div>

        {/* Base URL */}
        <div>
          <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
            {t('model.baseurl')}
          </label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={t('model.baseurl.hint')}
            className="w-full px-3 py-2 text-[14px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500 font-mono text-[13px]"
          />
        </div>

        {/* Model ID */}
        <div>
          <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
            {t('model.modelid')}
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('model.modelid.hint')}
            className="w-full px-3 py-2 text-[14px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
          />
        </div>

        {/* API Key */}
        <div>
          <label className="block text-[13px] font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
            {t('model.apikey')}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isEditing ? 'Enter new key to update (leave blank to keep)' : 'sk-...'}
            className="w-full px-3 py-2 text-[14px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
          />
        </div>

        {/* Default toggle */}
        <label className="flex items-center justify-between py-1">
          <div>
            <p className="text-[14px] font-medium text-zinc-700 dark:text-zinc-300">{t('model.default')}</p>
            <p className="text-[12px] text-zinc-400 dark:text-zinc-500">{t('model.default.subtitle')}</p>
          </div>
          <button
            onClick={() => setIsDefault(!isDefault)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              isDefault ? 'bg-blue-600' : 'bg-zinc-200 dark:bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isDefault ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>

        {/* Supports tools */}
        <label className="flex items-center justify-between py-1">
          <div>
            <p className="text-[14px] font-medium text-zinc-700 dark:text-zinc-300">支持 Function Calling</p>
            <p className="text-[12px] text-zinc-400 dark:text-zinc-500">模型支持原生 tools/function calling 参数</p>
          </div>
          <button
            onClick={() => setSupportsTools(!supportsTools)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              supportsTools ? 'bg-blue-600' : 'bg-zinc-200 dark:bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                supportsTools ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>

        {/* Thinking mode */}
        <label className="flex items-center justify-between py-1">
          <div>
            <p className="text-[14px] font-medium text-zinc-700 dark:text-zinc-300">思考模式 (Thinking)</p>
            <p className="text-[12px] text-zinc-400 dark:text-zinc-500">MiMo 等模型的深度思考能力，开启后返回思考链</p>
          </div>
          <button
            onClick={() => setThinkingMode(!thinkingMode)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              thinkingMode ? 'bg-blue-600' : 'bg-zinc-200 dark:bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                thinkingMode ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>

        {/* Supports multimodal */}
        <label className="flex items-center justify-between py-1">
          <div>
            <p className="text-[14px] font-medium text-zinc-700 dark:text-zinc-300">支持多模态 (Vision)</p>
            <p className="text-[12px] text-zinc-400 dark:text-zinc-500">模型支持图片+文本输入，用于截图视觉分析。不支持时遇到图片会自动切换</p>
          </div>
          <button
            onClick={() => setSupportsMultimodal(!supportsMultimodal)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              supportsMultimodal ? 'bg-blue-600' : 'bg-zinc-200 dark:bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                supportsMultimodal ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>

        {/* Test connection */}
        <button
          onClick={handleTestConnection}
          disabled={isTesting}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[14px] font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
        >
          {isTesting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Wifi size={16} />
          )}
          {isTesting ? '测试中...' : '测试连通性'}
        </button>

        {/* Test result */}
        {testResult && (
          <div
            className={`p-3 rounded-lg border ${
              testResult.success
                ? 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800'
                : 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              {testResult.success ? (
                <CheckCircle size={14} className="text-green-500" />
              ) : (
                <XCircle size={14} className="text-red-500" />
              )}
              <span className={`text-[13px] font-semibold ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {testResult.success ? 'Success' : 'Failed'}
              </span>
            </div>
            <p className="text-[12px] font-mono text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
              {testResult.message}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 text-white font-medium text-[14px] hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {isEditing ? t('model.update') : t('model.save')}
          </button>
          {isEditing && (
            <button
              onClick={handleDelete}
              className="px-4 py-2.5 rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 font-medium text-[14px]"
            >
              {t('common.delete')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
