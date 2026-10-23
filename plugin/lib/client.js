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

const jsx6 = react_jsx_runtime["jsx"]; const jsxs6 = react_jsx_runtime["jsxs"];
const Fragment2 = react_jsx_runtime["Fragment"]; const jsx5 = react_jsx_runtime["jsx"]; const jsxs5 = react_jsx_runtime["jsxs"];
const useCallback4 = react["useCallback"]; const useEffect4 = react["useEffect"]; const useState4 = react["useState"];
const Fragment = react_jsx_runtime["Fragment"]; const jsx4 = react_jsx_runtime["jsx"]; const jsxs4 = react_jsx_runtime["jsxs"];
const useCallback3 = react["useCallback"]; const useEffect3 = react["useEffect"]; const useMemo4 = react["useMemo"]; const useState3 = react["useState"];
const jsx3 = react_jsx_runtime["jsx"]; const jsxs3 = react_jsx_runtime["jsxs"];
const jsx2 = react_jsx_runtime["jsx"]; const jsxs2 = react_jsx_runtime["jsxs"];
const useMemo2 = react["useMemo"];
const useCallback2 = react["useCallback"]; const useEffect2 = react["useEffect"]; const useMemo3 = react["useMemo"]; const useState2 = react["useState"];
const jsx = react_jsx_runtime["jsx"]; const jsxs = react_jsx_runtime["jsxs"];
const useCallback = react["useCallback"]; const useEffect = react["useEffect"]; const useMemo = react["useMemo"]; const useState = react["useState"];
const useCallback5 = react["useCallback"]; const useEffect5 = react["useEffect"]; const useState5 = react["useState"];
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

// src/client/BudgetPicker.tsx


