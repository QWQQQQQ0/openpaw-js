// UIA 差异检测 + 子组件记录

import type { InteractiveNode, TriggerInfo } from './types';
import { desktopService } from '@/services/desktop-service';
import { getUICache, updateSemanticAnnotations } from '@/services/cache-service';
import { getCacheService } from '@/services/cache-service-singleton';
import * as state from './state';
import { inferCapabilityFromInteraction } from './inference';
import { saveSingleCapability } from './storage';

// ── UIA helpers ──

export async function fetchInteractiveNodes(hwnd: number): Promise<InteractiveNode[]> {
  try {
    const result = await desktopService.uiaGetInteractive(hwnd, { onscreen_only: true, limit: 500 });
    const nodes = (result.nodes ?? result) as unknown[];
    if (!Array.isArray(nodes)) return [];
    return nodes.map((n) => {
      const node = n as Record<string, unknown>;
      return {
        role: String(node.role ?? ''),
        name: String(node.name ?? ''),
        automation_id: String(node.automation_id ?? node.automationId ?? ''),
        class_name: String(node.class_name ?? node.className ?? ''),
        enabled: Boolean(node.enabled),
        visible: Boolean(node.visible ?? node.is_visible ?? true),
        bounds: node.bounds as InteractiveNode['bounds'] ?? null,
      };
    });
  } catch {
    return [];
  }
}

export async function getAppFingerprint(hwnd: number): Promise<string> {
  try {
    const result = await desktopService.uiaFingerprint(hwnd);
    // Python 端返回的是 { window_fp: "xxx", pages: {...}, ... }
    const fp = result.window_fp ?? result.fingerprint ?? `hwnd_${hwnd}`;
    return typeof fp === 'string' ? fp : String(fp);
  } catch {
    return `hwnd_${hwnd}`;
  }
}

// ── 差异检测 ──

export function diffUIATrees(before: InteractiveNode[], after: InteractiveNode[]): InteractiveNode[] {
  const beforeIds = new Set(before.map(n => n.automation_id || `${n.role}:${n.name}`));
  return after.filter(n => {
    const key = n.automation_id || `${n.role}:${n.name}`;
    return !beforeIds.has(key) && n.visible && n.enabled;
  });
}

/** 根据屏幕坐标找到基线快照中被点击的元素 */
export function findElementAtPoint(nodes: InteractiveNode[], x: number, y: number): InteractiveNode | null {
  const matches = nodes.filter(n => {
    if (!n.bounds) return false;
    const b = n.bounds;
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  });
  if (matches.length === 0) return null;
  return matches.reduce((best, n) => {
    const bA = best.bounds!;
    const bB = n.bounds!;
    const areaA = (bA.right - bA.left) * (bA.bottom - bA.top);
    const areaB = (bB.right - bB.left) * (bB.bottom - bB.top);
    return areaB < areaA ? n : best;
  });
}

/** 判断新出现的元素是否是弹出/展开类子组件 */
export function isPopupOrExpanding(newElements: InteractiveNode[], interactionType: string): boolean {
  const popupRoles = ['menu', 'menuitem', 'popup', 'tooltip', 'dialog'];
  const hasPopupRole = newElements.some(el =>
    popupRoles.some(r => el.role.toLowerCase().includes(r))
  );
  if (interactionType === 'mouse_right_click') return true;
  if (hasPopupRole) return true;
  if (newElements.length >= 3) return true;
  return false;
}

// ── 子组件记录 ──

/**
 * 将新出现的元素记录为子组件
 * 返回子组件的 fingerprint
 */
export async function recordChildComponent(
  clickedElement: InteractiveNode,
  newElements: InteractiveNode[],
  interactionType: string,
): Promise<string | null> {
  const session = state.getSession();
  if (!session) return null;

  const { fingerprint, appName } = session;
  const cache = getCacheService();

  const triggerType = interactionType === 'mouse_right_click' ? 'click' : 'click';
  const trigger: TriggerInfo = {
    type: triggerType,
    detail: `点击「${clickedElement.name || clickedElement.role}」后出现`,
    elementRef: {
      label: clickedElement.name || clickedElement.role,
      name: clickedElement.name,
      automationId: clickedElement.automation_id,
    },
  };

  const childFp = `${fingerprint}:child:${clickedElement.automation_id || clickedElement.role}:${clickedElement.name}`;

  try {
    await cache.storeUICache(
      childFp,
      session.fingerprint,
      null,
      appName,
      '',
      newElements,
      [],
      fingerprint,
      trigger,
    );
    // 更新父组件中被点击元素的描述
    const childSummary = summarizeElements(newElements);
    if (childSummary) {
      const existing = await getUICache(fingerprint);
      if (existing) {
        const clickedKey = clickedElement.automation_id || `${clickedElement.role}:${clickedElement.name}`;
        const updated = existing.annotations.map(ann => {
          const annKey = ann.automationId || `${ann.role}:${ann.name}`;
          if (annKey === clickedKey) {
            return {
              ...ann,
              capability: {
                ...ann.capability,
                interactionType: ann.capability?.interactionType ?? 'click' as const,
                notes: `点击后展开: ${childSummary}`,
              },
            };
          }
          return ann;
        });
        await updateSemanticAnnotations(fingerprint, updated);
      }
    }

    return childFp;
  } catch {
    return null;
  }
}

/** 将元素列表总结为简短描述 */
export function summarizeElements(elements: InteractiveNode[]): string {
  const names = elements
    .map(el => el.name || el.role)
    .filter(Boolean)
    .slice(0, 8);
  if (names.length === 0) return '';
  const summary = names.join('、');
  return names.length < elements.length ? `${summary} 等 ${elements.length} 项` : summary;
}

// ── 事件触发检测 ──

/**
 * 事件触发：检测 UIA 树变化
 */
export async function detectChangesAfterInteraction(interactionType: string, clickX?: number, clickY?: number): Promise<void> {
  const session = state.getSession();
  if (!session) return;

  const hwnd = session.hwnd;
  session.interactionCount++;

  try {
    await new Promise(r => setTimeout(r, 300));

    let snapshotAfter = await fetchInteractiveNodes(hwnd);
    const newElements = diffUIATrees(state.getSnapshot() ?? [], snapshotAfter);

    if (newElements.length > 0) {
      const clickedElement = (clickX != null && clickY != null)
        ? findElementAtPoint(state.getSnapshot() ?? [], clickX, clickY)
        : null;

      if (clickedElement && isPopupOrExpanding(newElements, interactionType)) {
        await recordChildComponent(clickedElement, newElements, interactionType);
      }

      for (const element of newElements) {
        const capability = inferCapabilityFromInteraction(element, interactionType);
        if (capability) {
          const key = element.automation_id || `${element.role}:${element.name}`;
          if (!session.discoveredCapabilities.has(key)) {
            session.discoveredCapabilities.set(key, capability);
            if (element.bounds) session.discoveredBounds.set(key, element.bounds);
            await saveSingleCapability(key, capability, element.bounds);
          }
        }
      }
    }

    // 每次交互后都通知 UI 刷新（不管有没有新元素）
    state.setSnapshot(snapshotAfter);
    state.notifyListeners();
  } catch { /* ignore */ }
}
