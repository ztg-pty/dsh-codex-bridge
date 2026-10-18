/**
 * client/SettingsPage.tsx —— 插件独立设置页
 *
 * 要求 1：插件在插件列表页展示名称；点击名称进入独立设置页面。
 * 要求 2：全部弹窗、提示文案清晰易懂，失败有错误提示。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ImportDialog } from './ImportDialog';
import { ExportDialog } from './ExportDialog';
import { LogPanel } from './LogPanel';
import { detectRuntime } from '../io/adapter';
import { formatBytes } from '../shared/errors';
import type { CodexSessionSummary } from '../shared/types';

interface SettingsProps {
  /** 宿主注入的接口基址 */
  apiBase?: string;
}

type View = 'home' | 'import' | 'export';

export function CodexBridgeSettings({ apiBase = '/plugins/dsh-codex-bridge' }: SettingsProps) {
  const runtime = detectRuntime();
  const [view, setView] = useState<View>('home');
  const [status, setStatus] = useState<{ codexDir: string; dshSessionsRoot: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/status`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setStatus(d); })
      .catch(() => setError('无法连接到插件服务，请确认 DSH 正在运行。'));
  }, [apiBase]);

  if (view === 'import') {
    return <ImportDialog apiBase={apiBase} onBack={() => setView('home')} />;
  }
  if (view === 'export') {
    return <ExportDialog apiBase={apiBase} onBack={() => setView('home')} />;
  }

  return (
    <div className="codex-bridge-settings">
      <h2>Codex 会话桥接</h2>
      <p className="muted">
        打通 Codex 与 DeepSeek Harness 的会话数据，支持双向导入导出。
      </p>

      {/* 环境提示 */}
      <div className="env-badge desktop">
        {runtime === 'desktop'
          ? '桌面端：可扫描本机 Codex 目录，支持本地文件读写'
          : '本机模式：目录读写由 DSH 后端处理，可直接扫描与导入导出'}
      </div>

      {error && <div className="alert error">{error}</div>}

      {status && (
        <dl className="paths">
          <dt>Codex 目录</dt><dd>{status.codexDir}</dd>
          <dt>DSH 会话目录</dt><dd>{status.dshSessionsRoot}</dd>
        </dl>
      )}

      {/* 两个主操作 */}
      <div className="actions">
        <button className="primary" onClick={() => setView('import')}>
          导入 CodeX 会话
        </button>
        <button className="primary" onClick={() => setView('export')}>
          导出至 Codex
        </button>
      </div>

      <LogPanel apiBase={apiBase} />
    </div>
  );
}

export default CodexBridgeSettings;
