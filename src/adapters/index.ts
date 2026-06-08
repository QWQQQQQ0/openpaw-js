/**
 * 适配器模块导出
 */

// 平台适配器接口
export type {
  PlatformAdapter,
  PlatformAdapterFactory,
  PlatformEvent,
  ElementQuery,
} from './platform-adapter';

export { AdapterRegistry, adapterRegistry } from './platform-adapter';

// DOM 适配器
export { DOMAdapter } from './dom-adapter';

// UIA 适配器
export { UIAAdapter } from './uia-adapter';

// 初始化适配器（导入时自动注册）
import './dom-adapter';
import './uia-adapter';
