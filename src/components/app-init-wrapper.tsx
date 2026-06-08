import { useEffect } from 'react';
import { ThemeProvider } from './theme-provider';
import { useSettingsStore } from '@/stores/settings-store';
import { useModelConfigStore } from '@/stores/model-config-store';
import { setLocale } from '@/i18n/strings';
import { appLogger } from '@/services/app-logger';
import { watcherManager } from '@/services/watcher';

export function AppInitWrapper() {
  const loadSettings = useSettingsStore((s) => s.load);
  const loaded = useSettingsStore((s) => s.loaded);
  const loadConfigs = useModelConfigStore((s) => s.load);
  const locale = useSettingsStore((s) => s.locale);

  useEffect(() => {
    const init = async () => {
      loadSettings();
      await loadConfigs();
      appLogger.start();
      watcherManager.restore().catch(() => {});
      watcherManager.initSync().catch(() => {});
    };
    init();
  }, [loadSettings, loadConfigs]);

  useEffect(() => {
    if (loaded) {
      setLocale(locale ? (locale === 'zh' ? 'zh' : 'en') : 'zh');
    }
  }, [loaded, locale]);

  return <ThemeProvider />;
}
