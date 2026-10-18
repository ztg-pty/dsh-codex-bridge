/**
 * test/convert.spec.ts —— 转换逻辑单元测试
 *
 * 覆盖 P0 验证过的关键契约：
 *   seq 稠密、header 白名单、source.kind、tool/result 结构、加密占位
 */
import { describe, it, expect } from 'vitest';
import { codexToDsh } from '../src/convert/codex2dsh.js';
import { dshToCodex } from '../src/convert/dsh2codex.js';
import { mapFunctionCall, mapCustomToolCall, reverseToolName } from '../src/convert/toolmap.js';
import { parseRolloutText, extractMeta } from '../src/convert/codex-reader.js';
import { assertDense } from '../src/convert/dsh-store.js';
import { describeError } from '../src/shared/errors.js';
import type { CodexLine } from '../src/shared/types.js';

const T0 = '2026-10-16T06:50:48.874Z';

function makeLines(): CodexLine[] {
  return [
    {
      type: 'session_meta',
      payload: {
        id: 'thread-1', session_id: 'thread-1', timestamp: T0,
        cwd: 'D:\\proj', originator: 'Codex Desktop',
        cli_version: '0.162.0', thread_source: 'user',
        model_provider: 'openai', git: { commit_hash: 'abc', branch: 'main' },
      },
    },
    { type: 'turn_context', payload: { turn_id: 'turn-a', cwd: 'D:\\proj', model: 'gpt-6.1-sol' } },
    {
      type: 'response_item',
      payload: {
        type: 'message', id: 'm1', role: 'user',
        content: [{ type: 'input_text', text: '帮我看下代码' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message', id: 'm2', role: 'assistant',
        content: [{ type: 'output_text', text: '我来看一下' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call', id: 'fc1', call_id: 'call_1',
        name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls', shell: 'powershell' }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output', id: 'fo1', call_id: 'call_1',
        output: 'Process exited with code 0\nOutput:\nfile.txt',
      },
    },
  ] as CodexLine[];
}

describe('codexToDsh', () => {
  it('生成的 seq 必须从 0 稠密递增', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    expect(() => assertDense(session.events)).not.toThrow();
    session.events.forEach((e, i) => expect(e.seq).toBe(i));
  });

  it('会话头只包含白名单字段', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    const allowed = new Set([
      'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth',
      'cwd', 'parentSession', 'origin', 'agentPreset',
    ]);
    for (const k of Object.keys(session.header)) {
      expect(allowed.has(k)).toBe(true);
    }
    expect(session.header.version).toBe(4);
    expect(session.header.id).toBe('session-codex-thread-1');
    expect(session.header.delegationDepth).toBe(0);
  });

  it('turn 与 step 必须闭合', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    const types = session.events.map((e) => e.type);
    const firstTurn = types.indexOf('turn/start');
    const firstStep = types.indexOf('step/start');
    const firstStepEnd = types.indexOf('step/end');
    const firstTurnEnd = types.indexOf('turn/end');
    expect(firstTurn).toBeLessThan(firstStep);
    expect(firstStep).toBeLessThan(firstStepEnd);
    expect(firstStepEnd).toBeLessThan(firstTurnEnd);
  });

  it('tool/result 的 toolCallId 必须等于 source.callId', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    const results = session.events.filter((e) => e.type === 'tool/result');
    expect(results.length).toBe(1);
    const msg = (results[0].data as any).message;
    expect(msg.toolCallId).toBe('call_1');
    expect(msg.source.kind).toBe('tool');
    expect(msg.source.callId).toBe('call_1');
    expect(typeof msg.id).toBe('string');
    expect(msg.id.length).toBeGreaterThan(0);
  });

  it('不得产生 source.kind=plugin', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    for (const e of session.events) {
      const src = (e.data as any)?.message?.source ?? (e.data as any)?.source;
      if (src) expect(src.kind).not.toBe('plugin');
    }
  });

  it('加密内容替换为 text 占位，不破坏结构', () => {
    const lines = makeLines();
    lines.push({
      type: 'response_item',
      payload: {
        type: 'agent_message', id: 'am1',
        author: '/root/worker', recipient: '/root',
        content: [
          { type: 'input_text', text: 'Message Type: MESSAGE' },
          { type: 'encrypted_content', encrypted_content: 'gAAAAAB' + 'x'.repeat(100) },
        ],
      },
    } as CodexLine);
    const { session, report } = codexToDsh(lines, { sourceFile: 'test.jsonl' });
    expect(report.stats.encryptedBlocks).toBe(1);
    const agentMsg = session.events.find((e) =>
      JSON.stringify(e.data).includes('加密内容 · 无法解码'));
    expect(agentMsg).toBeTruthy();
    // 占位必须是合法 text 块
    const blocks = (agentMsg!.data as any).content;
    expect(blocks.every((b: any) => typeof b.type === 'string')).toBe(true);
    expect(blocks.some((b: any) => b.type === 'text' && b.text.includes('无法解码'))).toBe(true);
  });

  it('元数据写入 ignorable 事件而非 header', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    const metaEvt = session.events.find((e) => e.type === 'codex-bridge/meta');
    expect(metaEvt).toBeTruthy();
    expect(metaEvt!.ignorable).toBe(true);
    expect((metaEvt!.data as any).sessionId).toBe('thread-1');
    expect((metaEvt!.data as any).git.branch).toBe('main');
  });

  it('子代理会话写入 parentSession 与 origin', () => {
    const lines = makeLines();
    (lines[0].payload as any).thread_source = 'subagent';
    (lines[0].payload as any).parent_thread_id = 'parent-9';
    (lines[0].payload as any).source = {
      subagent: { thread_spawn: { parent_thread_id: 'parent-9', depth: 1, agent_path: '/root/x' } },
    };
    const { session } = codexToDsh(lines, { sourceFile: 'sub.jsonl' });
    expect(session.header.parentSession).toBe('session-codex-parent-9');
    expect(session.header.origin).toBe('subagent');
    expect(session.header.delegationDepth).toBe(1);
  });
});

