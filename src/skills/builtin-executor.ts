// Shared built-in executor factory — DB is the single source of truth for tool definitions.
// On startup, skill-store syncs markdown → DB. This module only reads from DB configs.
// All consumers that need built-in skill instances must go through this module.

import { SkillExecutor } from './executor';
import { DesktopScreenSkill } from './desktop';
import { DesktopUIASkill } from './desktop_uia';
import { WebScreenSkill } from './web';
import { PhoneScreenSkill } from './phone';
import { AppBuilderSkill } from './app-builder';
import { OfficeDocSkill } from './office-doc';
import { CodeToolsSkill } from './code-tools';
import type { Skill } from './skill';
import type { UserSkillConfig, ToolDefinition } from '@/types/skill';
import { desktopService } from '@/services/desktop-service';
import { extensionBridge } from '@/services/extension-bridge';
import { webScreenService } from '@/services/web-screen-service';
import type { IModelService } from '@/interfaces/model-service';
import type { ProviderConfig } from '@/types/provider';

let _executor: SkillExecutor | null = null;

/**
 * Initialize the built-in executor with skill configs from DB.
 * Must be called after skill-store.initializeSkills() so configs are available.
 * @param configs Skill configs loaded from DB (the single source of truth).
 */
export async function initBuiltinExecutor(configs: UserSkillConfig[]): Promise<SkillExecutor> {
  if (!_executor) {
    _executor = new SkillExecutor();
  }

  // Always rebuild from provided configs to avoid stale/empty executor from early init.
  if (configs.length > 0) {
    for (const cfg of configs) {
      if (!cfg.builtin) continue;
      const tools = cfg.tools as ToolDefinition[];
      const i18n = {
        nameCn: cfg.nameCn,
        descriptionCn: cfg.descriptionCn,
        categoryCn: cfg.categoryCn,
        usage: cfg.usage,
        usageCn: cfg.usageCn,
      };
      switch (cfg.id) {
        case 'desktop_screen':
          _executor.register(new DesktopScreenSkill(desktopService, { tools, ...i18n }));
          break;
        case 'desktop_uia':
          _executor.register(new DesktopUIASkill(desktopService, { tools, ...i18n }));
          break;
        case 'web_screen':
          _executor.register(new WebScreenSkill(extensionBridge, webScreenService, desktopService, { tools, ...i18n }));
          break;
        case 'phone_screen':
          _executor.register(new PhoneScreenSkill({ tools, ...i18n }));
          break;
        case 'app_builder':
          _executor.register(new AppBuilderSkill({ tools, ...i18n }));
          break;
        case 'office_doc':
          _executor.register(new OfficeDocSkill({ tools, ...i18n }));
          break;
        case 'code_tools':
          _executor.register(new CodeToolsSkill());
          break;
      }
    }
  }

  return _executor;
}

export function getBuiltinExecutor(): SkillExecutor {
  return _executor ?? new SkillExecutor();
}

export function getBuiltinSkill(id: string): Skill | undefined {
  return _executor?.getSkill(id);
}

/**
 * Configure ModelService for CodeToolsSkill.
 * This enables unified LLM access for code generation tools.
 */
export function setCodeToolsModelService(
  modelService: IModelService,
  provider: ProviderConfig,
  apiKey: string,
): void {
  const codeTools = _executor?.getSkill('code_tools') as CodeToolsSkill | undefined;
  if (codeTools) {
    codeTools.setModelService(modelService, provider, apiKey);
  }
}