var MODEL_OPTIONS = [
  { value: "", label: "\u9ED8\u8BA4\uFF08200k\uFF09", context: 2e5 },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", context: 2e5 },
  { value: "claude-opus-4", label: "Claude Opus 4", context: 2e5 },
  { value: "gpt-5", label: "GPT-5", context: 4e5 },
  { value: "gpt-4.1", label: "GPT-4.1", context: 1e6 },
  { value: "gpt-4o", label: "GPT-4o", context: 128e3 },
  { value: "gemini-2.0", label: "Gemini 2.0", context: 1e6 },
  { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro", context: 2e6 },
  { value: "deepseek-v4", label: "DeepSeek V4", context: 256e3 },
  { value: "deepseek-v3", label: "DeepSeek V3", context: 128e3 },
  { value: "glm-5", label: "GLM-5", context: 2e5 },
  { value: "glm-4.6", label: "GLM-4.6", context: 2e5 },
  { value: "kimi-k2", label: "Kimi K2", context: 256e3 },
  { value: "qwen", label: "Qwen", context: 128e3 }
];
var BUDGET_PRESETS = [16e3, 32e3, 64e3, 128e3, 2e5, 256e3, 4e5, 1e6];
var DEFAULT_BUDGET_VALUE = { mode: "model", model: "", custom: 2e5 };
function resolveDisplayBudget(v) {
  let requested;
  let label;
  if (v.mode === "custom") {
    requested = Math.max(1, Math.min(v.custom, 2e6));
    label = "\u81EA\u5B9A\u4E49";
  } else {
    const opt = MODEL_OPTIONS.find((m) => m.value === v.model);
    requested = opt?.context ?? 2e5;
    label = opt && opt.value ? opt.label : "\u9ED8\u8BA4";
  }
  return { requested, effective: Math.floor(requested * 0.92), label };
}
function BudgetPicker({ value, onChange, originalTokens, disabled }) {
  const display = useMemo2(() => resolveDisplayBudget(value), [value]);
  return /* @__PURE__ */ jsxs2("div", { className: "cb-budget", children: [
    /* @__PURE__ */ jsxs2("div", { className: "filters", style: { gap: 10 }, children: [
      /* @__PURE__ */ jsxs2("label", { children: [
        "\u4E0A\u4E0B\u6587\u957F\u5EA6",
        /* @__PURE__ */ jsxs2(
          "select",
          {
            value: value.mode,
            onChange: (e) => onChange({ ...value, mode: e.target.value }),
            disabled,
            children: [
              /* @__PURE__ */ jsx2("option", { value: "model", children: "\u6309\u6A21\u578B" }),
              /* @__PURE__ */ jsx2("option", { value: "custom", children: "\u81EA\u5B9A\u4E49 token" })
            ]
          }
        )
      ] }),
      value.mode === "model" ? /* @__PURE__ */ jsxs2("label", { style: { flex: "1 1 200px" }, children: [
        "\u6A21\u578B",
        /* @__PURE__ */ jsx2(
          "select",
          {
            style: { flex: 1 },
            value: value.model,
            onChange: (e) => onChange({ ...value, model: e.target.value }),
            disabled,
            children: MODEL_OPTIONS.map((m) => /* @__PURE__ */ jsxs2("option", { value: m.value, children: [
              m.label,
              m.value ? ` \xB7 ${(m.context / 1e3).toLocaleString()}k` : ""
            ] }, m.value))
          }
        )
      ] }) : /* @__PURE__ */ jsxs2("label", { style: { flex: "1 1 200px" }, children: [
        "\u4E0A\u9650",
        /* @__PURE__ */ jsx2(
          "select",
          {
            style: { flex: 1 },
            value: value.custom,
            onChange: (e) => onChange({ ...value, custom: Number(e.target.value) }),
            disabled,
            children: BUDGET_PRESETS.map((b) => /* @__PURE__ */ jsxs2("option", { value: b, children: [
              (b / 1e3).toLocaleString(),
              "k tokens"
            ] }, b))
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs2("div", { className: "cb-row-hint", style: { marginTop: 4 }, children: [
      "\u9884\u7B97 ",
      display.requested.toLocaleString(),
      " \u2192 \u5B9E\u9645\u53EF\u7528",
      " ",
      /* @__PURE__ */ jsx2("b", { style: { color: "var(--cb-text)" }, children: display.effective.toLocaleString() }),
      " tokens \uFF08\u5B89\u5168\u7CFB\u6570 92%\uFF09",
      originalTokens != null && (originalTokens <= display.effective ? /* @__PURE__ */ jsxs2("span", { style: { color: "var(--cb-success)" }, children: [
        " \xB7 \u4F1A\u8BDD ",
        originalTokens.toLocaleString(),
        " tokens\uFF0C\u65E0\u9700\u538B\u7F29"
      ] }) : /* @__PURE__ */ jsxs2("span", { style: { color: "var(--cb-warn)" }, children: [
        " \xB7 \u4F1A\u8BDD ",
        originalTokens.toLocaleString(),
        " tokens\uFF0C\u5C06\u538B\u7F29\u5230 ",
        (display.effective / originalTokens * 100).toFixed(0),
        "%"
      ] }))
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
  const [budgetValue, setBudgetValue] = useState2(DEFAULT_BUDGET_VALUE);
  const [trimContext, setTrimContext] = useState2(false);
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
  const visible = useMemo3(
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
      if (trimContext) {
        if (budgetValue.mode === "custom") body.budget = budgetValue.custom;
        else if (budgetValue.model) body.model = budgetValue.model;
        body.trimContext = true;
      }
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
    return /* @__PURE__ */ jsxs3("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx3("h3", { children: "\u5BFC\u51FA\u4F1A\u8BDD" }),
      /* @__PURE__ */ jsx3("p", { children: "\u6B63\u5728\u52A0\u8F7D\u4F1A\u8BDD\u5217\u8868\u2026" }),
      /* @__PURE__ */ jsx3("div", { className: "spinner" })
    ] });
  }
  if (phase === "exporting") {
    return /* @__PURE__ */ jsxs3("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx3("h3", { children: target === "workbuddy" ? "\u6B63\u5728\u5BFC\u5165 WorkBuddy\u2026" : "\u6B63\u5728\u5BFC\u51FA\u2026" }),
      /* @__PURE__ */ jsx3("p", { children: target === "workbuddy" ? "\u6B63\u5728\u8F6C\u6362\u5E76\u5199\u5165 WorkBuddy \u672C\u5730\u5B58\u50A8\uFF0C\u8BF7\u7A0D\u5019\u3002" : "\u6B63\u5728\u8F6C\u6362\u5E76\u5907\u4EFD Codex \u76EE\u5F55\u4E2D\u7684\u65E7\u6587\u4EF6\uFF0C\u8BF7\u7A0D\u5019\u3002" }),
      /* @__PURE__ */ jsx3("div", { className: "spinner" })
    ] });
  }
  if (phase === "error") {
    return /* @__PURE__ */ jsxs3("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx3("h3", { children: "\u5BFC\u51FA\u5931\u8D25" }),
      /* @__PURE__ */ jsx3("div", { className: "alert error", children: error }),
      /* @__PURE__ */ jsxs3("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx3("button", { onClick: onBack, children: "\u8FD4\u56DE" }),
        /* @__PURE__ */ jsx3("button", { className: "primary", onClick: load, children: "\u91CD\u8BD5" })
      ] })
    ] });
  }
  if (phase === "pick") {
    return /* @__PURE__ */ jsxs3("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx3("h3", { children: "\u5BFC\u51FA\u4F1A\u8BDD" }),
      /* @__PURE__ */ jsxs3("div", { className: "filters", style: { gap: 16 }, children: [
        /* @__PURE__ */ jsx3("span", { className: "muted", children: "\u5BFC\u51FA\u76EE\u6807\uFF1A" }),
        /* @__PURE__ */ jsxs3("label", { children: [
          /* @__PURE__ */ jsx3("input", { type: "radio", name: "target", checked: target === "codex", onChange: () => setTarget("codex") }),
          "Codex\uFF08\u751F\u6210 JSONL\uFF0C\u9700\u624B\u52A8\u590D\u5236\uFF09"
        ] }),
        /* @__PURE__ */ jsxs3("label", { children: [
          /* @__PURE__ */ jsx3("input", { type: "radio", name: "target", checked: target === "workbuddy", onChange: () => setTarget("workbuddy") }),
          "WorkBuddy\uFF08\u76F4\u63A5\u5199\u5165\u672C\u5730\uFF0C\u91CD\u542F\u5373\u53EF\u89C1\uFF09"
        ] })
      ] }),
      /* @__PURE__ */ jsxs3("p", { className: "muted", children: [
        "\u9009\u62E9\u8981\u5BFC\u51FA\u7684\u4F1A\u8BDD\uFF08\u53EF\u591A\u9009\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u5168\u9009\uFF09\u3002",
        /* @__PURE__ */ jsx3("br", {}),
        /* @__PURE__ */ jsxs3("span", { style: { fontSize: 12 }, children: [
          "\u63D0\u793A\uFF1ADSH \u6309\u300C\u9996\u6761\u6D88\u606F\u300D\u81EA\u52A8\u547D\u540D\uFF0C\u56E0\u6B64",
          /* @__PURE__ */ jsx3("strong", { children: "\u540C\u540D\u4E0D\u4EE3\u8868\u91CD\u590D" }),
          "\u3002\u8BF7\u7528\u300C\u4F1A\u8BDD ID\u300D\u548C\u66F4\u65B0\u65F6\u95F4\u533A\u5206\u3002"
        ] })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "filters", children: [
        /* @__PURE__ */ jsx3("input", { placeholder: "\u6309\u6807\u9898\u7B5B\u9009\u2026", value: keyword, onChange: (e) => setKeyword(e.target.value) }),
        /* @__PURE__ */ jsx3("button", { onClick: load, children: "\u5237\u65B0" })
      ] }),
      /* @__PURE__ */ jsxs3("table", { className: "sessions", children: [
        /* @__PURE__ */ jsx3("thead", { children: /* @__PURE__ */ jsxs3("tr", { children: [
          /* @__PURE__ */ jsx3("th", { style: { width: 32 } }),
          /* @__PURE__ */ jsx3("th", { children: "\u6807\u9898" }),
          /* @__PURE__ */ jsx3("th", { children: "\u4F1A\u8BDD ID" }),
          /* @__PURE__ */ jsx3("th", { children: "\u6700\u540E\u66F4\u65B0" }),
          /* @__PURE__ */ jsx3("th", { children: "\u8F6E\u6B21" }),
          /* @__PURE__ */ jsx3("th", { children: "\u5927\u5C0F" })
        ] }) }),
        /* @__PURE__ */ jsx3("tbody", { children: visible.map((s) => /* @__PURE__ */ jsxs3("tr", { className: checked.has(s.id) ? "checked" : "", children: [
          /* @__PURE__ */ jsx3("td", { children: /* @__PURE__ */ jsx3("input", { type: "checkbox", checked: checked.has(s.id), onChange: () => toggle(s.id) }) }),
          /* @__PURE__ */ jsx3("td", { title: s.title, children: s.title }),
          /* @__PURE__ */ jsxs3("td", { className: "path", title: `${s.id}
\u9879\u76EE\uFF1A${s.project}`, children: [
            "\u2026",
            s.id.slice(-8)
          ] }),
          /* @__PURE__ */ jsx3("td", { children: new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false }) }),
          /* @__PURE__ */ jsx3("td", { children: s.turns }),
          /* @__PURE__ */ jsx3("td", { children: formatBytes(s.sizeBytes) })
        ] }, s.id)) })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsxs3("span", { children: [
          "\u5171 ",
          visible.length,
          " \u4E2A\u4F1A\u8BDD\uFF0C\u5DF2\u9009 ",
          checked.size,
          " \u4E2A"
        ] }),
        /* @__PURE__ */ jsxs3("div", { children: [
          /* @__PURE__ */ jsx3("button", { onClick: onBack, children: "\u53D6\u6D88" }),
          /* @__PURE__ */ jsx3("button", { className: "primary", disabled: checked.size === 0, onClick: () => setPhase("confirm"), children: "\u4E0B\u4E00\u6B65" })
        ] })
      ] }),
      error && /* @__PURE__ */ jsx3("div", { className: "alert error", children: error })
    ] });
  }
  if (phase === "confirm") {
    return /* @__PURE__ */ jsxs3("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx3("h3", { children: "\u786E\u8BA4\u5BFC\u51FA" }),
      /* @__PURE__ */ jsxs3("div", { className: "alert info", children: [
        /* @__PURE__ */ jsxs3("p", { children: [
          "\u5373\u5C06\u5BFC\u51FA ",
          /* @__PURE__ */ jsx3("b", { children: checked.size }),
          " \u4E2A\u4F1A\u8BDD\u5230 ",
          /* @__PURE__ */ jsx3("b", { children: target === "workbuddy" ? "WorkBuddy" : "Codex" }),
          "\u3002"
        ] }),
        target === "workbuddy" ? /* @__PURE__ */ jsxs3("ul", { children: [
          /* @__PURE__ */ jsx3("li", { children: "\u4F1A\u76F4\u63A5\u5199\u5165 WorkBuddy \u672C\u5730\u5B58\u50A8\uFF08\u6570\u636E\u5E93 + \u4F1A\u8BDD\u6587\u4EF6\uFF09\u3002" }),
          /* @__PURE__ */ jsx3("li", { children: "\u5199\u5165\u524D\u4F1A\u81EA\u52A8\u5907\u4EFD WorkBuddy \u7684\u6570\u636E\u5E93\u3002" }),
          /* @__PURE__ */ jsxs3("li", { children: [
            "\u5B8C\u6210\u540E",
            /* @__PURE__ */ jsx3("b", { children: "\u91CD\u542F WorkBuddy" }),
            "\u5373\u53EF\u5728\u4F1A\u8BDD\u5217\u8868\u770B\u5230\u3002"
          ] })
        ] }) : /* @__PURE__ */ jsxs3("ul", { children: [
          /* @__PURE__ */ jsx3("li", { children: "\u4F1A\u5BFC\u51FA\u4E3A OpenAI \u517C\u5BB9 JSONL \u5230\u53D7\u63A7\u76EE\u5F55\u3002" }),
          /* @__PURE__ */ jsxs3("li", { children: [
            "\u5BFC\u51FA\u524D\u4F1A\u81EA\u52A8",
            /* @__PURE__ */ jsx3("b", { children: "\u5907\u4EFD" }),
            " Codex \u76EE\u5F55\u4E2D\u7684\u65E7\u7248 JSONL\u3002"
          ] }),
          /* @__PURE__ */ jsxs3("li", { children: [
            "\u63D2\u4EF6",
            /* @__PURE__ */ jsx3("b", { children: "\u4E0D\u4F1A" }),
            "\u76F4\u63A5\u5199\u5165 Codex \u4F1A\u8BDD\u76EE\u5F55\uFF0C\u907F\u514D\u7834\u574F\u6B63\u5728\u8FDB\u884C\u7684\u4F1A\u8BDD\u3002"
          ] }),
          /* @__PURE__ */ jsx3("li", { children: "\u5BFC\u51FA\u540E\u9700\u624B\u52A8\u590D\u5236\u5230 Codex \u539F\u76EE\u5F55\uFF0C\u5E76\u70B9\u300C\u6CE8\u518C\u5230 Codex \u7D22\u5F15\u300D\u3002" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "cb-card", children: [
        /* @__PURE__ */ jsxs3("div", { className: "cb-card-head", children: [
          /* @__PURE__ */ jsx3("span", { className: "cb-card-title", children: "\u4E0A\u4E0B\u6587\u957F\u5EA6" }),
          /* @__PURE__ */ jsxs3("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 400 }, children: [
            /* @__PURE__ */ jsx3(
              "input",
              {
                type: "checkbox",
                checked: trimContext,
                onChange: (e) => setTrimContext(e.target.checked)
              }
            ),
            "\u542F\u7528\u88C1\u526A"
          ] })
        ] }),
        /* @__PURE__ */ jsx3("div", { className: "cb-card-desc", children: trimContext ? "\u4F1A\u6309\u6240\u9009\u9884\u7B97\u538B\u7F29\u4F1A\u8BDD\u5185\u5BB9\uFF08\u6280\u672F\u7EC6\u8282\u4F18\u5148\u4FDD\u7559\uFF09\uFF0C\u8D85\u51FA\u90E8\u5206\u6298\u53E0\u4E3A\u6458\u8981\u3002" : "\u9ED8\u8BA4\u5B8C\u6574\u5BFC\u51FA\uFF08\u4E0D\u88C1\u526A\uFF09\u3002\u76EE\u6807\u6A21\u578B\u4E0A\u4E0B\u6587\u6709\u9650\u65F6\u53EF\u542F\u7528\u88C1\u526A\u3002" }),
        trimContext && /* @__PURE__ */ jsx3("div", { className: "cb-card-body", children: /* @__PURE__ */ jsx3(BudgetPicker, { value: budgetValue, onChange: setBudgetValue }) })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx3("div", {}),
        /* @__PURE__ */ jsxs3("div", { children: [
          /* @__PURE__ */ jsx3("button", { onClick: () => setPhase("pick"), children: "\u8FD4\u56DE" }),
          /* @__PURE__ */ jsx3("button", { className: "primary", onClick: doExport, children: "\u786E\u8BA4\u5BFC\u51FA" })
        ] })
      ] })
    ] });
  }
  const okCount = result?.succ ?? 0;
  const failed = result?.failed ?? 0;
  if (target === "workbuddy") {
    return /* @__PURE__ */ jsxs3("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx3("h3", { children: "\u5DF2\u5BFC\u5165 WorkBuddy" }),
      /* @__PURE__ */ jsxs3("div", { className: `alert ${failed === 0 ? "success" : "warn"}`, children: [
        "\u2705 \u6210\u529F\u5BFC\u5165 ",
        okCount,
        " \u4E2A\u4F1A\u8BDD",
        failed > 0 ? `\uFF0C${failed} \u4E2A\u5931\u8D25` : "",
        "\u3002"
      ] }),
      /* @__PURE__ */ jsx3("div", { className: "alert info", children: /* @__PURE__ */ jsxs3("p", { children: [
        /* @__PURE__ */ jsx3("b", { children: "\u91CD\u542F WorkBuddy" }),
        " \u540E\u5373\u53EF\u5728\u4F1A\u8BDD\u5217\u8868\u770B\u5230\u8FD9\u4E9B\u4F1A\u8BDD\uFF08\u5B83\u53EA\u5728\u542F\u52A8\u65F6\u8BFB\u6570\u636E\u5E93\uFF09\u3002"
      ] }) }),
      /* @__PURE__ */ jsxs3("table", { className: "sessions", children: [
        /* @__PURE__ */ jsx3("thead", { children: /* @__PURE__ */ jsxs3("tr", { children: [
          /* @__PURE__ */ jsx3("th", { children: "\u7ED3\u679C" }),
          /* @__PURE__ */ jsx3("th", { children: "\u4F1A\u8BDD" }),
          /* @__PURE__ */ jsx3("th", { children: "WorkBuddy \u4F1A\u8BDD ID" }),
          /* @__PURE__ */ jsx3("th", { children: "\u8BB0\u5F55\u6570" }),
          /* @__PURE__ */ jsx3("th", { children: "\u8BF4\u660E" })
        ] }) }),
        /* @__PURE__ */ jsx3("tbody", { children: (result?.results ?? []).map((r, i) => /* @__PURE__ */ jsxs3("tr", { children: [
          /* @__PURE__ */ jsx3("td", { children: r.ok ? "\u2705" : "\u274C" }),
          /* @__PURE__ */ jsx3("td", { title: r.sourceSessionId, children: r.sourceSessionId }),
          /* @__PURE__ */ jsx3("td", { className: "path", title: r.jsonlPath ?? "", children: r.workbuddySessionId ? `\u2026${String(r.workbuddySessionId).slice(-8)}` : "\u2014" }),
          /* @__PURE__ */ jsx3("td", { children: r.rows ?? 0 }),
          /* @__PURE__ */ jsx3("td", { className: "reason", children: r.error?.message ?? (r.warnings?.[0] ?? "\u2014") })
        ] }, i)) })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx3("div", {}),
        /* @__PURE__ */ jsxs3("div", { children: [
          /* @__PURE__ */ jsx3("button", { onClick: onBack, children: "\u5B8C\u6210" }),
          /* @__PURE__ */ jsx3("button", { onClick: () => {
            setResult(null);
            setChecked(/* @__PURE__ */ new Set());
            setPhase("pick");
          }, children: "\u518D\u5BFC\u4E00\u6279" })
        ] })
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxs3("div", { className: "dialog wide", children: [
    /* @__PURE__ */ jsx3("h3", { children: "\u5BFC\u51FA\u5B8C\u6210" }),
    /* @__PURE__ */ jsxs3("div", { className: `alert ${failed === 0 ? "success" : "warn"}`, children: [
      "\u2705 \u6210\u529F\u5BFC\u51FA ",
      okCount,
      " \u4E2A\u4F1A\u8BDD",
      failed > 0 ? `\uFF0C${failed} \u4E2A\u5931\u8D25` : "",
      "\u3002"
    ] }),
    /* @__PURE__ */ jsxs3("dl", { className: "paths", children: [
      /* @__PURE__ */ jsx3("dt", { children: "\u{1F4C1} \u65B0\u6587\u4EF6\u4F4D\u7F6E" }),
      /* @__PURE__ */ jsx3("dd", { children: /* @__PURE__ */ jsx3("code", { children: result?.outDir ?? "(\u672A\u77E5)" }) }),
      /* @__PURE__ */ jsx3("dt", { children: "\u{1F5C2} \u65E7\u7248 JSONL \u5907\u4EFD\u4F4D\u7F6E" }),
      /* @__PURE__ */ jsx3("dd", { children: /* @__PURE__ */ jsx3("code", { children: result?.backupDir || "(\u672A\u6267\u884C\u5907\u4EFD)" }) })
    ] }),
    /* @__PURE__ */ jsxs3("div", { className: "alert warn", children: [
      /* @__PURE__ */ jsx3("p", { children: /* @__PURE__ */ jsx3("b", { children: "\u26A0\uFE0F \u8BF7\u624B\u52A8\u5C06\u65B0\u7248 JSONL \u590D\u5236\u5230 Codex \u539F\u76EE\u5F55\uFF1A" }) }),
      /* @__PURE__ */ jsx3("p", { children: /* @__PURE__ */ jsx3("code", { children: "%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\" }) }),
      /* @__PURE__ */ jsx3("p", { className: "muted", children: "\u63D0\u793A\uFF1A\u63D2\u4EF6\u4E0D\u4F1A\u81EA\u52A8\u5199\u5165 Codex \u76EE\u5F55\uFF0C\u4EE5\u514D\u8986\u76D6\u6B63\u5728\u8FDB\u884C\u7684\u4F1A\u8BDD\u3002" })
    ] }),
    /* @__PURE__ */ jsxs3("div", { className: "alert info", children: [
      /* @__PURE__ */ jsx3("p", { children: /* @__PURE__ */ jsx3("b", { children: "\u{1F4CC} \u590D\u5236\u5B8C\u6210\u540E\uFF0C\u8FD8\u9700\u8981\u300C\u6CE8\u518C\u7D22\u5F15\u300DCodex \u624D\u80FD\u770B\u5230\uFF1A" }) }),
      /* @__PURE__ */ jsx3("p", { className: "muted", children: "Codex \u7684\u4F1A\u8BDD\u5217\u8868\u8BFB\u5B83\u81EA\u5DF1\u7684\u7D22\u5F15\u6570\u636E\u5E93\uFF0C\u4E0D\u626B\u63CF\u76EE\u5F55\u3002\u628A\u6587\u4EF6\u590D\u5236\u8FDB\u53BB\u540E\uFF0C\u70B9\u4E0B\u9762\u7684\u6309\u94AE\u628A\u65B0\u4F1A\u8BDD\u767B\u8BB0\u8FDB\u7D22\u5F15\u3002 \uFF08\u5EFA\u8BAE\u5148\u5173\u95ED Codex\uFF0C\u6CE8\u518C\u540E\u91CD\u65B0\u6253\u5F00\u3002\uFF09" }),
      /* @__PURE__ */ jsxs3("div", { style: { marginTop: 8 }, children: [
        /* @__PURE__ */ jsx3(
          "button",
          {
            className: "primary",
            disabled: registering || registerState === "done",
            onClick: doRegister,
            children: registering ? "\u6CE8\u518C\u4E2D\u2026" : registerState === "done" ? "\u2705 \u5DF2\u6CE8\u518C" : "\u6CE8\u518C\u5230 Codex \u7D22\u5F15"
          }
        ),
        registerResult && /* @__PURE__ */ jsxs3("span", { style: { marginLeft: 12, fontSize: 12 }, children: [
          "\u65B0\u6CE8\u518C ",
          registerResult.registered?.length ?? 0,
          " \u4E2A\uFF0C\u5DF2\u5B58\u5728 ",
          registerResult.skipped?.length ?? 0,
          " \u4E2A",
          registerResult.failed?.length ? `\uFF0C\u5931\u8D25 ${registerResult.failed.length} \u4E2A` : ""
        ] })
      ] }),
      registerError && /* @__PURE__ */ jsxs3("p", { style: { color: "#e66", fontSize: 12 }, children: [
        "\u6CE8\u518C\u5931\u8D25\uFF1A",
        registerError
      ] })
    ] }),
    /* @__PURE__ */ jsxs3("table", { className: "sessions", children: [
      /* @__PURE__ */ jsx3("thead", { children: /* @__PURE__ */ jsxs3("tr", { children: [
        /* @__PURE__ */ jsx3("th", { children: "\u7ED3\u679C" }),
        /* @__PURE__ */ jsx3("th", { children: "\u4F1A\u8BDD" }),
        /* @__PURE__ */ jsx3("th", { children: "\u884C\u6570" }),
        /* @__PURE__ */ jsx3("th", { children: "\u6D88\u606F" }),
        /* @__PURE__ */ jsx3("th", { children: "\u5DE5\u5177\u8C03\u7528" }),
        /* @__PURE__ */ jsx3("th", { children: "\u5927\u5C0F" }),
        /* @__PURE__ */ jsx3("th", { children: "\u8BF4\u660E" })
      ] }) }),
      /* @__PURE__ */ jsx3("tbody", { children: (result?.results ?? []).map((r, i) => /* @__PURE__ */ jsxs3("tr", { children: [
        /* @__PURE__ */ jsx3("td", { children: r.report?.ok ? "\u2705" : "\u274C" }),
        /* @__PURE__ */ jsx3("td", { title: r.sourceSessionId, children: r.sourceSessionId }),
        /* @__PURE__ */ jsx3("td", { children: r.report?.stats.lines ?? 0 }),
        /* @__PURE__ */ jsx3("td", { children: r.report?.stats.messages ?? 0 }),
        /* @__PURE__ */ jsx3("td", { children: r.report?.stats.toolCalls ?? 0 }),
        /* @__PURE__ */ jsx3("td", { children: formatBytes(r.report?.stats.bytes ?? 0) }),
        /* @__PURE__ */ jsx3("td", { className: "reason", children: r.report?.error?.message ?? (r.report?.warnings?.[0] ?? "\u2014") })
      ] }, i)) })
    ] }),
    /* @__PURE__ */ jsxs3("div", { className: "dialog-footer", children: [
      /* @__PURE__ */ jsx3("div", {}),
      /* @__PURE__ */ jsx3("button", { className: "primary", onClick: onBack, children: "\u5B8C\u6210" })
    ] })
  ] });
}

// src/client/TransferDialog.tsx


function TransferDialog({ apiBase, onBack }) {
  const [phase, setPhase] = useState3("loading");
  const [error, setError] = useState3(null);
  const [clients, setClients] = useState3([]);
  const [caps, setCaps] = useState3([]);
  const [platformNote, setPlatformNote] = useState3("");
  const [source, setSource] = useState3("");
  const [target, setTarget] = useState3("");
  const [sessions, setSessions] = useState3([]);
  const [selected, setSelected] = useState3("");
  const [keyword, setKeyword] = useState3("");
  const [losses, setLosses] = useState3([]);
  const [result, setResult] = useState3(null);
  const [preview, setPreview] = useState3(null);
  const [budgetValue, setBudgetValue] = useState3(DEFAULT_BUDGET_VALUE);
  const loadClients = useCallback3(async () => {
    setPhase("loading");
    setError(null);
    try {
      const r = await fetch(`${apiBase}/clients`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u52A0\u8F7D\u5931\u8D25");
      setClients(d.clients ?? []);
      setCaps(d.capabilities ?? []);
      setPlatformNote(d.platform?.note ?? "");
      const firstReadable = (d.clients ?? []).find((c) => c.canRead && c.detected);
      if (firstReadable) setSource(firstReadable.kind);
      setPhase("pick");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  }, [apiBase]);
  useEffect3(() => {
    void loadClients();
  }, [loadClients]);
  useEffect3(() => {
    if (!source) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${apiBase}/sessions/all?clients=${encodeURIComponent(source)}&limit=200`);
        const d = await r.json();
        if (cancelled) return;
        if (!d.ok) throw new Error(d.message ?? "\u52A0\u8F7D\u4F1A\u8BDD\u5931\u8D25");
        setSessions((d.sessions ?? []).filter((s) => s.client === source));
        setSelected("");
      } catch (e) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, source]);
  useEffect3(() => {
    if (!source || !target) {
      setLosses([]);
      return;
    }
    (async () => {
      try {
        const r = await fetch(`${apiBase}/loss?from=${encodeURIComponent(source)}&to=${encodeURIComponent(target)}`);
        const d = await r.json();
        if (d.ok) setLosses(d.losses ?? []);
      } catch {
        setLosses([]);
      }
    })();
  }, [apiBase, source, target]);
  const visible = useMemo4(
    () => sessions.filter((s) => !keyword || s.title.toLowerCase().includes(keyword.toLowerCase()) || s.cwd.toLowerCase().includes(keyword.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, keyword]
  );
  const doTransfer = async () => {
    if (!selected || !target) return;
    setPhase("running");
    setError(null);
    try {
      const r = await fetch(`${apiBase}/transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: source, fromId: selected, to: target })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u8F6C\u6362\u5931\u8D25");
      setResult(d);
      setPhase("done");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  };
  const doPreview = async () => {
    if (!selected) return;
    setPhase("running");
    setError(null);
    try {
      const body = { client: source, sessionId: selected };
      if (budgetValue.mode === "custom") body.budget = budgetValue.custom;
      else if (budgetValue.model) body.model = budgetValue.model;
      const r = await fetch(`${apiBase}/context/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.message ?? "\u9884\u89C8\u5931\u8D25");
      setPreview(d);
      setPhase("preview");
    } catch (e) {
      setError(String(e?.message ?? e));
      setPhase("error");
    }
  };
  if (phase === "loading") {
    return /* @__PURE__ */ jsxs4("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx4("h3", { children: "\u8DE8\u7AEF\u8F6C\u6362" }),
      /* @__PURE__ */ jsx4("p", { children: "\u6B63\u5728\u63A2\u6D4B\u5BA2\u6237\u7AEF\u2026" }),
      /* @__PURE__ */ jsx4("div", { className: "spinner" })
    ] });
  }
  if (phase === "running") {
    return /* @__PURE__ */ jsxs4("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx4("h3", { children: "\u5904\u7406\u4E2D\u2026" }),
      /* @__PURE__ */ jsx4("p", { children: "\u6B63\u5728\u8BFB\u53D6\u5E76\u8F6C\u6362\u4F1A\u8BDD\uFF0C\u8BF7\u7A0D\u5019\u3002" }),
      /* @__PURE__ */ jsx4("div", { className: "spinner" })
    ] });
  }
  if (phase === "error") {
    return /* @__PURE__ */ jsxs4("div", { className: "dialog", children: [
      /* @__PURE__ */ jsx4("h3", { children: "\u64CD\u4F5C\u5931\u8D25" }),
      /* @__PURE__ */ jsx4("div", { className: "alert error", children: error }),
      /* @__PURE__ */ jsxs4("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx4("div", {}),
        /* @__PURE__ */ jsxs4("div", { children: [
          /* @__PURE__ */ jsx4("button", { onClick: onBack, children: "\u8FD4\u56DE" }),
          /* @__PURE__ */ jsx4("button", { className: "primary", onClick: loadClients, children: "\u91CD\u8BD5" })
        ] })
      ] })
    ] });
  }
  if (phase === "done" && result) {
    return /* @__PURE__ */ jsxs4("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx4("h3", { children: "\u8F6C\u6362\u5B8C\u6210" }),
      /* @__PURE__ */ jsxs4("div", { className: "alert success", children: [
        "\u2705 \u5DF2\u4ECE ",
        /* @__PURE__ */ jsx4("b", { children: result.source?.client }),
        " \u8F6C\u6362\u5230 ",
        /* @__PURE__ */ jsx4("b", { children: result.target?.client })
      ] }),
      /* @__PURE__ */ jsxs4("table", { className: "sessions", children: [
        /* @__PURE__ */ jsx4("thead", { children: /* @__PURE__ */ jsxs4("tr", { children: [
          /* @__PURE__ */ jsx4("th", { children: "\u9879\u76EE" }),
          /* @__PURE__ */ jsx4("th", { children: "\u503C" })
        ] }) }),
        /* @__PURE__ */ jsxs4("tbody", { children: [
          /* @__PURE__ */ jsxs4("tr", { children: [
            /* @__PURE__ */ jsx4("td", { children: "\u6E90\u4F1A\u8BDD" }),
            /* @__PURE__ */ jsxs4("td", { children: [
              result.source?.title,
              "\uFF08",
              result.source?.turns,
              " \u8F6E\uFF09"
            ] })
          ] }),
          /* @__PURE__ */ jsxs4("tr", { children: [
            /* @__PURE__ */ jsx4("td", { children: "\u76EE\u6807 ID" }),
            /* @__PURE__ */ jsx4("td", { className: "path", children: result.target?.id })
          ] }),
          /* @__PURE__ */ jsxs4("tr", { children: [
            /* @__PURE__ */ jsx4("td", { children: "\u5199\u5165\u4F4D\u7F6E" }),
            /* @__PURE__ */ jsx4("td", { className: "path", children: result.target?.location })
          ] }),
          /* @__PURE__ */ jsxs4("tr", { children: [
            /* @__PURE__ */ jsx4("td", { children: "\u8BB0\u5F55\u6570" }),
            /* @__PURE__ */ jsx4("td", { children: result.target?.records })
          ] })
        ] })
      ] }),
      result.warnings?.length > 0 && /* @__PURE__ */ jsxs4("div", { className: "alert info", children: [
        /* @__PURE__ */ jsx4("p", { children: /* @__PURE__ */ jsx4("b", { children: "\u63D0\u793A\uFF1A" }) }),
        /* @__PURE__ */ jsx4("ul", { children: result.warnings.map((w, i) => /* @__PURE__ */ jsx4("li", { children: w }, i)) })
      ] }),
      /* @__PURE__ */ jsx4("div", { className: "alert warn", children: /* @__PURE__ */ jsxs4("p", { children: [
        "\u5982\u9700\u5728\u76EE\u6807\u5BA2\u6237\u7AEF\u770B\u5230\u8BE5\u4F1A\u8BDD\uFF0C\u53EF\u80FD\u9700\u8981",
        /* @__PURE__ */ jsx4("b", { children: "\u91CD\u542F\u76EE\u6807\u5BA2\u6237\u7AEF" }),
        "\uFF08\u5B83\u53EA\u5728\u542F\u52A8\u65F6\u8BFB\u7D22\u5F15\uFF09\u3002"
      ] }) }),
      /* @__PURE__ */ jsxs4("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx4("div", {}),
        /* @__PURE__ */ jsxs4("div", { children: [
          /* @__PURE__ */ jsx4("button", { onClick: onBack, children: "\u5B8C\u6210" }),
          /* @__PURE__ */ jsx4("button", { onClick: () => {
            setResult(null);
            setPhase("pick");
          }, children: "\u518D\u8F6C\u4E00\u4E2A" })
        ] })
      ] })
    ] });
  }
  if (phase === "preview" && preview) {
    return /* @__PURE__ */ jsxs4("div", { className: "dialog wide", children: [
      /* @__PURE__ */ jsx4("h3", { children: "\u4E0A\u4E0B\u6587\u9884\u89C8" }),
      /* @__PURE__ */ jsxs4("div", { className: "alert info", children: [
        /* @__PURE__ */ jsxs4("p", { children: [
          /* @__PURE__ */ jsx4("b", { children: preview.session?.title }),
          "\uFF08",
          preview.session?.turns,
          " \u8F6E\uFF09"
        ] }),
        /* @__PURE__ */ jsx4("p", { style: { fontSize: 12, whiteSpace: "pre-wrap" }, children: preview.statsText })
      ] }),
      /* @__PURE__ */ jsx4("div", { style: { maxHeight: 400, overflow: "auto", border: "1px solid #333", padding: 12, borderRadius: 6 }, children: /* @__PURE__ */ jsx4("pre", { style: { whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }, children: preview.context }) }),
      /* @__PURE__ */ jsxs4("div", { className: "dialog-footer", children: [
        /* @__PURE__ */ jsx4("div", {}),
        /* @__PURE__ */ jsxs4("div", { children: [
          /* @__PURE__ */ jsx4("button", { onClick: () => setPhase("pick"), children: "\u8FD4\u56DE" }),
          /* @__PURE__ */ jsx4(
            "button",
            {
              className: "primary",
              onClick: () => {
                const blob = new Blob([preview.context], { type: "text/markdown" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `context-${preview.session?.id?.slice(0, 8) ?? "session"}.md`;
                a.click();
                URL.revokeObjectURL(url);
              },
              children: "\u4E0B\u8F7D Markdown"
            }
          )
        ] })
      ] })
    ] });
  }
  const detected = clients.filter((c) => c.detected);
  const targetOptions = caps.filter((c) => c.canWrite && clients.some((x) => x.kind === c.client && x.detected));
  const selectedSession = sessions.find((s) => s.id === selected);
  return /* @__PURE__ */ jsxs4("div", { className: "dialog wide", children: [
    /* @__PURE__ */ jsx4("h3", { children: "\u8DE8\u7AEF\u8F6C\u6362" }),
    /* @__PURE__ */ jsxs4("div", { className: "cb-chips", children: [
      detected.length === 0 && /* @__PURE__ */ jsx4("span", { className: "muted", children: "\u672A\u68C0\u6D4B\u5230\u4EFB\u4F55\u5BA2\u6237\u7AEF" }),
      detected.map((c) => /* @__PURE__ */ jsxs4("span", { className: "cb-badge cb-badge-ok", children: [
        /* @__PURE__ */ jsx4("span", { className: "cb-dot" }),
        c.label,
        c.sessionCount != null ? ` \xB7 ${c.sessionCount}` : ""
      ] }, c.kind))
    ] }),
    /* @__PURE__ */ jsxs4("div", { className: "cb-card", children: [
      /* @__PURE__ */ jsx4("div", { className: "cb-card-head", children: /* @__PURE__ */ jsx4("span", { className: "cb-card-title", children: "\u8F6C\u6362\u65B9\u5411" }) }),
      /* @__PURE__ */ jsxs4("div", { className: "cb-card-body", children: [
        /* @__PURE__ */ jsxs4("div", { className: "filters", style: { gap: 12, alignItems: "flex-end" }, children: [
          /* @__PURE__ */ jsxs4("label", { style: { flex: "1 1 200px" }, children: [
            "\u6E90\uFF08\u4ECE\u8FD9\u91CC\u8BFB\uFF09",
            /* @__PURE__ */ jsxs4(
              "select",
              {
                style: { flex: 1 },
                value: source,
                onChange: (e) => {
                  setSource(e.target.value);
                  setSelected("");
                  setTarget("");
                },
                children: [
                  /* @__PURE__ */ jsx4("option", { value: "", children: "\u8BF7\u9009\u62E9" }),
                  detected.filter((c) => c.canRead).map((c) => /* @__PURE__ */ jsxs4("option", { value: c.kind, children: [
                    c.label,
                    c.sessionCount != null ? `\uFF08${c.sessionCount}\uFF09` : ""
                  ] }, c.kind))
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsx4("span", { style: { fontSize: 16, paddingBottom: 6, opacity: 0.5 }, children: "\u2192" }),
          /* @__PURE__ */ jsxs4("label", { style: { flex: "1 1 200px" }, children: [
            "\u76EE\u6807\uFF08\u5199\u5230\u8FD9\u91CC\uFF09",
            /* @__PURE__ */ jsxs4(
              "select",
              {
                style: { flex: 1 },
                value: target,
                onChange: (e) => setTarget(e.target.value),
                disabled: !source,
                children: [
                  /* @__PURE__ */ jsx4("option", { value: "", children: source ? "\u8BF7\u9009\u62E9" : "\u8BF7\u5148\u9009\u6E90" }),
                  targetOptions.filter((c) => c.client !== source).map((c) => /* @__PURE__ */ jsxs4("option", { value: c.client, children: [
                    c.label,
                    c.client === "dsh" ? "\uFF08DSH \u4E3B\u7A0B\u5E8F\uFF09" : ""
                  ] }, c.client))
                ]
              }
            )
          ] })
        ] }),
        source && /* @__PURE__ */ jsx4("div", { className: "cb-row-hint", style: { marginTop: 2 }, children: target ? /* @__PURE__ */ jsxs4(Fragment, { children: [
          "\u5C06\u628A ",
          /* @__PURE__ */ jsx4("b", { style: { color: "var(--cb-text)" }, children: clients.find((c) => c.kind === source)?.label }),
          " \u7684\u4F1A\u8BDD\u8F6C\u6362\u5230 ",
          /* @__PURE__ */ jsx4("b", { style: { color: "var(--cb-accent)" }, children: caps.find((c) => c.client === target)?.label })
        ] }) : /* @__PURE__ */ jsxs4(Fragment, { children: [
          "\u5DF2\u9009\u6E90\u7AEF ",
          /* @__PURE__ */ jsx4("b", { style: { color: "var(--cb-text)" }, children: clients.find((c) => c.kind === source)?.label }),
          "\uFF0C\u8BF7\u9009\u62E9\u76EE\u6807\uFF08\u53EF\u9009 ",
          targetOptions.filter((c) => c.client !== source).length,
          " \u9879\uFF09"
        ] }) })
      ] })
    ] }),
    losses.length > 0 && /* @__PURE__ */ jsxs4("div", { className: "alert warn", children: [
      /* @__PURE__ */ jsx4("p", { children: /* @__PURE__ */ jsx4("b", { children: "\u8F6C\u6362\u4F1A\u4E22\u5931\u4EE5\u4E0B\u4FE1\u606F" }) }),
      /* @__PURE__ */ jsx4("ul", { children: losses.map((l, i) => /* @__PURE__ */ jsx4("li", { children: l }, i)) })
    ] }),
    /* @__PURE__ */ jsxs4("div", { className: "cb-card", children: [
      /* @__PURE__ */ jsxs4("div", { className: "cb-card-head", children: [
        /* @__PURE__ */ jsxs4("span", { className: "cb-card-title", children: [
          "\u9009\u62E9\u4F1A\u8BDD",
          visible.length > 0 && /* @__PURE__ */ jsx4("span", { className: "cb-badge", children: visible.length })
        ] }),
        /* @__PURE__ */ jsx4("button", { className: "cb-btn-ghost cb-btn-sm", onClick: () => {
          const s = source;
          setSource("");
          setTimeout(() => setSource(s), 0);
        }, children: "\u5237\u65B0" })
      ] }),
      /* @__PURE__ */ jsxs4("div", { className: "cb-card-body", style: { padding: 0 }, children: [
        /* @__PURE__ */ jsx4("div", { className: "filters", style: { padding: "10px 14px" }, children: /* @__PURE__ */ jsx4("input", { placeholder: "\u6309\u6807\u9898\u6216\u8DEF\u5F84\u7B5B\u9009\u2026", value: keyword, onChange: (e) => setKeyword(e.target.value) }) }),
        /* @__PURE__ */ jsx4("div", { className: "cb-table-wrap", style: { border: "none", borderRadius: 0, maxHeight: 320, overflow: "auto" }, children: /* @__PURE__ */ jsxs4("table", { className: "sessions", children: [
          /* @__PURE__ */ jsx4("thead", { children: /* @__PURE__ */ jsxs4("tr", { children: [
            /* @__PURE__ */ jsx4("th", { style: { width: 32 } }),
            /* @__PURE__ */ jsx4("th", { children: "\u6807\u9898" }),
            /* @__PURE__ */ jsx4("th", { children: "\u4F1A\u8BDD ID" }),
            /* @__PURE__ */ jsx4("th", { children: "\u8F6E\u6B21" }),
            /* @__PURE__ */ jsx4("th", { children: "\u66F4\u65B0" })
          ] }) }),
          /* @__PURE__ */ jsxs4("tbody", { children: [
            visible.length === 0 && /* @__PURE__ */ jsx4("tr", { children: /* @__PURE__ */ jsx4("td", { colSpan: 5, className: "muted", style: { padding: 16 }, children: "\u8BE5\u5BA2\u6237\u7AEF\u6CA1\u6709\u53EF\u8BFB\u53D6\u7684\u4F1A\u8BDD" }) }),
            visible.map((s) => /* @__PURE__ */ jsxs4("tr", { className: selected === s.id ? "checked" : "", onClick: () => setSelected(s.id), children: [
              /* @__PURE__ */ jsx4("td", { children: /* @__PURE__ */ jsx4("input", { type: "radio", checked: selected === s.id, onChange: () => setSelected(s.id) }) }),
              /* @__PURE__ */ jsx4("td", { title: s.title, children: s.title }),
              /* @__PURE__ */ jsxs4("td", { className: "path", title: s.id, children: [
                "\u2026",
                s.id.slice(-8)
              ] }),
              /* @__PURE__ */ jsx4("td", { children: s.turns ?? "\u2014" }),
              /* @__PURE__ */ jsx4("td", { children: new Date(s.updatedAt).toLocaleDateString("zh-CN") })
            ] }, s.id))
          ] })
        ] }) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs4("div", { className: "cb-card", children: [
      /* @__PURE__ */ jsx4("div", { className: "cb-card-head", children: /* @__PURE__ */ jsx4("span", { className: "cb-card-title", children: "\u4E0A\u4E0B\u6587\u9884\u89C8" }) }),
      /* @__PURE__ */ jsx4("div", { className: "cb-card-desc", children: "\u5148\u628A\u4F1A\u8BDD\u538B\u7F29\u6210 Markdown \u770B\u770B\u6548\u679C\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u8F6C\u6362\u3002" }),
      /* @__PURE__ */ jsxs4("div", { className: "cb-card-body", children: [
        /* @__PURE__ */ jsx4(
          BudgetPicker,
          {
            value: budgetValue,
            onChange: setBudgetValue,
            disabled: !selected
          }
        ),
        /* @__PURE__ */ jsx4("div", { className: "filters", children: /* @__PURE__ */ jsx4("button", { disabled: !selected, onClick: doPreview, children: "\u9884\u89C8\u538B\u7F29\u4E0A\u4E0B\u6587" }) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs4("div", { className: "dialog-footer", children: [
      /* @__PURE__ */ jsx4("span", { children: selectedSession ? `\u5DF2\u9009\uFF1A${selectedSession.title.slice(0, 30)}` : "\u8BF7\u9009\u62E9\u8981\u8F6C\u6362\u7684\u4F1A\u8BDD" }),
      /* @__PURE__ */ jsxs4("div", { children: [
        /* @__PURE__ */ jsx4("button", { onClick: onBack, children: "\u53D6\u6D88" }),
        /* @__PURE__ */ jsx4("button", { className: "primary", disabled: !selected || !target, onClick: doTransfer, children: "\u5F00\u59CB\u8F6C\u6362" })
      ] })
    ] }),
    error && /* @__PURE__ */ jsx4("div", { className: "alert error", children: error })
  ] });
}

// src/client/LogPanel.tsx


var OP_LABEL = {
  import: "\u5BFC\u5165",
  export: "\u5BFC\u51FA",
  backup: "\u5907\u4EFD",
  scan: "\u626B\u63CF",
  transfer: "\u8F6C\u6362",
  error: "\u9519\u8BEF"
};
var PHASE_ICON = { start: "\u23F3", ok: "\u2705", fail: "\u274C" };
function LogPanel({ apiBase }) {
  const [open, setOpen] = useState4(false);
  const [logs, setLogs] = useState4([]);
  const [loading, setLoading] = useState4(false);
  const load = useCallback4(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${apiBase}/logs?limit=100`);
      const d = await r.json();
      if (d.ok) setLogs(d.logs ?? []);
    } catch {
    }
    setLoading(false);
  }, [apiBase]);
  useEffect4(() => {
    if (open) void load();
  }, [open, load]);
  return /* @__PURE__ */ jsxs5("div", { className: "cb-card log-panel", children: [
    /* @__PURE__ */ jsxs5("div", { className: "cb-card-head", children: [
      /* @__PURE__ */ jsxs5("span", { className: "cb-card-title", children: [
        "\u64CD\u4F5C\u65E5\u5FD7",
        logs.length > 0 && /* @__PURE__ */ jsx5("span", { className: "cb-badge", children: logs.length })
      ] }),
      /* @__PURE__ */ jsxs5("div", { style: { display: "flex", gap: 6 }, children: [
        open && /* @__PURE__ */ jsx5("button", { className: "cb-btn-ghost cb-btn-sm", onClick: load, disabled: loading, children: loading ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0" }),
        /* @__PURE__ */ jsx5("button", { className: "cb-btn-ghost cb-btn-sm", onClick: () => setOpen((v) => !v), children: open ? "\u6536\u8D77" : "\u5C55\u5F00" })
      ] })
    ] }),
    open && /* @__PURE__ */ jsxs5(Fragment2, { children: [
      /* @__PURE__ */ jsx5("div", { className: "cb-card-desc", children: "\u6700\u8FD1 100 \u6761\u8BB0\u5F55\uFF08\u5BFC\u5165 / \u5BFC\u51FA / \u5907\u4EFD / \u8F6C\u6362\uFF09" }),
      /* @__PURE__ */ jsxs5("div", { className: "log-body", children: [
        logs.length === 0 && /* @__PURE__ */ jsx5("p", { className: "muted", style: { padding: "0 14px" }, children: "\u6682\u65E0\u8BB0\u5F55\u3002" }),
        logs.map((l) => /* @__PURE__ */ jsxs5("div", { className: "msg", children: [
          /* @__PURE__ */ jsx5("span", { className: "time", children: new Date(l.at).toLocaleTimeString("zh-CN", { hour12: false }) }),
          /* @__PURE__ */ jsxs5("span", { className: "op", children: [
            PHASE_ICON[l.phase] ?? "",
            " ",
            OP_LABEL[l.op] ?? l.op
          ] }),
          /* @__PURE__ */ jsx5("span", { children: l.message }),
          l.sessionId && /* @__PURE__ */ jsx5("span", { className: "sid", children: String(l.sessionId).slice(0, 8) })
        ] }, l.id))
      ] })
    ] })
  ] });
}

// src/client/SettingsPage.tsx

var CLIENT_ICON = {
  dsh: "\u25C6",
  codex: "\u25C7",
  zcode: "\u25C8",
  "claude-code": "\u25C9",
  workbuddy: "\u25CE"
};
function CodexBridgeSettings({ apiBase = "/plugins/dsh-codex-bridge" }) {
  const [view, setView] = useState5("home");
  const [status, setStatus] = useState5(null);
  const [clients, setClients] = useState5([]);
  const [platformNote, setPlatformNote] = useState5("");
  const [error, setError] = useState5(null);
  const [loading, setLoading] = useState5(true);
  const loadStatus = useCallback5(() => {
    setLoading(true);
    Promise.all([
      fetch(`${apiBase}/status`).then((r) => r.json()).catch(() => null),
      fetch(`${apiBase}/clients`).then((r) => r.json()).catch(() => null)
    ]).then(([s, c]) => {
      if (s?.ok) setStatus(s);
      else setError("\u65E0\u6CD5\u8FDE\u63A5\u5230\u63D2\u4EF6\u670D\u52A1\uFF0C\u8BF7\u786E\u8BA4 DSH \u6B63\u5728\u8FD0\u884C\u3002");
      if (c?.ok) {
        setClients(c.clients ?? []);
        setPlatformNote(c.platform?.note ?? "");
      }
      setLoading(false);
    });
  }, [apiBase]);
  useEffect5(() => {
    loadStatus();
  }, [loadStatus]);
  if (view === "import") return /* @__PURE__ */ jsx6(ImportDialog, { apiBase, onBack: () => setView("home") });
  if (view === "export") return /* @__PURE__ */ jsx6(ExportDialog, { apiBase, onBack: () => setView("home") });
  if (view === "transfer") return /* @__PURE__ */ jsx6(TransferDialog, { apiBase, onBack: () => setView("home") });
  const detected = clients.filter((c) => c.detected);
  const missing = clients.filter((c) => !c.detected);
  return /* @__PURE__ */ jsxs6("div", { className: "codex-bridge-settings", children: [
    /* @__PURE__ */ jsx6("h2", { children: "\u4F1A\u8BDD\u6865\u63A5" }),
    /* @__PURE__ */ jsx6("p", { className: "cb-lead", children: "Codex / DeepSeek Harness / Zcode / Claude Code / WorkBuddy \u4E94\u7AEF\u4F1A\u8BDD\u4E92\u901A\u3002" }),
    error && /* @__PURE__ */ jsx6("div", { className: "alert error", children: error }),
    /* @__PURE__ */ jsxs6("div", { className: "cb-card", children: [
      /* @__PURE__ */ jsxs6("div", { className: "cb-card-head", children: [
        /* @__PURE__ */ jsxs6("span", { className: "cb-card-title", children: [
          "\u5DF2\u68C0\u6D4B\u5BA2\u6237\u7AEF",
          /* @__PURE__ */ jsxs6("span", { className: "cb-badge cb-badge-ok", children: [
            /* @__PURE__ */ jsx6("span", { className: "cb-dot" }),
            detected.length,
            " / ",
            clients.length || 5
          ] })
        ] }),
        /* @__PURE__ */ jsx6("button", { className: "cb-btn-ghost cb-btn-sm", onClick: loadStatus, disabled: loading, children: loading ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0" })
      ] }),
      /* @__PURE__ */ jsx6("div", { className: "cb-card-desc", children: "\u81EA\u52A8\u63A2\u6D4B\u672C\u673A\u5B89\u88C5\u7684\u5BA2\u6237\u7AEF\u3002\u53EA\u8BFB\u6807\u8BB0\u8868\u793A\u8BE5\u7AEF\u53EA\u80FD\u8BFB\u53D6\u3001\u4E0D\u80FD\u5199\u5165\u3002" }),
      /* @__PURE__ */ jsxs6("div", { className: "cb-card-body", children: [
        clients.length === 0 && /* @__PURE__ */ jsx6("span", { className: "muted", children: "\u6B63\u5728\u63A2\u6D4B\u2026" }),
        detected.map((c) => /* @__PURE__ */ jsxs6("div", { className: "cb-row", children: [
          /* @__PURE__ */ jsxs6("div", { className: "cb-row-main", children: [
            /* @__PURE__ */ jsxs6("div", { className: "cb-row-label", children: [
              /* @__PURE__ */ jsx6("span", { style: { marginRight: 6, opacity: 0.7 }, children: CLIENT_ICON[c.kind] ?? "\xB7" }),
              c.label
            ] }),
            /* @__PURE__ */ jsx6("div", { className: "cb-row-hint", title: c.home, children: c.home })
          ] }),
          /* @__PURE__ */ jsxs6("div", { className: "cb-row-ctrl", children: [
            c.sessionCount != null && /* @__PURE__ */ jsxs6("span", { className: "cb-badge", children: [
              c.sessionCount,
              " \u4F1A\u8BDD"
            ] }),
            /* @__PURE__ */ jsxs6("span", { className: `cb-badge ${c.canWrite ? "cb-badge-ok" : ""}`, children: [
              /* @__PURE__ */ jsx6("span", { className: "cb-dot" }),
              c.canWrite ? "\u53EF\u8BFB\u5199" : "\u53EA\u8BFB"
            ] })
          ] })
        ] }, c.kind)),
        missing.length > 0 && /* @__PURE__ */ jsx6("div", { className: "cb-row", children: /* @__PURE__ */ jsx6("div", { className: "cb-row-main", children: /* @__PURE__ */ jsxs6("div", { className: "cb-row-hint", children: [
          "\u672A\u68C0\u6D4B\u5230\uFF1A",
          missing.map((c) => c.label).join("\u3001")
        ] }) }) }),
        platformNote && /* @__PURE__ */ jsx6("div", { className: "cb-row", children: /* @__PURE__ */ jsx6("div", { className: "cb-row-main", children: /* @__PURE__ */ jsx6("div", { className: "cb-row-hint", children: platformNote }) }) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs6("div", { className: "cb-card", children: [
      /* @__PURE__ */ jsx6("div", { className: "cb-card-head", children: /* @__PURE__ */ jsx6("span", { className: "cb-card-title", children: "\u64CD\u4F5C" }) }),
      /* @__PURE__ */ jsx6("div", { className: "cb-card-desc", children: "\u4E09\u4E2A\u5165\u53E3\u80FD\u529B\u4E0D\u540C\uFF0C\u6309\u9700\u6C42\u9009\u62E9\u3002" }),
      /* @__PURE__ */ jsx6("div", { className: "cb-card-body", children: /* @__PURE__ */ jsxs6("div", { className: "actions", children: [
        /* @__PURE__ */ jsxs6("button", { className: "cb-action cb-action-primary", onClick: () => setView("transfer"), children: [
          /* @__PURE__ */ jsx6("span", { className: "cb-action-title", children: "\u8DE8\u7AEF\u8F6C\u6362" }),
          /* @__PURE__ */ jsx6("span", { className: "cb-action-desc", children: "\u4EFB\u610F\u4E24\u7AEF\u4E92\u8F6C\uFF08\u542B Zcode / Claude Code \u2192 DSH\uFF09\uFF0C\u652F\u6301\u4E0A\u4E0B\u6587\u9884\u89C8\u4E0E\u538B\u7F29" })
        ] }),
        /* @__PURE__ */ jsxs6("button", { className: "cb-action", onClick: () => setView("import"), children: [
          /* @__PURE__ */ jsx6("span", { className: "cb-action-title", children: "\u5BFC\u5165 Codex \u2192 DSH" }),
          /* @__PURE__ */ jsx6("span", { className: "cb-action-desc", children: "\u5E26\u5DE5\u4F5C\u533A\u9009\u62E9\u3001\u53BB\u91CD\u3001\u52A0\u5BC6\u5185\u5BB9\u5360\u4F4D" })
        ] }),
        /* @__PURE__ */ jsxs6("button", { className: "cb-action", onClick: () => setView("export"), children: [
          /* @__PURE__ */ jsx6("span", { className: "cb-action-title", children: "\u5BFC\u51FA DSH \u2192 Codex / WorkBuddy" }),
          /* @__PURE__ */ jsx6("span", { className: "cb-action-desc", children: "\u81EA\u52A8\u5907\u4EFD\u65E7\u6587\u4EF6\u3001\u6CE8\u518C Codex \u7D22\u5F15" })
        ] })
      ] }) })
    ] }),
    status && /* @__PURE__ */ jsxs6("div", { className: "cb-card", children: [
      /* @__PURE__ */ jsx6("div", { className: "cb-card-head", children: /* @__PURE__ */ jsx6("span", { className: "cb-card-title", children: "\u5B58\u50A8\u4F4D\u7F6E" }) }),
      /* @__PURE__ */ jsx6("div", { className: "cb-card-body", children: /* @__PURE__ */ jsxs6("dl", { className: "paths", children: [
        /* @__PURE__ */ jsx6("dt", { children: "Codex \u76EE\u5F55" }),
        /* @__PURE__ */ jsx6("dd", { children: status.codexDir }),
        /* @__PURE__ */ jsx6("dt", { children: "DSH \u4F1A\u8BDD\u76EE\u5F55" }),
        /* @__PURE__ */ jsx6("dd", { children: status.dshSessionsRoot })
      ] }) })
    ] }),
    /* @__PURE__ */ jsx6(LogPanel, { apiBase })
  ] });
}

// src/client/styles.ts
var BRIDGE_CSS_ID = "dsh-codex-bridge/styles.css";
function injectStyles() {
  if (typeof document === "undefined") return () => {
  };
  const selector = `style[data-plugin-css="${BRIDGE_CSS_ID}"]`;
  if (document.querySelector(selector) !== null) {
    return () => {
    };
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-codex-bridge";
  tag.dataset.pluginCss = BRIDGE_CSS_ID;
  tag.textContent = BRIDGE_CSS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
var BRIDGE_CSS = `
/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u53D8\u91CF \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u6807\u9898\u533A \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u5206\u7EC4\u5361\u7247 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u884C\uFF08\u6807\u7B7E + \u53F3\u4FA7\u63A7\u4EF6\uFF09 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u6309\u94AE \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u52A8\u4F5C\u6309\u94AE\u7EC4 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u5FBD\u7AE0 / \u6807\u7B7E \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u63D0\u793A\u6761 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u8868\u5355\u63A7\u4EF6 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u8868\u683C \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u5BF9\u8BDD\u6846 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u5176\u4ED6 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
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

/* \u65E5\u5FD7\u9762\u677F */
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

/* \u6DF1\u8272\u6EDA\u52A8\u6761 */
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
      const disposeCss = injectStyles();
      if (typeof ctx.effect === "function") {
        ctx.effect(() => disposeCss, "codexBridge.styles");
      }
      console.info("[codex-bridge] \u6837\u5F0F\u5DF2\u6CE8\u5165");
    } catch (e) {
      console.warn("[codex-bridge] \u6837\u5F0F\u6CE8\u5165\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u529F\u80FD\uFF09:", e);
    }
    try {
      ctx.locale?.register?.("settings.codexBridge", {
        zh: { title: "\u4F1A\u8BDD\u6865\u63A5" },
        en: { title: "Session Bridge" }
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
  return React7.createElement("section", { className: "plugin-settings-section" }, props.children);
}


		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
