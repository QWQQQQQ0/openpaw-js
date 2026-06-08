// Vite 插件 —— 将 Agent API 中间件挂载到 Vite dev server。
// 中间件逻辑内联于此避免 Vite 配置加载阶段解析 @ 别名失败。

import type { Plugin, ViteDevServer } from 'vite';

export function agentApiPlugin(): Plugin {
  return {
    name: 'openpaw-agent-api',
    configureServer(server: ViteDevServer) {
      // 在 Vite 服务器完全就绪后注册中间件
      // 使用 server.ssrLoadModule 通过 Vite 的模块解析加载后端 handler
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/agent/')) {
          next();
          return;
        }
        try {
          const { handleRequest } = await server.ssrLoadModule('/src/backend/middleware.ts');
          const handled = await handleRequest(req, res);
          if (!handled) next();
        } catch (e) {
          next(e);
        }
      });
    },
  };
}
