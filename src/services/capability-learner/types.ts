// 能力学习器类型定义

import type {
  ElementCapability,
  InteractiveNode,
  LearningStatus,
  LearningSession,
  LearningProgress,
  SemanticAnnotation,
  VisionElement,
} from '@/types/cache';
import type { TriggerInfo } from '@/types/page-component';

export type {
  ElementCapability,
  InteractiveNode,
  LearningStatus,
  LearningSession,
  LearningProgress,
  SemanticAnnotation,
  VisionElement,
  TriggerInfo,
};

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AutoLearnResult {
  explored: number;
  childComponentsFound: number;
  visionElementsFound: number;
  errors: string[];
}

/** 可探索元素：UIA 节点或视觉识别元素 */
export interface ExplorableElement {
  source: 'uia' | 'vision';
  name: string;
  role: string;
  bounds: { left: number; top: number; width: number; height: number } | null;
  visionElement?: VisionElement;
  uiaNode?: InteractiveNode;
}

/** LLM 分类 + 能力提取结果 */
export interface LLMClassifiedElement {
  index: number;
  category: 'auto_explore' | 'capability' | 'skip';
  interactionType?: 'click' | 'doubleClick' | 'rightClick' | 'type' | 'expand' | 'select' | 'drag';
  description?: string;
  inputFormat?: string;
  notes?: string;
}
