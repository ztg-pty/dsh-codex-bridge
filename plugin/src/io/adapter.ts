/**
 * io/adapter.ts —— 运行环境适配
 *
 * ★ 关键认知（实测 DSH 插件模型）：
 *   DSH 的桌面端和 Web 端，UI 都跑在浏览器渲染进程里；
 *   本地目录读写由【host 插件】在 DSH 宿主进程内完成，
 *   前端一律通过 /plugins/<包名>/* 的 HTTP 路由调用后端。
 *   因此 UI 侧【不需要】判断桌面/Web 来决定能否读写本地目录——
 *   后端路由天然具备本地目录能力，且 Web 端访问时后端同样能读（因为后端就在本机）。
 *
 *   官方 dsh-workbuddy-connect 的客户端也完全没有 detectRuntime/platform 判断。
 */
import { BridgeError } from '../shared/errors.js';

export type RuntimeKind = 'desktop' | 'web';

/**
 * 检测运行环境（仅用于展示徽章文案，不再用于开关本地目录能力）。
 * DSH 桌面版通过 Electron 加载 dsh-app:// 协议页面；Web 版是 http(s) 页面。
 */
export function detectRuntime(): RuntimeKind {
  const g = globalThis as any;
  const loc = g.location;
  if (loc && typeof loc.protocol === 'string') {
    if (loc.protocol === 'dsh-app:' || loc.protocol === 'file:') return 'desktop';
  }
  // Electron 注入的桥接对象
  if (typeof g.process !== 'undefined' && g.process?.versions?.electron) return 'desktop';
  return 'web';
}

export interface IoAdapter {
  readonly kind: RuntimeKind;
  /** 本地目录扫描/读写由后端路由提供，两端均可用（后端在本机） */
  canReadLocalDir(): boolean;
  canWriteLocalFile(): boolean;
}

export const desktopAdapter: IoAdapter = {
  kind: 'desktop',
  canReadLocalDir: () => true,
  canWriteLocalFile: () => true,
};

export const webAdapter: IoAdapter = {
  kind: 'web',
  canReadLocalDir: () => true,   // ★ 后端在本机，Web 端也能通过路由扫描
  canWriteLocalFile: () => true,
};

export function createAdapter(): IoAdapter {
  return detectRuntime() === 'desktop' ? desktopAdapter : webAdapter;
}

/** 触发浏览器下载（Web 端导出兜底用） */
export function downloadText(fileName: string, text: string, mime = 'application/x-ndjson'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 读取用户选择的文件为文本 */
export async function readUploadedFile(file: File): Promise<string> {
  return await file.text();
}

