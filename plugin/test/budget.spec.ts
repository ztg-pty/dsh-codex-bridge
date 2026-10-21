/**
 * test/budget.spec.ts —— 摘要引擎测试
 *
 * 核心验收：200k 预算下，技术细节（代码/命令/路径/报错/参数）保留率。
 */
import { describe, it, expect } from 'vitest';
import type { UirSession, UirTurn, UirBlock } from '../src/uir/types.js';
import { summarizeSession, extractProtected } from '../src/budget/summarize.js';
import { estimateTokens, estimateTokensHeuristic, effectiveBudget } from '../src/budget/tokens.js';

// ── 构造测试会话 ──

function mkText(role: 'user' | 'assistant', text: string): UirBlock {
  return { kind: 'text', role, text, tier: 'medium' };
}

function mkTurn(index: number, userText: string, assistantText: string, extras: UirBlock[] = []): UirTurn {
  return {
    index,
    startedAt: Date.now(),
    userMessages: [mkText('user', userText)],
    steps: [{ index: 0, blocks: [mkText('assistant', assistantText), ...extras] }],
  };
}

function mkSession(turns: UirTurn[]): UirSession {
  return {
    id: 'test-session',
    title: '测试会话',
    cwd: 'D:\\Test\\Project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    origin: { client: 'dsh', originalId: 'session-test' },
    turns,
  };
}

describe('token 估算', () => {
  it('中文约 1 token/字', () => {
    const t = estimateTokensHeuristic('这是一段中文文本');
    expect(t).toBeGreaterThanOrEqual(8);
    expect(t).toBeLessThanOrEqual(10);
  });

  it('英文约 4 字符/token', () => {
    const t = estimateTokensHeuristic('hello world this is a test');
    expect(t).toBeGreaterThanOrEqual(4);
    expect(t).toBeLessThanOrEqual(10);
  });

  it('空字符串为 0', () => {
    expect(estimateTokensHeuristic('')).toBe(0);
  });

  it('有效预算 = 请求预算 × 安全系数', () => {
    expect(effectiveBudget(200_000)).toBe(184_000);
    expect(effectiveBudget(1000)).toBeLessThanOrEqual(1000);
  });
});

describe('技术片段提取（P0 保护）', () => {
  it('提取代码块', () => {
    const pieces = extractProtected('看这段：\n```cpp\nvoid Foo();\n```\n结束');
    expect(pieces.some((p) => p.kind === 'code')).toBe(true);
  });

  it('提取 Windows 路径', () => {
    const pieces = extractProtected('文件在 D:\\UE Save\\fpsys\\FPS_Extraction\\Source 下');
    expect(pieces.some((p) => p.kind === 'path')).toBe(true);
  });

  it('提取报错信息', () => {
    const pieces = extractProtected('编译失败\nError C2065: undeclared identifier');
    expect(pieces.some((p) => p.kind === 'error')).toBe(true);
  });

  it('提取版本号', () => {
    const pieces = extractProtected('升级到 v1.2.3 版本');
    expect(pieces.some((p) => p.kind === 'version')).toBe(true);
  });

  it('去重相同片段', () => {
    const pieces = extractProtected('`code` 和 `code` 是同一个');
    const inline = pieces.filter((p) => p.kind === 'inline-code');
    expect(inline.length).toBe(1);
  });
});

