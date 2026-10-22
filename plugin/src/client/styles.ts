/**
 * client/styles.ts —— 插件样式（运行时注入）
 *
 * 做法对齐 DSH 官方插件（如 dsh-workbuddy-connect）：
 *   创建 <style> 标签 → textContent 写入 CSS → appendChild 到 head
 *   带 data-plugin-css 去重标记，卸载时移除。
 *
 * 设计参考：
 *   - 卡片分组（group card）：标题 + 说明 + 内容
 *   - 开关式行（row with switch）
 *   - 状态徽章（badge）
 *   - 柔和边框 + 圆角，深色主题
 */

export const BRIDGE_CSS_ID = 'dsh-codex-bridge/styles.css';

/** 注入样式（幂等） */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {};

  const selector = `style[data-plugin-css="${BRIDGE_CSS_ID}"]`;
  if (document.querySelector(selector) !== null) {
    return () => {};
  }

  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-codex-bridge';
  tag.dataset.pluginCss = BRIDGE_CSS_ID;
  tag.textContent = BRIDGE_CSS;
  document.head.appendChild(tag);

  return () => { tag.remove(); };
}

export const BRIDGE_CSS = `
/* ══════════════ 变量 ══════════════ */
.codex-bridge-settings {
  --cb-bg: #1b1b1f;
  --cb-bg-soft: #222228;
  --cb-bg-hover: #2a2a32;
  --cb-border: #33333d;
  --cb-border-soft: #2a2a33;
  --cb-text: #e8e8ec;
  --cb-text-dim: #9a9aa8;
  --cb-text-faint: #6e6e7e;
  --cb-accent: #4f8cff;
  --cb-accent-soft: rgba(79, 140, 255, 0.14);
  --cb-success: #3ecf8e;
  --cb-warn: #e8b339;
  --cb-error: #f0605d;
  --cb-radius: 10px;
  --cb-radius-sm: 6px;
  --cb-gap: 12px;

  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 24px;
  color: var(--cb-text);
  font-size: 13px;
  line-height: 1.6;
}

/* ══════════════ 标题区 ══════════════ */
.codex-bridge-settings > h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 2px;
  letter-spacing: -0.01em;
}

.codex-bridge-settings .cb-lead {
  margin: 0;
  color: var(--cb-text-dim);
  font-size: 13px;
}

/* ══════════════ 分组卡片 ══════════════ */
.codex-bridge-settings .cb-card {
  background: var(--cb-bg-soft);
  border: 1px solid var(--cb-border-soft);
  border-radius: var(--cb-radius);
  overflow: hidden;
}

.codex-bridge-settings .cb-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--cb-border-soft);
}

.codex-bridge-settings .cb-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13.5px;
}

.codex-bridge-settings .cb-card-desc {
  padding: 0 14px 10px;
  color: var(--cb-text-faint);
  font-size: 12px;
  border-bottom: 1px solid var(--cb-border-soft);
}

.codex-bridge-settings .cb-card-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ══════════════ 行（标签 + 右侧控件） ══════════════ */
.codex-bridge-settings .cb-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
}

.codex-bridge-settings .cb-row-main {
  min-width: 0;
  flex: 1;
}

.codex-bridge-settings .cb-row-label {
  font-size: 13px;
  color: var(--cb-text);
}

.codex-bridge-settings .cb-row-hint {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--cb-text-faint);
  line-height: 1.5;
}

.codex-bridge-settings .cb-row-ctrl {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ══════════════ 按钮 ══════════════ */
.codex-bridge-settings button,
.codex-bridge-settings .cb-btn {
  font: inherit;
  font-size: 12.5px;
  padding: 7px 14px;
  border-radius: var(--cb-radius-sm);
  border: 1px solid var(--cb-border);
  background: var(--cb-bg);
  color: var(--cb-text);
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
  white-space: nowrap;
}

.codex-bridge-settings button:hover:not(:disabled) {
  background: var(--cb-bg-hover);
  border-color: #444450;
}

.codex-bridge-settings button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.codex-bridge-settings button.primary {
  background: var(--cb-accent);
  border-color: var(--cb-accent);
  color: #fff;
  font-weight: 500;
}

.codex-bridge-settings button.primary:hover:not(:disabled) {
  background: #5f97ff;
  border-color: #5f97ff;
}

.codex-bridge-settings button.cb-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--cb-text-dim);
  padding: 6px 10px;
}

.codex-bridge-settings button.cb-btn-ghost:hover:not(:disabled) {
  background: var(--cb-bg-hover);
  color: var(--cb-text);
}

.codex-bridge-settings button.cb-btn-sm {
  font-size: 11.5px;
  padding: 4px 10px;
}

/* ══════════════ 动作按钮组 ══════════════ */
.codex-bridge-settings .actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.codex-bridge-settings .cb-action {
  flex: 1 1 180px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 12px 14px;
  text-align: left;
  border-radius: var(--cb-radius);
  border: 1px solid var(--cb-border-soft);
  background: var(--cb-bg-soft);
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease;
}

.codex-bridge-settings .cb-action:hover {
  background: var(--cb-bg-hover);
  border-color: var(--cb-border);
}

.codex-bridge-settings .cb-action-primary {
  border-color: rgba(79, 140, 255, 0.45);
  background: var(--cb-accent-soft);
}

.codex-bridge-settings .cb-action-primary:hover {
  background: rgba(79, 140, 255, 0.2);
  border-color: var(--cb-accent);
}

.codex-bridge-settings .cb-action-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--cb-text);
}

.codex-bridge-settings .cb-action-desc {
  font-size: 11.5px;
  color: var(--cb-text-faint);
  line-height: 1.5;
  white-space: normal;
}

/* ══════════════ 徽章 / 标签 ══════════════ */
.codex-bridge-settings .cb-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--cb-border);
  background: var(--cb-bg);
  color: var(--cb-text-dim);
  white-space: nowrap;
}

.codex-bridge-settings .cb-badge-ok {
  border-color: rgba(62, 207, 142, 0.4);
  background: rgba(62, 207, 142, 0.1);
  color: var(--cb-success);
}

.codex-bridge-settings .cb-badge-off {
  border-color: var(--cb-border-soft);
  color: var(--cb-text-faint);
}

.codex-bridge-settings .cb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.codex-bridge-settings .cb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ══════════════ 提示条 ══════════════ */
.codex-bridge-settings .alert {
  padding: 10px 12px;
  border-radius: var(--cb-radius-sm);
  border: 1px solid var(--cb-border-soft);
  background: var(--cb-bg-soft);
  font-size: 12px;
  line-height: 1.6;
}

.codex-bridge-settings .alert.info {
  border-color: rgba(79, 140, 255, 0.32);
  background: rgba(79, 140, 255, 0.08);
}

.codex-bridge-settings .alert.success {
  border-color: rgba(62, 207, 142, 0.32);
  background: rgba(62, 207, 142, 0.08);
}

.codex-bridge-settings .alert.warn {
  border-color: rgba(232, 179, 57, 0.32);
  background: rgba(232, 179, 57, 0.08);
}

.codex-bridge-settings .alert.error {
  border-color: rgba(240, 96, 93, 0.32);
  background: rgba(240, 96, 93, 0.08);
}

.codex-bridge-settings .alert p { margin: 0; }
.codex-bridge-settings .alert p + p { margin-top: 6px; }
.codex-bridge-settings .alert ul { margin: 6px 0 0; padding-left: 18px; }

/* ══════════════ 表单控件 ══════════════ */
.codex-bridge-settings .filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.codex-bridge-settings .filters > label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--cb-text-dim);
}

.codex-bridge-settings input[type="text"],
.codex-bridge-settings input[type="search"],
.codex-bridge-settings input:not([type]),
.codex-bridge-settings select {
  font: inherit;
  font-size: 12.5px;
  padding: 6px 10px;
  border-radius: var(--cb-radius-sm);
  border: 1px solid var(--cb-border);
  background: var(--cb-bg);
  color: var(--cb-text);
  outline: none;
  transition: border-color 0.14s ease;
  min-width: 0;
}

.codex-bridge-settings input:focus,
.codex-bridge-settings select:focus {
  border-color: var(--cb-accent);
}

.codex-bridge-settings input[type="radio"],
.codex-bridge-settings input[type="checkbox"] {
  accent-color: var(--cb-accent);
  cursor: pointer;
}

.codex-bridge-settings .filters > input[type="text"],
.codex-bridge-settings .filters > input {
  flex: 1 1 200px;
}

/* ══════════════ 表格 ══════════════ */
.codex-bridge-settings .cb-table-wrap {
  border: 1px solid var(--cb-border-soft);
  border-radius: var(--cb-radius-sm);
  overflow: hidden;
}

.codex-bridge-settings table.sessions {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.codex-bridge-settings table.sessions thead th {
  text-align: left;
  font-weight: 500;
  font-size: 11.5px;
  color: var(--cb-text-faint);
  padding: 8px 10px;
  background: var(--cb-bg);
  border-bottom: 1px solid var(--cb-border-soft);
  position: sticky;
  top: 0;
  z-index: 1;
  white-space: nowrap;
}

.codex-bridge-settings table.sessions tbody td {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(42, 42, 51, 0.7);
  vertical-align: middle;
}

.codex-bridge-settings table.sessions tbody tr:last-child td {
  border-bottom: none;
}

.codex-bridge-settings table.sessions tbody tr {
  transition: background 0.12s ease;
}

.codex-bridge-settings table.sessions tbody tr:hover {
  background: rgba(255, 255, 255, 0.025);
  cursor: pointer;
}

.codex-bridge-settings table.sessions tbody tr.checked {
  background: var(--cb-accent-soft);
}

.codex-bridge-settings .path,
.codex-bridge-settings code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--cb-text-dim);
  background: rgba(255, 255, 255, 0.04);
  padding: 1px 5px;
  border-radius: 4px;
  word-break: break-all;
}

.codex-bridge-settings .reason {
  color: var(--cb-text-faint);
  font-size: 11.5px;
  max-width: 320px;
}

/* ══════════════ 对话框 ══════════════ */
.codex-bridge-settings .dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px 20px;
  color: var(--cb-text);
  font-size: 13px;
}

.codex-bridge-settings .dialog h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.codex-bridge-settings .dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  margin-top: 4px;
  border-top: 1px solid var(--cb-border-soft);
  font-size: 12px;
  color: var(--cb-text-dim);
}

.codex-bridge-settings .dialog-footer > div {
  display: flex;
  gap: 8px;
}

/* ══════════════ 其他 ══════════════ */
.codex-bridge-settings .muted {
  color: var(--cb-text-faint);
}

.codex-bridge-settings dl.paths {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 11.5px;
}

.codex-bridge-settings dl.paths dt {
  color: var(--cb-text-faint);
  white-space: nowrap;
}

.codex-bridge-settings dl.paths dd {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  color: var(--cb-text-dim);
  word-break: break-all;
}

.codex-bridge-settings .spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--cb-border);
  border-top-color: var(--cb-accent);
  border-radius: 50%;
  animation: cb-spin 0.8s linear infinite;
  align-self: flex-start;
}

@keyframes cb-spin {
  to { transform: rotate(360deg); }
}

.codex-bridge-settings .progress {
  height: 4px;
  border-radius: 999px;
  background: var(--cb-bg);
  overflow: hidden;
}

.codex-bridge-settings .progress > div {
  height: 100%;
  background: var(--cb-accent);
  transition: width 0.2s ease;
}

/* 日志面板 */
.codex-bridge-settings .log-panel {
  border: 1px solid var(--cb-border-soft);
  border-radius: var(--cb-radius);
  overflow: hidden;
  background: var(--cb-bg-soft);
}

.codex-bridge-settings .log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--cb-border-soft);
  font-size: 12.5px;
  font-weight: 600;
}

.codex-bridge-settings .log-body {
  max-height: 260px;
  overflow: auto;
  padding: 8px 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
}

.codex-bridge-settings .log-body .msg {
  display: flex;
  gap: 8px;
  padding: 3px 14px;
  color: var(--cb-text-dim);
  line-height: 1.5;
}

.codex-bridge-settings .log-body .msg:hover {
  background: rgba(255, 255, 255, 0.03);
}

.codex-bridge-settings .log-body .time {
  color: var(--cb-text-faint);
  flex-shrink: 0;
}

.codex-bridge-settings .log-body .op {
  flex-shrink: 0;
  color: var(--cb-accent);
}

.codex-bridge-settings .log-body .sid {
  color: var(--cb-text-faint);
  flex-shrink: 0;
}

/* 深色滚动条 */
.codex-bridge-settings ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.codex-bridge-settings ::-webkit-scrollbar-track {
  background: transparent;
}
.codex-bridge-settings ::-webkit-scrollbar-thumb {
  background: #3a3a46;
  border-radius: 4px;
}
.codex-bridge-settings ::-webkit-scrollbar-thumb:hover {
  background: #4a4a58;
}
`;
