/**
 * client/BudgetPicker.tsx —— 上下文长度选择器
 *
 * 支持两种模式：
 *   1. 按模型选（自动查上下文窗口预设）
 *   2. 自定义 token 数
 *
 * 用于导出对话框与跨端转换对话框。
 */
import React, { useMemo } from 'react';

/** 与后端 MODEL_CONTEXT_PRESETS 保持一致的常用选项（前端只做展示，最终由后端解析） */
export const MODEL_OPTIONS: Array<{ value: string; label: string; context: number }> = [
  { value: '', label: '默认（200k）', context: 200_000 },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', context: 200_000 },
  { value: 'claude-opus-4', label: 'Claude Opus 4', context: 200_000 },
  { value: 'gpt-5', label: 'GPT-5', context: 400_000 },
  { value: 'gpt-4.1', label: 'GPT-4.1', context: 1_000_000 },
  { value: 'gpt-4o', label: 'GPT-4o', context: 128_000 },
  { value: 'gemini-2.0', label: 'Gemini 2.0', context: 1_000_000 },
  { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', context: 2_000_000 },
  { value: 'deepseek-v4', label: 'DeepSeek V4', context: 256_000 },
  { value: 'deepseek-v3', label: 'DeepSeek V3', context: 128_000 },
  { value: 'glm-5', label: 'GLM-5', context: 200_000 },
  { value: 'glm-4.6', label: 'GLM-4.6', context: 200_000 },
  { value: 'kimi-k2', label: 'Kimi K2', context: 256_000 },
  { value: 'qwen', label: 'Qwen', context: 128_000 },
];

/** 预设的 token 数选项 */
export const BUDGET_PRESETS = [16_000, 32_000, 64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000];

export interface BudgetValue {
  /** 模式：按模型 或 自定义 */
  mode: 'model' | 'custom';
  /** 模型名（mode=model 时有效） */
  model: string;
  /** 自定义 token（mode=custom 时有效） */
  custom: number;
}

export const DEFAULT_BUDGET_VALUE: BudgetValue = { mode: 'model', model: '', custom: 200_000 };

interface Props {
  value: BudgetValue;
  onChange: (v: BudgetValue) => void;
  /** 原始会话大小（可选，用于提示「不需要压缩」） */
  originalTokens?: number;
  /** 是否禁用 */
  disabled?: boolean;
}

/** 计算实际生效的预算（用于显示） */
export function resolveDisplayBudget(v: BudgetValue): { requested: number; effective: number; label: string } {
  let requested: number;
  let label: string;
  if (v.mode === 'custom') {
    requested = Math.max(1, Math.min(v.custom, 2_000_000));
    label = '自定义';
  } else {
    const opt = MODEL_OPTIONS.find((m) => m.value === v.model);
    requested = opt?.context ?? 200_000;
    label = opt && opt.value ? opt.label : '默认';
  }
  return { requested, effective: Math.floor(requested * 0.92), label };
}

export function BudgetPicker({ value, onChange, originalTokens, disabled }: Props) {
  const display = useMemo(() => resolveDisplayBudget(value), [value]);

  return (
    <div className="cb-budget">
      <div className="filters" style={{ gap: 10 }}>
        <label>
          上下文长度
          <select
            value={value.mode}
            onChange={(e) => onChange({ ...value, mode: e.target.value as 'model' | 'custom' })}
            disabled={disabled}
          >
            <option value="model">按模型</option>
            <option value="custom">自定义 token</option>
          </select>
        </label>

        {value.mode === 'model' ? (
          <label style={{ flex: '1 1 200px' }}>
            模型
            <select
              style={{ flex: 1 }}
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
              disabled={disabled}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}{m.value ? ` · ${(m.context / 1000).toLocaleString()}k` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label style={{ flex: '1 1 200px' }}>
            上限
            <select
              style={{ flex: 1 }}
              value={value.custom}
              onChange={(e) => onChange({ ...value, custom: Number(e.target.value) })}
              disabled={disabled}
            >
              {BUDGET_PRESETS.map((b) => (
                <option key={b} value={b}>{(b / 1000).toLocaleString()}k tokens</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="cb-row-hint" style={{ marginTop: 4 }}>
        预算 {display.requested.toLocaleString()} → 实际可用{' '}
        <b style={{ color: 'var(--cb-text)' }}>{display.effective.toLocaleString()}</b> tokens
        （安全系数 92%）
        {originalTokens != null && (
          originalTokens <= display.effective
            ? <span style={{ color: 'var(--cb-success)' }}> · 会话 {originalTokens.toLocaleString()} tokens，无需压缩</span>
            : <span style={{ color: 'var(--cb-warn)' }}> · 会话 {originalTokens.toLocaleString()} tokens，将压缩到 {(display.effective / originalTokens * 100).toFixed(0)}%</span>
        )}
      </div>
    </div>
  );
}