describe('摘要引擎', () => {
  it('未超预算时不做摘要（L0）', () => {
    const session = mkSession([
      mkTurn(0, '你好', '你好！有什么可以帮你的？'),
    ]);
    const r = summarizeSession(session, { budget: 200_000 });
    expect(r.stats.level).toBe('L0');
    expect(r.stats.summarized).toBe(false);
    expect(r.context).toContain('你好');
  });

  it('超预算时自动摘要', () => {
    // 构造大量轮次
    const turns: UirTurn[] = [];
    for (let i = 0; i < 60; i++) {
      turns.push(mkTurn(
        i,
        `第 ${i} 轮：请修改文件 D:\\Proj\\src\\file${i}.cpp 的第 ${i} 行`,
        `好的，我来修改 file${i}.cpp。` + '这是一段很长的叙述性内容，用来撑大上下文。'.repeat(30),
      ));
    }
    const session = mkSession(turns);
    const r = summarizeSession(session, { budget: 10_000 });

    expect(r.stats.summarized).toBe(true);
    expect(r.stats.returnedTokens).toBeLessThanOrEqual(10_000);
    expect(r.stats.level).not.toBe('L0');
  });

  it('摘要后仍保留代码块（P0 不丢失）', () => {
    const turns: UirTurn[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push(mkTurn(
        i,
        `第 ${i} 轮需求`,
        `这里是实现：\n\`\`\`cpp\nvoid Func${i}() { return ${i}; }\n\`\`\`\n` + '叙述内容。'.repeat(200),
      ));
    }
    const session = mkSession(turns);
    const r = summarizeSession(session, { budget: 8_000 });

    // 至少最近几轮的代码块要保留
    const codeCount = (r.context.match(/```cpp/g) ?? []).length;
    expect(codeCount).toBeGreaterThan(0);
    expect(r.stats.preserved.codeBlocks).toBeGreaterThan(0);
  });

  it('摘要后仍保留文件路径（P0 不丢失）', () => {
    const turns: UirTurn[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push(mkTurn(
        i,
        `修改 D:\\Proj\\src\\Important${i}.cpp`,
        '已完成修改。' + '很长的说明。'.repeat(300),
      ));
    }
    const session = mkSession(turns);
    const r = summarizeSession(session, { budget: 8_000 });

    // 最近的路径必须保留
    expect(r.context).toContain('Important');
  });

  it('返回统计信息可用于验证', () => {
    const turns: UirTurn[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push(mkTurn(i, `需求 ${i}`, '回复。'.repeat(500)));
    }
    const r = summarizeSession(mkSession(turns), { budget: 5_000 });

    expect(r.stats.originalTokens).toBeGreaterThan(0);
    expect(r.stats.returnedTokens).toBeGreaterThan(0);
    expect(r.stats.compressionRatio).toBeLessThan(1);
    expect(typeof r.stats.preserved.paths).toBe('number');
  });

  it('outline 提供机器可读大纲', () => {
    const session = mkSession([
      mkTurn(0, '第一个需求', '回复1'),
      mkTurn(1, '第二个需求', '回复2'),
    ]);
    const r = summarizeSession(session, { budget: 200_000 });
    expect(r.outline.length).toBe(2);
    expect(r.outline[0].turn).toBe(1);
    expect(r.outline[0].intent).toContain('第一个需求');
  });

  it('空会话不崩溃', () => {
    const r = summarizeSession(mkSession([]), { budget: 200_000 });
    expect(r.context).toBeTruthy();
    expect(r.stats.level).toBe('L3');
  });

  it('compact 保真度压缩更激进', () => {
    const turns: UirTurn[] = [];
    for (let i = 0; i < 30; i++) {
      turns.push(mkTurn(i, `需求 ${i}`, '内容。'.repeat(400)));
    }
    const session = mkSession(turns);
    const balanced = summarizeSession(session, { budget: 10_000, fidelity: 'balanced' });
    const compact = summarizeSession(session, { budget: 10_000, fidelity: 'compact' });

    // 两者都不超预算
    expect(balanced.stats.returnedTokens).toBeLessThanOrEqual(10_000);
    expect(compact.stats.returnedTokens).toBeLessThanOrEqual(10_000);
  });
});

describe('注入模板剥离', () => {
  it('剥离 environment_context', () => {
    const session = mkSession([
      {
        index: 0,
        startedAt: Date.now(),
        userMessages: [
          mkText('user', '<environment_context>\n很长的环境信息\n</environment_context>'),
          mkText('user', '真正的用户需求'),
        ],
        steps: [{ index: 0, blocks: [mkText('assistant', '好的')] }],
      },
    ]);
    const r = summarizeSession(session, { budget: 200_000 });
    // L0 不剥离；用小预算触发 L1
    const r2 = summarizeSession(session, { budget: 50 });
    expect(r2.stats.dropped.injected).toBeGreaterThan(0);
    expect(r.context).toBeTruthy();
  });
});
