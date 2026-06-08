// 保存操作：将学习到的能力写入 ui_cache

import type { ElementCapability, InteractiveNode, SemanticAnnotation, VisionElement, WindowBounds } from './types';
import { getUICache, updateSemanticAnnotations } from '@/services/cache-service';
import { getSession, getSnapshot, getScreenshotPath } from './state';

/** 增量保存：将单个新发现的能力立即写入 ui_cache */
export async function saveSingleCapability(
  key: string,
  capability: ElementCapability,
  bounds: InteractiveNode['bounds'],
  winBounds?: WindowBounds | null,
  visionInfo?: { label: string; description: string; keywords: string[]; type?: 'interactive' | 'content' },
  targetFingerprint?: string,
): Promise<void> {
  const session = getSession();
  if (!session) return;

  const fingerprint = targetFingerprint ?? session.fingerprint;
  const { appName } = session;
  let existing = await getUICache(fingerprint);

  // 首次学习时记录可能不存在，先创建
  if (!existing) {
    const { storeUICache } = await import('@/services/cache-service');
    await storeUICache(fingerprint, fingerprint, null, appName, '', getSnapshot() ?? [], [], null, null, getScreenshotPath());
    existing = await getUICache(fingerprint);
    if (!existing) return;
  } else if (getScreenshotPath() && !existing.row.screenshot_path) {
    // 记录已存在但没有截图路径，补充更新
    const { updateScreenshotPath } = await import('@/services/cache-service');
    await updateScreenshotPath(fingerprint, getScreenshotPath()!);
  }

  // 从 bounds 计算相对坐标
  let relX = 0.5, relY = 0.5, relW: number | undefined, relH: number | undefined;
  if (bounds && winBounds && winBounds.width > 0 && winBounds.height > 0) {
    relX = Math.max(0, Math.min(1, (bounds.left - winBounds.x) / winBounds.width));
    relY = Math.max(0, Math.min(1, (bounds.top - winBounds.y) / winBounds.height));
    relW = Math.max(0.01, Math.min(1, bounds.width / winBounds.width));
    relH = Math.max(0.01, Math.min(1, bounds.height / winBounds.height));
  }

  // 从 key 解析 role/name
  const [role, ...nameParts] = key.split(':');
  const name = nameParts.length > 0 ? nameParts.join(':') : key;

  // 构建语义信息：视觉 > 规则推断
  const label = visionInfo?.label || name || role;
  const description = visionInfo?.description || capability.notes || `${role} 元素`;
  const keywords = visionInfo?.keywords?.length
    ? visionInfo.keywords
    : [name, role].filter(Boolean);

  // 检查是否已存在
  const already = existing.annotations.some(ann => (ann.automationId || `${ann.role}:${ann.name}`) === key);
  if (already) {
    const updated = existing.annotations.map(ann => {
      if ((ann.automationId || `${ann.role}:${ann.name}`) === key && !ann.capability) {
        return { ...ann, capability };
      }
      return ann;
    });
    await updateSemanticAnnotations(fingerprint, updated);
  } else {
    const newAnn: SemanticAnnotation = {
      label,
      description,
      role,
      name,
      automationId: key.includes(':') ? '' : key,
      relativeX: relX,
      relativeY: relY,
      relativeWidth: relW,
      relativeHeight: relH,
      keywords,
      type: visionInfo?.type ?? 'interactive',
      capability,
    };
    await updateSemanticAnnotations(fingerprint, [...existing.annotations, newAnn]);
  }
}

/** 保存视觉发现的元素为 SemanticAnnotation */
export async function saveVisionElementAsAnnotation(ve: VisionElement, capability: ElementCapability, targetFingerprint?: string): Promise<void> {
  const session = getSession();
  if (!session) return;

  const fingerprint = targetFingerprint ?? session.fingerprint;
  const { appName } = session;
  let existing = await getUICache(fingerprint);

  // 首次学习时记录可能不存在，先创建
  if (!existing) {
    const { storeUICache } = await import('@/services/cache-service');
    await storeUICache(fingerprint, fingerprint, null, appName, '', getSnapshot() ?? [], [], null, null, getScreenshotPath());
    existing = await getUICache(fingerprint);
    if (!existing) return;
  } else if (getScreenshotPath() && !existing.row.screenshot_path) {
    const { updateScreenshotPath } = await import('@/services/cache-service');
    await updateScreenshotPath(fingerprint, getScreenshotPath()!);
  }

  const newAnn: SemanticAnnotation = {
    label: ve.label,
    description: ve.description,
    role: 'vision',
    name: ve.label,
    automationId: '',
    relativeX: ve.relativeX,
    relativeY: ve.relativeY,
    relativeWidth: ve.relativeWidth,
    relativeHeight: ve.relativeHeight,
    keywords: ve.keywords,
    type: ve.type,
    capability,
  };

  await updateSemanticAnnotations(fingerprint, [...existing.annotations, newAnn]);
}
