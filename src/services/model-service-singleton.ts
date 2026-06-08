import type { IModelService } from '@/interfaces/model-service';
import { LlmGateway } from '@/services/llm-gateway/gateway';

let _instance: IModelService | null = null;

export function getModelService(): IModelService {
  if (!_instance) {
    _instance = new LlmGateway();
  }
  return _instance;
}

export function setModelService(service: IModelService): void {
  _instance = service;
}
