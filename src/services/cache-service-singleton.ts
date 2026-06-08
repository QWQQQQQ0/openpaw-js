import type { ICacheService } from '@/interfaces/cache-service';
import { createCacheService } from '@/services/cache-service';

let _instance: ICacheService | null = null;

export function getCacheService(): ICacheService {
  if (!_instance) {
    _instance = createCacheService();
  }
  return _instance;
}

export function setCacheService(service: ICacheService): void {
  _instance = service;
}
