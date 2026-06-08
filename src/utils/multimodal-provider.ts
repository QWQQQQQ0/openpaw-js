// 多模态模型自动切换工具
// 当消息包含图片但当前 provider 不支持多模态时，自动切换到支持多模态的模型

import type { ProviderConfig } from '@/types/provider';
import type { MessageContent } from '@/types/message';
import { hasImages } from '@/utils/content';

/**
 * 检查消息内容是否包含图片
 */
export function messageContainsImages(content: MessageContent): boolean {
  return hasImages(content);
}

/**
 * 如果消息包含图片但当前 provider 不支持多模态，
 * 自动从已配置的 provider 列表中找一个支持多模态的替代。
 * 如果找不到，返回原 provider（让调用方处理错误）。
 *
 * @param currentProvider 当前使用的 provider
 * @param allProviders 所有已配置的 provider 列表
 * @param content 消息内容（用于检测是否包含图片）
 * @returns 解析后的 provider（可能是切换后的）
 */
export function resolveMultimodalProvider(
  currentProvider: ProviderConfig,
  allProviders: ProviderConfig[],
  content: MessageContent,
): { provider: ProviderConfig; switched: boolean } {
  // 消息不包含图片，无需切换
  if (!messageContainsImages(content)) {
    return { provider: currentProvider, switched: false };
  }

  // 当前 provider 已支持多模态，无需切换
  if (currentProvider.supportsMultimodal !== false) {
    return { provider: currentProvider, switched: false };
  }

  // 找一个支持多模态的替代 provider
  const multimodalProvider = allProviders.find(
    (p) => p.supportsMultimodal !== false && p.id !== currentProvider.id,
  );

  if (multimodalProvider) {
    console.log(
      `[multimodal-provider] 自动切换: ${currentProvider.name} (${currentProvider.model}) → ${multimodalProvider.name} (${multimodalProvider.model})，原因: 消息包含图片但当前模型不支持多模态`,
    );
    return { provider: multimodalProvider, switched: true };
  }

  // 找不到替代，返回原 provider
  console.warn(
    `[multimodal-provider] 消息包含图片但当前模型 "${currentProvider.name}" 不支持多模态，且未找到支持多模态的替代模型`,
  );
  return { provider: currentProvider, switched: false };
}
