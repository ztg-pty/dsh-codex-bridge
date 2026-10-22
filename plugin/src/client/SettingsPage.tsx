/**
 * client/SettingsPage.tsx —— 插件设置主页
 *
 * 视觉设计对齐 DSH 官方插件（分组卡片 + 状态徽章 + 说明文字）：
 *   - 顶部：标题 + 一句话说明
 *   - 客户端状态卡片：每个端一行（图标 + 名称 + 会话数 + 徽章）
 *   - 操作卡片：三个大按钮（带标题 + 说明）
 *   - 路径卡片：Codex / DSH 目录
 *   - 日志面板
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ImportDialog } from './ImportDialog';
import { ExportDialog } from './ExportDialog';
import { TransferDialog } from './TransferDialog';
import { LogPanel } from './LogPanel';

interface SettingsProps {
  apiBase?: string;
}

type View = 'home' | 'import' | 'export' | 'transfer';

interface ClientStatus {
  kind: string;
  label: string;
  home: string;
  detected: boolean;
  canRead: boolean;
  canWrite: boolean;
  sessionCount?: number;
  reason?: string;
}

const CLIENT_ICON: Record<string, string> = {
  dsh: '◆',
  codex: '◇',
  zcode: '◈',
  'claude-code': '◉',
  workbuddy: '◎',
};

export function CodexBridgeSettings({ apiBase = '/plugins/dsh-codex-bridge' }: SettingsProps) {
  const [view, setView] = useState<View>('home');
  const [status, setStatus] = useState<{ codexDir: string; dshSessionsRoot: string } | null>(null);
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [platformNote, setPlatformNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`${apiBase}/status`).then((r) => r.json()).catch(() => null),
      fetch(`${apiBase}/clients`).then((r) => r.json()).catch(() => null),
    ]).then(([s, c]) => {
      if (s?.ok) setStatus(s);
      else setError('无法连接到插件服务，请确认 DSH 正在运行。');
      if (c?.ok) {
        setClients(c.clients ?? []);
        setPlatformNote(c.platform?.note ?? '');
      }
      setLoading(false);
    });
  }, [apiBase]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  if (view === 'import') return <ImportDialog apiBase={apiBase} onBack={() => setView('home')} />;
  if (view === 'export') return <ExportDialog apiBase={apiBase} onBack={() => setView('home')} />;
  if (view === 'transfer') return <TransferDialog apiBase={apiBase} onBack={() => setView('home')} />;

  const detected = clients.filter((c) => c.detected);
  const missing = clients.filter((c) => !c.detected);

  return (
    <div className="codex-bridge-settings">
      <h2>会话桥接</h2>
      <p className="cb-lead">
        Codex / DeepSeek Harness / Zcode / Claude Code / WorkBuddy 五端会话互通。
      </p>

      {error && <div className="alert error">{error}</div>}

      {/* ── 客户端状态 ── */}
      <div className="cb-card">
        <div className="cb-card-head">
          <span className="cb-card-title">
            已检测客户端
            <span className="cb-badge cb-badge-ok">
              <span className="cb-dot" />
              {detected.length} / {clients.length || 5}
            </span>
          </span>
          <button className="cb-btn-ghost cb-btn-sm" onClick={loadStatus} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
        <div className="cb-card-desc">
          自动探测本机安装的客户端。只读标记表示该端只能读取、不能写入。
        </div>
        <div className="cb-card-body">
          {clients.length === 0 && <span className="muted">正在探测…</span>}
          {detected.map((c) => (
            <div className="cb-row" key={c.kind}>
              <div className="cb-row-main">
                <div className="cb-row-label">
                  <span style={{ marginRight: 6, opacity: 0.7 }}>{CLIENT_ICON[c.kind] ?? '·'}</span>
                  {c.label}
                </div>
                <div className="cb-row-hint" title={c.home}>{c.home}</div>
              </div>
              <div className="cb-row-ctrl">
                {c.sessionCount != null && (
                  <span className="cb-badge">{c.sessionCount} 会话</span>
                )}
                <span className={`cb-badge ${c.canWrite ? 'cb-badge-ok' : ''}`}>
                  <span className="cb-dot" />
                  {c.canWrite ? '可读写' : '只读'}
                </span>
              </div>
            </div>
          ))}
          {missing.length > 0 && (
            <div className="cb-row">
              <div className="cb-row-main">
                <div className="cb-row-hint">
                  未检测到：{missing.map((c) => c.label).join('、')}
                </div>
              </div>
            </div>
          )}
          {platformNote && (
            <div className="cb-row">
              <div className="cb-row-main">
                <div className="cb-row-hint">{platformNote}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 操作入口 ── */}
      <div className="cb-card">
        <div className="cb-card-head">
          <span className="cb-card-title">操作</span>
        </div>
        <div className="cb-card-desc">
          三个入口能力不同，按需求选择。
        </div>
        <div className="cb-card-body">
          <div className="actions">
            <button className="cb-action cb-action-primary" onClick={() => setView('transfer')}>
              <span className="cb-action-title">跨端转换</span>
              <span className="cb-action-desc">
                任意两端互转（含 Zcode / Claude Code → DSH），支持上下文预览与压缩
              </span>
            </button>
            <button className="cb-action" onClick={() => setView('import')}>
              <span className="cb-action-title">导入 Codex → DSH</span>
              <span className="cb-action-desc">
                带工作区选择、去重、加密内容占位
              </span>
            </button>
            <button className="cb-action" onClick={() => setView('export')}>
              <span className="cb-action-title">导出 DSH → Codex / WorkBuddy</span>
              <span className="cb-action-desc">
                自动备份旧文件、注册 Codex 索引
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* ── 路径 ── */}
      {status && (
        <div className="cb-card">
          <div className="cb-card-head">
            <span className="cb-card-title">存储位置</span>
          </div>
          <div className="cb-card-body">
            <dl className="paths">
              <dt>Codex 目录</dt><dd>{status.codexDir}</dd>
              <dt>DSH 会话目录</dt><dd>{status.dshSessionsRoot}</dd>
            </dl>
          </div>
        </div>
      )}

      <LogPanel apiBase={apiBase} />
    </div>
  );
}

export default CodexBridgeSettings;
