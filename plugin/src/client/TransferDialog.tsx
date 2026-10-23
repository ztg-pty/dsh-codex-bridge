/**
 * client/TransferDialog.tsx —— 跨端转换 / 上下文预览
 *
 * 流程：
 *   1. 选择源客户端 + 会话（列出该端所有会话）
 *   2. 选择目标客户端（显示转换损失提示）
 *   3. 执行转换，或预览压缩上下文
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../shared/errors';
import { BudgetPicker, DEFAULT_BUDGET_VALUE, resolveDisplayBudget, type BudgetValue } from './BudgetPicker';

type Phase = 'loading' | 'pick' | 'confirm' | 'running' | 'done' | 'preview' | 'error';

interface Props {
  apiBase: string;
  onBack: () => void;
}

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

interface Capability {
  client: string;
  label: string;
  canRead: boolean;
  canWrite: boolean;
  supportsSubagent: boolean;
  supportsImage: boolean;
  supportsFileChange: boolean;
  supportsBranching: boolean;
  lossyFields: string[];
}

interface SessionItem {
  client: string;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  turns?: number;
  approxTokens?: number;
}

export function TransferDialog({ apiBase, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [platformNote, setPlatformNote] = useState('');

  const [source, setSource] = useState<string>('');
  const [target, setTarget] = useState<string>('');
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [losses, setLosses] = useState<string[]>([]);
  const [result, setResult] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [budgetValue, setBudgetValue] = useState<BudgetValue>(DEFAULT_BUDGET_VALUE);

  // 加载客户端状态
  const loadClients = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const r = await fetch(`${apiBase}/clients`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '加载失败');
      setClients(d.clients ?? []);
      setCaps(d.capabilities ?? []);
      setPlatformNote(d.platform?.note ?? '');

      // 默认源：第一个可读且有会话的
      const firstReadable = (d.clients ?? []).find((c: ClientStatus) => c.canRead && c.detected);
      if (firstReadable) setSource(firstReadable.kind);
      setPhase('pick');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  }, [apiBase]);

  useEffect(() => { void loadClients(); }, [loadClients]);

  // 加载会话列表
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${apiBase}/sessions/all?clients=${encodeURIComponent(source)}&limit=200`);
        const d = await r.json();
        if (cancelled) return;
        if (!d.ok) throw new Error(d.message ?? '加载会话失败');
        setSessions((d.sessions ?? []).filter((s: SessionItem) => s.client === source));
        setSelected('');
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, source]);

  // 加载损失提示
  useEffect(() => {
    if (!source || !target) { setLosses([]); return; }
    (async () => {
      try {
        const r = await fetch(`${apiBase}/loss?from=${encodeURIComponent(source)}&to=${encodeURIComponent(target)}`);
        const d = await r.json();
        if (d.ok) setLosses(d.losses ?? []);
      } catch { setLosses([]); }
    })();
  }, [apiBase, source, target]);

  const visible = useMemo(
    () => sessions
      .filter((s) => !keyword || s.title.toLowerCase().includes(keyword.toLowerCase()) || s.cwd.toLowerCase().includes(keyword.toLowerCase()))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, keyword],
  );

  const doTransfer = async () => {
    if (!selected || !target) return;
    setPhase('running');
    setError(null);
    try {
      const r = await fetch(`${apiBase}/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: source, fromId: selected, to: target }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '转换失败');
      setResult(d);
      setPhase('done');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  };

  const doPreview = async () => {
    if (!selected) return;
    setPhase('running');
    setError(null);
    try {
      const body: Record<string, unknown> = { client: source, sessionId: selected };
      if (budgetValue.mode === 'custom') body.budget = budgetValue.custom;
      else if (budgetValue.model) body.model = budgetValue.model;
      const r = await fetch(`${apiBase}/context/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '预览失败');
      setPreview(d);
      setPhase('preview');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  };

  // ── 渲染 ──

  if (phase === 'loading') {
    return <div className="dialog"><h3>跨端转换</h3><p>正在探测客户端…</p><div className="spinner" /></div>;
  }

  if (phase === 'running') {
    return <div className="dialog"><h3>处理中…</h3><p>正在读取并转换会话，请稍候。</p><div className="spinner" /></div>;
  }

  if (phase === 'error') {
    return (
      <div className="dialog">
        <h3>操作失败</h3>
        <div className="alert error">{error}</div>
        <div className="dialog-footer">
          <div />
          <div>
            <button onClick={onBack}>返回</button>
            <button className="primary" onClick={loadClients}>重试</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'done' && result) {
    return (
      <div className="dialog wide">
        <h3>转换完成</h3>
        <div className="alert success">
          ✅ 已从 <b>{result.source?.client}</b> 转换到 <b>{result.target?.client}</b>
        </div>
        <table className="sessions">
          <thead><tr><th>项目</th><th>值</th></tr></thead>
          <tbody>
            <tr><td>源会话</td><td>{result.source?.title}（{result.source?.turns} 轮）</td></tr>
            <tr><td>目标 ID</td><td className="path">{result.target?.id}</td></tr>
            <tr><td>写入位置</td><td className="path">{result.target?.location}</td></tr>
            <tr><td>记录数</td><td>{result.target?.records}</td></tr>
          </tbody>
        </table>
        {result.warnings?.length > 0 && (
          <div className="alert info">
            <p><b>提示：</b></p>
            <ul>{result.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}
        <div className="alert warn">
          <p>如需在目标客户端看到该会话，可能需要<b>重启目标客户端</b>（它只在启动时读索引）。</p>
        </div>
        <div className="dialog-footer">
          <div />
          <div>
            <button onClick={onBack}>完成</button>
            <button onClick={() => { setResult(null); setPhase('pick'); }}>再转一个</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'preview' && preview) {
    return (
      <div className="dialog wide">
        <h3>上下文预览</h3>
        <div className="alert info">
          <p><b>{preview.session?.title}</b>（{preview.session?.turns} 轮）</p>
          <p style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{preview.statsText}</p>
        </div>
        <div style={{ maxHeight: 400, overflow: 'auto', border: '1px solid #333', padding: 12, borderRadius: 6 }}>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{preview.context}</pre>
        </div>
        <div className="dialog-footer">
          <div />
          <div>
            <button onClick={() => setPhase('pick')}>返回</button>
            <button
              className="primary"
              onClick={() => {
                const blob = new Blob([preview.context], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `context-${preview.session?.id?.slice(0, 8) ?? 'session'}.md`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              下载 Markdown
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── pick 阶段 ──
  const detected = clients.filter((c) => c.detected);
  const targetOptions = caps.filter((c) => c.canWrite && clients.some((x) => x.kind === c.client && x.detected));
  const selectedSession = sessions.find((s) => s.id === selected);

  return (
    <div className="dialog wide">
      <h3>跨端转换</h3>

      {/* 客户端状态徽章 */}
      <div className="cb-chips">
        {detected.length === 0 && <span className="muted">未检测到任何客户端</span>}
        {detected.map((c) => (
          <span key={c.kind} className="cb-badge cb-badge-ok">
            <span className="cb-dot" />
            {c.label}{c.sessionCount != null ? ` · ${c.sessionCount}` : ''}
          </span>
        ))}
      </div>

      {/* 源 → 目标 */}
      <div className="cb-card">
        <div className="cb-card-head">
          <span className="cb-card-title">转换方向</span>
        </div>
        <div className="cb-card-body">
          <div className="filters" style={{ gap: 12, alignItems: 'flex-end' }}>
            <label style={{ flex: '1 1 200px' }}>
              源（从这里读）
              <select
                style={{ flex: 1 }}
                value={source}
                onChange={(e) => { setSource(e.target.value); setSelected(''); setTarget(''); }}
              >
                <option value="">请选择</option>
                {detected.filter((c) => c.canRead).map((c) => (
                  <option key={c.kind} value={c.kind}>
                    {c.label}{c.sessionCount != null ? `（${c.sessionCount}）` : ''}
                  </option>
                ))}
              </select>
            </label>
            <span style={{ fontSize: 16, paddingBottom: 6, opacity: 0.5 }}>→</span>
            <label style={{ flex: '1 1 200px' }}>
              目标（写到这里）
              <select
                style={{ flex: 1 }}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={!source}
              >
                <option value="">{source ? '请选择' : '请先选源'}</option>
                {targetOptions.filter((c) => c.client !== source).map((c) => (
                  <option key={c.client} value={c.client}>
                    {c.label}{c.client === 'dsh' ? '（DSH 主程序）' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* 当前选择摘要 */}
          {source && (
            <div className="cb-row-hint" style={{ marginTop: 2 }}>
              {target
                ? <>将把 <b style={{ color: 'var(--cb-text)' }}>{clients.find((c) => c.kind === source)?.label}</b> 的会话转换到 <b style={{ color: 'var(--cb-accent)' }}>{caps.find((c) => c.client === target)?.label}</b></>
                : <>已选源端 <b style={{ color: 'var(--cb-text)' }}>{clients.find((c) => c.kind === source)?.label}</b>，请选择目标（可选 {targetOptions.filter((c) => c.client !== source).length} 项）</>}
            </div>
          )}
        </div>
      </div>

      {/* 损失提示 */}
      {losses.length > 0 && (
        <div className="alert warn">
          <p><b>转换会丢失以下信息</b></p>
          <ul>{losses.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      )}

      {/* 会话列表 */}
      <div className="cb-card">
        <div className="cb-card-head">
          <span className="cb-card-title">
            选择会话
            {visible.length > 0 && <span className="cb-badge">{visible.length}</span>}
          </span>
          <button className="cb-btn-ghost cb-btn-sm" onClick={() => { const s = source; setSource(''); setTimeout(() => setSource(s), 0); }}>
            刷新
          </button>
        </div>
        <div className="cb-card-body" style={{ padding: 0 }}>
          <div className="filters" style={{ padding: '10px 14px' }}>
            <input placeholder="按标题或路径筛选…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
          <div className="cb-table-wrap" style={{ border: 'none', borderRadius: 0, maxHeight: 320, overflow: 'auto' }}>
            <table className="sessions">
              <thead>
                <tr><th style={{ width: 32 }} /><th>标题</th><th>会话 ID</th><th>轮次</th><th>更新</th></tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>该客户端没有可读取的会话</td></tr>
                )}
                {visible.map((s) => (
            <tr key={s.id} className={selected === s.id ? 'checked' : ''} onClick={() => setSelected(s.id)}>
              <td><input type="radio" checked={selected === s.id} onChange={() => setSelected(s.id)} /></td>
              <td title={s.title}>{s.title}</td>
              <td className="path" title={s.id}>…{s.id.slice(-8)}</td>
              <td>{s.turns ?? '—'}</td>
              <td>{new Date(s.updatedAt).toLocaleDateString('zh-CN')}</td>
            </tr>
          ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 上下文预览 */}
      <div className="cb-card">
        <div className="cb-card-head">
          <span className="cb-card-title">上下文预览</span>
        </div>
        <div className="cb-card-desc">
          先把会话压缩成 Markdown 看看效果，再决定是否转换。
        </div>
        <div className="cb-card-body">
          <BudgetPicker
            value={budgetValue}
            onChange={setBudgetValue}
            disabled={!selected}
          />
          <div className="filters">
            <button disabled={!selected} onClick={doPreview}>预览压缩上下文</button>
          </div>
        </div>
      </div>

      <div className="dialog-footer">
        <span>
          {selectedSession
            ? `已选：${selectedSession.title.slice(0, 30)}`
            : '请选择要转换的会话'}
        </span>
        <div>
          <button onClick={onBack}>取消</button>
          <button className="primary" disabled={!selected || !target} onClick={doTransfer}>
            开始转换
          </button>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}
