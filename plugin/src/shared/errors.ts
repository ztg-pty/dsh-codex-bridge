/**
 * shared/errors.ts —— 统一错误码 + 中文提示文案
 *
 * 设计要求：所有失败都必须给用户可读的中文原因 + 可复制的技术细节。
 */

export type ErrorCode =
  | 'CODEX_DIR_NOT_FOUND'
  | 'CODEX_DIR_EMPTY'
  | 'PERMISSION_DENIED'
  | 'FILE_CORRUPTED'
  | 'JSON_PARSE_FAILED'
  | 'FILE_TOO_LARGE'
  | 'NO_SESSION_META'
  | 'DSH_WRITE_FAILED'
  | 'DSH_SESSION_EXISTS'
  | 'EXPORT_WRITE_FAILED'
  | 'BACKUP_FAILED'
  | 'NO_SELECTION'
  | 'WEB_MODE_LIMIT'
  | 'UNSUPPORTED_ENV'
  | 'SCAN_FAILED'
  | 'CONVERT_FAILED';

/** 带错误码的异常，便于 UI 精确映射中文提示 */
export class BridgeError extends Error {
  code: ErrorCode;
  detail?: Record<string, unknown>;
  constructor(code: ErrorCode, message?: string, detail: Record<string, unknown> = {}) {
    // ★ 默认就把中文文案写进 message，避免调用方只看到错误码
    super(message ?? describeError(code, detail));
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 中文提示文案。{placeholder} 会被 detail 中的同名键替换。
 */
const MESSAGES: Record<ErrorCode, string> = {
  CODEX_DIR_NOT_FOUND:
    '未找到 Codex 会话目录（预期位置：{dir}）。请确认 Codex 已安装并至少使用过一次，或在设置中手动指定目录。',
  CODEX_DIR_EMPTY:
    'Codex 会话目录存在，但里面没有任何会话文件。请先在 Codex 中完成一次对话后重试。',
  PERMISSION_DENIED:
    '权限不足：无法读取 {path}。请检查该文件夹的访问权限，或改用具有读取权限的账户运行。',
  FILE_CORRUPTED:
    '文件已损坏：{file} 的数据无法解压，可能写入被中断。该会话已跳过，其他会话不受影响。',
  JSON_PARSE_FAILED:
    'JSON 解析失败：{file} 第 {line} 行格式错误。该行已跳过，其余内容仍会导入。',
  FILE_TOO_LARGE:
    '会话文件过大：{file} 大小为 {size}，超过上限 {limit}。为避免内存耗尽已跳过，可在设置中调高上限后重试。',
  NO_SESSION_META:
    '该会话缺少 session_meta 记录（文件可能不完整或不是 Codex rollout）。已跳过。',
  DSH_WRITE_FAILED:
    '写入 DSH 会话失败：{reason}。原有数据未被修改。',
  DSH_SESSION_EXISTS:
    '该会话已导入过（目标 ID：{id}）。请选择「跳过」或「覆盖」后重试。',
  EXPORT_WRITE_FAILED:
    '导出文件写入失败：{reason}。请检查输出目录是否存在且可写。',
  BACKUP_FAILED:
    '备份失败：{reason}。已中止导出，以免覆盖旧数据。',
  NO_SELECTION: '请至少勾选一个会话。',
  WEB_MODE_LIMIT:
    '当前为 Web 模式，浏览器无法访问本机目录。请改用「上传文件」导入或「下载文件」导出。',
  UNSUPPORTED_ENV:
    '当前环境不支持本地目录访问（检测到：{env}）。请改用上传/下载方式。',
  SCAN_FAILED: '扫描会话目录失败：{reason}',
  CONVERT_FAILED: '数据转换失败：{reason}。该会话已跳过。',
};

/** 用 detail 填充中文文案中的占位符 */
export function describeError(code: ErrorCode, detail: Record<string, unknown> = {}): string {
  const tpl = MESSAGES[code] ?? '发生未知错误：{reason}';
  return tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = detail[k];
    if (v === undefined || v === null) return '';
    if (k === 'size' || k === 'limit') return formatBytes(Number(v));
    return String(v);
  });
}

/** 人类可读的体积 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 把 Node 的原始错误映射为 BridgeError（权限/找不到为重灾区） */
export function fromFsError(e: unknown, path?: string): BridgeError {
  const err = e as NodeJS.ErrnoException;
  switch (err?.code) {
    case 'ENOENT': return new BridgeError('CODEX_DIR_NOT_FOUND', undefined, { dir: path, path });
    case 'EACCES':
    case 'EPERM': return new BridgeError('PERMISSION_DENIED', undefined, { path });
    case 'ENOSPC': return new BridgeError('EXPORT_WRITE_FAILED', undefined, { reason: '磁盘空间不足' });
    default: return new BridgeError('SCAN_FAILED', undefined, { reason: err?.message ?? String(e) });
  }
}
