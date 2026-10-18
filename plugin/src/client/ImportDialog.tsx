/**
 * client/ImportDialog.tsx —— 导入 Codex 会话
 *
 * 流程（对应功能 1）：
 *   1. 自动扫描本机，定位 Codex 会话目录
 *   2. 列出最近的会话，提供筛选（关键字/日期），用户勾选
 *   3. 确认后转换并写入 DSH
 *   4. 完成后提示可直接去会话内发消息
 *
 * Web 端：不扫描本地，改为文件上传。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CodexSessionSummary, ImportReport } from '../shared/types';
import { formatBytes } from '../shared/errors';

type Phase = 'scanning' | 'pick' | 'chooseWs' | 'converting' | 'done' | 'error';

interface Props {
  apiBase: string;
  onBack: () => void;
}

interface WorkspaceInfo {
  path: string;
  title: string;
  sessionCount: number;
}

export function ImportDialog({ apiBase, onBack }: Props) {
  // ★ 一律从扫描开始（后端路由在本机，两端都能读本地目录）
  const [phase, setPhase] = useState<Phase>('scanning');
  const [sessions, setSessions] = useState<CodexSessionSummary[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set()); // 默认全不选
  const [keyword, setKeyword] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<ImportReport[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [skipped, setSkipped] = useState<Array<{ file: string; reason: string }>>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [targetCwd, setTargetCwd] = useState<string>('');
  const [mode, setMode] = useState<'skip' | 'overwrite'>('skip');

  const scan = useCallback(async () => {
    setPhase('scanning');
    setError(null);
    try {
      const r = await fetch(`${apiBase}/codex/sessions`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '扫描失败');
      setSessions(d.sessions ?? []);
      setSkipped(d.skipped ?? []);
      setPhase('pick');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  }, [apiBase]);

  useEffect(() => {
    // ★ 本地目录扫描由后端路由提供，桌面/Web 端都直接扫描，不再区分环境
    void scan();
  }, [scan]);

  // 筛选 + 时间倒序（全部会话，不隐藏）
  const visible = useMemo(() => {
    const from = dateFrom ? Date.parse(dateFrom) : 0;
    const to = dateTo ? Date.parse(dateTo) + 86400000 : Infinity;
    return sessions
      .filter((s) =>
        (!keyword
          || s.title.toLowerCase().includes(keyword.toLowerCase())
          || s.cwd.toLowerCase().includes(keyword.toLowerCase()))
        && s.updatedAt >= from && s.updatedAt <= to)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, keyword, dateFrom, dateTo]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  /** 勾选完成后 → 进入「选择目标工作区」 */
  const goChooseWorkspace = async () => {
    const files = sessions.filter((s) => checked.has(s.filePath));
    if (files.length === 0) { setError('请至少勾选一个会话。'); return; }
    setError(null);
    try {
      const r = await fetch(`${apiBase}/workspaces`);
      const d = await r.json();
      setWorkspaces(d.workspaces ?? []);
      setTargetCwd('');
      setPhase('chooseWs');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  };

  /** 执行导入 */
  const confirm = async () => {
    const files = sessions.filter((s) => checked.has(s.filePath)).map((s) => s.filePath);
    if (files.length === 0) { setError('请至少勾选一个会话。'); return; }
    setPhase('converting');
    setError(null);
    setProgress({ done: 0, total: files.length });
    try {
      const r = await fetch(`${apiBase}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files, mode, targetCwd: targetCwd || undefined }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '导入失败');
      setReports(d.results ?? []);
      setProgress({ done: files.length, total: files.length });
      setPhase('done');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  };

  // ── 扫描中 ──
  if (phase === 'scanning') {
    return (
      <div className="dialog">
        <h3>导入 CodeX 会话</h3>
        <p>正在扫描本机 Codex 会话目录…</p>
        <div className="spinner" />
      </div>
    );
  }

  // ── 选择列表 ──
  if (phase === 'pick') {
    return (
      <div className="dialog wide">
        <h3>导入 CodeX 会话</h3>
        <div className="filters">
          <input
            placeholder="按标题或工作目录筛选…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <label>从 <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></label>
          <label>到 <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></label>
          <button onClick={scan}>重新扫描</button>
        </div>

        {skipped.length > 0 && (
          <div className="alert warn">
            有 {skipped.length} 个文件无法读取，已跳过（示例：{skipped[0].reason}）
          </div>
        )}

        <table className="sessions">
          <thead>
            <tr>
              <th style={{ width: 32 }} />
              <th>标题</th>
              <th>工作目录</th>
              <th>更新时间</th>
              <th>大小</th>
              <th>轮次</th>
              <th>类型</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.filePath} className={checked.has(s.filePath) ? 'checked' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={checked.has(s.filePath)}
                    onChange={() => toggle(s.filePath)}
                  />
                </td>
                <td title={s.title}>{s.title}</td>
                <td className="path" title={s.cwd}>{s.cwd}</td>
                <td>{new Date(s.updatedAt).toLocaleString()}</td>
                <td>{formatBytes(s.sizeBytes)}</td>
                <td>{s.turnCount}</td>
                <td>
                  {s.isSubagent
                    ? <span className="tag sub" title={s.agentPath}>子代理</span>
                    : <span className="tag">主会话</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="dialog-footer">
          <span>共 {visible.length} 个会话，已选 {checked.size} 个</span>
          <div>
            <button onClick={onBack}>取消</button>
            <button className="primary" disabled={checked.size === 0} onClick={goChooseWorkspace}>
              下一步：选择目标工作区
            </button>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
      </div>
    );
  }

  // ── 选择目标工作区 ──
  if (phase === 'chooseWs') {
    return (
      <div className="dialog wide">
        <h3>选择目标工作区</h3>
        <p className="muted">
          已勾选 {checked.size} 个会话。导入的会话会归属到下面选中的 DSH 工作区，并出现在对应聊天列表。
        </p>
        <table className="sessions">
          <thead>
            <tr><th style={{ width: 32 }} /><th>工作区</th><th>路径</th><th>已有会话数</th></tr>
          </thead>
          <tbody>
            {workspaces.map((ws) => (
              <tr key={ws.path} className={targetCwd === ws.path ? 'checked' : ''}>
                <td>
                  <input
                    type="radio"
                    name="targetCwd"
                    checked={targetCwd === ws.path}
                    onChange={() => setTargetCwd(ws.path)}
                  />
                </td>
                <td>{ws.title}</td>
                <td className="path" title={ws.path}>{ws.path}</td>
                <td>{ws.sessionCount}</td>
              </tr>
            ))}
            {workspaces.length === 0 && (
              <tr><td colSpan={4} className="muted">未找到现有工作区。请在下方输入目标路径，或先在 DSH 中打开一个项目。</td></tr>
            )}
          </tbody>
        </table>

        <div className="filters">
          <input
            placeholder="或手动输入目标工作区绝对路径…"
            value={targetCwd}
            onChange={(e) => setTargetCwd(e.target.value)}
          />
        </div>

        <div className="filters">
          <span className="muted">已存在同名会话时：</span>
          <label>
            <input type="radio" name="mode" checked={mode === 'skip'} onChange={() => setMode('skip')} />
            跳过
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />
            覆盖
          </label>
        </div>

        <div className="dialog-footer">
          <div />
          <div>
            <button onClick={() => setPhase('pick')}>返回</button>
            <button className="primary" disabled={!targetCwd.trim()} onClick={confirm}>
              开始导入
            </button>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
      </div>
    );
  }

  // ── 转换中 ──
  if (phase === 'converting') {
    return (
      <div className="dialog">
        <h3>正在导入…</h3>
        <p>已处理 {progress.done} / {progress.total}</p>
        <div className="progress"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
      </div>
    );
  }

  // ── 错误 ──
  if (phase === 'error') {
    return (
      <div className="dialog">
        <h3>导入失败</h3>
        <div className="alert error">{error}</div>
        <div className="dialog-footer">
          <button onClick={onBack}>返回</button>
          <button onClick={scan}>重试</button>
        </div>
      </div>
    );
  }

  // ── 完成 ──
  const okCount = reports.filter((r) => r.ok).length;
  const failCount = reports.length - okCount;
  const totalEncrypted = reports.reduce((n, r) => n + r.stats.encryptedBlocks, 0);

  return (
    <div className="dialog wide">
      <h3>导入完成</h3>
      <div className={`alert ${failCount === 0 ? 'success' : 'warn'}`}>
        成功导入 {okCount} 个会话{failCount > 0 ? `，${failCount} 个失败` : ''}。
        现在可以直接在 DeepSeek Harness 的会话列表中打开并继续对话。
      </div>

      {totalEncrypted > 0 && (
        <div className="alert info">
          ⚠️ 共 {totalEncrypted} 处加密内容无法解码，已以「[加密内容 · 无法解码]」占位，
          不影响会话正常使用。
        </div>
      )}

      <table className="sessions">
        <thead>
          <tr><th>结果</th><th>会话</th><th>轮次</th><th>消息</th><th>工具调用</th><th>说明</th></tr>
        </thead>
        <tbody>
          {reports.map((r, i) => (
            <tr key={i}>
              <td>{r.ok ? '✅' : '❌'}</td>
              <td title={r.sourceFile}>{r.sourceId || '(未知)'}</td>
              <td>{r.stats.turns}</td>
              <td>{r.stats.messages}</td>
              <td>{r.stats.toolCalls}</td>
              <td className="reason">
                {r.ok
                  ? (r.warnings.length ? r.warnings[0] : '—')
                  : (r.error?.message ?? '未知错误')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="dialog-footer">
        <div />
        <button className="primary" onClick={onBack}>完成</button>
      </div>
    </div>
  );
}
