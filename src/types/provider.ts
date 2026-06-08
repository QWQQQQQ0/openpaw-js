// 来源: lib/models/model_provider.dart

export type ProviderType = 'openai' | 'anthropic' | 'google';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
  isDefault: boolean;
  supportsTools: boolean;
  /** MiMo 等思考模型：开启 thinking 模式 */
  thinkingMode?: boolean;
  /** 模型是否支持多模态（图片+文本），用于截图视觉分析等场景 */
  supportsMultimodal?: boolean;
  createdAt: string;
}
