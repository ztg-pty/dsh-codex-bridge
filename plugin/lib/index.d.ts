import z from "@deepseek-ai/schemastery";
import { App } from "@deepseek-ai/cordis";

//#region src/index.d.ts
declare const name = "dsh-codex-bridge";
/** 配置 schema（对应 cordis.patch.yml 中的 config 段） */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  /** Codex 根目录，留空=自动探测 %USERPROFILE%\.codex */codexHome: z<string, string, "defined">; /** 导出输出目录，留空=<dsh-home>/codex-bridge/export */
  outputDir: z<string, string, "defined">; /** 导出前是否备份 Codex 目录旧 JSONL */
  backupBeforeExport: z<boolean, boolean, "defined">; /** 单文件上限（字节），超限跳过 */
  maxSessionBytes: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  /** Codex 根目录，留空=自动探测 %USERPROFILE%\.codex */codexHome: z<string, string, "defined">; /** 导出输出目录，留空=<dsh-home>/codex-bridge/export */
  outputDir: z<string, string, "defined">; /** 导出前是否备份 Codex 目录旧 JSONL */
  backupBeforeExport: z<boolean, boolean, "defined">; /** 单文件上限（字节），超限跳过 */
  maxSessionBytes: z<number, number, "defined">;
}>>, "plain">;
interface BridgeConfig {
  codexHome: string;
  outputDir: string;
  backupBeforeExport: boolean;
  maxSessionBytes: number;
}
declare const inject: readonly [];
/**
 * 插件主体：向宿主 webServer 注册 HTTP 路由。
 *
 * ★ 官方模式（实测 dsh-workbuddy-connect）：webServer 用 ctx.inject 延迟获取，
 *   不放进顶层 inject —— 顶层声明会导致 "pending (waiting for services)" 永不激活。
 */
declare function apply(ctx: App, config: BridgeConfig): void;
//#endregion
export { BridgeConfig, Config, apply, inject, name };