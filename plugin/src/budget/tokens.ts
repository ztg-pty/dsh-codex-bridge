/**
 * budget/tokens.ts —— Token 估算
 *
 * 优先用精确分词，缺失时用启发式兜底。
 * 目标：200k 预算下不超限（客户端还有包装开销）。
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
export function setEncoder(fn: ((text: string) => number) | null): void {
  tiktokenEncoder = fn;
}

/** 安全余量：200k 预算按 92% 使用 */
export const BUDGET_SAFETY_RATIO = 0.92;

/** 默认预算 */
export const DEFAULT_BUDGET = 200_000;

/** 计算实际可用预算 */
export function effectiveBudget(requested?: number): number {
  const raw = requested ?? DEFAULT_BUDGET;
  // 只做上限约束（不超过 200k），不抬高用户请求的预算
  const b = Math.min(Math.max(raw, 1), DEFAULT_BUDGET);
  return Math.floor(b * BUDGET_SAFETY_RATIO);
}
