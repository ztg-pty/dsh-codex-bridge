/**
 * client/LogPanel.tsx —— 操作日志面板
 *
 * 关键操作（导入 / 导出 / 备份）都会落日志，便于排查问题。
 * 只展示元数据，不含消息正文。
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { OpLogEntry } from '../shared/types';

interface Props { apiBase: string }

const OP_LABEL: Record<string, string> = {
  import: '导入', export: '导出', backup: '备份', scan: '扫描', error: '错误',
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
    <div className="log-panel">
      <button className="link" onClick={() => setOpen((v) => !v)}>
        {open ? '收起操作日志' : '查看操作日志'}
      </button>

      {open && (
        <div className="log-body">
          <div className="log-header">
            <span>最近 100 条记录</span>
            <button onClick={load} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
          </div>
          {logs.length === 0 && <p className="muted">暂无记录。</p>}
          <ul>
            {logs.map((l) => (
              <li key={l.id} className={l.phase}>
                <span className="time">{new Date(l.at).toLocaleString()}</span>
                <span className="op">{PHASE_ICON[l.phase] ?? ''} {OP_LABEL[l.op] ?? l.op}</span>
                <span className="msg">{l.message}</span>
                {l.sessionId && <span className="sid">{l.sessionId}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
