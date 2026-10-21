/**
 * client/SettingsPage.tsx —— 插件独立设置页
 *
 * 要求 1：插件在插件列表页展示名称；点击名称进入独立设置页面。
 * 要求 2：全部弹窗、提示文案清晰易懂，失败有错误提示。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ImportDialog } from './ImportDialog';
import { ExportDialog } from './ExportDialog';
import { TransferDialog } from './TransferDialog';
import { LogPanel } from './LogPanel';
import { detectRuntime } from '../io/adapter';
import { formatBytes } from '../shared/errors';
import type { CodexSessionSummary } from '../shared/types';

interface SettingsProps {
  /** 宿主注入的接口基址 */
  apiBase?: string;
}

type View = 'home' | 'import' | 'export' | 'transfer';

interface ClientStatus {
  kind: string;
  label: string;
  detected: boolean;
  canRead: boolean;
  canWrite: boolean;
  sessionCount?: number;
  reason?: string;
}

export function CodexBridgeSettings({ apiBase = '/plugins/dsh-codex-bridge' }: SettingsProps) {
  const runtime = detectRuntime();
  const [view, setView] = useState<View>('home');
  const [status, setStatus] = useState<{ codexDir: string; dshSessionsRoot: string } | null>(null);
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [platformNote, setPlatformNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    fetch(`${apiBase}/status`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setStatus(d); })
      .catch(() => setError('无法连接到插件服务，请确认 DSH 正在运行。'));
    fetch(`${apiBase}/clients`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setClients(d.clients ?? []);
          setPlatformNote(d.platform?.note ?? '');
        }
      })
      .catch(() => { /* 忽略：客户端探测失败不阻塞主页 */ });
  }, [apiBase]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  if (view === 'import') {
    return <ImportDialog apiBase={apiBase} onBack={() => setView('home')} />;
  }
  if (view === 'export') {
    return <ExportDialog apiBase={apiBase} onBack={() => setView('home')} />;
  }
  if (view === 'transfer') {
    return <TransferDialog apiBase={apiBase} onBack={() => setView('home')} />;
  }

  const detected = clients.filter((c) => c.detected);

  return (
    <div className="codex-bridge-settings">
      <h2>会话桥接</h2>
      <p className="muted">
        打通 <b>Codex</b> / <b>DeepSeek Harness</b> / <b>Zcode</b> / <b>Claude Code</b> / <b>WorkBuddy</b> 五端会话。
      </p>

      {/* 环境提示 */}
      <div className="env-badge desktop">
        {runtime === 'desktop'
          ? '桌面端：可扫描本机客户端目录，支持本地文件读写'
          : '本机模式：目录读写由 DSH 后端处理，可直接扫描与导入导出'}
      </div>

      {error && <div className="alert error">{error}</div>}
      {platformNote && <p className="muted" style={{ fontSize: 12 }}>{platformNote}</p>}

      {/* 客户端状态 */}
      <div style={{ margin: '12px 0' }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>已检测到的客户端：</div>
        {detected.length === 0 && <span className="muted">（未检测到，请确认已安装对应客户端）</span>}
        {detected.map((c) => (
          <span
            key={c.kind}
            title={c.reason ?? ''}
            style={{ fontSize: 12, padding: '2px 8px', marginRight: 6, border: '1px solid #444', borderRadius: 4, display: 'inline-block', marginBottom: 4 }}
          >
            {c.label}
            {c.sessionCount != null ? ` · ${c.sessionCount} 会话` : ''}
            {!c.canWrite ? '（只读）' : ''}
          </span>
        ))}
      </div>

      {status && (
        <dl className="paths">
          <dt>Codex 目录</dt><dd>{status.codexDir}</dd>
          <dt>DSH 会话目录</dt><dd>{status.dshSessionsRoot}</dd>
        </dl>
      )}

      {/* 主操作 */}
      <div className="actions">
        <button className="primary" onClick={() => setView('transfer')}>
          跨端转换 / 上下文预览
        </button>
        <button className="primary" onClick={() => setView('import')}>
          导入 Codex 会话
        </button>
        <button className="primary" onClick={() => setView('export')}>
          导出至 Codex / WorkBuddy
        </button>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        提示：跨端转换支持 Zcode / Claude Code（UIR 适配器已实现），
        其余端走专用转换器。转换前会显示损失提示。
      </p>

      <LogPanel apiBase={apiBase} />
    </div>
  );
}

export default CodexBridgeSettings;
