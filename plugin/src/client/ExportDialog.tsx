/**
 * client/ExportDialog.tsx —— 导出 DSH 会话为 OpenAI 兼容 JSONL
 *
 * 流程（对应功能 2）：
 *   1. 弹出绘画选择列表，用户手动勾选（**不自动全选**）
 *   2. 导出为 OpenAI 兼容 JSONL
 *   3. 导出瞬间自动备份 Codex 目录中的旧版 JSONL
 *   4. 完成后提示：需手动复制到 Codex 原目录 + 备份文件位置
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../shared/errors';
import { BudgetPicker, DEFAULT_BUDGET_VALUE, type BudgetValue } from './BudgetPicker';

type Phase = 'loading' | 'pick' | 'confirm' | 'exporting' | 'done' | 'error';

interface DshSessionSummary {
  id: string; title: string; createdAt: number; updatedAt: number;
  sizeBytes: number; turns: number; filePath: string;
  project?: string;
  isEmpty?: boolean;
}

interface ExportResult {
  ok: boolean;
  sourceSessionId: string;
  report?: { ok: boolean; stats: { lines: number; messages: number; toolCalls: number; bytes: number }; warnings: string[]; error?: { message: string } };
  outFile?: string;
  reportError?: string;
}

interface Props {
  apiBase: string;
  onBack: () => void;
}

export function ExportDialog({ apiBase, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [sessions, setSessions] = useState<DshSessionSummary[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set()); // ★ 初始全不选
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  /** 导出目标：Codex（导出文件+手动复制）或 WorkBuddy（直接写入本地） */
  const [target, setTarget] = useState<'codex' | 'workbuddy'>('codex');
  // 注册到 Codex 索引的状态
  const [registering, setRegistering] = useState(false);
  const [registerState, setRegisterState] = useState<'idle' | 'done'>('idle');
  const [registerResult, setRegisterResult] = useState<any>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  /** 导出的上下文长度（按模型 / 自定义 token） */
  const [budgetValue, setBudgetValue] = useState<BudgetValue>(DEFAULT_BUDGET_VALUE);
  /** 是否启用上下文裁剪（默认关闭，完整导出） */
  const [trimContext, setTrimContext] = useState(false);

  const doRegister = useCallback(async () => {
    setRegistering(true);
    setRegisterError(null);
    try {
      const r = await fetch(`${apiBase}/register-codex`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 不传 files：后端扫描 Codex sessions 目录下所有 rollout，补齐未注册的
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '注册失败');
      setRegisterResult(d);
      setRegisterState('done');
    } catch (e) {
      setRegisterError(String((e as Error)?.message ?? e));
    } finally {
      setRegistering(false);
    }
  }, [apiBase]);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const r = await fetch(`${apiBase}/dsh/sessions`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '加载失败');
      setSessions(d.sessions ?? []);
      setChecked(new Set());          // ★ 明确保证不全选
      setPhase('pick');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  }, [apiBase]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => sessions
      .filter((s) => !keyword || s.title.toLowerCase().includes(keyword.toLowerCase()))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, keyword],
  );

  const toggle = (id: string) => {
    setChecked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const doExport = async () => {
    if (checked.size === 0) { setError('请至少勾选一个会话。'); return; }
    setPhase('exporting');
    setError(null);
    try {
      const endpoint = target === 'workbuddy' ? '/export-workbuddy' : '/export';
      const body: Record<string, unknown> = target === 'workbuddy'
        ? { sessionIds: [...checked] }
        : { sessionIds: [...checked], doBackup: true };

      // ★ 上下文裁剪（可选）：启用时传 model / budget，后端会按预算压缩
      if (trimContext) {
        if (budgetValue.mode === 'custom') body.budget = budgetValue.custom;
        else if (budgetValue.model) body.model = budgetValue.model;
        body.trimContext = true;
      }

      const r = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? '导出失败');
      setResult(d);
      setPhase('done');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  };

  if (phase === 'loading') {
    return <div className="dialog"><h3>导出会话</h3><p>正在加载会话列表…</p><div className="spinner" /></div>;
  }

  if (phase === 'exporting') {
    return (
      <div className="dialog">
        <h3>{target === 'workbuddy' ? '正在导入 WorkBuddy…' : '正在导出…'}</h3>
        <p>{target === 'workbuddy' ? '正在转换并写入 WorkBuddy 本地存储，请稍候。' : '正在转换并备份 Codex 目录中的旧文件，请稍候。'}</p>
        <div className="spinner" />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="dialog">
        <h3>导出失败</h3>
        <div className="alert error">{error}</div>
        <div className="dialog-footer">
          <button onClick={onBack}>返回</button>
          <button className="primary" onClick={load}>重试</button>
        </div>
      </div>
    );
  }

  if (phase === 'pick') {
    return (
      <div className="dialog wide">
        <h3>导出会话</h3>

        <div className="filters" style={{ gap: 16 }}>
          <span className="muted">导出目标：</span>
          <label>
            <input type="radio" name="target" checked={target === 'codex'} onChange={() => setTarget('codex')} />
            Codex（生成 JSONL，需手动复制）
          </label>
          <label>
            <input type="radio" name="target" checked={target === 'workbuddy'} onChange={() => setTarget('workbuddy')} />
            WorkBuddy（直接写入本地，重启即可见）
          </label>
        </div>

        <p className="muted">
          选择要导出的会话（可多选，不会自动全选）。
          <br />
          <span style={{ fontSize: 12 }}>
            提示：DSH 按「首条消息」自动命名，因此<strong>同名不代表重复</strong>。请用「会话 ID」和更新时间区分。
          </span>
        </p>

        <div className="filters">
          <input placeholder="按标题筛选…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <button onClick={load}>刷新</button>
        </div>

        <table className="sessions">
          <thead>
            <tr>
              <th style={{ width: 32 }} />
              <th>标题</th>
              <th>会话 ID</th>
              <th>最后更新</th>
              <th>轮次</th>
              <th>大小</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.id} className={checked.has(s.id) ? 'checked' : ''}>
                <td><input type="checkbox" checked={checked.has(s.id)} onChange={() => toggle(s.id)} /></td>
                <td title={s.title}>{s.title}</td>
                <td className="path" title={`${s.id}\n项目：${s.project}`}>
                  …{s.id.slice(-8)}
                </td>
                <td>{new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                <td>{s.turns}</td>
                <td>{formatBytes(s.sizeBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="dialog-footer">
          <span>共 {visible.length} 个会话，已选 {checked.size} 个</span>
          <div>
            <button onClick={onBack}>取消</button>
            <button className="primary" disabled={checked.size === 0} onClick={() => setPhase('confirm')}>
              下一步
            </button>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
      </div>
    );
  }

  if (phase === 'confirm') {
    return (
      <div className="dialog">
        <h3>确认导出</h3>
        <div className="alert info">
          <p>即将导出 <b>{checked.size}</b> 个会话到 <b>{target === 'workbuddy' ? 'WorkBuddy' : 'Codex'}</b>。</p>
          {target === 'workbuddy' ? (
            <ul>
              <li>会直接写入 WorkBuddy 本地存储（数据库 + 会话文件）。</li>
              <li>写入前会自动备份 WorkBuddy 的数据库。</li>
              <li>完成后<b>重启 WorkBuddy</b>即可在会话列表看到。</li>
            </ul>
          ) : (
            <ul>
              <li>会导出为 OpenAI 兼容 JSONL 到受控目录。</li>
              <li>导出前会自动<b>备份</b> Codex 目录中的旧版 JSONL。</li>
              <li>插件<b>不会</b>直接写入 Codex 会话目录，避免破坏正在进行的会话。</li>
              <li>导出后需手动复制到 Codex 原目录，并点「注册到 Codex 索引」。</li>
            </ul>
          )}
        </div>

        {/* ★ 上下文长度（可选裁剪） */}
        <div className="cb-card">
          <div className="cb-card-head">
            <span className="cb-card-title">上下文长度</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={trimContext}
                onChange={(e) => setTrimContext(e.target.checked)}
              />
              启用裁剪
            </label>
          </div>
          <div className="cb-card-desc">
            {trimContext
              ? '会按所选预算压缩会话内容（技术细节优先保留），超出部分折叠为摘要。'
              : '默认完整导出（不裁剪）。目标模型上下文有限时可启用裁剪。'}
          </div>
          {trimContext && (
            <div className="cb-card-body">
              <BudgetPicker value={budgetValue} onChange={setBudgetValue} />
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <div />
          <div>
            <button onClick={() => setPhase('pick')}>返回</button>
            <button className="primary" onClick={doExport}>确认导出</button>
          </div>
        </div>
      </div>
    );
  }

  // ── 完成 ──
  const okCount = result?.succ ?? 0;
  const failed = result?.failed ?? 0;

  // WorkBuddy 导出：结果结构不同，单独渲染
  if (target === 'workbuddy') {
    return (
      <div className="dialog wide">
        <h3>已导入 WorkBuddy</h3>
        <div className={`alert ${failed === 0 ? 'success' : 'warn'}`}>
          ✅ 成功导入 {okCount} 个会话{failed > 0 ? `，${failed} 个失败` : ''}。
        </div>
        <div className="alert info">
          <p><b>重启 WorkBuddy</b> 后即可在会话列表看到这些会话（它只在启动时读数据库）。</p>
        </div>
        <table className="sessions">
          <thead>
            <tr><th>结果</th><th>会话</th><th>WorkBuddy 会话 ID</th><th>记录数</th><th>说明</th></tr>
          </thead>
          <tbody>
            {(result?.results ?? []).map((r: any, i: number) => (
              <tr key={i}>
                <td>{r.ok ? '✅' : '❌'}</td>
                <td title={r.sourceSessionId}>{r.sourceSessionId}</td>
                <td className="path" title={r.jsonlPath ?? ''}>
                  {r.workbuddySessionId ? `…${String(r.workbuddySessionId).slice(-8)}` : '—'}
                </td>
                <td>{r.rows ?? 0}</td>
                <td className="reason">{r.error?.message ?? (r.warnings?.[0] ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dialog-footer">
          <div />
          <div>
            <button onClick={onBack}>完成</button>
            <button onClick={() => { setResult(null); setChecked(new Set()); setPhase('pick'); }}>再导一批</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog wide">
      <h3>导出完成</h3>

      <div className={`alert ${failed === 0 ? 'success' : 'warn'}`}>
        ✅ 成功导出 {okCount} 个会话{failed > 0 ? `，${failed} 个失败` : ''}。
      </div>

      <dl className="paths">
        <dt>📁 新文件位置</dt>
        <dd><code>{result?.outDir ?? '(未知)'}</code></dd>
        <dt>🗂 旧版 JSONL 备份位置</dt>
        <dd><code>{result?.backupDir || '(未执行备份)'}</code></dd>
      </dl>

      <div className="alert warn">
        <p><b>⚠️ 请手动将新版 JSONL 复制到 Codex 原目录：</b></p>
        <p><code>%USERPROFILE%\.codex\sessions\YYYY\MM\DD\</code></p>
        <p className="muted">提示：插件不会自动写入 Codex 目录，以免覆盖正在进行的会话。</p>
      </div>

      <div className="alert info">
        <p><b>📌 复制完成后，还需要「注册索引」Codex 才能看到：</b></p>
        <p className="muted">
          Codex 的会话列表读它自己的索引数据库，不扫描目录。把文件复制进去后，点下面的按钮把新会话登记进索引。
          （建议先关闭 Codex，注册后重新打开。）
        </p>
        <div style={{ marginTop: 8 }}>
          <button
            className="primary"
            disabled={registering || registerState === 'done'}
            onClick={doRegister}
          >
            {registering ? '注册中…' : registerState === 'done' ? '✅ 已注册' : '注册到 Codex 索引'}
          </button>
          {registerResult && (
            <span style={{ marginLeft: 12, fontSize: 12 }}>
              新注册 {registerResult.registered?.length ?? 0} 个，已存在 {registerResult.skipped?.length ?? 0} 个
              {registerResult.failed?.length ? `，失败 ${registerResult.failed.length} 个` : ''}
            </span>
          )}
        </div>
        {registerError && <p style={{ color: '#e66', fontSize: 12 }}>注册失败：{registerError}</p>}
      </div>

      <table className="sessions">
        <thead>
          <tr><th>结果</th><th>会话</th><th>行数</th><th>消息</th><th>工具调用</th><th>大小</th><th>说明</th></tr>
        </thead>
        <tbody>
          {(result?.results ?? []).map((r: ExportResult, i: number) => (
            <tr key={i}>
              <td>{r.report?.ok ? '✅' : '❌'}</td>
              <td title={r.sourceSessionId}>{r.sourceSessionId}</td>
              <td>{r.report?.stats.lines ?? 0}</td>
              <td>{r.report?.stats.messages ?? 0}</td>
              <td>{r.report?.stats.toolCalls ?? 0}</td>
              <td>{formatBytes(r.report?.stats.bytes ?? 0)}</td>
              <td className="reason">{r.report?.error?.message ?? (r.report?.warnings?.[0] ?? '—')}</td>
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
