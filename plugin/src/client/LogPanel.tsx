/**
 * client/LogPanel.tsx —— 操作日志面板
 *
 * 关键操作（导入 / 导出 / 备份 / 转换）都会落日志，便于排查问题。
 * 只展示元数据，不含消息正文。
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { OpLogEntry } from '../shared/types';

interface Props { apiBase: string }

const OP_LABEL: Record<string, string> = {
  import: '导入', export: '导出', backup: '备份', scan: '扫描', transfer: '转换', error: '错误',
};
const PHASE_ICON: Record<string, string> = { start: '⏳', ok: '✅', fail: '❌' };

export function LogPanel({ apiBase }: Props) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<OpLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiBase}/logs?limit=100`);
      const d = await r.json();
      if (d.ok) setLogs(d.logs ?? []);
    } catch { /* 忽略 */ }
    setLoading(false);
  }, [apiBase]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  return (
    <div className="cb-card log-panel">
      <div className="cb-card-head">
        <span className="cb-card-title">
          操作日志
          {logs.length > 0 && <span className="cb-badge">{logs.length}</span>}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {open && (
            <button className="cb-btn-ghost cb-btn-sm" onClick={load} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
          )}
          <button className="cb-btn-ghost cb-btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {open && (
        <>
          <div className="cb-card-desc">最近 100 条记录（导入 / 导出 / 备份 / 转换）</div>
          <div className="log-body">
            {logs.length === 0 && <p className="muted" style={{ padding: '0 14px' }}>暂无记录。</p>}
            {logs.map((l) => (
              <div key={l.id} className="msg">
                <span className="time">{new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className="op">{PHASE_ICON[l.phase] ?? ''} {OP_LABEL[l.op] ?? l.op}</span>
                <span>{l.message}</span>
                {l.sessionId && <span className="sid">{String(l.sessionId).slice(0, 8)}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
