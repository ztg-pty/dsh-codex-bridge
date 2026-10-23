/**
 * budget/tokens.ts —— Token 估算与预算计算
 *
 * 支持两种预算来源：
 *   1. 显式指定 token 数（budget: 128000）
 *   2. 按模型名自动查表（model: 'claude-sonnet-4-5' → 200k）
 *
 * 硬上限由 `MAX_BUDGET` 控制（默认 2M，覆盖当前所有主流模型）。
 */

/** 是否尝试加载 tiktoken（可选依赖） */
let tiktokenEncoder: ((text: string) => number) | null | undefined;

/**
 * 启发式估算（零依赖，误差约 ±15%）。
 * 依据：中文约 1 token/字，英文约 4 字符/token，代码约 3 字符/token。
 */
export function estimateTokensHeuristic(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) ascii++;
    else if (
      (c >= 0x4e00 && c <= 0x9fff) ||   // CJK 统一汉字
      (c >= 0x3040 && c <= 0x30ff) ||   // 日文假名
      (c >= 0xac00 && c <= 0xd7af)      // 韩文
    ) cjk++;
    else other++;
  }
  // 中文 1 token/字；ASCII 约 3.8 字符/token；其它（emoji/符号）约 1.5 字符/token
  return Math.ceil(cjk * 1.0 + ascii / 3.8 + other / 1.5);
}

/**
 * 估算 token 数。
 * 当前实现使用启发式（零依赖，跨平台稳定）。
 * 预留 tiktoken 接入点：若宿主环境提供精确分词，可通过 setEncoder 注入。
 */
export function estimateTokens(text: string): number {
  if (tiktokenEncoder) return tiktokenEncoder(text);
  return estimateTokensHeuristic(text);
}

/** 注入精确分词器（可选） */
export function setEncoder(fn: ((text: number) => number) | null): void {
  tiktokenEncoder = fn as any;
}

/** 安全余量：预算按 92% 使用（留出客户端包装开销） */
export const BUDGET_SAFETY_RATIO = 0.92;

/** 默认预算（未指定模型/预算时） */
export const DEFAULT_BUDGET = 200_000;

/** 硬上限：允许的最大预算（2M，覆盖 Gemini 1.5 Pro 等） */
export const MAX_BUDGET = 2_000_000;

/**
 * 模型上下文长度预设表。
 *
 * 键为小写匹配片段（按顺序匹配，先具体后通用）。
 * 数值为**模型总上下文窗口**（不是可用输出），预算会再乘安全系数。
 */
export const MODEL_CONTEXT_PRESETS: Array<{ match: string; context: number; label: string }> = [
  // ── Anthropic Claude ──
  { match: 'claude-opus-4', context: 200_000, label: 'Claude Opus 4' },
  { match: 'claude-sonnet-4', context: 200_000, label: 'Claude Sonnet 4' },
  { match: 'claude-3-7', context: 200_000, label: 'Claude 3.7' },
  { match: 'claude-3-5', context: 200_000, label: 'Claude 3.5' },
  { match: 'claude', context: 200_000, label: 'Claude' },

  // ── OpenAI GPT ──
  { match: 'gpt-5', context: 400_000, label: 'GPT-5' },
  { match: 'gpt-4.1', context: 1_000_000, label: 'GPT-4.1' },
  { match: 'gpt-4o', context: 128_000, label: 'GPT-4o' },
  { match: 'gpt-4-turbo', context: 128_000, label: 'GPT-4 Turbo' },
  { match: 'gpt-4', context: 128_000, label: 'GPT-4' },
  { match: 'o1', context: 200_000, label: 'o1' },
  { match: 'o3', context: 200_000, label: 'o3' },

  // ── Google Gemini ──
  { match: 'gemini-2', context: 1_000_000, label: 'Gemini 2' },
  { match: 'gemini-1.5-pro', context: 2_000_000, label: 'Gemini 1.5 Pro' },
  { match: 'gemini', context: 1_000_000, label: 'Gemini' },

  // ── DeepSeek ──
  { match: 'deepseek-v4', context: 256_000, label: 'DeepSeek V4' },
  { match: 'deepseek-v3', context: 128_000, label: 'DeepSeek V3' },
  { match: 'deepseek', context: 128_000, label: 'DeepSeek' },

  // ── GLM / 智谱 ──
  { match: 'glm-5', context: 200_000, label: 'GLM-5' },
  { match: 'glm-4.6', context: 200_000, label: 'GLM-4.6' },
  { match: 'glm-4', context: 128_000, label: 'GLM-4' },
  { match: 'glm', context: 128_000, label: 'GLM' },

  // ── Kimi / 月之暗面 ──
  { match: 'kimi-k2', context: 256_000, label: 'Kimi K2' },
  { match: 'kimi', context: 128_000, label: 'Kimi' },

  // ── 其他国产 ──
  { match: 'qwen', context: 128_000, label: 'Qwen' },
  { match: 'minimax', context: 200_000, label: 'MiniMax' },
  { match: 'doubao', context: 128_000, label: '豆包' },
  { match: 'hunyuan', context: 128_000, label: '混元' },
  { match: 'yi-', context: 200_000, label: 'Yi' },
  { match: 'llama', context: 128_000, label: 'Llama' },
  { match: 'mistral', context: 128_000, label: 'Mistral' },
];

/** 按模型名查上下文长度（未匹配返回 undefined） */
export function contextForModel(model?: string): { context: number; label: string } | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  for (const p of MODEL_CONTEXT_PRESETS) {
    if (m.includes(p.match)) return { context: p.context, label: p.label };
  }
  return undefined;
}

/** 预算来源（用于回显给用户） */
export interface BudgetResolution {
  /** 请求的原始预算（token） */
  requested: number;
  /** 实际可用预算（已乘安全系数） */
  effective: number;
  /** 来源说明 */
  source: 'explicit' | 'model' | 'default' | 'clamped';
  /** 命中的模型预设 */
  modelPreset?: { context: number; label: string };
  /** 是否被上限裁剪 */
  clamped: boolean;
}

/**
 * 解析预算。
 *
 * 优先级：显式 budget > 模型预设 > 默认 200k
 * 上限：MAX_BUDGET
 */
export function resolveBudget(opts: { budget?: number; model?: string } = {}): BudgetResolution {
  let requested: number;
  let source: BudgetResolution['source'];
  let modelPreset: BudgetResolution['modelPreset'];

  if (opts.budget != null && Number.isFinite(opts.budget) && opts.budget > 0) {
    requested = Math.floor(opts.budget);
    source = 'explicit';
  } else {
    const preset = contextForModel(opts.model);
    if (preset) {
      requested = preset.context;
      modelPreset = preset;
      source = 'model';
    } else {
      requested = DEFAULT_BUDGET;
      source = 'default';
    }
  }

  let clamped = false;
  if (requested > MAX_BUDGET) {
    requested = MAX_BUDGET;
    clamped = true;
    source = 'clamped';
  }
  if (requested < 1) requested = 1;

  return {
    requested,
    effective: Math.floor(requested * BUDGET_SAFETY_RATIO),
    source,
    modelPreset,
    clamped,
  };
}

/** 计算实际可用预算（兼容旧调用） */
export function effectiveBudget(requested?: number): number {
  return resolveBudget({ budget: requested }).effective;
}