describe('dshToCodex', () => {
  it('导出为合法的 Codex rollout 行结构', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    const { jsonl } = dshToCodex(session);
    const rows = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r, i) => expect(r.ordinal).toBe(i));
    expect(rows[0].type).toBe('session_meta');
    expect(rows.some((r) => r.type === 'response_item' && r.payload.type === 'function_call')).toBe(true);
  });

  it('往返后 thread id 保持一致', () => {
    const { session } = codexToDsh(makeLines(), { sourceFile: 'test.jsonl' });
    const { jsonl } = dshToCodex(session);
    const { lines } = parseRolloutText(jsonl);
    const meta = extractMeta(lines);
    expect(meta?.id).toBe('thread-1');
  });
});

describe('toolmap', () => {
  it('exec_command 映射为 pwsh 并转换参数', () => {
    const m = mapFunctionCall('exec_command', JSON.stringify({ cmd: 'ls -la' }));
    expect(m.name).toBe('pwsh');
    expect(JSON.parse(m.arguments).command).toBe('ls -la');
    expect(m.degraded).toBe(false);
  });

  it('apply_patch 标记为语义降级', () => {
    const m = mapFunctionCall('apply_patch', JSON.stringify({ input: '*** Begin Patch' }));
    expect(m.degraded).toBe(true);
    expect(m.note).toBeTruthy();
  });

  it('custom_tool_call(exec) 标记为降级', () => {
    const m = mapCustomToolCall('exec', 'const a = 1;');
    expect(m.name).toBe('pwsh');
    expect(m.degraded).toBe(true);
  });

  it('未知工具保留原名并标记', () => {
    const m = mapFunctionCall('some_new_tool', '{"a":1}');
    expect(m.name).toBe('some_new_tool');
    expect(m.degraded).toBe(true);
  });

  it('反向映射 pwsh → exec_command', () => {
    expect(reverseToolName('pwsh')).toBe('exec_command');
    expect(reverseToolName('read')).toBe('read_file');
  });
});

describe('errors', () => {
  it('所有错误码都有中文文案', () => {
    const codes = [
      'CODEX_DIR_NOT_FOUND', 'PERMISSION_DENIED', 'FILE_CORRUPTED',
      'JSON_PARSE_FAILED', 'NO_SELECTION', 'WEB_MODE_LIMIT',
    ] as const;
    for (const c of codes) {
      const msg = describeError(c, { dir: 'D:\\x', file: 'a', line: 1, path: 'D:\\y' });
      expect(msg).toMatch(/[\u4e00-\u9fa5]/); // 含中文
      expect(msg).not.toContain('{');
    }
  });
});

describe('parseRolloutText', () => {
  it('单行损坏不影响其他行', () => {
    const text = [
      '{"type":"session_meta","payload":{"id":"a","session_id":"a"}}',
      '{ broken json',
      '{"type":"turn_context","payload":{}}',
    ].join('\n');
    const { lines, badLines } = parseRolloutText(text);
    expect(lines.length).toBe(2);
    expect(badLines).toEqual([2]);
  });
});
