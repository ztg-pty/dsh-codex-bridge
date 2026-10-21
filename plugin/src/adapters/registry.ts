/**
 * adapters/registry.ts —— 适配器注册表与跨端转换
 *
 * 提供：
 *   - 统一的适配器查找（按 ClientKind）
 *   - 能力矩阵（UI 据此展示损失提示）
 *   - 跨端转换（read A → UIR → write B）
 */
import type { ClientKind, SessionAdapter, AdapterCapability, SessionSummary, ReadResult, WriteResult, UirSession } from '../uir/types.js';
import { claudeCodeAdapter } from './claude-code/adapter.js';
import { zcodeAdapter } from './zcode/adapter.js';

/**
 * 已实现的 UIR 适配器。
 *
 * 说明：DSH / Codex / WorkBuddy 目前仍走原有的专用转换器
 * （`convert/codex2dsh.ts`、`convert/dsh2codex.ts`、`convert/dsh2wb.ts`），
 * 后续会逐步迁移到 UIR 适配器接口。
 */
const ADAPTERS: Partial<Record<ClientKind, SessionAdapter>> = {
  'claude-code': claudeCodeAdapter,
  zcode: zcodeAdapter,
};

/** 按客户端获取适配器 */
export function getAdapter(client: ClientKind): SessionAdapter | null {
  return ADAPTERS[client] ?? null;
}

/** 列出已实现 UIR 适配器的客户端 */
export function availableAdapters(): ClientKind[] {
  return Object.keys(ADAPTERS) as ClientKind[];
}

/** 能力矩阵（含未实现 UIR 适配器的端，供 UI 展示全貌） */
export function capabilityMatrix(): AdapterCapability[] {
  const out: AdapterCapability[] = [];

  // 已实现 UIR 适配器的
  for (const client of availableAdapters()) {
    const a = ADAPTERS[client];
    if (a) out.push(a.capability);
  }

  // 尚未迁移到 UIR 的（用现有转换器的能力描述）
  const legacy: AdapterCapability[] = [
    {
      client: 'dsh', label: 'DeepSeek Harness',
      canRead: true, canWrite: true,
      supportsSubagent: true, supportsImage: true, supportsFileChange: true, supportsBranching: false,
      lossyFields: ['加密思考内容（无法解码）'],
    },
    {
      client: 'codex', label: 'Codex',
      canRead: true, canWrite: true,
      supportsSubagent: true, supportsImage: true, supportsFileChange: true, supportsBranching: false,
      lossyFields: ['加密内容 encrypted_content', '子代理会话需合并到父会话'],
    },
    {
      client: 'workbuddy', label: 'WorkBuddy',
      canRead: true, canWrite: true,
      supportsSubagent: false, supportsImage: true, supportsFileChange: true, supportsBranching: false,
      lossyFields: ['子代理结构（无对应概念）', 'zcode-artifact 等私有 URI'],
    },
  ];

  for (const l of legacy) {
    if (!out.some((c) => c.client === l.client)) out.push(l);
  }
  return out;
}

/** 列出所有可用客户端的会话 */
export async function listAllSessions(opts: {
  clients?: ClientKind[];
  limitPerClient?: number;
} = {}): Promise<{ sessions: SessionSummary[]; errors: Array<{ client: ClientKind; message: string }> }> {
  const targets = opts.clients ?? availableAdapters();
  const sessions: SessionSummary[] = [];
  const errors: Array<{ client: ClientKind; message: string }> = [];
  const limit = opts.limitPerClient ?? 50;

  for (const client of targets) {
    const adapter = getAdapter(client);
    if (!adapter) continue;
    const probe = adapter.probe();
    if (!probe.available) {
      errors.push({ client, message: probe.reason ?? '不可用' });
      continue;
    }
    try {
      const list = await adapter.list();
      sessions.push(...list.slice(0, limit));
    } catch (e) {
      errors.push({ client, message: String((e as Error)?.message ?? e) });
    }
  }

  return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), errors };
}

/** 读取会话为 UIR */
export async function readSession(client: ClientKind, sessionId: string): Promise<ReadResult> {
  const adapter = getAdapter(client);
  if (!adapter) {
    throw new Error(`客户端 ${client} 尚未支持 UIR 读取（当前支持：${availableAdapters().join(', ')}）`);
  }
  return adapter.read({ sessionId });
}

/** 把 UIR 写入指定客户端 */
export async function writeSession(
  client: ClientKind,
  session: UirSession,
  opts: { title?: string; cwd?: string; mode?: 'skip' | 'overwrite' } = {},
): Promise<WriteResult> {
  const adapter = getAdapter(client);
  if (!adapter) {
    throw new Error(`客户端 ${client} 尚未支持 UIR 写入（当前支持：${availableAdapters().join(', ')}）`);
  }
  return adapter.write(session, opts);
}

/**
 * 跨端转换：从一端读到 UIR，再写入另一端。
 *
 * 这是 N×N 互通的核心：不需要 N² 个转换器，只要 2N 个适配器。
 */
export async function transferSession(params: {
  from: ClientKind;
  fromId: string;
  to: ClientKind;
  title?: string;
  cwd?: string;
}): Promise<{
  ok: boolean;
  source: { client: ClientKind; id: string; title: string; turns: number };
  target: { client: ClientKind; id: string; location: string; records: number };
  warnings: string[];
}> {
  const read = await readSession(params.from, params.fromId);
  const write = await writeSession(params.to, read.session, {
    title: params.title,
    cwd: params.cwd,
  });

  if (!write.ok) {
    throw new Error(write.error?.message ?? '写入目标端失败');
  }

  return {
    ok: true,
    source: {
      client: params.from,
      id: params.fromId,
      title: read.session.title,
      turns: read.session.turns.length,
    },
    target: {
      client: params.to,
      id: write.targetId,
      location: write.location,
      records: write.records,
    },
    warnings: [...read.warnings, ...write.warnings],
  };
}

/** 生成转换损失提示（中文） */
export function describeLoss(from: ClientKind, to: ClientKind): string[] {
  const matrix = capabilityMatrix();
  const src = matrix.find((c) => c.client === from);
  const dst = matrix.find((c) => c.client === to);
  if (!src || !dst) return [];

  const losses: string[] = [];

  if (src.supportsSubagent && !dst.supportsSubagent) {
    losses.push(`${dst.label} 不支持子代理结构，子代理会话将被合并或跳过`);
  }
  if (src.supportsBranching && !dst.supportsBranching) {
    losses.push(`${dst.label} 不支持消息分支，分支将线性化`);
  }
  if (src.supportsImage && !dst.supportsImage) {
    losses.push(`${dst.label} 不支持图片，图片将丢失`);
  }
  if (src.supportsFileChange && !dst.supportsFileChange) {
    losses.push(`${dst.label} 不支持文件变更记录，变更历史将丢失`);
  }

  // 目标端已知的有损字段
  for (const f of dst.lossyFields) {
    losses.push(`${dst.label}：${f}`);
  }

  return [...new Set(losses)];
}
