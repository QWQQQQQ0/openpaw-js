// 来源: lib/providers/model_config_provider.dart

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getDB } from '@/db';
import type { ModelProviderRow } from '@/db';
import type { ProviderConfig, ProviderType } from '@/types/provider';
import { encrypt } from '@/utils/crypto';

interface ModelConfigState {
  providers: ProviderConfig[];
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  save: (params: {
    id?: string;
    name: string;
    type: ProviderType;
    baseUrl: string;
    model: string;
    apiKey: string;
    isDefault?: boolean;
    supportsTools?: boolean;
    thinkingMode?: boolean;
    supportsMultimodal?: boolean;
    password: string;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  getApiKey: (providerId: string, password: string) => Promise<string>;
  defaultConfig: () => ProviderConfig | undefined;
}

function rowToConfig(row: ModelProviderRow): ProviderConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.provider_type as ProviderType,
    baseUrl: row.base_url,
    model: row.model,
    encryptedApiKey: row.encrypted_api_key,
    isDefault: row.is_default === 1,
    supportsTools: row.supports_tools !== 0,
    thinkingMode: row.thinking_mode === 1,
    supportsMultimodal: row.supports_multimodal !== 0,
    createdAt: row.created_at,
  };
}

export const useModelConfigStore = create<ModelConfigState>()(
  immer((set, get) => ({
    providers: [],
    loading: false,
    error: null,

    load: async () => {
      set({ loading: true, error: null });
      try {
        const db = await getDB();
        const rows = await db.query<ModelProviderRow>(
          'SELECT * FROM modelProviders ORDER BY created_at DESC'
        );
        set({ providers: rows.map(rowToConfig), loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    save: async ({ id, name, type, baseUrl, model, apiKey, isDefault, supportsTools, thinkingMode, supportsMultimodal, password }) => {
      const db = await getDB();
      // When editing with empty apiKey, keep existing encrypted key
      let encryptedApiKey: string;
      if (id && !apiKey) {
        const row = await db.get<ModelProviderRow>(
          'SELECT encrypted_api_key FROM modelProviders WHERE id = ?', [id]
        );
        encryptedApiKey = row?.encrypted_api_key ?? '';
      } else {
        encryptedApiKey = await encrypt(apiKey, password);
      }
      const providerId = id ?? crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const supportsToolsVal = (supportsTools ?? true) ? 1 : 0;
      const thinkingModeVal = (thinkingMode ?? false) ? 1 : 0;
      const supportsMultimodalVal = (supportsMultimodal ?? true) ? 1 : 0;

      if (isDefault) {
        await db.execute('UPDATE modelProviders SET is_default = 0');
      }

      await db.execute(
        `INSERT INTO modelProviders (id, name, provider_type, base_url, model, encrypted_api_key, is_default, supports_tools, thinking_mode, supports_multimodal, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, provider_type=excluded.provider_type,
           base_url=excluded.base_url, model=excluded.model,
           encrypted_api_key=excluded.encrypted_api_key, is_default=excluded.is_default,
           supports_tools=excluded.supports_tools, thinking_mode=excluded.thinking_mode,
           supports_multimodal=excluded.supports_multimodal`,
        [providerId, name, type, baseUrl, model, encryptedApiKey, isDefault ? 1 : 0, supportsToolsVal, thinkingModeVal, supportsMultimodalVal, createdAt]
      );
      await get().load();
    },

    remove: async (id) => {
      const db = await getDB();
      await db.execute('DELETE FROM modelProviders WHERE id = ?', [id]);
      await get().load();
    },

    setDefault: async (id) => {
      const db = await getDB();
      await db.execute('UPDATE modelProviders SET is_default = 0');
      await db.execute('UPDATE modelProviders SET is_default = 1 WHERE id = ?', [id]);
      await get().load();
    },

    getApiKey: async (providerId, password) => {
      const db = await getDB();
      const row = await db.get<ModelProviderRow>(
        'SELECT encrypted_api_key FROM modelProviders WHERE id = ?',
        [providerId]
      );
      if (!row) throw new Error('Provider not found');
      const { decrypt } = await import('@/utils/crypto');
      return decrypt(row.encrypted_api_key, password);
    },

    defaultConfig: () => {
      const { providers } = get();
      const def = providers.find(p => p.isDefault);
      return def ?? providers[0];
    },
  }))
);
