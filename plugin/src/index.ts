/**
 * index.ts —— 服务端入口（cordis 插件）
 *
 * 实测关键点（来自 DSH 源码与真实插件）：
 *   1. 服务名是 `webServer`（camelCase），不是 `server`
 *      —— 之前写 `inject: ['server', 'logger']` 导致
 *         "pending (waiting for services: server, logger)"，插件永不激活
 *   2. 注册路由用 `ctx.webServer.register({ kind, path, handler })`
 *      kind: 'exact' | 'prefix'；handler: async (req, res) => {}
 *   3. 注册应在 ctx.effect() 内完成（宿主用 effect 管理生命周期）
 *   4. logger 由 cordis 内置提供（ctx.logger），无需 inject
 */
import type { App } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { mountRoutes, ROUTE_BASE } from './host/routes.js';

export const name = 'dsh-codex-bridge';

/** 配置 schema（对应 cordis.patch.yml 中的 config 段） */
export const Config = z.object({
  /** Codex 根目录，留空=自动探测 %USERPROFILE%\.codex */
  codexHome: z.string().default(''),
  /** 导出输出目录，留空=<dsh-home>/codex-bridge/export */
  outputDir: z.string().default(''),
  /** 导出前是否备份 Codex 目录旧 JSONL */
  backupBeforeExport: z.boolean().default(true),
  /** 单文件上限（字节），超限跳过 */
  maxSessionBytes: z.number().default(256 * 1024 * 1024),
});

export interface BridgeConfig {
  codexHome: string;
  outputDir: string;
  backupBeforeExport: boolean;
  maxSessionBytes: number;
}

export const inject = [] as const;

/**
 * 插件主体：向宿主 webServer 注册 HTTP 路由。
 *
 * ★ 官方模式（实测 dsh-workbuddy-connect）：webServer 用 ctx.inject 延迟获取，
 *   不放进顶层 inject —— 顶层声明会导致 "pending (waiting for services)" 永不激活。
 */
export function apply(ctx: App, config: BridgeConfig): void {
  const anyCtx = ctx as any;
  const logger = anyCtx.logger ?? console;

  const adapter = {
    get: (path: string, handler: (req: any, res: any) => Promise<void> | void) => {
      anyCtx.inject?.(['webServer'], (webCtx: any) => {
        webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), `codex-bridge: GET ${path}`);
      });
    },
    post: (path: string, handler: (req: any, res: any) => Promise<void> | void) => {
      anyCtx.inject?.(['webServer'], (webCtx: any) => {
        webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), `codex-bridge: POST ${path}`);
      });
    },
  };

  try {
    mountRoutes(adapter);
    logger.info?.(`[${name}] 已排队路由注册（7 条，等待 webServer 就绪）`);
  } catch (e) {
    logger.error?.(`[${name}] 初始化失败：${String((e as Error)?.message ?? e)}`);
  }
}
