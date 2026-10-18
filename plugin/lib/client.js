/* dsh-codex-bridge — DSH client bundle
 * 由 scripts/build-client.mjs 生成，使用 DSH 的 __ModuleLoader__ 协议。
 * ⚠️ 不要手改；改了 src 后重新执行 npm run build:client
 */
window.__ModuleLoader__.load({
	id: "dsh-codex-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

const jsx4 = react_jsx_runtime["jsx"]; const jsxs4 = react_jsx_runtime["jsxs"];
const jsx3 = react_jsx_runtime["jsx"]; const jsxs3 = react_jsx_runtime["jsxs"];
const useCallback3 = react["useCallback"]; const useEffect3 = react["useEffect"]; const useState3 = react["useState"];
const jsx2 = react_jsx_runtime["jsx"]; const jsxs2 = react_jsx_runtime["jsxs"];
const useCallback2 = react["useCallback"]; const useEffect2 = react["useEffect"]; const useMemo2 = react["useMemo"]; const useState2 = react["useState"];
const jsx = react_jsx_runtime["jsx"]; const jsxs = react_jsx_runtime["jsxs"];
const useCallback = react["useCallback"]; const useEffect = react["useEffect"]; const useMemo = react["useMemo"]; const useState = react["useState"];
const useEffect4 = react["useEffect"]; const useState4 = react["useState"];
// src/client.ts

// src/client/SettingsPage.tsx

// src/client/ImportDialog.tsx

// src/shared/errors.ts
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "\u672A\u77E5\u5927\u5C0F";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// src/client/ImportDialog.tsx

function ImportDialog({ apiBase, onBack }) {
  const [phase, setPhase] = useState("scanning");
  const [sessions, setSessions] = useState([]);
  const [checked, setChecked] = useState(/* @__PURE__ */ new Set());
  const [keyword, setKeyword] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [error, setError] = useState(null);
  const [reports, setReports] = useState([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [skipped, setSkipped] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [targetCwd, setTargetCwd] = useState("");
  const [mode, setMode] = useState("skip");
  const scan = useCallback(async () => {
    setPhase("scanning");
    setError(null);
    try {
      const r = await fetch(`${apiBase}/codex/sessions`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u626B\u63CF\u5931\u8D25");
      setSessions(d.sessions ?? []);
      setSkipped(d.skipped ?? []);
      setPhase("pick");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  }, [apiBase]);
  useEffect(() => {
    void scan();
  }, [scan]);
  const visible = useMemo(() => {
    const from = dateFrom ? Date.parse(dateFrom) : 0;
    const to = dateTo ? Date.parse(dateTo) + 864e5 : Infinity;
    return sessions.filter((s) => (!keyword || s.title.toLowerCase().includes(keyword.toLowerCase()) || s.cwd.toLowerCase().includes(keyword.toLowerCase())) && s.updatedAt >= from && s.updatedAt <= to).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, keyword, dateFrom, dateTo]);
  const toggle = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const goChooseWorkspace = async () => {
    const files = sessions.filter((s) => checked.has(s.filePath));
    if (files.length === 0) {
      setError("\u8BF7\u81F3\u5C11\u52FE\u9009\u4E00\u4E2A\u4F1A\u8BDD\u3002");
      return;
    }
    setError(null);
    try {
      const r = await fetch(`${apiBase}/workspaces`);
      const d = await r.json();
      setWorkspaces(d.workspaces ?? []);
      setTargetCwd("");
      setPhase("chooseWs");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  };
  const confirm = async () => {
    const files = sessions.filter((s) => checked.has(s.filePath)).map((s) => s.filePath);
    if (files.length === 0) {
      setError("\u8BF7\u81F3\u5C11\u52FE\u9009\u4E00\u4E2A\u4F1A\u8BDD\u3002");
      return;
    }
    setPhase("converting");
    setError(null);
    setProgress({ done: 0, total: files.length });
    try {
      const r = await fetch(`${apiBase}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files, mode, targetCwd: targetCwd || void 0 })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u5BFC\u5165\u5931\u8D25");
      setReports(d.results ?? []);
      setProgress({ done: files.length, total: files.length });
      setPhase("done");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  };
  if (phase === "scanning") {
    return /* @__PURE__ */ jsxs("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx("h3", { children: "\u5BFC\u5165 CodeX \u4F1A\u8BDD" }),
      /* @__PURE__ */ jsx("p", { children: "\u6B63\u5728\u626B\u63CF\u672C\u673A Codex \u4F1A\u8BDD\u76EE\u5F55\u2026" }),
      /* @__PURE__ */ jsx("div", { className: "spinner" })
    ] });
  }
  if (phase === "pick") {
    return /* @__PURE__ */ jsxs("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx("h3", { children: "\u5BFC\u5165 CodeX \u4F1A\u8BDD" }),
      /* @__PURE__ */ jsxs("div", { className: "filters", children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            placeholder: "\u6309\u6807\u9898\u6216\u5DE5\u4F5C\u76EE\u5F55\u7B5B\u9009\u2026",
            value: keyword,
            onChange: (e) => setKeyword(e.target.value)
          }
        ),
        /* @__PURE__ */ jsxs("label", { children: [
          "\u4ECE ",
          /* @__PURE__ */ jsx("input", { type: "date", value: dateFrom, onChange: (e) => setDateFrom(e.target.value) })
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          "\u5230 ",
          /* @__PURE__ */ jsx("input", { type: "date", value: dateTo, onChange: (e) => setDateTo(e.target.value) })
        ] }),
        /* @__PURE__ */ jsx("button", { onClick: scan, children: "\u91CD\u65B0\u626B\u63CF" })
      ] }),
      skipped.length > 0 && /* @__PURE__ */ jsxs("div", { className: "alert warn", children: [
        "\u6709 ",
        skipped.length,
        " \u4E2A\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u5DF2\u8DF3\u8FC7\uFF08\u793A\u4F8B\uFF1A",
        skipped[0].reason,
        "\uFF09"
      ] }),
      /* @__PURE__ */ jsxs("table", { className: "sessions", children: [
        /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("th", { style: { width: 32 } }),
          /* @__PURE__ */ jsx("th", { children: "\u6807\u9898" }),
          /* @__PURE__ */ jsx("th", { children: "\u5DE5\u4F5C\u76EE\u5F55" }),
          /* @__PURE__ */ jsx("th", { children: "\u66F4\u65B0\u65F6\u95F4" }),
          /* @__PURE__ */ jsx("th", { children: "\u5927\u5C0F" }),
          /* @__PURE__ */ jsx("th", { children: "\u8F6E\u6B21" }),
          /* @__PURE__ */ jsx("th", { children: "\u7C7B\u578B" })
        ] }) }),
        /* @__PURE__ */ jsx("tbody", { children: visible.map((s) => /* @__PURE__ */ jsxs("tr", { className: checked.has(s.filePath) ? "checked" : "", children: [
          /* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: checked.has(s.filePath),
              onChange: () => toggle(s.filePath)
            }
          ) }),
          /* @__PURE__ */ jsx("td", { title: s.title, children: s.title }),
          /* @__PURE__ */ jsx("td", { className: "path", title: s.cwd, children: s.cwd }),
          /* @__PURE__ */ jsx("td", { children: new Date(s.updatedAt).toLocaleString() }),
          /* @__PURE__ */ jsx("td", { children: formatBytes(s.sizeBytes) }),
          /* @__PURE__ */ jsx("td", { children: s.turnCount }),
          /* @__PURE__ */ jsx("td", { children: s.isSubagent ? /* @__PURE__ */ jsx("span", { className: "tag sub", title: s.agentPath, children: "\u5B50\u4EE3\u7406" }) : /* @__PURE__ */ jsx("span", { className: "tag", children: "\u4E3B\u4F1A\u8BDD" }) })
        ] }, s.filePath)) })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsxs("span", { children: [
          "\u5171 ",
          visible.length,
          " \u4E2A\u4F1A\u8BDD\uFF0C\u5DF2\u9009 ",
          checked.size,
          " \u4E2A"
        ] }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("button", { onClick: onBack, children: "\u53D6\u6D88" }),
          /* @__PURE__ */ jsx("button", { className: "primary", disabled: checked.size === 0, onClick: goChooseWorkspace, children: "\u4E0B\u4E00\u6B65\uFF1A\u9009\u62E9\u76EE\u6807\u5DE5\u4F5C\u533A" })
        ] })
      ] }),
      error && /* @__PURE__ */ jsx("div", { className: "alert error", children: error })
    ] });
  }
  if (phase === "chooseWs") {
    return /* @__PURE__ */ jsxs("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx("h3", { children: "\u9009\u62E9\u76EE\u6807\u5DE5\u4F5C\u533A" }),
      /* @__PURE__ */ jsxs("p", { className: "muted", children: [
        "\u5DF2\u52FE\u9009 ",
        checked.size,
        " \u4E2A\u4F1A\u8BDD\u3002\u5BFC\u5165\u7684\u4F1A\u8BDD\u4F1A\u5F52\u5C5E\u5230\u4E0B\u9762\u9009\u4E2D\u7684 DSH \u5DE5\u4F5C\u533A\uFF0C\u5E76\u51FA\u73B0\u5728\u5BF9\u5E94\u804A\u5929\u5217\u8868\u3002"
      ] }),
      /* @__PURE__ */ jsxs("table", { className: "sessions", children: [
        /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("th", { style: { width: 32 } }),
          /* @__PURE__ */ jsx("th", { children: "\u5DE5\u4F5C\u533A" }),
          /* @__PURE__ */ jsx("th", { children: "\u8DEF\u5F84" }),
          /* @__PURE__ */ jsx("th", { children: "\u5DF2\u6709\u4F1A\u8BDD\u6570" })
        ] }) }),
        /* @__PURE__ */ jsxs("tbody", { children: [
          workspaces.map((ws) => /* @__PURE__ */ jsxs("tr", { className: targetCwd === ws.path ? "checked" : "", children: [
            /* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx(
              "input",
              {
                type: "radio",
                name: "targetCwd",
                checked: targetCwd === ws.path,
                onChange: () => setTargetCwd(ws.path)
              }
            ) }),
            /* @__PURE__ */ jsx("td", { children: ws.title }),
            /* @__PURE__ */ jsx("td", { className: "path", title: ws.path, children: ws.path }),
            /* @__PURE__ */ jsx("td", { children: ws.sessionCount })
          ] }, ws.path)),
          workspaces.length === 0 && /* @__PURE__ */ jsx("tr", { children: /* @__PURE__ */ jsx("td", { colSpan: 4, className: "muted", children: "\u672A\u627E\u5230\u73B0\u6709\u5DE5\u4F5C\u533A\u3002\u8BF7\u5728\u4E0B\u65B9\u8F93\u5165\u76EE\u6807\u8DEF\u5F84\uFF0C\u6216\u5148\u5728 DSH \u4E2D\u6253\u5F00\u4E00\u4E2A\u9879\u76EE\u3002" }) })
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "filters", children: /* @__PURE__ */ jsx(
        "input",
        {
          placeholder: "\u6216\u624B\u52A8\u8F93\u5165\u76EE\u6807\u5DE5\u4F5C\u533A\u7EDD\u5BF9\u8DEF\u5F84\u2026",
          value: targetCwd,
          onChange: (e) => setTargetCwd(e.target.value)
        }
      ) }),
      /* @__PURE__ */ jsxs("div", { className: "filters", children: [
        /* @__PURE__ */ jsx("span", { className: "muted", children: "\u5DF2\u5B58\u5728\u540C\u540D\u4F1A\u8BDD\u65F6\uFF1A" }),
        /* @__PURE__ */ jsxs("label", { children: [
          /* @__PURE__ */ jsx("input", { type: "radio", name: "mode", checked: mode === "skip", onChange: () => setMode("skip") }),
          "\u8DF3\u8FC7"
        ] }),
        /* @__PURE__ */ jsxs("label", { children: [
          /* @__PURE__ */ jsx("input", { type: "radio", name: "mode", checked: mode === "overwrite", onChange: () => setMode("overwrite") }),
          "\u8986\u76D6"
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx("div", {}),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("button", { onClick: () => setPhase("pick"), children: "\u8FD4\u56DE" }),
          /* @__PURE__ */ jsx("button", { className: "primary", disabled: !targetCwd.trim(), onClick: confirm, children: "\u5F00\u59CB\u5BFC\u5165" })
        ] })
      ] }),
      error && /* @__PURE__ */ jsx("div", { className: "alert error", children: error })
    ] });
  }
  if (phase === "converting") {
    return /* @__PURE__ */ jsxs("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx("h3", { children: "\u6B63\u5728\u5BFC\u5165\u2026" }),
      /* @__PURE__ */ jsxs("p", { children: [
        "\u5DF2\u5904\u7406 ",
        progress.done,
        " / ",
        progress.total
      ] }),
      /* @__PURE__ */ jsx("div", { className: "progress", children: /* @__PURE__ */ jsx("div", { style: { width: `${progress.total ? progress.done / progress.total * 100 : 0}%` } }) })
    ] });
  }
  if (phase === "error") {
    return /* @__PURE__ */ jsxs("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx("h3", { children: "\u5BFC\u5165\u5931\u8D25" }),
      /* @__PURE__ */ jsx("div", { className: "alert error", children: error }),
      /* @__PURE__ */ jsxs("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx("button", { onClick: onBack, children: "\u8FD4\u56DE" }),
        /* @__PURE__ */ jsx("button", { onClick: scan, children: "\u91CD\u8BD5" })
      ] })
    ] });
  }
  const okCount = reports.filter((r) => r.ok).length;
  const failCount = reports.length - okCount;
  const totalEncrypted = reports.reduce((n, r) => n + r.stats.encryptedBlocks, 0);
  return /* @__PURE__ */ jsxs("div", { className: "dialog wide", children: [
    /* @__PURE__ */ jsx("h3", { children: "\u5BFC\u5165\u5B8C\u6210" }),
    /* @__PURE__ */ jsxs("div", { className: `alert ${failCount === 0 ? "success" : "warn"}`, children: [
      "\u6210\u529F\u5BFC\u5165 ",
      okCount,
      " \u4E2A\u4F1A\u8BDD",
      failCount > 0 ? `\uFF0C${failCount} \u4E2A\u5931\u8D25` : "",
      "\u3002 \u73B0\u5728\u53EF\u4EE5\u76F4\u63A5\u5728 DeepSeek Harness \u7684\u4F1A\u8BDD\u5217\u8868\u4E2D\u6253\u5F00\u5E76\u7EE7\u7EED\u5BF9\u8BDD\u3002"
    ] }),
    totalEncrypted > 0 && /* @__PURE__ */ jsxs("div", { className: "alert info", children: [
      "\u26A0\uFE0F \u5171 ",
      totalEncrypted,
      " \u5904\u52A0\u5BC6\u5185\u5BB9\u65E0\u6CD5\u89E3\u7801\uFF0C\u5DF2\u4EE5\u300C[\u52A0\u5BC6\u5185\u5BB9 \xB7 \u65E0\u6CD5\u89E3\u7801]\u300D\u5360\u4F4D\uFF0C \u4E0D\u5F71\u54CD\u4F1A\u8BDD\u6B63\u5E38\u4F7F\u7528\u3002"
    ] }),
    /* @__PURE__ */ jsxs("table", { className: "sessions", children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("th", { children: "\u7ED3\u679C" }),
        /* @__PURE__ */ jsx("th", { children: "\u4F1A\u8BDD" }),
        /* @__PURE__ */ jsx("th", { children: "\u8F6E\u6B21" }),
        /* @__PURE__ */ jsx("th", { children: "\u6D88\u606F" }),
        /* @__PURE__ */ jsx("th", { children: "\u5DE5\u5177\u8C03\u7528" }),
        /* @__PURE__ */ jsx("th", { children: "\u8BF4\u660E" })
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: reports.map((r, i) => /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("td", { children: r.ok ? "\u2705" : "\u274C" }),
        /* @__PURE__ */ jsx("td", { title: r.sourceFile, children: r.sourceId || "(\u672A\u77E5)" }),
        /* @__PURE__ */ jsx("td", { children: r.stats.turns }),
        /* @__PURE__ */ jsx("td", { children: r.stats.messages }),
        /* @__PURE__ */ jsx("td", { children: r.stats.toolCalls }),
        /* @__PURE__ */ jsx("td", { className: "reason", children: r.ok ? r.warnings.length ? r.warnings[0] : "\u2014" : r.error?.message ?? "\u672A\u77E5\u9519\u8BEF" })
      ] }, i)) })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "dialog-footer", children: [
      /* @__PURE__ */ jsx("div", {}),
      /* @__PURE__ */ jsx("button", { className: "primary", onClick: onBack, children: "\u5B8C\u6210" })
    ] })
  ] });
}

// src/client/ExportDialog.tsx


function ExportDialog({ apiBase, onBack }) {
  const [phase, setPhase] = useState2("loading");
  const [sessions, setSessions] = useState2([]);
  const [checked, setChecked] = useState2(/* @__PURE__ */ new Set());
  const [keyword, setKeyword] = useState2("");
  const [error, setError] = useState2(null);
  const [result, setResult] = useState2(null);
  const [target, setTarget] = useState2("codex");
  const [registering, setRegistering] = useState2(false);
  const [registerState, setRegisterState] = useState2("idle");
  const [registerResult, setRegisterResult] = useState2(null);
  const [registerError, setRegisterError] = useState2(null);
  const doRegister = useCallback2(async () => {
    setRegistering(true);
    setRegisterError(null);
    try {
      const r = await fetch(`${apiBase}/register-codex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 不传 files：后端扫描 Codex sessions 目录下所有 rollout，补齐未注册的
        body: JSON.stringify({})
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u6CE8\u518C\u5931\u8D25");
      setRegisterResult(d);
      setRegisterState("done");
    } catch (e) {
      setRegisterError(String(e?.message ?? e));
    } finally {
      setRegistering(false);
    }
  }, [apiBase]);
  const load = useCallback2(async () => {
    setPhase("loading");
    try {
      const r = await fetch(`${apiBase}/dsh/sessions`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u52A0\u8F7D\u5931\u8D25");
      setSessions(d.sessions ?? []);
      setChecked(/* @__PURE__ */ new Set());
      setPhase("pick");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  }, [apiBase]);
  useEffect2(() => {
    void load();
  }, [load]);
  const visible = useMemo2(
    () => sessions.filter((s) => !keyword || s.title.toLowerCase().includes(keyword.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, keyword]
  );
  const toggle = (id) => {
    setChecked((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const doExport = async () => {
    if (checked.size === 0) {
      setError("\u8BF7\u81F3\u5C11\u52FE\u9009\u4E00\u4E2A\u4F1A\u8BDD\u3002");
      return;
    }
    setPhase("exporting");
    setError(null);
    try {
      const endpoint = target === "workbuddy" ? "/export-workbuddy" : "/export";
      const body = target === "workbuddy" ? { sessionIds: [...checked] } : { sessionIds: [...checked], doBackup: true };
      const r = await fetch(`${apiBase}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u5BFC\u51FA\u5931\u8D25");
      setResult(d);
      setPhase("done");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  };
  if (phase === "loading") {
    return /* @__PURE__ */ jsxs2("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx2("h3", { children: "\u5BFC\u51FA\u4F1A\u8BDD" }),
      /* @__PURE__ */ jsx2("p", { children: "\u6B63\u5728\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u2026" }),
      /* @__PURE__ */ jsx2("div", { className: "spinner" })
    ] });
  }
  if (phase === "exporting") {
    return /* @__PURE__ */ jsxs2("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx2("h3", { children: target === "workbuddy" ? "\u6B63\u5728\u5BFC\u5165 WorkBuddy\u2026" : "\u6B63\u5728\u5BFC\u51FA\u2026" }),
      /* @__PURE__ */ jsx2("p", { children: target === "workbuddy" ? "\u6B63\u5728\u8F6C\u6362\u5E76\u5199\u5165 WorkBuddy \u672C\u5730\u5B58\u50A8\uFF0C\u8BF7\u7A0D\u5019\u3002" : "\u6B63\u5728\u8F6C\u6362\u5E76\u5907\u4EFD Codex \u76EE\u5F55\u4E2D\u7684\u65E7\u6587\u4EF6\uFF0C\u8BF7\u7A0D\u5019\u3002" }),
      /* @__PURE__ */ jsx2("div", { className: "spinner" })
    ] });
  }
  if (phase === "error") {
    return /* @__PURE__ */ jsxs2("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx2("h3", { children: "\u5BFC\u51FA\u5931\u8D25" }),
      /* @__PURE__ */ jsx2("div", { className: "alert error", children: error }),
      /* @__PURE__ */ jsxs2("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx2("button", { onClick: onBack, children: "\u8FD4\u56DE" }),
        /* @__PURE__ */ jsx2("button", { className: "primary", onClick: load, children: "\u91CD\u8BD5" })
      ] })
    ] });
  }
  if (phase === "pick") {
    return /* @__PURE__ */ jsxs2("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx2("h3", { children: "\u5BFC\u51FA\u4F1A\u8BDD" }),
      /* @__PURE__ */ jsxs2("div", { className: "filters", style: { gap: 16 }, children: [
        /* @__PURE__ */ jsx2("span", { className: "muted", children: "\u5BFC\u51FA\u76EE\u6807\uFF1A" }),
        /* @__PURE__ */ jsxs2("label", { children: [
          /* @__PURE__ */ jsx2("input", { type: "radio", name: "target", checked: target === "codex", onChange: () => setTarget("codex") }),
          "Codex\uFF08\u751F\u6210 JSONL\uFF0C\u9700\u624B\u52A8\u590D\u5236\uFF09"
        ] }),
        /* @__PURE__ */ jsxs2("label", { children: [
          /* @__PURE__ */ jsx2("input", { type: "radio", name: "target", checked: target === "workbuddy", onChange: () => setTarget("workbuddy") }),
          "WorkBuddy\uFF08\u76F4\u63A5\u5199\u5165\u672C\u5730\uFF0C\u91CD\u542F\u5373\u53EF\u89C1\uFF09"
        ] })
      ] }),
      /* @__PURE__ */ jsxs2("p", { className: "muted", children: [
        "\u9009\u62E9\u8981\u5BFC\u51FA\u7684\u4F1A\u8BDD\uFF08\u53EF\u591A\u9009\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u5168\u9009\uFF09\u3002",
        /* @__PURE__ */ jsx2("br", {}),
        /* @__PURE__ */ jsxs2("span", { style: { fontSize: 12 }, children: [
          "\u63D0\u793A\uFF1ADSH \u6309\u300C\u9996\u6761\u6D88\u606F\u300D\u81EA\u52A8\u547D\u540D\uFF0C\u56E0\u6B64",
          /* @__PURE__ */ jsx2("strong", { children: "\u540C\u540D\u4E0D\u4EE3\u8868\u91CD\u590D" }),
          "\u3002\u8BF7\u7528\u300C\u4F1A\u8BDD ID\u300D\u548C\u66F4\u65B0\u65F6\u95F4\u533A\u5206\u3002"
        ] })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "filters", children: [
        /* @__PURE__ */ jsx2("input", { placeholder: "\u6309\u6807\u9898\u7B5B\u9009\u2026", value: keyword, onChange: (e) => setKeyword(e.target.value) }),
        /* @__PURE__ */ jsx2("button", { onClick: load, children: "\u5237\u65B0" })
      ] }),
      /* @__PURE__ */ jsxs2("table", { className: "sessions", children: [
        /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
          /* @__PURE__ */ jsx2("th", { style: { width: 32 } }),
          /* @__PURE__ */ jsx2("th", { children: "\u6807\u9898" }),
          /* @__PURE__ */ jsx2("th", { children: "\u4F1A\u8BDD ID" }),
          /* @__PURE__ */ jsx2("th", { children: "\u6700\u540E\u66F4\u65B0" }),
          /* @__PURE__ */ jsx2("th", { children: "\u8F6E\u6B21" }),
          /* @__PURE__ */ jsx2("th", { children: "\u5927\u5C0F" })
        ] }) }),
        /* @__PURE__ */ jsx2("tbody", { children: visible.map((s) => /* @__PURE__ */ jsxs2("tr", { className: checked.has(s.id) ? "checked" : "", children: [
          /* @__PURE__ */ jsx2("td", { children: /* @__PURE__ */ jsx2("input", { type: "checkbox", checked: checked.has(s.id), onChange: () => toggle(s.id) }) }),
          /* @__PURE__ */ jsx2("td", { title: s.title, children: s.title }),
          /* @__PURE__ */ jsxs2("td", { className: "path", title: `${s.id}
\u9879\u76EE\uFF1A${s.project}`, children: [
            "\u2026",
            s.id.slice(-8)
          ] }),
          /* @__PURE__ */ jsx2("td", { children: new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false }) }),
          /* @__PURE__ */ jsx2("td", { children: s.turns }),
          /* @__PURE__ */ jsx2("td", { children: formatBytes(s.sizeBytes) })
        ] }, s.id)) })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsxs2("span", { children: [
          "\u5171 ",
          visible.length,
          " \u4E2A\u4F1A\u8BDD\uFF0C\u5DF2\u9009 ",
          checked.size,
          " \u4E2A"
        ] }),
        /* @__PURE__ */ jsxs2("div", { children: [
          /* @__PURE__ */ jsx2("button", { onClick: onBack, children: "\u53D6\u6D88" }),
          /* @__PURE__ */ jsx2("button", { className: "primary", disabled: checked.size === 0, onClick: () => setPhase("confirm"), children: "\u4E0B\u4E00\u6B65" })
        ] })
      ] }),
      error && /* @__PURE__ */ jsx2("div", { className: "alert error", children: error })
    ] });
  }
  if (phase === "confirm") {
    return /* @__PURE__ */ jsxs2("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx2("h3", { children: "\u786E\u8BA4\u5BFC\u51FA" }),
      /* @__PURE__ */ jsxs2("div", { className: "alert info", children: [
        /* @__PURE__ */ jsxs2("p", { children: [
          "\u5373\u5C06\u5BFC\u51FA ",
          /* @__PURE__ */ jsx2("b", { children: checked.size }),
          " \u4E2A\u4F1A\u8BDD\u5230 ",
          /* @__PURE__ */ jsx2("b", { children: target === "workbuddy" ? "WorkBuddy" : "Codex" }),
          "\u3002"
        ] }),
        target === "workbuddy" ? /* @__PURE__ */ jsxs2("ul", { children: [
          /* @__PURE__ */ jsx2("li", { children: "\u4F1A\u76F4\u63A5\u5199\u5165 WorkBuddy \u672C\u5730\u5B58\u50A8\uFF08\u6570\u636E\u5E93 + \u4F1A\u8BDD\u6587\u4EF6\uFF09\u3002" }),
          /* @__PURE__ */ jsx2("li", { children: "\u5199\u5165\u524D\u4F1A\u81EA\u52A8\u5907\u4EFD WorkBuddy \u7684\u6570\u636E\u5E93\u3002" }),
          /* @__PURE__ */ jsxs2("li", { children: [
            "\u5B8C\u6210\u540E",
            /* @__PURE__ */ jsx2("b", { children: "\u91CD\u542F WorkBuddy" }),
            "\u5373\u53EF\u5728\u4F1A\u8BDD\u5217\u8868\u770B\u5230\u3002"
          ] })
        ] }) : /* @__PURE__ */ jsxs2("ul", { children: [
          /* @__PURE__ */ jsx2("li", { children: "\u4F1A\u5BFC\u51FA\u4E3A OpenAI \u517C\u5BB9 JSONL \u5230\u53D7\u63A7\u76EE\u5F55\u3002" }),
          /* @__PURE__ */ jsxs2("li", { children: [
            "\u5BFC\u51FA\u524D\u4F1A\u81EA\u52A8",
            /* @__PURE__ */ jsx2("b", { children: "\u5907\u4EFD" }),
            " Codex \u76EE\u5F55\u4E2D\u7684\u65E7\u7248 JSONL\u3002"
          ] }),
          /* @__PURE__ */ jsxs2("li", { children: [
            "\u63D2\u4EF6",
            /* @__PURE__ */ jsx2("b", { children: "\u4E0D\u4F1A" }),
            "\u76F4\u63A5\u5199\u5165 Codex \u4F1A\u8BDD\u76EE\u5F55\uFF0C\u907F\u514D\u7834\u574F\u6B63\u5728\u8FDB\u884C\u7684\u4F1A\u8BDD\u3002"
          ] }),
          /* @__PURE__ */ jsx2("li", { children: "\u5BFC\u51FA\u540E\u9700\u624B\u52A8\u590D\u5236\u5230 Codex \u539F\u76EE\u5F55\uFF0C\u5E76\u70B9\u300C\u6CE8\u518C\u5230 Codex \u7D22\u5F15\u300D\u3002" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx2("div", {}),
        /* @__PURE__ */ jsxs2("div", { children: [
          /* @__PURE__ */ jsx2("button", { onClick: () => setPhase("pick"), children: "\u8FD4\u56DE" }),
          /* @__PURE__ */ jsx2("button", { className: "primary", onClick: doExport, children: "\u786E\u8BA4\u5BFC\u51FA" })
        ] })
      ] })
    ] });
  }
  const okCount = result?.succ ?? 0;
  const failed = result?.failed ?? 0;
  if (target === "workbuddy") {
    return /* @__PURE__ */ jsxs2("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx2("h3", { children: "\u5DF2\u5BFC\u5165 WorkBuddy" }),
      /* @__PURE__ */ jsxs2("div", { className: `alert ${failed === 0 ? "success" : "warn"}`, children: [
        "\u2705 \u6210\u529F\u5BFC\u5165 ",
        okCount,
        " \u4E2A\u4F1A\u8BDD",
        failed > 0 ? `\uFF0C${failed} \u4E2A\u5931\u8D25` : "",
        "\u3002"
      ] }),
      /* @__PURE__ */ jsx2("div", { className: "alert info", children: /* @__PURE__ */ jsxs2("p", { children: [
        /* @__PURE__ */ jsx2("b", { children: "\u91CD\u542F WorkBuddy" }),
        " \u540E\u5373\u53EF\u5728\u4F1A\u8BDD\u5217\u8868\u770B\u5230\u8FD9\u4E9B\u4F1A\u8BDD\uFF08\u5B83\u53EA\u5728\u542F\u52A8\u65F6\u8BFB\u6570\u636E\u5E93\uFF09\u3002"
      ] }) }),
      /* @__PURE__ */ jsxs2("table", { className: "sessions", children: [
        /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
          /* @__PURE__ */ jsx2("th", { children: "\u7ED3\u679C" }),
          /* @__PURE__ */ jsx2("th", { children: "\u4F1A\u8BDD" }),
          /* @__PURE__ */ jsx2("th", { children: "WorkBuddy \u4F1A\u8BDD ID" }),
          /* @__PURE__ */ jsx2("th", { children: "\u8BB0\u5F55\u6570" }),
          /* @__PURE__ */ jsx2("th", { children: "\u8BF4\u660E" })
        ] }) }),
        /* @__PURE__ */ jsx2("tbody", { children: (result?.results ?? []).map((r, i) => /* @__PURE__ */ jsxs2("tr", { children: [
          /* @__PURE__ */ jsx2("td", { children: r.ok ? "\u2705" : "\u274C" }),
          /* @__PURE__ */ jsx2("td", { title: r.sourceSessionId, children: r.sourceSessionId }),
          /* @__PURE__ */ jsx2("td", { className: "path", title: r.jsonlPath ?? "", children: r.workbuddySessionId ? `\u2026${String(r.workbuddySessionId).slice(-8)}` : "\u2014" }),
          /* @__PURE__ */ jsx2("td", { children: r.rows ?? 0 }),
          /* @__PURE__ */ jsx2("td", { className: "reason", children: r.error?.message ?? (r.warnings?.[0] ?? "\u2014") })
        ] }, i)) })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx2("div", {}),
        /* @__PURE__ */ jsxs2("div", { children: [
          /* @__PURE__ */ jsx2("button", { onClick: onBack, children: "\u5B8C\u6210" }),
          /* @__PURE__ */ jsx2("button", { onClick: () => {
            setResult(null);
            setChecked(/* @__PURE__ */ new Set());
            setPhase("pick");
          }, children: "\u518D\u5BFC\u4E00\u6279" })
        ] })
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxs2("div", { className: "dialog wide", children: [
    /* @__PURE__ */ jsx2("h3", { children: "\u5BFC\u51FA\u5B8C\u6210" }),
    /* @__PURE__ */ jsxs2("div", { className: `alert ${failed === 0 ? "success" : "warn"}`, children: [
      "\u2705 \u6210\u529F\u5BFC\u51FA ",
      okCount,
      " \u4E2A\u4F1A\u8BDD",
      failed > 0 ? `\uFF0C${failed} \u4E2A\u5931\u8D25` : "",
      "\u3002"
    ] }),
    /* @__PURE__ */ jsxs2("dl", { className: "paths", children: [
      /* @__PURE__ */ jsx2("dt", { children: "\u{1F4C1} \u65B0\u6587\u4EF6\u4F4D\u7F6E" }),
      /* @__PURE__ */ jsx2("dd", { children: /* @__PURE__ */ jsx2("code", { children: result?.outDir ?? "(\u672A\u77E5)" }) }),
      /* @__PURE__ */ jsx2("dt", { children: "\u{1F5C2} \u65E7\u7248 JSONL \u5907\u4EFD\u4F4D\u7F6E" }),
      /* @__PURE__ */ jsx2("dd", { children: /* @__PURE__ */ jsx2("code", { children: result?.backupDir || "(\u672A\u6267\u884C\u5907\u4EFD)" }) })
    ] }),
    /* @__PURE__ */ jsxs2("div", { className: "alert warn", children: [
      /* @__PURE__ */ jsx2("p", { children: /* @__PURE__ */ jsx2("b", { children: "\u26A0\uFE0F \u8BF7\u624B\u52A8\u5C06\u65B0\u7248 JSONL \u590D\u5236\u5230 Codex \u539F\u76EE\u5F55\uFF1A" }) }),
      /* @__PURE__ */ jsx2("p", { children: /* @__PURE__ */ jsx2("code", { children: "%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\" }) }),
      /* @__PURE__ */ jsx2("p", { className: "muted", children: "\u63D0\u793A\uFF1A\u63D2\u4EF6\u4E0D\u4F1A\u81EA\u52A8\u5199\u5165 Codex \u76EE\u5F55\uFF0C\u4EE5\u514D\u8986\u76D6\u6B63\u5728\u8FDB\u884C\u7684\u4F1A\u8BDD\u3002" })
    ] }),
    /* @__PURE__ */ jsxs2("div", { className: "alert info", children: [
      /* @__PURE__ */ jsx2("p", { children: /* @__PURE__ */ jsx2("b", { children: "\u{1F4CC} \u590D\u5236\u5B8C\u6210\u540E\uFF0C\u8FD8\u9700\u8981\u300C\u6CE8\u518C\u7D22\u5F15\u300DCodex \u624D\u80FD\u770B\u5230\uFF1A" }) }),
      /* @__PURE__ */ jsx2("p", { className: "muted", children: "Codex \u7684\u4F1A\u8BDD\u5217\u8868\u8BFB\u5B83\u81EA\u5DF1\u7684\u7D22\u5F15\u6570\u636E\u5E93\uFF0C\u4E0D\u626B\u63CF\u76EE\u5F55\u3002\u628A\u6587\u4EF6\u590D\u5236\u8FDB\u53BB\u540E\uFF0C\u70B9\u4E0B\u9762\u7684\u6309\u94AE\u628A\u65B0\u4F1A\u8BDD\u767B\u8BB0\u8FDB\u7D22\u5F15\u3002 \uFF08\u5EFA\u8BAE\u5148\u5173\u95ED Codex\uFF0C\u6CE8\u518C\u540E\u91CD\u65B0\u6253\u5F00\u3002\uFF09" }),
      /* @__PURE__ */ jsxs2("div", { style: { marginTop: 8 }, children: [
        /* @__PURE__ */ jsx2(
          "button",
          {
            className: "primary",
            disabled: registering || registerState === "done",
            onClick: doRegister,
            children: registering ? "\u6CE8\u518C\u4E2D\u2026" : registerState === "done" ? "\u2705 \u5DF2\u6CE8\u518C" : "\u6CE8\u518C\u5230 Codex \u7D22\u5F15"
          }
        ),
        registerResult && /* @__PURE__ */ jsxs2("span", { style: { marginLeft: 12, fontSize: 12 }, children: [
          "\u65B0\u6CE8\u518C ",
          registerResult.registered?.length ?? 0,
          " \u4E2A\uFF0C\u5DF2\u5B58\u5728 ",
          registerResult.skipped?.length ?? 0,
          " \u4E2A",
          registerResult.failed?.length ? `\uFF0C\u5931\u8D25 ${registerResult.failed.length} \u4E2A` : ""
        ] })
      ] }),
      registerError && /* @__PURE__ */ jsxs2("p", { style: { color: "#e66", fontSize: 12 }, children: [
        "\u6CE8\u518C\u5931\u8D25\uFF1A",
        registerError
      ] })
    ] }),
    /* @__PURE__ */ jsxs2("table", { className: "sessions", children: [
      /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
        /* @__PURE__ */ jsx2("th", { children: "\u7ED3\u679C" }),
        /* @__PURE__ */ jsx2("th", { children: "\u4F1A\u8BDD" }),
        /* @__PURE__ */ jsx2("th", { children: "\u884C\u6570" }),
        /* @__PURE__ */ jsx2("th", { children: "\u6D88\u606F" }),
        /* @__PURE__ */ jsx2("th", { children: "\u5DE5\u5177\u8C03\u7528" }),
        /* @__PURE__ */ jsx2("th", { children: "\u5927\u5C0F" }),
        /* @__PURE__ */ jsx2("th", { children: "\u8BF4\u660E" })
      ] }) }),
      /* @__PURE__ */ jsx2("tbody", { children: (result?.results ?? []).map((r, i) => /* @__PURE__ */ jsxs2("tr", { children: [
        /* @__PURE__ */ jsx2("td", { children: r.report?.ok ? "\u2705" : "\u274C" }),
        /* @__PURE__ */ jsx2("td", { title: r.sourceSessionId, children: r.sourceSessionId }),
        /* @__PURE__ */ jsx2("td", { children: r.report?.stats.lines ?? 0 }),
        /* @__PURE__ */ jsx2("td", { children: r.report?.stats.messages ?? 0 }),
        /* @__PURE__ */ jsx2("td", { children: r.report?.stats.toolCalls ?? 0 }),
        /* @__PURE__ */ jsx2("td", { children: formatBytes(r.report?.stats.bytes ?? 0) }),
        /* @__PURE__ */ jsx2("td", { className: "reason", children: r.report?.error?.message ?? (r.report?.warnings?.[0] ?? "\u2014") })
      ] }, i)) })
    ] }),
    /* @__PURE__ */ jsxs2("div", { className: "dialog-footer", children: [
      /* @__PURE__ */ jsx2("div", {}),
      /* @__PURE__ */ jsx2("button", { className: "primary", onClick: onBack, children: "\u5B8C\u6210" })
    ] })
  ] });
}

// src/client/LogPanel.tsx


var OP_LABEL = {
  import: "\u5BFC\u5165",
  export: "\u5BFC\u51FA",
  backup: "\u5907\u4EFD",
  scan: "\u626B\u63CF",
  error: "\u9519\u8BEF"
};
var PHASE_ICON = { start: "\u23F3", ok: "\u2705", fail: "\u274C" };
function LogPanel({ apiBase }) {
  const [open, setOpen] = useState3(false);
  const [logs, setLogs] = useState3([]);
  const [loading, setLoading] = useState3(false);
  const load = useCallback3(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiBase}/logs?limit=100`);
      const d = await r.json();
      if (d.ok) setLogs(d.logs ?? []);
    } catch {
    }
    setLoading(false);
  }, [apiBase]);
  useEffect3(() => {
    if (open) void load();
  }, [open, load]);
  return /* @__PURE__ */ jsxs3("div", { className: "log-panel", children: [
    /* @__PURE__ */ jsx3("button", { className: "link", onClick: () => setOpen((v) => !v), children: open ? "\u6536\u8D77\u64CD\u4F5C\u65E5\u5FD7" : "\u67E5\u770B\u64CD\u4F5C\u65E5\u5FD7" }),
    open && /* @__PURE__ */ jsxs3("div", { className: "log-body", children: [
      /* @__PURE__ */ jsxs3("div", { className: "log-header", children: [
        /* @__PURE__ */ jsx3("span", { children: "\u6700\u8FD1 100 \u6761\u8BB0\u5F55" }),
        /* @__PURE__ */ jsx3("button", { onClick: load, disabled: loading, children: loading ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0" })
      ] }),
      logs.length === 0 && /* @__PURE__ */ jsx3("p", { className: "muted", children: "\u6682\u65E0\u8BB0\u5F55\u3002" }),
      /* @__PURE__ */ jsx3("ul", { children: logs.map((l) => /* @__PURE__ */ jsxs3("li", { className: l.phase, children: [
        /* @__PURE__ */ jsx3("span", { className: "time", children: new Date(l.at).toLocaleString() }),
        /* @__PURE__ */ jsxs3("span", { className: "op", children: [
          PHASE_ICON[l.phase] ?? "",
          " ",
          OP_LABEL[l.op] ?? l.op
        ] }),
        /* @__PURE__ */ jsx3("span", { className: "msg", children: l.message }),
        l.sessionId && /* @__PURE__ */ jsx3("span", { className: "sid", children: l.sessionId })
      ] }, l.id)) })
    ] })
  ] });
}

// src/io/adapter.ts
function detectRuntime() {
  const g = globalThis;
  const loc = g.location;
  if (loc && typeof loc.protocol === "string") {
    if (loc.protocol === "dsh-app:" || loc.protocol === "file:") return "desktop";
  }
  if (typeof g.process !== "undefined" && g.process?.versions?.electron) return "desktop";
  return "web";
}

// src/client/SettingsPage.tsx

function CodexBridgeSettings({ apiBase = "/plugins/dsh-codex-bridge" }) {
  const runtime = detectRuntime();
  const [view, setView] = useState4("home");
  const [status, setStatus] = useState4(null);
  const [error, setError] = useState4(null);
  useEffect4(() => {
    fetch(`${apiBase}/status`).then((r) => r.json()).then((d) => {
      if (d.ok) setStatus(d);
    }).catch(() => setError("\u65E0\u6CD5\u8FDE\u63A5\u5230\u63D2\u4EF6\u670D\u52A1\uFF0C\u8BF7\u786E\u8BA4 DSH \u6B63\u5728\u8FD0\u884C\u3002"));
  }, [apiBase]);
  if (view === "import") {
    return /* @__PURE__ */ jsx4(ImportDialog, { apiBase, onBack: () => setView("home") });
  }
  if (view === "export") {
    return /* @__PURE__ */ jsx4(ExportDialog, { apiBase, onBack: () => setView("home") });
  }
  return /* @__PURE__ */ jsxs4("div", { className: "codex-bridge-settings", children: [
    /* @__PURE__ */ jsx4("h2", { children: "Codex \u4F1A\u8BDD\u6865\u63A5" }),
    /* @__PURE__ */ jsx4("p", { className: "muted", children: "\u6253\u901A Codex \u4E0E DeepSeek Harness \u7684\u4F1A\u8BDD\u6570\u636E\uFF0C\u652F\u6301\u53CC\u5411\u5BFC\u5165\u5BFC\u51FA\u3002" }),
    /* @__PURE__ */ jsx4("div", { className: "env-badge desktop", children: runtime === "desktop" ? "\u684C\u9762\u7AEF\uFF1A\u53EF\u626B\u63CF\u672C\u673A Codex \u76EE\u5F55\uFF0C\u652F\u6301\u672C\u5730\u6587\u4EF6\u8BFB\u5199" : "\u672C\u673A\u6A21\u5F0F\uFF1A\u76EE\u5F55\u8BFB\u5199\u7531 DSH \u540E\u7AEF\u5904\u7406\uFF0C\u53EF\u76F4\u63A5\u626B\u63CF\u4E0E\u5BFC\u5165\u5BFC\u51FA" }),
    error && /* @__PURE__ */ jsx4("div", { className: "alert error", children: error }),
    status && /* @__PURE__ */ jsxs4("dl", { className: "paths", children: [
      /* @__PURE__ */ jsx4("dt", { children: "Codex \u76EE\u5F55" }),
      /* @__PURE__ */ jsx4("dd", { children: status.codexDir }),
      /* @__PURE__ */ jsx4("dt", { children: "DSH \u4F1A\u8BDD\u76EE\u5F55" }),
      /* @__PURE__ */ jsx4("dd", { children: status.dshSessionsRoot })
    ] }),
    /* @__PURE__ */ jsxs4("div", { className: "actions", children: [
      /* @__PURE__ */ jsx4("button", { className: "primary", onClick: () => setView("import"), children: "\u5BFC\u5165 CodeX \u4F1A\u8BDD" }),
      /* @__PURE__ */ jsx4("button", { className: "primary", onClick: () => setView("export"), children: "\u5BFC\u51FA\u81F3 Codex" })
    ] }),
    /* @__PURE__ */ jsx4(LogPanel, { apiBase })
  ] });
}

// src/client.ts
var PACKAGE_NAME = "dsh-codex-bridge";
var PLUGIN_SETTINGS_SECTION_ID = "plugin-settings";
var PLUGIN_SETTINGS_ITEM_SLOT = "plugin-settings.item";
var PLUGIN_MANAGER_SLOT = "plugins.bundle.config";
var name = "dsh-codex-bridge-client";
var inject = ["slots", "locale", "remote", "remote.session"];
function apply(ctx) {
  try {
    console.info("[codex-bridge] client apply \u5F00\u59CB\uFF1Bslots:", typeof ctx.slots !== "undefined", "| locale:", typeof ctx.locale !== "undefined", "| remote:", typeof ctx.remote !== "undefined");
    try {
      ctx.locale?.register?.("settings.codexBridge", {
        zh: { title: "Codex \u4F1A\u8BDD\u6865\u63A5" },
        en: { title: "Codex Session Bridge" }
      });
    } catch {
    }
    const cardInject = () => ({
      apiBase: "/plugins/dsh-codex-bridge"
    });
    const registerItem = () => {
      const r = ctx.slots.register({
        name: PLUGIN_SETTINGS_ITEM_SLOT,
        id: PACKAGE_NAME,
        order: 30,
        inject: cardInject
        // ← 官方同款：props 注入面
      }, CodexBridgeSettings);
      console.info("[codex-bridge] plugin-settings.item \u5DF2\u6CE8\u518C");
      return r;
    };
    const registerIntoSection = () => {
      ctx.slots.inject("settings.section", () => {
        console.info("[codex-bridge] settings.section \u5DE5\u5382\u6267\u884C\uFF08\u5BBF\u4E3B\u69FD\u4F4D\u5DF2\u5C31\u7EEA\uFF09");
        if (ctx.slots.entries("settings.section").some((e) => e.options?.id === PLUGIN_SETTINGS_SECTION_ID)) {
          console.info("[codex-bridge] \u590D\u7528\u5DF2\u6709\u300A\u63D2\u4EF6\u8BBE\u7F6E\u300B\u5BB9\u5668");
          return registerItem();
        }
        try {
          const results = [
            ctx.slots.register({
              name: "settings.section",
              id: PLUGIN_SETTINGS_SECTION_ID,
              order: 900,
              label: () => "\u63D2\u4EF6\u8BBE\u7F6E",
              children: {
                [PLUGIN_SETTINGS_ITEM_SLOT]: { kind: "list", scope: "root" }
              }
            }, PluginSettingsSection),
            registerItem()
          ];
          console.info("[codex-bridge] \u5DF2\u521B\u5EFA\u300A\u63D2\u4EF6\u8BBE\u7F6E\u300B\u5BB9\u5668 + \u5361\u7247");
          return results;
        } catch (e) {
          console.warn("[codex-bridge] \u5BB9\u5668\u7ADE\u4E89\u5931\u8D25\uFF0C\u9000\u5316\u4E3A\u76F4\u63A5\u6302\u5361\u7247:", e);
          return registerItem();
        }
      });
    };
    registerIntoSection();
    try {
      ctx.slots.inject(PLUGIN_MANAGER_SLOT, () => ctx.slots.register({
        name: PLUGIN_MANAGER_SLOT,
        key: PACKAGE_NAME,
        inject: () => cardInject()
      }, CodexBridgeSettings));
      console.info("[codex-bridge] plugins.bundle.config \u5DF2\u6CE8\u518C\uFF08keyed\uFF09");
    } catch (e) {
      console.error("[codex-bridge] \u63D2\u4EF6\u7BA1\u7406\u9875\u6CE8\u518C\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u8BBE\u7F6E\u5757\uFF09\uFF1A", e);
    }
  } catch (e) {
    console.error("[codex-bridge] \u8BBE\u7F6E\u9875\u6CE8\u518C\u5931\u8D25\uFF08\u5BBF\u4E3B\u4E0D\u53D7\u5F71\u54CD\uFF09\uFF1A", e);
  }
}
function PluginSettingsSection(props) {
  return React5.createElement("section", { className: "plugin-settings-section" }, props.children);
}


		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
