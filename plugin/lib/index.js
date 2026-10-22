import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import fsp, { stat } from "node:fs/promises";
import path from "node:path";
import fs, { createReadStream } from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import crypto$1 from "node:crypto";
//#region \0rolldown/runtime.js
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region src/shared/errors.ts
/** 带错误码的异常，便于 UI 精确映射中文提示 */
var BridgeError = class extends Error {
	code;
	detail;
	constructor(code, message, detail = {}) {
		super(message ?? describeError(code, detail));
		this.name = "BridgeError";
		this.code = code;
		this.detail = detail;
	}
};
/**
* 中文提示文案。{placeholder} 会被 detail 中的同名键替换。
*/
const MESSAGES = {
	CODEX_DIR_NOT_FOUND: "未找到 Codex 会话目录（预期位置：{dir}）。请确认 Codex 已安装并至少使用过一次，或在设置中手动指定目录。",
	CODEX_DIR_EMPTY: "Codex 会话目录存在，但里面没有任何会话文件。请先在 Codex 中完成一次对话后重试。",
	PERMISSION_DENIED: "权限不足：无法读取 {path}。请检查该文件夹的访问权限，或改用具有读取权限的账户运行。",
	FILE_CORRUPTED: "文件已损坏：{file} 的数据无法解压，可能写入被中断。该会话已跳过，其他会话不受影响。",
	JSON_PARSE_FAILED: "JSON 解析失败：{file} 第 {line} 行格式错误。该行已跳过，其余内容仍会导入。",
	FILE_TOO_LARGE: "会话文件过大：{file} 大小为 {size}，超过上限 {limit}。为避免内存耗尽已跳过，可在设置中调高上限后重试。",
	NO_SESSION_META: "该会话缺少 session_meta 记录（文件可能不完整或不是 Codex rollout）。已跳过。",
	DSH_WRITE_FAILED: "写入 DSH 会话失败：{reason}。原有数据未被修改。",
	DSH_SESSION_EXISTS: "该会话已导入过（目标 ID：{id}）。请选择「跳过」或「覆盖」后重试。",
	EXPORT_WRITE_FAILED: "导出文件写入失败：{reason}。请检查输出目录是否存在且可写。",
	BACKUP_FAILED: "备份失败：{reason}。已中止导出，以免覆盖旧数据。",
	NO_SELECTION: "请至少勾选一个会话。",
	WEB_MODE_LIMIT: "当前为 Web 模式，浏览器无法访问本机目录。请改用「上传文件」导入或「下载文件」导出。",
	UNSUPPORTED_ENV: "当前环境不支持本地目录访问（检测到：{env}）。请改用上传/下载方式。",
	SCAN_FAILED: "扫描会话目录失败：{reason}",
	CONVERT_FAILED: "数据转换失败：{reason}。该会话已跳过。"
};
/** 用 detail 填充中文文案中的占位符 */
function describeError(code, detail = {}) {
	return (MESSAGES[code] ?? "发生未知错误：{reason}").replace(/\{(\w+)\}/g, (_, k) => {
		const v = detail[k];
		if (v === void 0 || v === null) return "";
		if (k === "size" || k === "limit") return formatBytes(Number(v));
		return String(v);
	});
}
/** 人类可读的体积 */
function formatBytes(n) {
	if (!Number.isFinite(n) || n < 0) return "未知大小";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
//#endregion
//#region src/convert/codex-reader.ts
/**
* convert/codex-reader.ts —— 读取 Codex rollout（明文 .jsonl / 压缩 .jsonl.zst）
*
* 实测要点：
*   1. Codex 存在两种扩展名：.jsonl（明文）与 .jsonl.zst（单帧 zstd）
*   2. 需要流式逐行读取，单个 105 MB 的文件不能整体 JSON.parse
*   3. 单行损坏不应拖垮整个会话（按行隔离）
*/
/** 单文件默认上限（256 MB），超过直接拒绝，避免 OOM */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const ZSTD_MAGIC = [
	40,
	181,
	47,
	253
];
/**
* 判断一段 Buffer 是否以 zstd magic 开头。
* .jsonl.zst 是单帧；.jsonl 是纯文本。
*/
function isZstd(buf) {
	if (buf.length < 4) return false;
	return ZSTD_MAGIC.every((b, i) => buf[i] === b);
}
/** 解压 zstd；支持多帧（Codex 的 .zst 实测为单帧，但防御性支持多帧） */
function decompressZstd(buf) {
	try {
		return zlib.zstdDecompressSync(buf);
	} catch {
		const cuts = [];
		for (let i = 0; i + 3 < buf.length; i++) if (ZSTD_MAGIC.every((b, k) => buf[i + k] === b)) cuts.push(i);
		if (cuts.length === 0) throw new BridgeError("FILE_CORRUPTED", void 0, { file: "(zstd)" });
		const parts = [];
		let failed = 0;
		for (let i = 0; i < cuts.length; i++) {
			const chunk = buf.subarray(cuts[i], cuts[i + 1] ?? buf.length);
			try {
				parts.push(zlib.zstdDecompressSync(chunk));
			} catch {
				failed++;
			}
		}
		if (parts.length === 0) throw new BridgeError("FILE_CORRUPTED", void 0, { file: "(zstd)" });
		return Buffer.concat(parts);
	}
}
/** 把文件内容解码为文本行（自动识别 zstd / 明文） */
function decodeRolloutBuffer(buf) {
	return (isZstd(buf) ? decompressZstd(buf) : buf).toString("utf8");
}
/**
* 逐行解析 rollout 文本。
* @returns 解析成功的行 + 解析失败的行号列表（不中断整体）
*/
function parseRolloutText(text, file = "(unknown)") {
	const lines = [];
	const badLines = [];
	const arr = text.split("\n");
	for (let i = 0; i < arr.length; i++) {
		const s = arr[i].trim();
		if (!s) continue;
		try {
			const o = JSON.parse(s);
			if (o && typeof o === "object" && typeof o.type === "string") lines.push(o);
			else badLines.push(i + 1);
		} catch {
			badLines.push(i + 1);
		}
	}
	return {
		lines,
		badLines
	};
}
/** 读取整个 rollout（带大小保护） */
async function readRollout(filePath, maxBytes = DEFAULT_MAX_BYTES) {
	const st = await stat(filePath);
	if (st.size > maxBytes) throw new BridgeError("FILE_TOO_LARGE", void 0, {
		file: filePath,
		size: st.size,
		limit: maxBytes
	});
	const chunks = [];
	await new Promise((resolve, reject) => {
		const rs = createReadStream(filePath);
		rs.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
		rs.on("end", () => resolve());
		rs.on("error", (e) => reject(e));
	});
	const { lines, badLines } = parseRolloutText(decodeRolloutBuffer(Buffer.concat(chunks)), filePath);
	return {
		lines,
		badLines,
		sizeBytes: st.size
	};
}
/** 从 rollout 行中提取会话元数据 */
function extractMeta(lines) {
	const row = lines.find((l) => l.type === "session_meta");
	if (!row) return null;
	return row.payload;
}
/** 从 rollout 行统计出列表展示所需的摘要信息 */
function summarize(lines, meta, filePath, sizeBytes) {
	const isSubagent = meta.thread_source === "subagent";
	const spawn = typeof meta.source === "object" && meta.source !== null ? meta.source?.subagent?.thread_spawn : void 0;
	let turnCount = 0;
	let messageCount = 0;
	let firstUserText = "";
	for (const l of lines) {
		if (l.type === "event_msg" && l.payload?.type === "task_started") turnCount++;
		if (l.type === "response_item" && l.payload?.type === "message") {
			messageCount++;
			const role = l.payload.role;
			const text = (l.payload.content ?? []).filter((c) => typeof c.text === "string").map((c) => c.text).join(" ");
			if (!firstUserText && role === "user" && text) {
				const cleaned = text.replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, "").replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "").trim();
				if (cleaned) firstUserText = cleaned;
			}
		}
	}
	const created = Date.parse(meta.timestamp ?? "") || 0;
	const last = lines[lines.length - 1];
	const updated = Date.parse(last?.timestamp ?? "") || created;
	return {
		id: meta.id,
		filePath,
		title: firstUserText.slice(0, 80) || "(无标题)",
		cwd: meta.cwd ?? "",
		createdAt: created,
		updatedAt: updated,
		sizeBytes,
		compressed: filePath.endsWith(".zst"),
		isSubagent,
		parentThreadId: meta.parent_thread_id ?? spawn?.parent_thread_id,
		agentPath: meta.agent_path ?? spawn?.agent_path,
		agentNickname: meta.agent_nickname ?? spawn?.agent_nickname,
		turnCount,
		messageCount
	};
}
/**
* 读取 Codex 官方会话索引（session_index.jsonl）。
* 这是「会话（thread）」的权威列表——rollout 文件里还包含子代理线程与 turn 分片，
* 数量会虚高；索引里的 thread_name 是 Codex 维护的标题，比从内容猜可靠。
*/
async function readSessionIndex(indexFile) {
	let text;
	try {
		text = await import("node:fs/promises").then((fsp) => fsp.readFile(indexFile, "utf8"));
	} catch {
		return [];
	}
	const out = [];
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			const o = JSON.parse(s);
			if (o && typeof o.id === "string") out.push({
				id: o.id,
				thread_name: typeof o.thread_name === "string" ? o.thread_name : "",
				updated_at: typeof o.updated_at === "string" ? o.updated_at : ""
			});
		} catch {}
	}
	return out;
}
/**
* 从 rollout 文件名解析 thread id。
* 命名规则：rollout-<ISO时间>-<threadId>[_<turnId>].jsonl[.zst]
* 文件名的第一段 uuid 是 thread id；带第二段 uuid 的是同一个 thread 的 turn 分片。
*/
function threadIdFromFileName(filePath) {
	const m = (filePath.split(/[\\/]/).pop() ?? "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
	return m ? m[0] : null;
}
//#endregion
//#region src/convert/toolmap.ts
/** 把 Codex 的 arguments(JSON 字符串) 安全解析为对象 */
function safeParseArgs(raw) {
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}
/**
* function_call 形态的映射表。
* 关键点：exec_command 的 shell 命令 → DSH 的 pwsh(command)。
*/
const FUNCTION_MAP = {
	exec_command: (a) => {
		const cmd = String(a.cmd ?? a.command ?? "");
		return {
			name: "pwsh",
			arguments: JSON.stringify({ command: cmd }),
			degraded: false
		};
	},
	shell: (a) => {
		const cmd = String(a.command ?? a.cmd ?? "");
		return {
			name: "pwsh",
			arguments: JSON.stringify({ command: cmd }),
			degraded: false
		};
	},
	read_file: (a) => ({
		name: "read",
		arguments: JSON.stringify({ file_path: a.file_path ?? a.path ?? "" }),
		degraded: false
	}),
	view_image: (a) => ({
		name: "read_image",
		arguments: JSON.stringify({ file_path: a.path ?? a.file_path ?? "" }),
		degraded: false
	}),
	apply_patch: (a) => ({
		name: "edit",
		arguments: JSON.stringify({ patch: a.input ?? a.patch ?? "" }),
		degraded: true,
		note: "patch 文本无法还原为 DSH edit 的「文件路径+替换」结构"
	}),
	update_plan: (a) => ({
		name: "todo_write",
		arguments: JSON.stringify({ todos: a.plan ?? a.todos ?? [] }),
		degraded: true,
		note: "计划结构不同，仅保留内容"
	}),
	spawn_agent: (a) => ({
		name: "spawn_teammate",
		arguments: JSON.stringify({
			name: String(a.task_name ?? "subagent"),
			description: String(a.task_name ?? ""),
			prompt: "[加密内容 · 无法解码]"
		}),
		degraded: true,
		note: "任务内容在 Codex 中加密，子代理创建参数无法完整还原"
	}),
	send_message: (a) => ({
		name: "send_message",
		arguments: JSON.stringify({
			target: a.agent_id ?? a.target,
			message: a.message ?? ""
		}),
		degraded: false
	}),
	list_agents: () => ({
		name: "list_agents",
		arguments: "{}",
		degraded: false
	}),
	followup_task: (a) => ({
		name: "send_message",
		arguments: JSON.stringify({
			target: a.agent_id ?? a.task_name,
			message: a.message ?? ""
		}),
		degraded: true,
		note: "Codex followup_task 语义映射为 DSH send_message"
	}),
	request_user_input_async: (a) => ({
		name: "ask_user_question",
		arguments: JSON.stringify({ questions: a.questions ?? [] }),
		degraded: true,
		note: "异步提问语义不同"
	}),
	sleep: (a) => ({
		name: "sleep",
		arguments: JSON.stringify({ ms: a.ms ?? a.duration_ms ?? 0 }),
		degraded: false
	})
};
/**
* custom_tool_call 形态的映射。
* 实测 custom tool 只有 `exec`（JS 内联执行），input 是原始代码字符串。
*/
function mapCustomTool(name, input) {
	if (name === "exec") return {
		name: "pwsh",
		arguments: JSON.stringify({ command: input }),
		degraded: true,
		note: "Codex 的 JS 内联执行脚本无法直接转为 shell 命令，以原文保留"
	};
	return {
		name: `codex_${sanitize(name)}`,
		arguments: JSON.stringify({ input }),
		degraded: true,
		note: "未知的 Codex custom tool，原样保留"
	};
}
function sanitize(name) {
	return (name || "unknown").replace(/[^A-Za-z0-9_]/g, "_");
}
/** 映射 function_call */
function mapFunctionCall(name, rawArguments) {
	const args = safeParseArgs(rawArguments);
	const fn = FUNCTION_MAP[name];
	if (fn) return fn(args);
	return {
		name: sanitize(name),
		arguments: rawArguments || "{}",
		degraded: true,
		note: `未知的 Codex 工具「${name}」，原样保留`
	};
}
/** 映射 custom_tool_call */
function mapCustomToolCall(name, input) {
	return mapCustomTool(name, input);
}
/** 反向映射：DSH 工具名 → Codex 工具名（导出时用） */
const REVERSE = {
	pwsh: "exec_command",
	bash: "exec_command",
	read: "read_file",
	read_image: "view_image",
	edit: "apply_patch",
	write: "apply_patch",
	todo_write: "update_plan",
	spawn_teammate: "spawn_agent",
	send_message: "send_message",
	list_agents: "list_agents",
	ask_user_question: "request_user_input_async"
};
function reverseToolName(dshName) {
	return REVERSE[dshName] ?? dshName;
}
/**
* 反向参数映射：DSH {command} → Codex {cmd, shell, workdir}
* Codex exec_command 必填 cmd。
*/
function reverseArguments(dshName, rawArguments) {
	let args = {};
	try {
		args = JSON.parse(rawArguments || "{}");
	} catch {}
	if (dshName === "pwsh" || dshName === "bash") return JSON.stringify({
		cmd: String(args.command ?? ""),
		shell: "powershell",
		...args.workdir ? { workdir: args.workdir } : {}
	});
	return rawArguments || "{}";
}
//#endregion
//#region src/convert/codex2dsh.ts
const ENCRYPTED_PLACEHOLDER = (bytes) => `[加密内容 · 无法解码 · ${bytes} 字节]`;
let idSeq = 0;
function nextId$1(prefix) {
	idSeq += 1;
	return `${prefix}-${idSeq.toString(16).padStart(6, "0")}`;
}
/** 内容块规范化：加密块换为合法 text 占位，保持数组同形 */
function normalizeContent(parts, acc, ordinal, kind, author) {
	const out = [];
	for (const p of parts ?? []) {
		if (!p) continue;
		if (p.type === "encrypted_content") {
			const bytes = Buffer.byteLength(p.encrypted_content ?? "", "utf8");
			acc.blocks++;
			acc.bytes += bytes;
			acc.detail.push({
				ordinal,
				kind,
				author,
				bytes
			});
			out.push({
				type: "text",
				text: ENCRYPTED_PLACEHOLDER(bytes)
			});
		} else if (typeof p.text === "string") out.push({
			type: "text",
			text: p.text
		});
	}
	return out;
}
function reasoningText(payload) {
	return (Array.isArray(payload?.summary) ? payload.summary : []).map((s) => typeof s?.text === "string" ? s.text : "").filter(Boolean).join("\n");
}
function normalizeToolOutput(output) {
	if (typeof output === "string") return output;
	if (Array.isArray(output)) return output.map((p) => typeof p?.text === "string" ? p.text : "").filter(Boolean).join("\n");
	if (output == null) return "";
	return String(output);
}
function detectError(output) {
	const m = output.match(/Process exited with code (\d+)/);
	if (m) return Number(m[1]) !== 0;
	return /^Error[: ]/i.test(output.trim());
}
function codexToDsh(lines, opts) {
	idSeq = 0;
	const meta = lines.find((l) => l.type === "session_meta")?.payload;
	if (!meta) return {
		session: {
			header: emptyHeader(),
			events: []
		},
		report: {
			sourceId: "",
			sourceFile: opts.sourceFile,
			ok: false,
			stats: zeroStats$1(),
			encryptedDetail: [],
			warnings: [],
			error: {
				code: "NO_SESSION_META",
				message: "缺少 session_meta"
			}
		}
	};
	const acc = {
		blocks: 0,
		bytes: 0,
		detail: []
	};
	const warnings = [];
	let compactedIndex = -1;
	const compactedReplacement = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].type !== "compacted") continue;
		compactedIndex = i;
		const hist = lines[i].payload?.replacement_history;
		if (Array.isArray(hist)) for (const m of hist) {
			const text = (m?.content ?? []).map((c) => typeof c?.text === "string" ? c.text : "").filter(Boolean).join("\n");
			if (text) compactedReplacement.push({
				role: m.role ?? "user",
				text
			});
		}
	}
	const effective = compactedIndex >= 0 ? lines.slice(compactedIndex + 1).filter((l) => l.type !== "compacted") : lines;
	const turns = [];
	const turnMap = /* @__PURE__ */ new Map();
	let currentUnit = null;
	let activeTurnId = "";
	const callMeta = /* @__PURE__ */ new Map();
	const ensureTurn = (turnId) => {
		let t = turnMap.get(turnId);
		if (!t) {
			t = {
				turnId,
				units: []
			};
			turnMap.set(turnId, t);
			turns.push(t);
		}
		return t;
	};
	const ensureUnit = (t) => {
		if (!currentUnit) {
			currentUnit = {
				userMessages: [],
				agentMessages: [],
				pieces: []
			};
			t.units.push(currentUnit);
		}
		return currentUnit;
	};
	/** 取当前 unit 里最后一段 assistant；没有就新建一段 */
	const currentAssistant = (u) => {
		const last = u.pieces[u.pieces.length - 1];
		if (last && last.kind === "assistant") return last;
		const p = {
			kind: "assistant",
			reasoning: "",
			texts: [],
			toolCalls: []
		};
		u.pieces.push(p);
		return p;
	};
	for (let idx = 0; idx < effective.length; idx++) {
		const line = effective[idx];
		const ordinal = line.ordinal ?? idx;
		if (line.type === "turn_context" || line.type === "event_msg" && line.payload?.type === "task_started") {
			const id = String(line.payload?.turn_id ?? `turn-${turns.length + 1}`);
			activeTurnId = id;
			ensureTurn(id);
			currentUnit = null;
			continue;
		}
		if (line.type !== "response_item") continue;
		const item = line.payload;
		const turn = ensureTurn(activeTurnId || "turn-1");
		switch (item.type) {
			case "message":
				if (item.role === "user") {
					const content = normalizeContent(item.content, acc, ordinal, "user message");
					if (content.some((c) => c.text && !isInjectedContext(c.text))) ensureUnit(turn).userMessages.push({
						id: nextId$1("u"),
						content,
						source: {
							kind: "user",
							origin: "codex-import"
						}
					});
				} else if (item.role === "assistant") {
					const a = currentAssistant(ensureUnit(turn));
					for (const c of item.content ?? []) if (typeof c.text === "string") a.texts.push(c.text);
					else if (c.type === "encrypted_content") {
						const bytes = Buffer.byteLength(c.encrypted_content ?? "", "utf8");
						acc.blocks++;
						acc.bytes += bytes;
						acc.detail.push({
							ordinal,
							kind: "assistant message",
							bytes
						});
						a.texts.push(ENCRYPTED_PLACEHOLDER(bytes));
					}
				}
				break;
			case "reasoning": {
				const a = currentAssistant(ensureUnit(turn));
				const t = reasoningText(item);
				if (t) a.reasoning += (a.reasoning ? "\n" : "") + t;
				break;
			}
			case "function_call":
			case "custom_tool_call": {
				const m = item.type === "function_call" ? mapFunctionCall(item.name, item.arguments) : mapCustomToolCall(item.name, item.input ?? "");
				const callId = item.call_id;
				const info = {
					callId,
					name: m.name,
					arguments: m.arguments,
					degraded: m.degraded,
					note: m.note
				};
				callMeta.set(callId, info);
				currentAssistant(ensureUnit(turn)).toolCalls.push(info);
				break;
			}
			case "function_call_output":
			case "custom_tool_call_output": {
				const u = ensureUnit(turn);
				const text = normalizeToolOutput(item.output);
				const callId = item.call_id;
				const cm = callMeta.get(callId);
				u.pieces.push({
					kind: "toolResult",
					callId,
					text,
					isError: detectError(text),
					toolName: cm?.name ?? "unknown"
				});
				break;
			}
			case "agent_message": {
				const u = ensureUnit(turn);
				const content = normalizeContent(item.content, acc, ordinal, "agent message", item.author);
				u.agentMessages.push({
					id: nextId$1("am"),
					content,
					author: item.author
				});
				break;
			}
			default: break;
		}
	}
	const subagents = [];
	if (opts.includeSubagentsAsCatalog !== false) {
		const seen = /* @__PURE__ */ new Set();
		for (const l of lines) {
			if (l.type !== "event_msg") continue;
			const p = l.payload;
			if (p?.type !== "item_completed") continue;
			const it = p.item;
			if (it?.type !== "SubAgentActivity" || it.kind !== "started") continue;
			const childId = String(it.agent_thread_id ?? "");
			if (!childId || seen.has(childId)) continue;
			seen.add(childId);
			subagents.push({
				childId,
				startedAt: Date.parse(l.timestamp ?? "") || Date.now(),
				agentPath: String(it.agent_path ?? "")
			});
		}
	}
	const spawn = typeof meta.source === "object" && meta.source !== null ? meta.source?.subagent?.thread_spawn : void 0;
	const isSubagent = meta.thread_source === "subagent";
	const parentThreadId = meta.parent_thread_id ?? spawn?.parent_thread_id;
	const depth = Number(spawn?.depth ?? (isSubagent ? 1 : 0)) || 0;
	const header = {
		version: 4,
		id: `session-codex-${meta.id}`,
		createdAt: Date.parse(meta.timestamp ?? "") || Date.now(),
		isSeeded: false,
		delegationDepth: isSubagent ? Math.max(depth, 1) : 0,
		...meta.cwd ? { cwd: meta.cwd } : {},
		...isSubagent && parentThreadId ? {
			parentSession: `session-codex-${parentThreadId}`,
			origin: "subagent"
		} : {},
		agentPreset: "standard"
	};
	const events = [];
	let seq = 0;
	const push = (type, data, extra = {}) => {
		events.push({
			type,
			seq: seq++,
			time: header.createdAt + seq * 10,
			data,
			...extra
		});
	};
	let statTurns = 0, statSteps = 0, statMessages = 0, statToolCalls = 0, statToolResults = 0;
	const model = effectiveModel(effective);
	const relevantTurns = turns.filter((t) => t.units.length > 0);
	if (compactedReplacement.length > 0) {
		push("turn/start", { turn: 1 });
		push("step/start", {
			turn: 1,
			step: 1
		});
		push("user/message", {
			role: "user",
			id: nextId$1("u"),
			content: [{
				type: "text",
				text: `【上下文压缩摘要（来自 Codex）】\n\n${compactedReplacement.map((m) => m.text).join("\n\n")}`
			}],
			source: {
				kind: "user",
				origin: "codex-compaction"
			}
		}, { surfaceOp: "append" });
		push("step/end", {
			turn: 1,
			step: 1
		});
		push("turn/end", {
			turn: 1,
			reason: { kind: "completed" }
		});
		statTurns++;
		statSteps++;
		statMessages++;
	}
	const base = statTurns;
	for (let ti = 0; ti < relevantTurns.length; ti++) {
		const turnNo = base + ti + 1;
		statTurns++;
		push("turn/start", { turn: turnNo });
		for (let ui = 0; ui < relevantTurns[ti].units.length; ui++) {
			const unit = relevantTurns[ti].units[ui];
			const stepNo = ui + 1;
			statSteps++;
			push("step/start", {
				turn: turnNo,
				step: stepNo
			});
			for (const um of unit.userMessages) {
				push("user/message", {
					role: "user",
					id: um.id,
					content: um.content,
					source: um.source
				}, { surfaceOp: "append" });
				statMessages++;
			}
			for (const am of unit.agentMessages) {
				const short = String(am.author.split("/").pop() ?? am.author);
				push("user/message", {
					role: "user",
					id: am.id,
					content: [{
						type: "text",
						text: `Agent ${short} sent a message: `
					}, ...am.content],
					source: {
						kind: "agent-message",
						form: "relay",
						senderSessionId: `codex-agent-${slug(short)}`
					}
				}, { surfaceOp: "append" });
				statMessages++;
			}
			for (const piece of unit.pieces) if (piece.kind === "assistant") {
				const content = [];
				if (piece.reasoning) content.push({
					type: "reasoning",
					text: piece.reasoning
				});
				for (const t of piece.texts) content.push({
					type: "text",
					text: t
				});
				for (const tc of piece.toolCalls) content.push({
					type: "tool-call",
					id: tc.callId,
					name: tc.name,
					arguments: tc.arguments
				});
				if (content.length === 0) continue;
				push("assistant/message", {
					turn: turnNo,
					step: stepNo,
					message: {
						role: "assistant",
						id: nextId$1("a"),
						content,
						source: {
							kind: "model",
							provider: "codex-import",
							model,
							imported: true
						}
					},
					stream: []
				}, { surfaceOp: "append" });
				statMessages++;
				for (const tc of piece.toolCalls) {
					push("tool/call", {
						turn: turnNo,
						step: stepNo,
						callId: tc.callId,
						name: tc.name,
						arguments: tc.arguments
					});
					statToolCalls++;
					if (tc.degraded) warnings.push(`工具「${tc.name}」为语义降级调用${tc.note ? `：${tc.note}` : ""}，该历史结果不可重放`);
				}
			} else {
				push("tool/result", {
					turn: turnNo,
					step: stepNo,
					message: {
						role: "tool",
						id: nextId$1("tr"),
						toolCallId: piece.callId,
						source: {
							kind: "tool",
							callId: piece.callId
						},
						content: [{
							type: "text",
							text: piece.text
						}],
						isError: piece.isError
					},
					meta: {
						importedFrom: "codex",
						toolName: piece.toolName
					}
				}, { surfaceOp: "append" });
				statToolResults++;
			}
			push("step/end", {
				turn: turnNo,
				step: stepNo
			});
		}
		push("turn/end", {
			turn: turnNo,
			reason: { kind: "completed" }
		});
	}
	push("session/title", {
		title: (opts.title?.trim() || firstRealUserText(relevantTurns) || "Codex 导入会话").slice(0, 200),
		messageSeqs: [],
		source: { kind: "user" }
	});
	for (const sa of subagents) push("subagent/catalog", {
		version: 0,
		childId: sa.childId,
		childCreatedAt: sa.startedAt,
		mode: "one-shot",
		label: `${sa.agentPath}`.slice(0, 120)
	});
	push("model/selection", {
		provider: "codex-import",
		model
	});
	events.push({
		type: "codex-bridge/meta",
		seq: seq++,
		time: header.createdAt,
		ignorable: true,
		data: stripUndefined({
			sessionId: meta.id,
			parentThreadId: meta.parent_thread_id,
			threadSource: meta.thread_source,
			originator: meta.originator,
			cliVersion: meta.cli_version,
			source: typeof meta.source === "string" ? meta.source : "subagent",
			modelProvider: meta.model_provider,
			workspaceRoots: meta.runtime_workspace_roots,
			git: meta.git,
			creator: meta.creator_user_id || meta.creator_account_id ? stripUndefined({
				userId: meta.creator_user_id,
				accountId: meta.creator_account_id
			}) : void 0,
			contextWindow: meta.context_window,
			historyMode: meta.history_mode,
			baseInstructionsLength: meta.base_instructions?.text?.length,
			agentPath: meta.agent_path,
			agentNickname: meta.agent_nickname,
			sourceFile: opts.sourceFile,
			importedAt: Date.now(),
			droppedFields: collectDroppedFields(lines)
		})
	});
	push("user/message", {
		role: "user",
		id: nextId$1("notice"),
		content: [{
			type: "text",
			text: [
				"【导入说明】本会话由 Codex 导入。",
				"历史中的文件修改类工具结果（apply_patch / 写文件命令）可能已与当前磁盘不一致，",
				"路径、工作目录、环境变量也可能发生变化。",
				"在依赖这些历史结果继续操作之前，请重新执行或核对相关文件与命令输出。",
				acc.blocks > 0 ? `本会话另有 ${acc.blocks} 处加密内容无法解码，已以占位符呈现。` : ""
			].filter(Boolean).join("")
		}],
		source: {
			kind: "user",
			origin: "codex-import-notice"
		}
	}, { surfaceOp: "append" });
	return {
		session: {
			header,
			events
		},
		report: {
			sourceId: meta.id,
			sourceFile: opts.sourceFile,
			ok: true,
			targetSessionId: header.id,
			stats: {
				turns: statTurns,
				steps: statSteps,
				messages: statMessages,
				toolCalls: statToolCalls,
				toolResults: statToolResults,
				subagents: subagents.length,
				encryptedBlocks: acc.blocks,
				encryptedBytes: acc.bytes
			},
			encryptedDetail: acc.detail,
			warnings: [...new Set(warnings)]
		}
	};
}
function emptyHeader() {
	return {
		version: 4,
		id: "session-empty",
		createdAt: Date.now(),
		isSeeded: false,
		delegationDepth: 0
	};
}
function zeroStats$1() {
	return {
		turns: 0,
		steps: 0,
		messages: 0,
		toolCalls: 0,
		toolResults: 0,
		subagents: 0,
		encryptedBlocks: 0,
		encryptedBytes: 0
	};
}
function isInjectedContext(text) {
	return /^# AGENTS\.md instructions/.test(text) || /^<environment_context>/.test(text);
}
/** 递归剔除对象里的 undefined 值（DSH 要求事件无损 JSON 序列化） */
function stripUndefined(value) {
	if (Array.isArray(value)) return value.map((v) => stripUndefined(v));
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (v === void 0) continue;
			out[k] = stripUndefined(v);
		}
		return out;
	}
	return value;
}
/** 提取第一条真实的用户文本（用于缺 title 时兜底） */
function firstRealUserText(turns) {
	for (const t of turns) for (const u of t.units) for (const um of u.userMessages) for (const b of um.content) if (b.type === "text" && b.text && !isInjectedContext(b.text)) {
		const clean = b.text.replace(/\s+/g, " ").trim();
		if (clean) return clean;
	}
	return "";
}
function effectiveModel(lines) {
	for (let i = lines.length - 1; i >= 0; i--) if (lines[i].type === "turn_context") {
		const m = lines[i].payload?.model;
		if (typeof m === "string" && m) return m;
	}
	return "unknown";
}
function slug(s) {
	return s.replace(/[^A-Za-z0-9_-]/g, "_");
}
function collectDroppedFields(lines) {
	const dropped = [];
	const types = new Set(lines.map((l) => l.type));
	if (types.has("world_state")) dropped.push("world_state（环境快照，DSH 自行生成）");
	if (types.has("token_usage_record")) dropped.push("token_usage_record（逐请求用量，不进入会话历史）");
	if (types.has("event_msg")) dropped.push("event_msg/item_completed（UI 事件流，已提取关键信息）");
	return dropped;
}
//#endregion
//#region src/convert/dsh-store.ts
/**
* convert/dsh-store.ts —— DSH v4 会话文件读写（多 zstd frame）
*
* ⚠️ 核心实测结论：单个 session.v4.jsonl.zstd 由 **多个独立 zstd frame 顺序追加** 组成。
*    实测：4,334,982 字节 = 2,305 个 frame = 3,980 行事件。
*    直接 zstdDecompressSync(整个文件) 只能得到第一帧（214 字节的 header）。
*
* 正确做法：
*   读：扫描 28 B5 2F FD 魔数切帧 → 逐帧解压 → 拼接
*   写：header 一帧 + 事件逐行一帧（与 DSH 原生增量写一致）
*/
const SESSION_FILE = "session.v4.jsonl.zstd";
/** 找到所有 zstd frame 起点 */
function findFrameOffsets(buf) {
	const cuts = [];
	for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 40 && buf[i + 1] === 181 && buf[i + 2] === 47 && buf[i + 3] === 253) cuts.push(i);
	return cuts;
}
/**
* 读取 DSH v4 会话文件。
* 容忍尾部中断帧（写入中断），跳过但记录告警。
*/
function readDshSessionFile(filePath) {
	const buf = fs.readFileSync(filePath);
	const cuts = findFrameOffsets(buf);
	if (cuts.length === 0) throw new BridgeError("FILE_CORRUPTED", void 0, { file: filePath });
	const warnings = [];
	let text = "";
	for (let i = 0; i < cuts.length; i++) {
		const chunk = buf.subarray(cuts[i], cuts[i + 1] ?? buf.length);
		try {
			text += zlib.zstdDecompressSync(chunk).toString("utf8");
		} catch (e) {
			if (i < cuts.length - 1) warnings.push(`第 ${i + 1} 个数据帧损坏，已跳过（共 ${cuts.length} 帧）`);
			else warnings.push("最后一个数据帧不完整（可能是写入中断），已跳过");
		}
	}
	const rows = text.split("\n").filter((s) => s.trim());
	if (rows.length === 0) throw new BridgeError("FILE_CORRUPTED", void 0, { file: filePath });
	let header = null;
	const events = [];
	for (let i = 0; i < rows.length; i++) try {
		const o = JSON.parse(rows[i]);
		if (o.type === "session" || i === 0 && typeof o.version === "number" && typeof o.id === "string") header = normalizeHeader(o);
		else events.push(o);
	} catch {
		warnings.push(`第 ${i + 1} 行 JSON 损坏，已跳过`);
	}
	if (!header) throw new BridgeError("FILE_CORRUPTED", void 0, { file: filePath });
	return {
		header,
		events,
		warnings
	};
}
/** 兼容两种 header 形态：{type:'session',...} 或纯 {version,id,...} */
function normalizeHeader(o) {
	return {
		version: 4,
		id: String(o.id),
		createdAt: Number(o.createdAt) || Date.now(),
		isSeeded: Boolean(o.isSeeded),
		delegationDepth: Number(o.delegationDepth) || 0,
		...o.cwd ? { cwd: String(o.cwd) } : {},
		...o.parentSession ? { parentSession: String(o.parentSession) } : {},
		...o.origin ? { origin: "subagent" } : {},
		...o.agentPreset ? { agentPreset: String(o.agentPreset) } : {}
	};
}
/**
* 写入 DSH v4 会话：header 一帧，每个事件一帧。
* ★ 强制 seq 稠密（P0 实测：非稠密会被 "is not dense" 拒绝）。
*/
async function writeDshSessionFile(session, targetDir) {
	await fsp.mkdir(targetDir, { recursive: true });
	const filePath = path.join(targetDir, SESSION_FILE);
	const events = session.events.map((e, i) => ({
		...e,
		seq: i
	}));
	const headerLine = JSON.stringify({
		type: "session",
		...session.header
	}) + "\n";
	const frames = [zlib.zstdCompressSync(Buffer.from(headerLine, "utf8"))];
	for (const e of events) frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + "\n", "utf8")));
	const tmp = filePath + ".tmp-" + process.pid;
	await fsp.writeFile(tmp, Buffer.concat(frames));
	await fsp.rename(tmp, filePath);
	return filePath;
}
/** 列出某个 DSH home 下的全部会话（用于导出列表） */
async function listDshSessions(sessionsRoot) {
	const out = [];
	let projects = [];
	try {
		projects = await fsp.readdir(sessionsRoot);
	} catch {
		return out;
	}
	for (const proj of projects) {
		const projDir = path.join(sessionsRoot, proj);
		let entries = [];
		try {
			entries = await fsp.readdir(projDir);
		} catch {
			continue;
		}
		for (const ent of entries) {
			if (!ent.startsWith("session-")) continue;
			const f = path.join(projDir, ent, SESSION_FILE);
			try {
				const st = await fsp.stat(f);
				out.push({
					id: ent,
					projectDir: projDir,
					filePath: f,
					sizeBytes: st.size,
					mtime: st.mtimeMs
				});
			} catch {}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}
//#endregion
//#region src/host/paths.ts
/**
* host/paths.ts —— 路径探测与解析
*
* 桌面端需要自动定位 Codex 会话目录与 DSH home。
* 路径规则来自实测：
*   Codex:  %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl[.zst]
*   DSH:    %USERPROFILE%\.dsh\sessions\<project>\<session-id>\session.v4.jsonl.zstd
*/
/** 默认 Codex 根目录 */
function defaultCodexHome() {
	return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}
/** 默认 Codex 会话目录 */
function defaultCodexSessionsDir() {
	return path.join(defaultCodexHome(), "sessions");
}
/**
* Codex 官方会话索引（权威的 thread 列表 + thread_name 标题）。
* 实测：session_index.jsonl 记录 41 个 thread，而 rollout 文件有 140 个（含子代理线程 + turn 分片）。
*/
function codexSessionIndexFile() {
	return path.join(defaultCodexHome(), "session_index.jsonl");
}
/**
* Codex 归档会话目录（被归档的 rollout 也在这里）。
* 实测：session_index 里的 thread 有 23 个只在 archived_sessions 里。
*/
function codexArchivedSessionsDir() {
	return path.join(defaultCodexHome(), "archived_sessions");
}
/**
* ★ DSH 会话目录的 projectKey 编码（逐字复刻 dsh-session-persistence-jsonl 的实现）。
* 会话文件必须写到 sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd，
* 否则 DSH 的派生索引不会发现它、聊天列表不会显示。
*/
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
/** 默认 DSH home */
function defaultDshHome() {
	return process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
}
/** DSH 会话根目录 */
function defaultDshSessionsRoot() {
	return path.join(defaultDshHome(), "sessions");
}
/** 插件输出目录（导出 JSONL、备份、日志） */
function bridgeWorkDir() {
	return path.join(defaultDshHome(), "codex-bridge");
}
/** 导出文件目录 */
function exportDir() {
	return path.join(bridgeWorkDir(), "export");
}
/** 备份目录（按时间戳分子目录） */
function backupDir(stamp) {
	return path.join(bridgeWorkDir(), "backup", stamp);
}
/** 操作日志文件 */
function opLogFile() {
	return path.join(bridgeWorkDir(), "operations.ndjson");
}
/** 判断目录是否存在且可读 */
async function dirAccessible(p) {
	try {
		if (!(await fsp.stat(p)).isDirectory()) return {
			ok: false,
			reason: "OTHER"
		};
		await fsp.access(p, 4);
		return { ok: true };
	} catch (e) {
		if (e?.code === "ENOENT") return {
			ok: false,
			reason: "ENOENT"
		};
		if (e?.code === "EACCES" || e?.code === "EPERM") return {
			ok: false,
			reason: "EACCES"
		};
		return {
			ok: false,
			reason: "OTHER"
		};
	}
}
/** 递归列出所有 rollout 文件 */
async function listRolloutFiles(sessionsDir) {
	const out = [];
	async function walk(dir) {
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) await walk(full);
			else if (/^rollout-.*\.jsonl(\.zst)?$/.test(ent.name)) out.push(full);
		}
	}
	await walk(sessionsDir);
	return out;
}
/** DSH workspace.json 的路径 */
function workspaceRegistryFile() {
	return path.join(defaultDshHome(), "storages", "workspace.json");
}
/**
* 列出 DSH 现有工作区（导入时供用户选择目标）。
* 从 storages/workspace.json 读取 tables.workspaces。
*/
async function listWorkspaces() {
	try {
		const raw = await fsp.readFile(workspaceRegistryFile(), "utf8");
		const tables = JSON.parse(raw)?.tables?.workspaces ?? {};
		const out = [];
		for (const key of Object.keys(tables)) {
			const ws = tables[key];
			if (ws && typeof ws.path === "string") out.push({
				path: ws.path,
				title: typeof ws.title === "string" ? ws.title : path.basename(ws.path),
				sessionCount: Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0
			});
		}
		return out.sort((a, b) => b.sessionCount - a.sessionCount);
	} catch {
		return [];
	}
}
//#endregion
//#region src/host/oplog.ts
/**
* host/oplog.ts —— 关键操作日志（导入 / 导出 / 备份）
*
* 设计要点：
*  - NDJSON 追加写，天然支持并发与崩溃恢复
*  - 只记录元数据，**绝不记录消息正文**（避免敏感信息落盘）
*  - 按大小轮转，避免无限增长
*/
const MAX_LOG_BYTES = 4 * 1024 * 1024;
let dirReady = false;
async function ensureDir() {
	if (dirReady) return;
	await fsp.mkdir(path.dirname(opLogFile()), { recursive: true }).catch(() => {});
	dirReady = true;
}
async function rotateIfNeeded() {
	try {
		if ((await fsp.stat(opLogFile())).size > MAX_LOG_BYTES) {
			const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
			await fsp.rename(opLogFile(), path.join(bridgeWorkDir(), `operations-${stamp}.ndjson`));
		}
	} catch {}
}
let seq = 0;
/** 写一条操作日志 */
async function logOp(entry) {
	try {
		await ensureDir();
		await rotateIfNeeded();
		const full = {
			id: `op-${Date.now().toString(36)}-${(seq++).toString(36)}`,
			at: Date.now(),
			...entry
		};
		await fsp.appendFile(opLogFile(), JSON.stringify(full) + "\n", "utf8");
	} catch {}
}
/** 读取最近 N 条日志（用于 UI 展示） */
async function readRecentLogs(limit = 100) {
	try {
		const rows = (await fsp.readFile(opLogFile(), "utf8")).split("\n").filter((s) => s.trim());
		const out = [];
		for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) try {
			out.push(JSON.parse(rows[i]));
		} catch {}
		return out;
	} catch {
		return [];
	}
}
//#endregion
//#region src/host/import.ts
/**
* host/import.ts —— 扫描 Codex 会话 + 执行导入
*
* 流程：扫描目录 → 列会话（全部，时间倒序）→ 用户勾选 → 逐条转换 → 写入 DSH → 记日志
* 失败隔离：单个会话失败不影响其他会话（每条独立 try/catch）
*/
/**
* 扫描 Codex 会话，以 session_index.jsonl 的 thread 为准（去重、标题权威）。
* 对每个 thread 定位其 rollout 文件（主文件，非 turn 分片），提取元数据。
*/
async function scanCodexSessions(opts) {
	const codexDir = opts.codexDir?.trim() || defaultCodexSessionsDir();
	const acc = await dirAccessible(codexDir);
	if (!acc.ok) {
		if (acc.reason === "ENOENT") throw new BridgeError("CODEX_DIR_NOT_FOUND", void 0, { dir: codexDir });
		if (acc.reason === "EACCES") throw new BridgeError("PERMISSION_DENIED", void 0, { path: codexDir });
		throw new BridgeError("SCAN_FAILED", void 0, { reason: "目录不可访问" });
	}
	const files = await listRolloutFiles(codexDir);
	const archivedFiles = await listRolloutFiles(codexArchivedSessionsDir());
	const allFiles = [...files, ...archivedFiles];
	if (allFiles.length === 0) throw new BridgeError("CODEX_DIR_EMPTY");
	const index = await readSessionIndex(codexSessionIndexFile());
	const fileByThread = /* @__PURE__ */ new Map();
	for (const f of allFiles) {
		const tid = threadIdFromFileName(f);
		if (!tid) continue;
		let st;
		try {
			st = await fsp.stat(f);
		} catch {
			continue;
		}
		const prev = fileByThread.get(tid);
		if (!prev || st.mtimeMs > prev.mtimeMs) fileByThread.set(tid, {
			path: f,
			mtimeMs: st.mtimeMs
		});
	}
	const sessions = [];
	const skipped = [];
	let done = 0;
	const latestByThread = /* @__PURE__ */ new Map();
	for (const e of index) {
		const prev = latestByThread.get(e.id);
		if (!prev || (e.updated_at ?? "") >= (prev.updated_at ?? "")) latestByThread.set(e.id, {
			id: e.id,
			thread_name: e.thread_name,
			updated_at: e.updated_at ?? ""
		});
	}
	const threadIds = latestByThread.size > 0 ? [...latestByThread.keys()] : [...fileByThread.keys()];
	for (const tid of threadIds) {
		done++;
		opts.onProgress?.(done, threadIds.length);
		const entry = latestByThread.get(tid);
		const fileRec = fileByThread.get(tid);
		if (!fileRec) {
			skipped.push({
				file: `(thread ${tid})`,
				reason: "索引中有该会话，但找不到对应的 rollout 文件"
			});
			continue;
		}
		try {
			const { lines, sizeBytes } = await readRollout(fileRec.path, opts.maxBytes);
			const meta = extractMeta(lines);
			if (!meta) {
				skipped.push({
					file: fileRec.path,
					reason: describeError("NO_SESSION_META")
				});
				continue;
			}
			const summary = summarize(lines, meta, fileRec.path, sizeBytes);
			if (entry?.thread_name) summary.title = entry.thread_name.slice(0, 80);
			sessions.push(summary);
		} catch (e) {
			const be = e;
			skipped.push({
				file: fileRec.path,
				reason: be instanceof BridgeError ? describeError(be.code, be.detail ?? {}) : String(e?.message ?? e)
			});
		}
	}
	sessions.sort((a, b) => b.updatedAt - a.updatedAt);
	await logOp({
		op: "scan",
		phase: "ok",
		message: `扫描完成：${sessions.length} 个会话（去重后），跳过 ${skipped.length} 个`,
		detail: {
			codexDir,
			totalFiles: allFiles.length,
			indexedThreads: latestByThread.size
		}
	});
	return {
		codexDir,
		sessions,
		totalFiles: allFiles.length,
		skipped
	};
}
/**
* 导入单个会话。
* @param mode 'skip' 已存在则跳过；'overwrite' 覆盖
* @param targetCwd 目标 DSH 工作区路径（决定会话归属与显示位置）
*/
async function importOne(filePath, opts = {}) {
	const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();
	const mode = opts.mode ?? "skip";
	await logOp({
		op: "import",
		phase: "start",
		message: `开始导入 ${path.basename(filePath)}`,
		detail: { filePath }
	});
	let lines;
	let sizeBytes;
	try {
		const r = await readRollout(filePath, opts.maxBytes);
		lines = r.lines;
		sizeBytes = r.sizeBytes;
	} catch (e) {
		const be = e;
		const report = {
			sourceId: "",
			sourceFile: filePath,
			ok: false,
			stats: zeroStats(),
			encryptedDetail: [],
			warnings: [],
			error: {
				code: be?.code ?? "SCAN_FAILED",
				message: be instanceof BridgeError ? describeError(be.code, be.detail ?? {}) : String(e?.message ?? e)
			}
		};
		await logOp({
			op: "import",
			phase: "fail",
			message: report.error.message,
			detail: { filePath }
		});
		return { report };
	}
	let title = opts.title?.trim();
	if (!title) try {
		const tid = threadIdFromFileName(filePath);
		if (tid) {
			const entry = (await readSessionIndex(codexSessionIndexFile())).find((e) => e.id === tid);
			if (entry?.thread_name) title = entry.thread_name;
		}
	} catch {}
	let session;
	let report;
	try {
		const r = codexToDsh(lines, {
			sourceFile: filePath,
			title
		});
		session = r.session;
		report = r.report;
	} catch (e) {
		const msg = String(e?.message ?? e);
		report = {
			sourceId: "",
			sourceFile: filePath,
			ok: false,
			stats: zeroStats(),
			encryptedDetail: [],
			warnings: [],
			error: {
				code: "CONVERT_FAILED",
				message: describeError("CONVERT_FAILED", { reason: msg })
			}
		};
		await logOp({
			op: "import",
			phase: "fail",
			message: report.error.message,
			detail: { filePath }
		});
		return { report };
	}
	if (!report.ok) {
		await logOp({
			op: "import",
			phase: "fail",
			message: `转换失败：${report.error?.message}`,
			detail: { filePath }
		});
		return { report };
	}
	const targetCwd = opts.targetCwd?.trim() || (session.header.cwd ?? process.cwd());
	session.header.cwd = targetCwd;
	const projectGroup = projectKey(targetCwd);
	const targetDir = path.join(dshRoot, projectGroup, session.header.id);
	try {
		await fsp.stat(path.join(targetDir, "session.v4.jsonl.zstd"));
		if (mode === "skip") {
			report.ok = false;
			report.error = {
				code: "DSH_SESSION_EXISTS",
				message: describeError("DSH_SESSION_EXISTS", { id: session.header.id })
			};
			await logOp({
				op: "import",
				phase: "fail",
				message: report.error.message,
				sessionId: session.header.id
			});
			return { report };
		}
		const backupPath = path.join(targetDir, `backup-${Date.now()}.jsonl.zstd`);
		await fsp.copyFile(path.join(targetDir, "session.v4.jsonl.zstd"), backupPath);
		await logOp({
			op: "backup",
			phase: "ok",
			message: `覆盖前已备份旧会话到 ${path.basename(backupPath)}`,
			sessionId: session.header.id
		});
	} catch {}
	try {
		const targetFile = await writeDshSessionFile(session, targetDir);
		report.targetSessionId = session.header.id;
		try {
			await registerSessionToWorkspace(session.header.id, targetCwd);
		} catch (regErr) {
			report.warnings.push(`会话已写入，但注册到工作区失败：${String(regErr?.message ?? regErr)}（可能需要重启 DSH 后手动刷新）`);
			await logOp({
				op: "import",
				phase: "fail",
				sessionId: session.header.id,
				message: `注册到工作区失败：${String(regErr?.message ?? regErr)}`
			});
		}
		await logOp({
			op: "import",
			phase: "ok",
			sessionId: session.header.id,
			message: `导入成功：${report.stats.turns} 轮 / ${report.stats.messages} 条消息 / ${report.stats.toolCalls} 次工具调用`,
			detail: {
				sourceFile: filePath,
				sizeBytes,
				targetCwd,
				encryptedBlocks: report.stats.encryptedBlocks,
				encryptedBytes: report.stats.encryptedBytes
			}
		});
		return {
			report,
			targetFile
		};
	} catch (e) {
		const msg = String(e?.message ?? e);
		report.ok = false;
		report.error = {
			code: "DSH_WRITE_FAILED",
			message: describeError("DSH_WRITE_FAILED", { reason: msg })
		};
		await logOp({
			op: "import",
			phase: "fail",
			message: report.error.message,
			detail: { filePath }
		});
		return { report };
	}
}
/** 批量导入（逐条隔离失败） */
async function importMany(filePaths, opts = {}) {
	const results = [];
	for (const f of filePaths) {
		const { report } = await importOne(f, opts);
		results.push(report);
	}
	const ok = results.filter((r) => r.ok).length;
	return {
		results,
		ok,
		failed: results.length - ok
	};
}
/** 从内存文本导入（Web 端上传模式） */
async function importFromText(text, fileName, opts = {}) {
	const { lines, badLines } = parseRolloutText(text, fileName);
	if (lines.length === 0) return { report: {
		sourceId: "",
		sourceFile: fileName,
		ok: false,
		stats: zeroStats(),
		encryptedDetail: [],
		warnings: [],
		error: {
			code: "JSON_PARSE_FAILED",
			message: describeError("JSON_PARSE_FAILED", {
				file: fileName,
				line: 1
			})
		}
	} };
	const r = codexToDsh(lines, { sourceFile: fileName });
	const report = r.report;
	if (badLines.length > 0) report.warnings.push(`共 ${badLines.length} 行 JSON 损坏，已跳过（首行：第 ${badLines[0]} 行）`);
	if (!report.ok) return { report };
	const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();
	const targetCwd = opts.targetCwd?.trim() || (r.session.header.cwd ?? process.cwd());
	r.session.header.cwd = targetCwd;
	const targetDir = path.join(dshRoot, projectKey(targetCwd), r.session.header.id);
	try {
		await fsp.stat(path.join(targetDir, "session.v4.jsonl.zstd"));
		if ((opts.mode ?? "skip") === "skip") {
			report.ok = false;
			report.error = {
				code: "DSH_SESSION_EXISTS",
				message: describeError("DSH_SESSION_EXISTS", { id: r.session.header.id })
			};
			return { report };
		}
	} catch {}
	try {
		const targetFile = await writeDshSessionFile(r.session, targetDir);
		await logOp({
			op: "import",
			phase: "ok",
			sessionId: r.session.header.id,
			message: `上传导入成功（${fileName}）`,
			detail: { encryptedBlocks: report.stats.encryptedBlocks }
		});
		return {
			report,
			targetFile
		};
	} catch (e) {
		report.ok = false;
		report.error = {
			code: "DSH_WRITE_FAILED",
			message: describeError("DSH_WRITE_FAILED", { reason: String(e?.message ?? e) })
		};
		return { report };
	}
}
function zeroStats() {
	return {
		turns: 0,
		steps: 0,
		messages: 0,
		toolCalls: 0,
		toolResults: 0,
		subagents: 0,
		encryptedBlocks: 0,
		encryptedBytes: 0
	};
}
/**
* 把新导入的会话注册进目标工作区的 sessionIds 数组（DSH 聊天列表据此显示会话）。
*
* 实测机制（dsh-workspace 源码）：
*   - workspace.json 的 tables.workspaces.<id>.sessionIds 是持久化的会话归属列表
*   - 会话要显示，必须：文件在正确目录 + header.cwd 匹配 workspace.path + sessionId 在该数组
*   - DSH 只在首次启动（!initialized）时 bootstrap 扫描目录；已初始化后新文件不会自动注册
*
* 因此导入后需直接改写 workspace.json，把 sessionId 前置到对应 workspace 的 sessionIds。
* 注意：DSH 运行中可能缓存此文件，写入后需 DSH 重启（或触发 workspace 重载）才完全生效；
* 但至少落盘后，重启必然能看到。
*/
async function registerSessionToWorkspace(sessionId, targetCwd) {
	const file = workspaceRegistryFile();
	let raw;
	try {
		raw = await fsp.readFile(file, "utf8");
	} catch {
		return;
	}
	const data = JSON.parse(raw);
	const tables = data?.tables?.workspaces;
	if (!tables) return;
	const targetPath = targetCwd.replace(/\//g, "\\");
	for (const key of Object.keys(tables)) {
		const ws = tables[key];
		if (typeof ws?.path !== "string") continue;
		if (ws.path.replace(/\//g, "\\") !== targetPath) continue;
		const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
		if (ids.includes(sessionId)) return;
		ws.sessionIds = [sessionId, ...ids];
		ws.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await fsp.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
		return;
	}
}
//#endregion
//#region src/convert/dsh2codex.ts
/**
* 兜底 system prompt：Codex 的 session_meta.base_instructions 是加载会话的必需字段。
* 导出时若无法从来源恢复原始 prompt，用这段通用说明（真实 Codex 会话约 21k 字符，
* 这里给精简版以便 Codex 能正常打开并续聊）。
*/
const DEFAULT_BASE_INSTRUCTIONS = [
	"You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
	"",
	"# Personality",
	"You are a deeply pragmatic, effective software engineer. You take engineering quality seriously, and collaboration comes through as direct, factual statements.",
	"",
	"## Values",
	"- Clarity: communicate reasoning explicitly and concretely, so decisions and tradeoffs are easy to evaluate.",
	"- Pragmatism: keep the end goal and momentum in mind, focusing on what will actually work.",
	"- Rigor: expect technical arguments to be coherent and defensible; surface gaps and weak assumptions politely.",
	"",
	"## Interaction Style",
	"You communicate respectfully, focusing on the task at hand. You always prioritize actionable guidance and state assumptions clearly.",
	"",
	"# Note",
	"This conversation was exported from DeepSeek Harness. Historical tool results may no longer match the current workspace; re-run or verify before relying on them."
].join("\n");
function iso(t) {
	return new Date(t).toISOString();
}
/** 提取 DSH 消息中的纯文本 */
function joinText$1(content) {
	return (content ?? []).filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n");
}
/** 生成 Codex 风格的 UUID（用于 context_window.window_id 等） */
function uuidLike() {
	return crypto.randomUUID();
}
/** 安全解析 JSON 字符串为对象 */
function safeParse(raw) {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch {
		return {};
	}
}
/** 导出主函数 */
function dshToCodex(session, opts = {}) {
	const { header, events } = session;
	const warnings = [];
	const lines = [];
	let ordinal = 0;
	const emit = (type, payload, ts) => {
		lines.push({
			timestamp: iso(ts),
			ordinal: ordinal++,
			type,
			payload
		});
	};
	const metaEvt = events.find((e) => e.type === "codex-bridge/meta");
	const legacyEvt = events.find((e) => e.type === "model/selection" && e.data?.xCodexMeta);
	const xMeta = metaEvt?.data ?? (legacyEvt?.data)?.xCodexMeta ?? {};
	const threadId = xMeta.sessionId ?? deriveThreadId$1(header.id);
	const baseInstructions = xMeta.baseInstructions ?? (opts.baseInstructions ? { text: opts.baseInstructions } : { text: DEFAULT_BASE_INSTRUCTIONS });
	emit("session_meta", {
		id: threadId,
		session_id: xMeta.parentThreadId ? xMeta.parentThreadId : threadId,
		...xMeta.parentThreadId ? { parent_thread_id: xMeta.parentThreadId } : {},
		timestamp: iso(header.createdAt),
		cwd: header.cwd ?? process.cwd(),
		runtime_workspace_roots: xMeta.workspaceRoots ?? (header.cwd ? [header.cwd] : []),
		originator: xMeta.originator ?? "DeepSeek Harness",
		cli_version: xMeta.cliVersion ?? "dsh-export",
		source: xMeta.source ?? "dsh",
		thread_source: xMeta.threadSource ?? (header.origin === "subagent" ? "subagent" : "user"),
		model_provider: xMeta.modelProvider ?? "openai",
		base_instructions: baseInstructions,
		history_mode: xMeta.historyMode ?? "paginated",
		history_base: null,
		multi_agent_version: "v2",
		context_window: { window_id: xMeta.contextWindow?.window_id ?? uuidLike() },
		...xMeta.git ? { git: xMeta.git } : {},
		...xMeta.creator ? {
			creator_user_id: xMeta.creator.userId,
			creator_account_id: xMeta.creator.accountId
		} : {}
	}, header.createdAt);
	const shadowed = /* @__PURE__ */ new Set();
	for (const e of events) if (e.type === "compaction/prune") {
		const seqs = e.data?.shadowedSeqs;
		if (Array.isArray(seqs)) seqs.forEach((s) => shadowed.add(s));
		const range = e.data?.shadowedRange;
		if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) for (let s = range.start; s <= range.end; s++) shadowed.add(s);
	}
	let statMessages = 0;
	let statToolCalls = 0;
	let currentTurnId = "";
	let turnStarted = false;
	/** 当前 turn 的起始时间（用于 task_complete 的 started_at / duration_ms） */
	let turnStartMs = 0;
	/** 当前 turn 的最后一条 assistant 正文（用于 task_complete 的 last_agent_message） */
	let lastAgentMessage = "";
	/** 工具调用信息缓存（tool/call 先到，tool/result 到达时补全 CommandExecution） */
	const pendingCalls = /* @__PURE__ */ new Map();
	/**
	* ★ 生成 Codex UI 渲染所需的 item_completed 事件。
	* 实测：Codex Desktop 的消息渲染读 thread_history 投影，而投影源数据是
	* rollout 里的 `event_msg/item_completed`。缺这类事件 → UI 报 "Couldn't load messages"。
	*/
	const emitItem = (item, startedMs, completedMs, time) => {
		emit("event_msg", {
			type: "item_completed",
			thread_id: threadId,
			turn_id: currentTurnId || "turn-1",
			item,
			started_at_ms: startedMs,
			completed_at_ms: completedMs
		}, time);
	};
	const startTurn = (e) => {
		currentTurnId = `turn-${e.data?.turn ?? 1}`;
		turnStartMs = e.time;
		if (!turnStarted) {
			turnStarted = true;
			emit("event_msg", {
				type: "task_started",
				turn_attribution: {
					turn_id: currentTurnId,
					turn_trigger: "composer",
					parent_turn_id: null,
					initiating_agent_path: null,
					root_turn_id: currentTurnId
				},
				turn_id: currentTurnId,
				root_turn_id: currentTurnId,
				started_at: Math.floor(e.time / 1e3),
				model_context_window: 0,
				collaboration_mode_kind: "default"
			}, e.time);
		}
	};
	for (const e of events) {
		if (shadowed.has(e.seq)) continue;
		switch (e.type) {
			case "turn/start": {
				startTurn(e);
				const model = effectiveModelFrom(events);
				emit("turn_context", {
					turn_id: currentTurnId,
					root_turn_id: currentTurnId,
					disabled_plugin_ids: [],
					cwd: header.cwd ?? process.cwd(),
					workspace_roots: header.cwd ? [header.cwd] : [],
					current_date: new Date(e.time).toISOString().slice(0, 10),
					timezone: "UTC",
					approval_policy: "never",
					approvals_reviewer: "user",
					sandbox_policy: { type: "danger-full-access" },
					permission_profile: { type: "disabled" },
					active_permission_profile: { id: ":danger-full-access" },
					model,
					personality: "pragmatic",
					collaboration_mode: {
						mode: "default",
						settings: { model }
					},
					multi_agent_version: "v2",
					realtime_active: false,
					effort: "medium",
					summary: "auto"
				}, e.time);
				break;
			}
			case "turn/end": {
				const durMs = Math.max(0, e.time - (turnStartMs || e.time));
				emit("event_msg", {
					type: "task_complete",
					root_turn_id: currentTurnId,
					turn_id: currentTurnId,
					last_agent_message: lastAgentMessage,
					started_at: Math.floor((turnStartMs || e.time) / 1e3),
					completed_at: Math.floor(e.time / 1e3),
					duration_ms: durMs,
					time_to_first_token_ms: 0
				}, e.time);
				turnStarted = false;
				lastAgentMessage = "";
				break;
			}
			case "user/message": {
				const d = e.data;
				const src = d.source ?? {};
				const userText = (d.content ?? []).filter((b) => typeof b?.text === "string").map((b) => b.text).join("\n");
				if (src.kind === "agent-message") {
					const sender = String(src.senderSessionId ?? "unknown");
					emit("response_item", {
						type: "agent_message",
						id: `amsg_${e.seq}`,
						author: `/${sender}`,
						recipient: "/root",
						content: (d.content ?? []).map((b) => ({
							type: b.type === "text" ? "input_text" : b.type,
							...b.text !== void 0 ? { text: b.text } : {}
						}))
					}, e.time);
					emitItem({
						type: "AgentMessage",
						id: `amsg_${e.seq}`,
						content: [{
							type: "Text",
							text: userText
						}]
					}, e.time, e.time, e.time);
				} else {
					emit("response_item", {
						type: "message",
						id: d.id ?? `msg_${e.seq}`,
						role: "user",
						content: (d.content ?? []).map((b) => ({
							type: "input_text",
							text: b.text ?? ""
						}))
					}, e.time);
					emitItem({
						type: "UserMessage",
						id: d.id ?? `item-${e.seq}`,
						content: [{
							type: "text",
							text: userText,
							text_elements: []
						}]
					}, e.time, e.time, e.time);
				}
				statMessages++;
				break;
			}
			case "assistant/message": {
				const m = e.data?.message ?? {};
				const blocks = m.content ?? [];
				const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => b.text).join("\n");
				if (reasoning) {
					emit("response_item", {
						type: "reasoning",
						id: `rs_${e.seq}`,
						summary: [{
							type: "summary_text",
							text: reasoning
						}]
					}, e.time);
					emitItem({
						type: "Reasoning",
						id: `rs_${e.seq}`,
						summary_text: [reasoning]
					}, e.time, e.time, e.time);
				}
				const texts = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
				if (texts) {
					lastAgentMessage = texts.slice(0, 2e3);
					emit("response_item", {
						type: "message",
						id: m.id ?? `msg_${e.seq}`,
						role: "assistant",
						content: [{
							type: "output_text",
							text: texts
						}]
					}, e.time);
					emitItem({
						type: "AgentMessage",
						id: m.id ?? `msg_${e.seq}`,
						content: [{
							type: "Text",
							text: texts
						}]
					}, e.time, e.time, e.time);
					statMessages++;
				}
				break;
			}
			case "tool/call": {
				const d = e.data;
				const codexName = reverseToolName(d.name);
				const args = reverseArguments(d.name, d.arguments ?? "{}");
				emit("response_item", {
					type: "function_call",
					id: `fc_${d.callId}`,
					call_id: d.callId,
					name: codexName,
					arguments: args
				}, e.time);
				pendingCalls.set(d.callId, {
					name: d.name,
					args: d.arguments ?? "{}",
					time: e.time
				});
				statToolCalls++;
				break;
			}
			case "tool/result": {
				const m = e.data?.message ?? {};
				const callId = m.toolCallId ?? m.source?.callId ?? `call_${e.seq}`;
				const output = joinText$1(m.content);
				const isError = m.isError === true;
				emit("response_item", {
					type: "function_call_output",
					id: `fco_${callId}`,
					call_id: callId,
					output
				}, e.time);
				const call = pendingCalls.get(callId);
				const callArgs = call ? safeParse(call.args) : {};
				const cmdText = String(callArgs?.command ?? callArgs?.cmd ?? call?.name ?? "tool");
				call?.name;
				emitItem({
					type: "CommandExecution",
					id: callId,
					process_id: "0",
					command: [
						"pwsh",
						"-Command",
						cmdText
					],
					cwd: "file:///" + (header.cwd ?? process.cwd()).replace(/\\/g, "/"),
					parsed_cmd: [{
						type: "unknown",
						cmd: cmdText
					}],
					source: "unified_exec_startup",
					status: isError ? "failed" : "completed",
					aggregated_output: output,
					exit_code: isError ? 1 : 0,
					duration: {
						secs: 0,
						nanos: 0
					}
				}, call?.time ?? e.time, e.time, e.time);
				pendingCalls.delete(callId);
				break;
			}
			case "session/title":
				emit("event_msg", {
					type: "thread_name_updated",
					thread_name: String(e.data?.title ?? "")
				}, e.time);
				break;
			case "subagent/catalog": {
				const d = e.data;
				emit("event_msg", {
					type: "item_completed",
					item: {
						type: "SubAgentActivity",
						id: `sa_${e.seq}`,
						kind: "started",
						agent_thread_id: d.childId,
						agent_path: d.label ?? ""
					}
				}, e.time);
				break;
			}
			default: break;
		}
	}
	const jsonl = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	return {
		jsonl,
		report: {
			sourceSessionId: header.id,
			ok: true,
			stats: {
				lines: lines.length,
				messages: statMessages,
				toolCalls: statToolCalls,
				bytes: Buffer.byteLength(jsonl, "utf8")
			},
			warnings
		}
	};
}
/** 从会话中提取模型名 */
function effectiveModelFrom(events) {
	for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "model/selection") {
		const m = events[i].data?.model;
		if (typeof m === "string" && m) return m;
	}
	return "gpt-5";
}
/** DSH 会话 id → Codex thread id */
function deriveThreadId$1(dshId) {
	const m = dshId.match(/^session-codex-(.+)$/);
	if (m) return m[1];
	return dshId.replace(/^session-/, "");
}
//#endregion
//#region src/convert/dsh2wb.ts
let idCounter = 0;
function nextId(kind) {
	idCounter++;
	const n = idCounter.toString(16).padStart(12, "0");
	const seq = Date.now().toString(16).slice(-8).padStart(8, "0");
	return `${kind.padEnd(8, "0").slice(0, 8).replace(/[^0-9a-f]/g, "0")}-0000-4000-8000-${seq}${n.slice(-4)}`;
}
/** 提取消息纯文本 */
function joinText(content) {
	return (content ?? []).filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n");
}
/**
* 把 DSH 会话转换为 WorkBuddy JSONL 行。
* @param session DSH 会话
* @param sessionId WorkBuddy 会话 id（由调用方生成，需与 sessions 表一致）
* @param cwd 会话工作目录（Windows 反斜杠形式，写入 ai-title）
*/
function dshToWorkbuddy(session, opts) {
	idCounter = 0;
	const warnings = [];
	const rows = [];
	let parentId;
	let title = "";
	const callNames = /* @__PURE__ */ new Map();
	const stats = {
		rows: 0,
		messages: 0,
		toolCalls: 0,
		toolResults: 0
	};
	const push = (row) => {
		const id = nextId((typeof row.type === "string" ? row.type : "row").replace(/[^a-z]/gi, ""));
		const full = {
			id,
			...parentId ? { parentId } : {},
			...row
		};
		rows.push(full);
		parentId = id;
		stats.rows++;
		return full;
	};
	push({
		type: "session-meta",
		sessionId: opts.sessionId,
		timestamp: session.header.createdAt,
		meta: { "codebuddy.ai/hostKind": "unopted" }
	});
	for (const e of session.events) {
		const d = e.data ?? {};
		switch (e.type) {
			case "session/title":
				title = String(d.title ?? "").trim();
				break;
			case "user/message": {
				if ((d.source ?? {}).kind === "agent-message") {
					warnings.push("子代理中继消息已跳过（WorkBuddy 无对应概念）");
					break;
				}
				const text = joinText(d.content);
				if (!text) break;
				push({
					type: "message",
					timestamp: e.time,
					role: "user",
					content: [{
						type: "input_text",
						text
					}]
				});
				stats.messages++;
				break;
			}
			case "assistant/message": {
				const blocks = d.message?.content ?? [];
				const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => b.text).filter(Boolean).join("\n");
				if (reasoning) push({
					type: "reasoning",
					timestamp: e.time,
					content: [],
					rawContent: [{
						type: "reasoning_text",
						text: reasoning
					}]
				});
				const text = blocks.filter((b) => b.type === "text").map((b) => b.text).filter(Boolean).join("\n");
				if (text) {
					push({
						type: "message",
						timestamp: e.time,
						role: "assistant",
						content: [{
							type: "output_text",
							text
						}]
					});
					stats.messages++;
				}
				break;
			}
			case "tool/call":
				callNames.set(String(d.callId), String(d.name ?? "tool"));
				push({
					type: "function_call",
					timestamp: e.time,
					callId: d.callId,
					name: d.name ?? "tool",
					arguments: typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments ?? {})
				});
				stats.toolCalls++;
				break;
			case "tool/result": {
				const m = d.message ?? {};
				const callId = m.toolCallId ?? m.source?.callId;
				const output = joinText(m.content);
				push({
					type: "function_call_result",
					timestamp: e.time,
					name: callNames.get(String(callId)) ?? "tool",
					callId,
					status: m.isError ? "failed" : "completed",
					output: {
						type: "text",
						text: output
					}
				});
				stats.toolResults++;
				break;
			}
			default: break;
		}
	}
	const finalTitle = (opts.title || title || "导入会话").slice(0, 200);
	push({
		type: "ai-title",
		timestamp: Date.now(),
		aiTitle: finalTitle,
		sessionId: opts.sessionId,
		cwd: opts.cwd
	});
	return {
		rows,
		report: {
			ok: true,
			stats,
			warnings: [...new Set(warnings)]
		}
	};
}
//#endregion
//#region src/host/wb-store.ts
/**
* host/wb-store.ts —— 把会话写入 WorkBuddy 本地存储
*
* ★ 实测机制（WorkBuddy AI v5.8.4，2026-10）：
*   会话由三部分组成：
*     1. `workbuddy.db` 的 `sessions` 表 —— 元数据（必填 cwd/user_id/created_at/updated_at）
*     2. `workbuddy.db` 的 `workspaces` 表 —— 工作区列表（path 为 Windows 反斜杠形式）
*     3. `projects/<cwd编码>/<sessionId>.jsonl` —— 会话内容
*   cwd 编码规则：`D:/UE Save/x` → `d-UE Save-x`（盘符小写，冒号与斜杠都变 `-`）
*
* ⚠️ 写入顺序至关重要：必须先写数据库、再写 jsonl 文件。
*    反过来 WorkBuddy 会把无主项目目录当成垃圾清理掉（实测）。
*/
/** WorkBuddy 本地根目录（Electron userData 的上一层，实测路径） */
function defaultWorkbuddyHome() {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	return path.join(home, ".workbuddy-ai");
}
/** WorkBuddy 数据库路径 */
function workbuddyDbFile() {
	return path.join(defaultWorkbuddyHome(), "workbuddy.db");
}
/** 会话项目目录（cwd 编码后的目录名） */
function workbuddyProjectDir(cwdWin) {
	const encoded = cwdWin.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/[/:]/g, "-");
	return path.join(defaultWorkbuddyHome(), "projects", encoded);
}
/** 检测 WorkBuddy 是否已安装（数据库存在即可） */
function workbuddyAvailable() {
	try {
		return fs.existsSync(workbuddyDbFile());
	} catch {
		return false;
	}
}
/**
* 读取 WorkBuddy 的 user_id（导入的会话需要归属同一登录用户）。
*
* 三级兜底（保证换机器也能用）：
*   1. 从现有 sessions 行取（最可靠）
*   2. 从 `user-<uuid>-personal` 目录名提取（实测该目录名含 user_id）
*   3. 都没有 → 明确报错并给出操作指引
*/
function readUserId(db) {
	try {
		const row = db.prepare("SELECT user_id FROM sessions WHERE user_id IS NOT NULL LIMIT 1").get();
		if (row?.user_id) return String(row.user_id);
	} catch {}
	try {
		const home = defaultWorkbuddyHome();
		const entries = fs.readdirSync(home, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const m = e.name.match(/^user-([0-9a-fA-F-]{36})-personal$/);
			if (m) return m[1];
		}
	} catch {}
	throw new BridgeError("UNSUPPORTED_ENV", void 0, { reason: "无法确定 WorkBuddy 用户 ID。请先在 WorkBuddy 里创建并打开一个会话（或登录账号），再重试。" });
}
/**
* 把一个 DSH 会话导入 WorkBuddy。
* @param session DSH 会话
* @param opts.title 覆盖标题；opts.cwd 覆盖工作目录
*/
async function writeWorkbuddySession(session, opts = {}) {
	const dbFile = workbuddyDbFile();
	if (!fs.existsSync(dbFile)) throw new BridgeError("UNSUPPORTED_ENV", void 0, { reason: `未找到 WorkBuddy 数据库：${dbFile}（请确认 WorkBuddy 已安装并运行过）` });
	let DatabaseSync;
	try {
		({DatabaseSync} = await import("node:sqlite"));
	} catch {
		throw new BridgeError("UNSUPPORTED_ENV", void 0, { reason: "当前 Node 运行时不支持 node:sqlite，无法写入 WorkBuddy" });
	}
	const sessionId = crypto$1.randomUUID();
	const cwdWin = (opts.cwd ?? session.header.cwd ?? process.cwd()).replace(/\//g, "\\");
	const cwdPosix = cwdWin.replace(/\\/g, "/");
	const createdMs = session.header.createdAt || Date.now();
	const now = Date.now();
	const converted = dshToWorkbuddy(session, {
		sessionId,
		cwd: cwdWin,
		title: opts.title
	});
	const title = String(converted.rows.find((r) => r.type === "ai-title")?.aiTitle ?? "导入会话").slice(0, 200);
	const db = new DatabaseSync(dbFile);
	try {
		const userId = readUserId(db);
		db.prepare("INSERT OR REPLACE INTO workspaces (path, last_opened_at) VALUES (?,?)").run(cwdWin, now);
		db.prepare(`
      INSERT INTO sessions (
        id, cwd, user_id, title, status, created_at, updated_at, last_activity_at,
        is_playground, source_mode, mode, model, permission_mode, use_sandbox_cli,
        context_window, thought_level, transport
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(sessionId, cwdPosix, userId, title, "completed", createdMs, now, now, 1, "craft", "craft", "deepseek-v4.1-flash", "bypassPermissions", 1, 1e6, "high", "local");
	} catch (e) {
		db.close();
		throw new BridgeError("DSH_WRITE_FAILED", void 0, { reason: `写入 WorkBuddy 数据库失败：${String(e?.message ?? e)}` });
	} finally {
		try {
			db.close();
		} catch {}
	}
	const projectDir = workbuddyProjectDir(cwdWin);
	await fsp.mkdir(projectDir, { recursive: true });
	const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
	const text = converted.rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
	const tmp = jsonlPath + ".tmp-" + process.pid;
	await fsp.writeFile(tmp, text, "utf8");
	await fsp.rename(tmp, jsonlPath);
	return {
		ok: true,
		sessionId,
		jsonlPath,
		projectDir,
		rows: converted.rows.length
	};
}
/** 列出 WorkBuddy 里现有的会话（用于 UI 展示/去重） */
async function listWorkbuddySessions() {
	const dbFile = workbuddyDbFile();
	if (!fs.existsSync(dbFile)) return [];
	let DatabaseSync;
	try {
		({DatabaseSync} = await import("node:sqlite"));
	} catch {
		return [];
	}
	const db = new DatabaseSync(dbFile, { readOnly: true });
	try {
		return db.prepare("SELECT id, title, cwd, updated_at, model FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC").all().map((r) => ({
			id: String(r.id),
			title: String(r.title ?? ""),
			cwd: String(r.cwd ?? ""),
			updatedAt: Number(r.updated_at ?? 0),
			model: String(r.model ?? "")
		}));
	} catch {
		return [];
	} finally {
		try {
			db.close();
		} catch {}
	}
}
//#endregion
//#region src/host/export.ts
/**
* host/export.ts —— 导出 DSH 会话为 OpenAI 兼容 JSONL + 备份 Codex 旧文件
*
* 关键设计（对齐你的原始需求）：
*  - 导出只写进受控输出目录，**绝不直接写入 Codex 会话目录**（避免破坏进行中的会话）
*  - 导出瞬间自动备份 Codex 目录中的同名旧 JSONL
*  - 完成提示必须告知：手动复制 + 备份存放位置
*/
/** 列出 DSH 会话（供 UI 勾选） */
async function listExportable(dshSessionsRoot) {
	const rows = await listDshSessions(dshSessionsRoot ?? defaultDshSessionsRoot());
	const out = [];
	for (const r of rows) try {
		const s = readDshSessionFile(r.filePath);
		let turns = 0;
		let messageCount = 0;
		let titleFromEvent = "";
		for (const e of s.events) {
			if (e.type === "session/title") titleFromEvent = String(e.data?.title ?? "");
			if (e.type === "turn/start") turns++;
			if (e.type === "user/message" || e.type === "assistant/message") messageCount++;
		}
		let title = titleFromEvent;
		if (!title) {
			for (const e of s.events) if (e.type === "user/message") {
				const text = e.data?.content?.find((b) => b?.type === "text")?.text ?? "";
				if (text && !/^# AGENTS\.md instructions/.test(text)) {
					title = text.slice(0, 60);
					break;
				}
			}
		}
		const isEmpty = messageCount === 0 && turns === 0;
		out.push({
			id: s.header.id,
			title: title || (isEmpty ? "(空会话)" : "(无标题)"),
			createdAt: s.header.createdAt,
			updatedAt: r.mtime,
			sizeBytes: r.sizeBytes,
			turns,
			filePath: r.filePath,
			project: r.projectDir.split(/[\\/]/).filter(Boolean).pop() ?? "",
			isEmpty
		});
	} catch {}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
/**
* 备份 Codex 目录中与该会话对应的旧 JSONL。
*
* 匹配策略（按可靠性排序）：
*   1. 文件名包含 thread id
*   2. 同 cwd 下最近修改的 rollout（保守做法：全部同名日期目录）
*/
async function backupCodexFiles(codexSessionsDir) {
	const target = backupDir((/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-"));
	await fsp.mkdir(target, { recursive: true });
	const copied = [];
	async function walk(dir, depth = 0) {
		if (depth > 6) return;
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				await walk(full, depth + 1);
				continue;
			}
			if (!/^rollout-.*\.jsonl(\.zst)?$/.test(ent.name)) continue;
			const rel = path.relative(codexSessionsDir, full);
			const dest = path.join(target, rel);
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.copyFile(full, dest);
			copied.push(rel);
		}
	}
	await walk(codexSessionsDir);
	return {
		dir: target,
		files: copied
	};
}
/**
* 导出单个 DSH 会话。
* @param doBackup 是否备份 Codex 目录旧 JSONL（默认 true）
*/
async function exportOne(sessionId, opts = {}) {
	const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();
	const codexDir = opts.codexSessionsDir ?? defaultCodexSessionsDir();
	const doBackup = opts.doBackup !== false;
	const outDir = exportDir();
	await logOp({
		op: "export",
		phase: "start",
		sessionId,
		message: `开始导出 ${sessionId}`
	});
	const rows = await listDshSessions(dshRoot);
	const row = rows.find((r) => r.id === sessionId) ?? rows.find((r) => r.id === `session-${sessionId}`) ?? rows.find((r) => r.id.replace(/^session-/, "") === sessionId.replace(/^session-/, ""));
	if (!row) {
		const report = {
			sourceSessionId: sessionId,
			ok: false,
			stats: {
				lines: 0,
				messages: 0,
				toolCalls: 0,
				bytes: 0
			},
			warnings: [],
			error: {
				code: "SCAN_FAILED",
				message: `未找到会话 ${sessionId}`
			}
		};
		await logOp({
			op: "export",
			phase: "fail",
			sessionId,
			message: report.error.message
		});
		return {
			report,
			outFile: "",
			backupDir: "",
			backupFiles: []
		};
	}
	sessionId = row.id;
	let backup = {
		dir: "",
		files: []
	};
	if (doBackup) try {
		backup = await backupCodexFiles(codexDir);
		await logOp({
			op: "backup",
			phase: "ok",
			sessionId,
			message: `已备份 ${backup.files.length} 个 Codex JSONL 文件`,
			detail: {
				dir: backup.dir,
				count: backup.files.length
			}
		});
	} catch (e) {
		const msg = String(e?.message ?? e);
		const report = {
			sourceSessionId: sessionId,
			ok: false,
			stats: {
				lines: 0,
				messages: 0,
				toolCalls: 0,
				bytes: 0
			},
			warnings: [],
			error: {
				code: "BACKUP_FAILED",
				message: describeError("BACKUP_FAILED", { reason: msg })
			}
		};
		await logOp({
			op: "backup",
			phase: "fail",
			sessionId,
			message: report.error.message
		});
		return {
			report,
			outFile: "",
			backupDir: "",
			backupFiles: []
		};
	}
	let jsonl;
	let report;
	try {
		const session = readDshSessionFile(row.filePath);
		const r = dshToCodex({
			header: session.header,
			events: session.events
		});
		jsonl = r.jsonl;
		report = r.report;
	} catch (e) {
		const msg = String(e?.message ?? e);
		report = {
			sourceSessionId: sessionId,
			ok: false,
			stats: {
				lines: 0,
				messages: 0,
				toolCalls: 0,
				bytes: 0
			},
			warnings: [],
			error: {
				code: "CONVERT_FAILED",
				message: describeError("CONVERT_FAILED", { reason: msg })
			}
		};
		await logOp({
			op: "export",
			phase: "fail",
			sessionId,
			message: report.error.message
		});
		return {
			report,
			outFile: "",
			backupDir: backup.dir,
			backupFiles: backup.files
		};
	}
	try {
		await fsp.mkdir(outDir, { recursive: true });
		const threadId = deriveThreadId(sessionId);
		const fileName = `rollout-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/:/g, "-")}-${threadId}.jsonl`;
		const outFile = path.join(outDir, fileName);
		await fsp.writeFile(outFile, jsonl, "utf8");
		await logOp({
			op: "export",
			phase: "ok",
			sessionId,
			message: `导出成功：${report.stats.lines} 行 / ${report.stats.messages} 条消息 / ${report.stats.toolCalls} 次工具调用`,
			detail: {
				outFile,
				backupDir: backup.dir,
				backupFiles: backup.files.length
			}
		});
		return {
			report,
			outFile,
			backupDir: backup.dir,
			backupFiles: backup.files
		};
	} catch (e) {
		const msg = String(e?.message ?? e);
		report.ok = false;
		report.error = {
			code: "EXPORT_WRITE_FAILED",
			message: describeError("EXPORT_WRITE_FAILED", { reason: msg })
		};
		await logOp({
			op: "export",
			phase: "fail",
			sessionId,
			message: report.error.message
		});
		return {
			report,
			outFile: "",
			backupDir: backup.dir,
			backupFiles: backup.files
		};
	}
}
/** 批量导出 */
async function exportMany(sessionIds, opts = {}) {
	if (sessionIds.length === 0) throw new BridgeError("NO_SELECTION");
	const results = [];
	let first = true;
	for (const id of sessionIds) {
		const r = await exportOne(id, {
			...opts,
			doBackup: opts.doBackup !== false && first
		});
		first = false;
		results.push(r);
	}
	const ok = results.filter((r) => r.report.ok).length;
	return {
		results,
		ok,
		failed: results.length - ok,
		backupDir: results[0]?.backupDir ?? "",
		outDir: exportDir()
	};
}
function deriveThreadId(dshId) {
	const m = dshId.match(/^session-codex-(.+)$/);
	return m ? m[1] : dshId.replace(/^session-/, "");
}
/**
* 把 DSH 会话导入 WorkBuddy（直接写入 WorkBuddy 本地存储）。
*
* 与 Codex 导出的区别：
*   - Codex：只写受控目录，用户手动复制（因为 Codex 有正在进行的会话，避免破坏）
*   - WorkBuddy：直接写入（它用 sqlite 索引 + 独立项目目录，追加不影响现有会话）
*   写入前同样会先做备份（由调用方统一处理）。
*/
async function exportOneToWorkbuddy(sessionId, opts = {}) {
	const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();
	await logOp({
		op: "export",
		phase: "start",
		sessionId,
		message: `开始导入 WorkBuddy：${sessionId}`
	});
	if (!workbuddyAvailable()) {
		const message = "未检测到 WorkBuddy（缺少 workbuddy.db）。请先安装并运行一次 WorkBuddy。";
		await logOp({
			op: "export",
			phase: "fail",
			sessionId,
			message
		});
		return {
			sourceSessionId: sessionId,
			ok: false,
			warnings: [],
			error: {
				code: "UNSUPPORTED_ENV",
				message
			}
		};
	}
	const rows = await listDshSessions(dshRoot);
	const row = rows.find((r) => r.id === sessionId) ?? rows.find((r) => r.id === `session-${sessionId}`) ?? rows.find((r) => r.id.replace(/^session-/, "") === sessionId.replace(/^session-/, ""));
	if (!row) {
		const message = `未找到会话 ${sessionId}`;
		await logOp({
			op: "export",
			phase: "fail",
			sessionId,
			message
		});
		return {
			sourceSessionId: sessionId,
			ok: false,
			warnings: [],
			error: {
				code: "SCAN_FAILED",
				message
			}
		};
	}
	try {
		const w = await writeWorkbuddySession(readDshSessionFile(row.filePath));
		await logOp({
			op: "export",
			phase: "ok",
			sessionId: row.id,
			message: `已导入 WorkBuddy：${w.rows} 条记录`,
			detail: {
				workbuddySessionId: w.sessionId,
				jsonlPath: w.jsonlPath,
				projectDir: w.projectDir
			}
		});
		return {
			sourceSessionId: row.id,
			ok: true,
			workbuddySessionId: w.sessionId,
			jsonlPath: w.jsonlPath,
			projectDir: w.projectDir,
			rows: w.rows,
			warnings: []
		};
	} catch (e) {
		const message = e instanceof BridgeError ? describeError(e.code, e.detail ?? {}) : String(e?.message ?? e);
		await logOp({
			op: "export",
			phase: "fail",
			sessionId: row.id,
			message
		});
		return {
			sourceSessionId: row.id,
			ok: false,
			warnings: [],
			error: {
				code: "DSH_WRITE_FAILED",
				message
			}
		};
	}
}
/** 批量导入 WorkBuddy */
async function exportManyToWorkbuddy(sessionIds, opts = {}) {
	if (sessionIds.length === 0) throw new BridgeError("NO_SELECTION");
	const results = [];
	for (const id of sessionIds) results.push(await exportOneToWorkbuddy(id, opts));
	const ok = results.filter((r) => r.ok).length;
	return {
		results,
		ok,
		failed: results.length - ok
	};
}
//#endregion
//#region src/host/codex-index.ts
/**
* host/codex-index.ts —— 把导出的 rollout 注册进 Codex 索引
*
* ★ 实测机制（本机 Codex 0.16x）：
*   Codex 的会话列表【不是扫描 sessions 目录】，而是读两个索引：
*     1. `state_5.sqlite` 的 `threads` 表 —— 桌面端会话列表的主数据源
*        关键字段：id / rollout_path / cwd / title / created_at_ms / updated_at_ms ...
*        rollout_path 是 Windows 长路径格式：`\\?\F:\...\rollout-xxx.jsonl`
*     2. `session_index.jsonl` —— 轻量索引（id / thread_name / updated_at），CLI resume 用
*
*   因此导出的 JSONL 复制进 Codex 目录后，必须在 threads 表补一行，Codex 才会显示。
*   本模块就是做这件事；写入前会检查 id 是否已存在（存在则更新路径与时间）。
*
* ⚠️ 风险：直接写 Codex 的 sqlite。调用方应先让用户确认、并建议备份数据库。
*    使用 WAL 模式时并发写通常安全，但仍建议在 Codex 未进行关键操作时执行。
*/
/** Windows 长路径前缀（Codex 内部统一用这种拼写） */
function longPath(p) {
	let real = p;
	try {
		real = fs.realpathSync.native(p);
	} catch {}
	return real.startsWith("\\\\?\\") ? real : "\\\\?\\" + real;
}
/**
* 读取 rollout 文本（支持 .jsonl 明文与 .jsonl.zst 压缩）。
* Codex 有些旧会话是 zstd 压缩的，读明文会失败。
*/
function readRolloutText$1(file) {
	try {
		const buf = fs.readFileSync(file);
		if (!(buf.length >= 4 && buf[0] === 40 && buf[1] === 181 && buf[2] === 47 && buf[3] === 253)) return buf.toString("utf8");
		return zlib.zstdDecompressSync(buf).toString("utf8");
	} catch {
		return null;
	}
}
/** 从 rollout 首行读 session_meta */
function readMeta(file) {
	try {
		const text = readRolloutText$1(file);
		if (text === null) return null;
		const firstLine = text.split("\n", 1)[0];
		const row = JSON.parse(firstLine);
		if (row?.type !== "session_meta") return null;
		return row.payload;
	} catch {
		return null;
	}
}
/** 统计 rollout 里的用户消息数 + 取首条用户文本 */
function scanUserMessages(file) {
	let count = 0;
	let first = "";
	try {
		const text = readRolloutText$1(file);
		if (text === null) return {
			count,
			first
		};
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			if (!line.includes("\"role\":\"user\"")) continue;
			let o;
			try {
				o = JSON.parse(line);
			} catch {
				continue;
			}
			if (o.type === "response_item" && o.payload?.type === "message" && o.payload.role === "user") {
				count++;
				if (!first) {
					const cleaned = (o.payload.content ?? []).filter((c) => typeof c?.text === "string").map((c) => c.text).join(" ").replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, "").replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "").trim();
					if (cleaned) first = cleaned.slice(0, 500);
				}
			}
		}
	} catch {}
	return {
		count,
		first
	};
}
/**
* 把一批 rollout 文件注册进 Codex 索引。
* @param files rollout 绝对路径列表
*/
async function registerToCodex(files) {
	const codexHome = defaultCodexHome();
	const dbPath = path.join(codexHome, "state_5.sqlite");
	const indexPath = path.join(codexHome, "session_index.jsonl");
	if (!fs.existsSync(dbPath)) throw new BridgeError("SCAN_FAILED", void 0, { reason: `未找到 Codex 索引数据库：${dbPath}（请确认 Codex 已安装并运行过）` });
	let DatabaseSync;
	try {
		({DatabaseSync} = await import("node:sqlite"));
	} catch {
		throw new BridgeError("UNSUPPORTED_ENV", void 0, { reason: "当前 Node 运行时不支持 node:sqlite，无法写 Codex 索引" });
	}
	const result = {
		registered: [],
		skipped: [],
		failed: [],
		dbPath,
		indexPath
	};
	const db = new DatabaseSync(dbPath);
	try {
		const selectById = db.prepare("SELECT id FROM threads WHERE id = ?");
		const insert = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
        git_sha, git_branch, git_origin_url, cli_version, first_user_message,
        agent_nickname, agent_role, memory_mode, model, reasoning_effort, agent_path,
        created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms,
        history_mode, name, is_pinned, originator
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
		const update = db.prepare("UPDATE threads SET rollout_path=?, updated_at=?, updated_at_ms=?, recency_at=?, recency_at_ms=? WHERE id=?");
		for (const file of files) {
			const meta = readMeta(file);
			if (!meta || typeof meta.id !== "string") {
				result.failed.push({
					file,
					reason: "首行不是合法的 session_meta（缺 id）"
				});
				continue;
			}
			const threadId = meta.id;
			if (selectById.get(threadId)) {
				result.skipped.push({
					id: threadId,
					reason: "索引中已存在"
				});
				continue;
			}
			const { count, first } = scanUserMessages(file);
			const createdMs = Date.parse(meta.timestamp) || fs.statSync(file).mtimeMs || Date.now();
			const updatedMs = fs.statSync(file).mtimeMs || createdMs;
			const createdS = Math.floor(createdMs / 1e3);
			const updatedS = Math.floor(updatedMs / 1e3);
			const title = (first || "(导入会话)").slice(0, 120);
			const rp = longPath(file);
			const cwd = meta.cwd ? longPath(meta.cwd) : longPath(process.cwd());
			try {
				insert.run(threadId, rp, createdS, updatedS, "vscode", meta.model_provider || "openai", cwd, title, "{\"type\":\"disabled\"}", "never", 0, count > 0 ? 1 : 0, 0, null, meta.git?.commit_hash ?? null, meta.git?.branch ?? null, null, meta.cli_version || "0.162.0", first, null, null, "enabled", null, null, null, Math.floor(createdMs), Math.floor(updatedMs), "user", first.slice(0, 200), updatedS, Math.floor(updatedMs), "paginated", title, 0, meta.originator || "DeepSeek Harness");
				result.registered.push({
					id: threadId,
					title,
					rolloutPath: rp
				});
			} catch (e) {
				try {
					update.run(rp, updatedS, Math.floor(updatedMs), updatedS, Math.floor(updatedMs), threadId);
					result.registered.push({
						id: threadId,
						title,
						rolloutPath: rp
					});
				} catch (e2) {
					result.failed.push({
						file,
						reason: String(e2?.message ?? e2)
					});
				}
			}
		}
	} finally {
		db.close();
	}
	try {
		const existing = /* @__PURE__ */ new Set();
		if (fs.existsSync(indexPath)) for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				existing.add(JSON.parse(line).id);
			} catch {}
		}
		const append = [];
		for (const r of result.registered) {
			if (existing.has(r.id)) continue;
			append.push(JSON.stringify({
				id: r.id,
				thread_name: r.title,
				updated_at: (/* @__PURE__ */ new Date()).toISOString()
			}));
		}
		if (append.length > 0) fs.appendFileSync(indexPath, append.join("\n") + "\n", "utf8");
	} catch {}
	return result;
}
//#endregion
//#region src/host/clients.ts
/**
* host/clients.ts —— 客户端发现与能力探测
*
* ★ 多机部署关键：不同机器安装的客户端不同，必须能「探测到什么用什么」，
*   而不是假设五端都存在。
*
* 每个客户端探测分两级：
*   1. 存储存在性（目录/数据库文件是否在）
*   2. 可读写性（能否实际读取一条会话 —— 只在真正操作时检查，探测阶段不读内容）
*
* 所有路径都从 os.homedir() 与环境变量推导，无硬编码。
*/
function home() {
	return os.homedir();
}
/** 环境变量覆盖（便于测试与自定义安装位置） */
function envHome(name, fallback) {
	const v = process.env[name]?.trim();
	return v ? v : path.join(home(), fallback);
}
/** DSH 根目录 */
function dshHome() {
	return envHome("DSH_HOME", ".dsh");
}
/** Codex 根目录 */
function codexHome() {
	return envHome("CODEX_HOME", ".codex");
}
/** Zcode 根目录 */
function zcodeHome() {
	return envHome("ZCODE_HOME", ".zcode");
}
/** Claude Code 根目录 */
function claudeCodeHome() {
	return envHome("CLAUDE_HOME", ".claude");
}
/** WorkBuddy 根目录 */
function workbuddyHome() {
	return envHome("WORKBUDDY_HOME", ".workbuddy-ai");
}
/** 统计目录下的文件数（浅层，失败返回 undefined） */
function countFiles(dir, predicate) {
	let n = 0;
	let ok = false;
	try {
		const walk = (d) => {
			const ents = fs.readdirSync(d, { withFileTypes: true });
			for (const e of ents) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) {
					if (d.split(path.sep).length - dir.split(path.sep).length < 4) walk(p);
				} else if (predicate(e.name)) n++;
			}
			ok = true;
		};
		walk(dir);
	} catch {
		return;
	}
	return ok ? n : void 0;
}
/** 探测单个客户端 */
function probeClient(kind) {
	switch (kind) {
		case "dsh": {
			const root = dshHome();
			const sessions = path.join(root, "sessions");
			const detected = fs.existsSync(sessions);
			return {
				kind,
				label: "DeepSeek Harness",
				home: root,
				detected,
				canRead: detected,
				canWrite: detected,
				sessionCount: detected ? countFiles(sessions, (n) => n === "session.v4.jsonl.zstd") : void 0,
				...detected ? {} : { reason: `未找到 DSH 会话目录：${sessions}` }
			};
		}
		case "codex": {
			const root = codexHome();
			const sessions = path.join(root, "sessions");
			const db = path.join(root, "state_5.sqlite");
			const detected = fs.existsSync(sessions);
			return {
				kind,
				label: "Codex",
				home: root,
				detected,
				canRead: detected,
				canWrite: detected && fs.existsSync(db),
				sessionCount: detected ? countFiles(sessions, (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n)) : void 0,
				...detected ? {} : { reason: `未找到 Codex 会话目录：${sessions}` },
				...detected && !fs.existsSync(db) ? { reason: "未找到 state_5.sqlite，只能读取不能写入" } : {}
			};
		}
		case "zcode": {
			const root = zcodeHome();
			const db = path.join(root, "cli", "db", "db.sqlite");
			const detected = fs.existsSync(db);
			let sessionCount;
			if (detected) try {
				sessionCount = void 0;
			} catch {}
			return {
				kind,
				label: "Zcode",
				home: root,
				detected,
				canRead: detected,
				canWrite: detected,
				sessionCount,
				...detected ? {} : { reason: `未找到 Zcode 数据库：${db}` }
			};
		}
		case "claude-code": {
			const root = claudeCodeHome();
			const projects = path.join(root, "projects");
			const detected = fs.existsSync(projects);
			return {
				kind,
				label: "Claude Code",
				home: root,
				detected,
				canRead: detected,
				canWrite: detected,
				sessionCount: detected ? countFiles(projects, (n) => n.endsWith(".jsonl")) : void 0,
				...detected ? {} : { reason: `未找到 Claude Code 会话目录：${projects}` }
			};
		}
		case "workbuddy": {
			const root = workbuddyHome();
			const db = path.join(root, "workbuddy.db");
			const projects = path.join(root, "projects");
			const detected = fs.existsSync(db);
			return {
				kind,
				label: "WorkBuddy",
				home: root,
				detected,
				canRead: detected && fs.existsSync(projects),
				canWrite: detected,
				sessionCount: fs.existsSync(projects) ? countFiles(projects, (n) => n.endsWith(".jsonl")) : void 0,
				...detected ? {} : { reason: `未找到 WorkBuddy 数据库：${db}` }
			};
		}
	}
}
/** 探测所有客户端 */
function probeAllClients() {
	return [
		"dsh",
		"codex",
		"zcode",
		"claude-code",
		"workbuddy"
	].map(probeClient);
}
/**
* 平台能力说明。
*
* 当前实现针对 Windows 做了路径编码（DSH projectKey、WorkBuddy/Claude Code 目录名）。
* POSIX 系统理论上可用（路径编码函数对 `/` 也做了处理），但未经实测，
* 因此显式声明并在 UI 提示。
*/
function platformSupport() {
	const p = process.platform;
	if (p === "win32") return {
		platform: p,
		fullySupported: true,
		note: "Windows：已完整实测"
	};
	if (p === "darwin" || p === "linux") return {
		platform: p,
		fullySupported: false,
		note: `${p === "darwin" ? "macOS" : "Linux"}：路径编码逻辑已兼容，但未在真机实测，请先小样本验证`
	};
	return {
		platform: p,
		fullySupported: false,
		note: `未支持的平台：${p}`
	};
}
//#endregion
//#region src/uir/helpers.ts
/** 代码围栏 ```lang\n...\n``` */
const FENCE_RE$1 = /```[\s\S]*?```/g;
/** 行内代码 `...` */
const INLINE_CODE_RE$1 = /`[^`\n]+`/g;
/** 文件路径（Windows / Unix / UNC） */
const PATH_RE$1 = /(?:[A-Za-z]:[\\/][^\s"'<>|*?\n]+|\/(?:[\w.-]+\/){2,}[\w.-]+|\\\\[\w.$-]+\\[^\s"'<>|*?\n]+)/g;
/** 命令行 */
const CMD_RE$1 = /(?:^|\n)\s*(?:\$|>|PS>)\s+[^\n]+|(?:pwsh|powershell|bash|sh|cmd|node|npm|pnpm|git|python)\s+(?:-[A-Za-z]+\s+)*[^\n]{3,}/g;
/** 错误信息 */
const ERROR_RE$1 = /\b(?:Error|Exception|FATAL|FAILED|panic|Traceback)\b[^\n]{0,300}/g;
/** 版本号 */
const VERSION_RE$1 = /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g;
/** JSON 片段（粗略） */
const JSON_RE = /[{[][\s\S]{20,}?[}\]]/g;
/** 提取文本特征（用于价值判定与统计） */
function analyzeText(text) {
	if (!text) return {
		codeBlocks: 0,
		inlineCode: 0,
		paths: 0,
		commands: 0,
		errors: 0,
		versions: 0,
		hasJson: false,
		length: 0
	};
	return {
		codeBlocks: (text.match(FENCE_RE$1) ?? []).length,
		inlineCode: (text.match(INLINE_CODE_RE$1) ?? []).length,
		paths: (text.match(PATH_RE$1) ?? []).length,
		commands: (text.match(CMD_RE$1) ?? []).length,
		errors: (text.match(ERROR_RE$1) ?? []).length,
		versions: (text.match(VERSION_RE$1) ?? []).length,
		hasJson: JSON_RE.test(text),
		length: text.length
	};
}
/**
* 判定一段文本的价值等级。
*
* 核心思想：含技术细节（代码/路径/命令/错误）的内容是高价值，永不删；
* 纯叙述性内容可压缩；环境注入模板可丢弃。
*/
function classifyText(text, opts = {}) {
	if (!text || !text.trim()) return "low";
	if (opts.injected) return "low";
	const f = analyzeText(text);
	if (f.codeBlocks > 0 || f.errors > 0 || f.commands > 0) return "critical";
	if (f.paths >= 2 || f.paths >= 1 && f.inlineCode >= 1) return "critical";
	if (f.paths >= 1 || f.hasJson || f.versions >= 2) return "high";
	if (text.trim().length < 20) return "low";
	return "medium";
}
/** 是否为注入的上下文模板 */
function isInjectedTemplate(text) {
	return /^#\s*AGENTS\.md instructions/.test(text) || /^<environment_context>/.test(text) || /^<system-reminder>/.test(text) || /^<local-command-caveat>/.test(text) || /^Current runtime context\./.test(text) || /^Time sampled while preparing/.test(text);
}
//#endregion
//#region src/adapters/claude-code/adapter.ts
/**
* adapters/claude-code/adapter.ts —— Claude Code 会话适配器
*
* 存储格式（实测 ~/.claude/projects/<cwd编码>/<sessionId>.jsonl）：
*   cwd 编码：D:\UE Save\fpsys\FPS_Extraction → D--UE-Save-fpsys-FPS-Extraction
*   行类型：user | assistant | attachment | system | mode | permission-mode |
*          file-history-snapshot | last-prompt | cost-state | atis-latch
*
* 关键字段：
*   user:      { parentUuid, type:'user', message:{role,content}, uuid, timestamp, cwd, sessionId, isMeta }
*   assistant: { parentUuid, message:{ model, id, role, content:[text|tool_use], usage }, uuid, timestamp }
*   attachment:{ attachment:{type:'environment',snapshot:{...}}, rendered:[...] }
*
* 特点：parentUuid 形成消息树（支持分支）；attachment 承载环境快照。
*/
/**
* Claude Code 的 cwd → 目录名编码（实测）。
*
*   D:\UE Save\fpsys\FPS_Extraction → D--UE-Save-fpsys-FPS-Extraction
*
* 规则（从实测样本反推）：
*   - 盘符后的 `:` → `--`
*   - `\` 或 `/` → `-`
*   - 空格、下划线 → `-`
*/
function encodeCwdDir(cwd) {
	const driveMatch = cwd.match(/^([A-Za-z]):/);
	const drive = driveMatch ? driveMatch[1] : "";
	let rest = driveMatch ? cwd.slice(2) : cwd;
	rest = rest.replace(/[\\/]+/g, "-").replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-/, "");
	return drive ? `${drive}--${rest}` : `-${rest}`;
}
/** 反向解码（尽力而为，不保证精确——编码有损） */
function decodeCwdDir(dir) {
	return dir.replace(/^([A-Za-z])--/, "$1:\\").replace(/-/g, "\\");
}
/** 判断文本是否为 CLI 内部标记（非真实用户输入） */
function isCliMarker(text) {
	return /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder)[\s>]/.test(text) || /<\/command-name>/.test(text);
}
/** 清理标题文本（去掉 CLI 标记） */
function cleanTitle(text) {
	return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
function readLines(file) {
	const text = fs.readFileSync(file, "utf8");
	const out = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {}
	}
	return out;
}
/** 把 Claude Code 的 content 转成 UIR blocks */
function contentToBlocks(content, role) {
	const blocks = [];
	if (content === void 0 || content === null) return blocks;
	if (typeof content === "string") {
		blocks.push({
			kind: "text",
			role,
			text: content,
			tier: classifyText(content, { injected: isInjectedTemplate(content) }),
			injected: isInjectedTemplate(content)
		});
		return blocks;
	}
	if (!Array.isArray(content)) return blocks;
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		switch (b.type) {
			case "text":
				if (typeof b.text === "string") blocks.push({
					kind: "text",
					role,
					text: b.text,
					tier: classifyText(b.text, { injected: isInjectedTemplate(b.text) }),
					injected: isInjectedTemplate(b.text)
				});
				break;
			case "thinking":
				if (typeof b.thinking === "string") blocks.push({
					kind: "reasoning",
					text: b.thinking,
					tier: "medium"
				});
				break;
			case "tool_use":
				blocks.push({
					kind: "tool-call",
					callId: String(b.id ?? `call-${crypto$1.randomUUID()}`),
					name: String(b.name ?? "tool"),
					args: b.input ?? {},
					rawArgs: JSON.stringify(b.input ?? {}),
					tier: "critical"
				});
				break;
			case "tool_result": {
				const out = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => typeof x?.text === "string" ? x.text : "").join("\n") : JSON.stringify(b.content ?? "");
				blocks.push({
					kind: "tool-result",
					callId: String(b.tool_use_id ?? ""),
					output: {
						text: out,
						originalLength: out.length
					},
					isError: b.is_error === true,
					tier: "critical"
				});
				break;
			}
			case "image":
				blocks.push({
					kind: "image",
					mime: String(b.source?.media_type ?? "image/png"),
					ref: String(b.source?.data ?? b.source?.url ?? ""),
					refKind: b.source?.type === "base64" ? "data-url" : "file",
					tier: "high"
				});
				break;
			default: break;
		}
	}
	return blocks;
}
var ClaudeCodeAdapter = class {
	capability = {
		client: "claude-code",
		label: "Claude Code",
		canRead: true,
		canWrite: true,
		supportsSubagent: true,
		supportsImage: true,
		supportsFileChange: true,
		supportsBranching: true,
		lossyFields: ["消息分支结构（跨端线性化）", "file-history-snapshot 内部状态"]
	};
	probe() {
		const dir = path.join(claudeCodeHome(), "projects");
		if (!fs.existsSync(dir)) return {
			available: false,
			reason: `未找到 Claude Code 会话目录：${dir}`
		};
		return { available: true };
	}
	/** 列出所有会话 */
	async list() {
		const root = path.join(claudeCodeHome(), "projects");
		const out = [];
		let projects = [];
		try {
			projects = await fsp.readdir(root);
		} catch {
			return out;
		}
		for (const proj of projects) {
			const projDir = path.join(root, proj);
			let files = [];
			try {
				files = (await fsp.readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}
			for (const f of files) {
				const file = path.join(projDir, f);
				try {
					const st = await fsp.stat(file);
					const lines = readLines(file);
					const first = lines.find((l) => l.type === "user" || l.type === "assistant");
					const cwd = lines.find((l) => typeof l.cwd === "string")?.cwd ?? decodeCwdDir(proj);
					const sessionId = f.replace(/\.jsonl$/, "");
					let title = "(无标题)";
					for (const l of lines) if (l.type === "user" && !l.isMeta) {
						const c = l.message?.content;
						const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text ?? "").join(" ") : "";
						if (text && !isInjectedTemplate(text) && !isCliMarker(text)) {
							const t = cleanTitle(text);
							if (t) {
								title = t;
								break;
							}
						}
					}
					out.push({
						client: "claude-code",
						id: sessionId,
						title,
						cwd,
						createdAt: first?.timestamp ? Date.parse(first.timestamp) : st.birthtimeMs,
						updatedAt: st.mtimeMs,
						turns: lines.filter((l) => l.type === "user" && !l.isMeta).length
					});
				} catch {}
			}
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	/** 找到会话文件 */
	findFile(sessionId) {
		const root = path.join(claudeCodeHome(), "projects");
		let projects = [];
		try {
			projects = fs.readdirSync(root);
		} catch {
			return null;
		}
		for (const proj of projects) {
			const file = path.join(root, proj, `${sessionId}.jsonl`);
			if (fs.existsSync(file)) return file;
		}
		return null;
	}
	/** 读取为 UIR */
	async read(opts) {
		const file = this.findFile(opts.sessionId);
		if (!file) throw new Error(`未找到 Claude Code 会话：${opts.sessionId}`);
		const lines = readLines(file);
		const warnings = [];
		const cwd = lines.find((l) => typeof l.cwd === "string")?.cwd ?? "";
		const firstTs = lines.find((l) => typeof l.timestamp === "string")?.timestamp;
		const createdAt = firstTs ? Date.parse(firstTs) : Date.now();
		const model = lines.find((l) => l.message?.model)?.message?.model;
		const envSnapshot = lines.find((l) => l.attachment?.type === "environment")?.attachment?.snapshot;
		const turns = [];
		let current = null;
		let step = null;
		let title = "";
		for (const l of lines) {
			if (l.type === "user" && !l.isMeta) {
				if (current) turns.push(current);
				current = {
					index: turns.length,
					startedAt: l.timestamp ? Date.parse(l.timestamp) : Date.now(),
					userMessages: [],
					steps: [],
					rawId: l.uuid
				};
				step = {
					index: 0,
					blocks: [],
					rawId: l.uuid
				};
				current.steps.push(step);
				const real = contentToBlocks(l.message?.content, "user").filter((b) => !(b.kind === "text" && b.injected));
				for (const b of real) current.userMessages.push(b);
				if (!title) {
					const t = real.find((b) => b.kind === "text" && !isCliMarker(String(b.text)));
					if (t) title = cleanTitle(String(t.text));
				}
				continue;
			}
			if (l.type === "assistant" && current && step) {
				const blocks = contentToBlocks(l.message?.content, "assistant");
				const reasoning = blocks.filter((b) => b.kind === "reasoning").map((b) => b.text).join("\n");
				if (reasoning && !step.reasoning) step.reasoning = reasoning;
				for (const b of blocks) if (b.kind !== "reasoning") step.blocks.push(b);
				const u = l.message?.usage;
				if (u) step.usage = {
					input: u.input_tokens,
					output: u.output_tokens,
					cacheRead: u.cache_read_input_tokens,
					cacheWrite: u.cache_creation_input_tokens
				};
				continue;
			}
			if (l.type === "system" && current) {
				const blocks = contentToBlocks(l.message?.content ?? l["content"], "system");
				for (const b of blocks) if (b.kind === "text" && !b.injected) current.userMessages.push(b);
			}
		}
		if (current) turns.push(current);
		return {
			session: {
				id: `cc-${opts.sessionId}`,
				title: title || "(无标题)",
				cwd,
				createdAt,
				updatedAt: fs.statSync(file).mtimeMs,
				origin: {
					client: "claude-code",
					originalId: opts.sessionId,
					raw: {
						file,
						envSnapshot
					}
				},
				model: model ? { id: model } : void 0,
				turns,
				warnings
			},
			warnings
		};
	}
	/** 写入（UIR → Claude Code JSONL） */
	async write(session, opts = {}) {
		const cwd = opts.cwd ?? session.cwd ?? process.cwd();
		const sessionId = crypto$1.randomUUID();
		const projDir = path.join(claudeCodeHome(), "projects", encodeCwdDir(cwd));
		const file = path.join(projDir, `${sessionId}.jsonl`);
		const lines = [];
		let parentUuid = null;
		const baseMeta = {
			cwd,
			sessionId,
			version: "2.1.295",
			userType: "external",
			entrypoint: "cli"
		};
		const envUuid = crypto$1.randomUUID();
		lines.push({
			parentUuid: null,
			isSidechain: false,
			type: "attachment",
			attachment: {
				type: "environment",
				snapshot: {
					workingDirectory: cwd,
					isWorktree: false,
					isGitRepo: false,
					additionalWorkingDirectories: [],
					platform: process.platform === "win32" ? "win32" : process.platform,
					shell: "bash"
				}
			},
			uuid: envUuid,
			timestamp: new Date(session.createdAt).toISOString(),
			...baseMeta
		});
		parentUuid = envUuid;
		for (const turn of session.turns) {
			for (const b of turn.userMessages) {
				if (b.kind !== "text") continue;
				const uuid = crypto$1.randomUUID();
				lines.push({
					parentUuid,
					isSidechain: false,
					type: "user",
					message: {
						role: "user",
						content: b.text
					},
					uuid,
					timestamp: new Date(turn.startedAt).toISOString(),
					...baseMeta
				});
				parentUuid = uuid;
			}
			for (const step of turn.steps) {
				const content = [];
				if (step.reasoning) content.push({
					type: "thinking",
					thinking: step.reasoning
				});
				for (const b of step.blocks) if (b.kind === "text" && b.role === "assistant") content.push({
					type: "text",
					text: b.text
				});
				else if (b.kind === "tool-call") content.push({
					type: "tool_use",
					id: b.callId,
					name: b.name,
					input: b.args
				});
				else if (b.kind === "tool-result") content.push({
					type: "tool_result",
					tool_use_id: b.callId,
					content: b.output.text,
					is_error: b.isError
				});
				if (content.length === 0) continue;
				const uuid = crypto$1.randomUUID();
				lines.push({
					parentUuid,
					isSidechain: false,
					type: "assistant",
					message: {
						model: session.model?.id ?? "claude-sonnet-4-5",
						id: `msg_${crypto$1.randomUUID().replace(/-/g, "").slice(0, 24)}`,
						type: "message",
						role: "assistant",
						content,
						stop_reason: "end_turn",
						usage: step.usage ? {
							input_tokens: step.usage.input ?? 0,
							output_tokens: step.usage.output ?? 0,
							cache_read_input_tokens: step.usage.cacheRead ?? 0,
							cache_creation_input_tokens: step.usage.cacheWrite ?? 0
						} : void 0
					},
					uuid,
					timestamp: new Date(turn.endedAt ?? turn.startedAt).toISOString(),
					...baseMeta
				});
				parentUuid = uuid;
			}
		}
		await fsp.mkdir(projDir, { recursive: true });
		const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
		const tmp = file + ".tmp-" + process.pid;
		await fsp.writeFile(tmp, text, "utf8");
		await fsp.rename(tmp, file);
		return {
			ok: true,
			targetId: sessionId,
			location: file,
			records: lines.length,
			warnings: []
		};
	}
};
const claudeCodeAdapter = new ClaudeCodeAdapter();
//#endregion
//#region src/adapters/zcode/adapter.ts
/**
* adapters/zcode/adapter.ts —— Zcode 会话适配器
*
* 存储格式（实测 ~/.zcode/cli/db/db.sqlite）：
*   session(id, parent_id, title, directory, time_created, time_updated, ...)   126 行
*   message(id, session_id, data, sequence)                                    24584 行
*   part(id, message_id, session_id, data, sequence)                           107370 行
*
* message.data（JSON）: { role, time:{created,completed}, modelID, providerID, mode, agent,
*                         path:{cwd,root}, tokens:{...}, semantics:{...}, anchor:{turnId} }
* part.data（JSON）: { type: 'text'|'reasoning'|'tool'|'step-start'|'step-finish'|'timeline'|'file', ... }
*   - text:      { text, time:{start,end} }
*   - reasoning: { text }
*   - tool:      { callID, tool, state:{status,input,output,title}, time }
*   - step-finish: { reason, cost, tokens:{...} }
*   - timeline:  { timelineType, fromModel, toModel }
*   - file:      { mime, url, metadata }
*
* ★ 安全：Zcode 数据库有 400MB+ 且进程可能正在运行。
*   读取用 readOnly；写入前必须备份，且使用 WAL 并发写。
*/
function zcodeDbFile() {
	return path.join(zcodeHome(), "cli", "db", "db.sqlite");
}
/** 动态加载 node:sqlite */
async function openDb$1(readOnly) {
	const mod = await import("node:sqlite");
	return readOnly ? new mod.DatabaseSync(zcodeDbFile(), { readOnly: true }) : new mod.DatabaseSync(zcodeDbFile());
}
function safeJson$3(s) {
	if (typeof s !== "string") return s ?? null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
/** 把 part.data 转成 UIR block */
function partToBlock(part) {
	if (!part || typeof part !== "object") return null;
	switch (part.type) {
		case "text": {
			const text = String(part.text ?? "");
			if (!text) return null;
			return {
				kind: "text",
				role: "assistant",
				text,
				tier: classifyText(text, { injected: isInjectedTemplate(text) }),
				injected: isInjectedTemplate(text)
			};
		}
		case "reasoning": {
			const text = String(part.text ?? "");
			if (!text) return null;
			return {
				kind: "reasoning",
				text,
				tier: "medium"
			};
		}
		case "tool": {
			const callId = String(part.callID ?? part.id ?? crypto$1.randomUUID());
			const state = part.state ?? {};
			const blocks = [];
			blocks.push({
				kind: "tool-call",
				callId,
				name: String(part.tool ?? "tool"),
				args: state.input ?? {},
				rawArgs: JSON.stringify(state.input ?? {}),
				tier: "critical"
			});
			if (state.output !== void 0) {
				const out = typeof state.output === "string" ? state.output : JSON.stringify(state.output);
				blocks.push({
					kind: "tool-result",
					callId,
					name: String(part.tool ?? "tool"),
					output: {
						text: out,
						originalLength: out.length
					},
					isError: state.status === "error" || state.status === "failed",
					tier: "critical"
				});
			}
			return blocks[0];
		}
		case "file": return {
			kind: "image",
			mime: String(part.mime ?? "application/octet-stream"),
			ref: String(part.url ?? ""),
			refKind: "client-uri",
			tier: "high"
		};
		default: return null;
	}
}
var ZcodeAdapter = class {
	capability = {
		client: "zcode",
		label: "Zcode",
		canRead: true,
		canWrite: true,
		supportsSubagent: true,
		supportsImage: true,
		supportsFileChange: false,
		supportsBranching: false,
		lossyFields: ["timeline 事件（模型切换记录）", "zcode-artifact:// 图片引用（跨端失效）"]
	};
	probe() {
		const db = zcodeDbFile();
		if (!fs.existsSync(db)) return {
			available: false,
			reason: `未找到 Zcode 数据库：${db}`
		};
		return { available: true };
	}
	async list() {
		const db = await openDb$1(true);
		try {
			return db.prepare(`
        SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, s.parent_id,
               (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
        FROM session s
        WHERE s.time_deleted IS NULL
        ORDER BY s.time_updated DESC
      `).all().map((r) => ({
				client: "zcode",
				id: String(r.id),
				title: String(r.title ?? "(无标题)"),
				cwd: String(r.directory ?? ""),
				createdAt: Number(r.time_created ?? 0),
				updatedAt: Number(r.time_updated ?? 0),
				turns: Math.floor(Number(r.msg_count ?? 0) / 2)
			}));
		} finally {
			db.close();
		}
	}
	async read(opts) {
		const db = await openDb$1(true);
		const warnings = [];
		try {
			const sess = db.prepare("SELECT * FROM session WHERE id = ?").get(opts.sessionId);
			if (!sess) throw new Error(`未找到 Zcode 会话：${opts.sessionId}`);
			let modelInfo;
			try {
				const entry = db.prepare("SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection' LIMIT 1").get(opts.sessionId);
				if (entry?.data) {
					const d = safeJson$3(entry.data);
					const ms = d?.modelSelection ?? d;
					if (ms) modelInfo = {
						provider: ms.providerId ? String(ms.providerId) : void 0,
						id: ms.modelId ? String(ms.modelId) : void 0,
						variant: ms.options?.reasoningLevel ? String(ms.options.reasoningLevel) : void 0
					};
				}
			} catch {}
			const messages = db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY sequence ASC, time_created ASC").all(opts.sessionId);
			const parts = db.prepare("SELECT * FROM part WHERE session_id = ? ORDER BY sequence ASC, time_created ASC").all(opts.sessionId);
			const partsByMsg = /* @__PURE__ */ new Map();
			for (const p of parts) {
				const mid = String(p.message_id);
				if (!partsByMsg.has(mid)) partsByMsg.set(mid, []);
				partsByMsg.get(mid).push(safeJson$3(p.data));
			}
			const turns = [];
			let current = null;
			let step = null;
			let title = String(sess.title ?? "");
			for (const m of messages) {
				const md = safeJson$3(m.data) ?? {};
				const role = String(md.role ?? "");
				const msgParts = partsByMsg.get(String(m.id)) ?? [];
				if (role === "user") {
					if (current) turns.push(current);
					current = {
						index: turns.length,
						startedAt: Number(md.time?.created ?? m.time_created ?? Date.now()),
						endedAt: Number(md.time?.completed ?? 0) || void 0,
						userMessages: [],
						steps: [],
						rawId: String(m.id)
					};
					step = {
						index: 0,
						blocks: [],
						rawId: String(m.id)
					};
					current.steps.push(step);
					for (const p of msgParts) {
						const b = partToBlock(p);
						if (b && b.kind === "text") {
							b.role = "user";
							const real = !b.injected;
							current.userMessages.push(b);
							if (real && !title) title = b.text.replace(/\s+/g, " ").slice(0, 80);
						}
					}
					continue;
				}
				if (role === "assistant" && current && step) {
					const tk = md.tokens;
					if (tk) step.usage = {
						input: Number(tk.input ?? 0) || void 0,
						output: Number(tk.output ?? 0) || void 0,
						reasoning: Number(tk.reasoning ?? 0) || void 0,
						cacheRead: Number(tk.cache?.read ?? 0) || void 0,
						cacheWrite: Number(tk.cache?.write ?? 0) || void 0
					};
					for (const p of msgParts) {
						if (!p) continue;
						if (p.type === "reasoning") {
							const text = String(p.text ?? "");
							if (text) step.reasoning = step.reasoning ? `${step.reasoning}\n${text}` : text;
							continue;
						}
						if (p.type === "tool") {
							const callId = String(p.callID ?? crypto$1.randomUUID());
							const state = p.state ?? {};
							step.blocks.push({
								kind: "tool-call",
								callId,
								name: String(p.tool ?? "tool"),
								args: state.input ?? {},
								rawArgs: JSON.stringify(state.input ?? {}),
								tier: "critical"
							});
							if (state.output !== void 0) {
								const out = typeof state.output === "string" ? state.output : JSON.stringify(state.output);
								step.blocks.push({
									kind: "tool-result",
									callId,
									name: String(p.tool ?? "tool"),
									output: {
										text: out,
										originalLength: out.length
									},
									isError: state.status === "error" || state.status === "failed",
									tier: "critical"
								});
							}
							continue;
						}
						const b = partToBlock(p);
						if (b) step.blocks.push(b);
					}
					continue;
				}
			}
			if (current) turns.push(current);
			return {
				session: {
					id: `zc-${opts.sessionId}`,
					title: title || "(无标题)",
					cwd: String(sess.directory ?? ""),
					createdAt: Number(sess.time_created ?? Date.now()),
					updatedAt: Number(sess.time_updated ?? Date.now()),
					origin: {
						client: "zcode",
						originalId: opts.sessionId,
						clientVersion: sess.version ? String(sess.version) : void 0,
						raw: {
							parentId: sess.parent_id,
							permission: safeJson$3(sess.permission)
						}
					},
					parent: sess.parent_id ? {
						client: "zcode",
						threadId: String(sess.parent_id)
					} : void 0,
					model: modelInfo,
					turns,
					warnings
				},
				warnings
			};
		} finally {
			db.close();
		}
	}
	async write(session, opts = {}) {
		const dbFile = zcodeDbFile();
		const backupDir = path.join(zcodeHome(), "cli", "db", "dsh-bridge-backups");
		await fsp.mkdir(backupDir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const backupFile = path.join(backupDir, `db-${stamp}.sqlite`);
		await fsp.copyFile(dbFile, backupFile);
		const db = await openDb$1(false);
		const sessionId = `sess_${crypto$1.randomUUID()}`;
		const cwd = opts.cwd ?? session.cwd ?? process.cwd();
		const now = Date.now();
		const title = (opts.title ?? session.title ?? "导入会话").slice(0, 200);
		try {
			const projectId = `proj_${cwd.replace(/[\\/:]/g, "-").toLowerCase()}`;
			db.prepare(`
        INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path,
                             title, version, time_created, time_updated, title_source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(sessionId, projectId, null, null, sessionId, cwd, cwd, title, "0.16.5", session.createdAt, now, "custom");
			let msgSeq = 0;
			let partSeq = 0;
			const insertMsg = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)");
			const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)");
			for (const turn of session.turns) {
				const userText = turn.userMessages.filter((b) => b.kind === "text").map((b) => b.text).join("\n");
				if (userText) {
					const mid = `msg_${crypto$1.randomUUID().replace(/-/g, "").slice(0, 16)}_message`;
					insertMsg.run(mid, sessionId, turn.startedAt, turn.startedAt, JSON.stringify({
						role: "user",
						time: { created: turn.startedAt },
						path: {
							cwd,
							root: cwd
						},
						semantics: {
							origin: "real_user",
							kind: "user_prompt"
						},
						anchor: { turnId: `turn_${crypto$1.randomUUID()}` }
					}), msgSeq++);
					insertPart.run(`part_${crypto$1.randomUUID().replace(/-/g, "").slice(0, 16)}`, mid, sessionId, turn.startedAt, turn.startedAt, JSON.stringify({
						type: "text",
						text: userText,
						time: {
							start: turn.startedAt,
							end: turn.startedAt
						}
					}), partSeq++);
				}
				for (const step of turn.steps) {
					const mid = `msg_${crypto$1.randomUUID().replace(/-/g, "").slice(0, 16)}_message`;
					const ts = turn.endedAt ?? turn.startedAt;
					insertMsg.run(mid, sessionId, ts, ts, JSON.stringify({
						role: "assistant",
						time: {
							created: ts,
							completed: ts
						},
						modelID: session.model?.id ?? "GLM-5.3-Flash",
						providerID: session.model?.provider ?? "builtin:zai-start-plan",
						mode: "craft",
						agent: "zcode-agent",
						path: {
							cwd,
							root: cwd
						},
						tokens: step.usage ? {
							input: step.usage.input ?? 0,
							output: step.usage.output ?? 0,
							reasoning: step.usage.reasoning ?? 0,
							cache: {
								read: step.usage.cacheRead ?? 0,
								write: step.usage.cacheWrite ?? 0
							}
						} : void 0,
						semantics: {
							origin: "system",
							kind: "assistant_message"
						}
					}), msgSeq++);
					if (step.reasoning) insertPart.run(`part_${crypto$1.randomUUID().replace(/-/g, "").slice(0, 16)}`, mid, sessionId, ts, ts, JSON.stringify({
						type: "reasoning",
						text: step.reasoning
					}), partSeq++);
					for (const b of step.blocks) if (b.kind === "text" && b.role === "assistant") insertPart.run(`part_${crypto$1.randomUUID().replace(/-/g, "").slice(0, 16)}`, mid, sessionId, ts, ts, JSON.stringify({
						type: "text",
						text: b.text,
						time: {
							start: ts,
							end: ts
						}
					}), partSeq++);
					else if (b.kind === "tool-call") {
						const result = step.blocks.find((x) => x.kind === "tool-result" && x.callId === b.callId);
						insertPart.run(`part_${crypto$1.randomUUID().replace(/-/g, "").slice(0, 16)}`, mid, sessionId, ts, ts, JSON.stringify({
							type: "tool",
							callID: b.callId,
							tool: b.name,
							state: {
								status: result ? result.isError ? "error" : "completed" : "completed",
								input: b.args ?? {},
								...result ? { output: result.output.text } : {},
								title: b.name
							},
							time: {
								start: ts,
								end: ts
							}
						}), partSeq++);
					}
				}
			}
			return {
				ok: true,
				targetId: sessionId,
				location: `${dbFile}#session=${sessionId}`,
				records: msgSeq + partSeq,
				warnings: [`已备份原数据库到 ${backupFile}`]
			};
		} finally {
			db.close();
		}
	}
};
const zcodeAdapter = new ZcodeAdapter();
//#endregion
//#region src/adapters/dsh/adapter.ts
/**
* adapters/dsh/adapter.ts —— DSH 会话适配器
*
* 复用现有的 `convert/dsh-store.ts`（v4 多帧 zstd 读写）。
* 存储：~/.dsh/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd
*
* DSH v4 事件模型 → UIR 映射：
*   turn/start + turn/end        → UirTurn
*   step/start + step/end        → UirStep
*   user/message                 → turn.userMessages
*   assistant/message            → step.blocks (text) + step.reasoning
*   tool/call + tool/result      → step.blocks (tool-call / tool-result)
*   session/title                → session.title
*   subagent/catalog             → opaque
*   compaction/prune             → opaque
*/
function dshSessionsRoot() {
	return path.join(dshHome(), "sessions");
}
var DshAdapter = class {
	capability = {
		client: "dsh",
		label: "DeepSeek Harness",
		canRead: true,
		canWrite: true,
		supportsSubagent: true,
		supportsImage: true,
		supportsFileChange: true,
		supportsBranching: false,
		lossyFields: ["加密思考内容（无法解码，仅保留占位）"]
	};
	probe() {
		const root = dshSessionsRoot();
		if (!fs.existsSync(root)) return {
			available: false,
			reason: `未找到 DSH 会话目录：${root}`
		};
		return { available: true };
	}
	async list() {
		const rows = await listDshSessions(dshSessionsRoot());
		const out = [];
		for (const r of rows) try {
			const s = readDshSessionFile(r.filePath);
			let title = "";
			let turns = 0;
			let messages = 0;
			for (const e of s.events) {
				if (e.type === "session/title") title = String(e.data?.title ?? "");
				if (e.type === "turn/start") turns++;
				if (e.type === "user/message" || e.type === "assistant/message") messages++;
			}
			if (!title) {
				for (const e of s.events) if (e.type === "user/message") {
					const text = (e.data?.content ?? []).filter((b) => typeof b?.text === "string").map((b) => b.text).join(" ");
					if (text && !isInjectedTemplate(text)) {
						title = text.replace(/\s+/g, " ").slice(0, 80);
						break;
					}
				}
			}
			out.push({
				client: "dsh",
				id: s.header.id,
				title: title || (messages === 0 ? "(空会话)" : "(无标题)"),
				cwd: s.header.cwd ?? "",
				createdAt: s.header.createdAt,
				updatedAt: r.mtime,
				turns
			});
		} catch {}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	async read(opts) {
		const rows = await listDshSessions(dshSessionsRoot());
		const row = rows.find((r) => r.id === opts.sessionId) ?? rows.find((r) => r.id.replace(/^session-/, "") === opts.sessionId.replace(/^session-/, ""));
		if (!row) throw new Error(`未找到 DSH 会话：${opts.sessionId}`);
		const s = readDshSessionFile(row.filePath);
		const warnings = [];
		const turns = [];
		const opaque = [];
		let title = "";
		let current = null;
		let step = null;
		let modelInfo;
		for (const e of s.events) {
			const d = e.data ?? {};
			switch (e.type) {
				case "session/title":
					title = String(d.title ?? "");
					break;
				case "turn/start":
					if (current) turns.push(current);
					current = {
						index: turns.length,
						startedAt: e.time,
						userMessages: [],
						steps: []
					};
					step = null;
					break;
				case "step/start":
					if (current) {
						step = {
							index: current.steps.length,
							blocks: []
						};
						current.steps.push(step);
					}
					break;
				case "user/message":
					if (!current) break;
					if ((d.source ?? {}).kind === "agent-message") {
						const text = (d.content ?? []).filter((b) => typeof b?.text === "string").map((b) => b.text).join("\n");
						if (text) current.userMessages.push({
							kind: "text",
							role: "user",
							text,
							tier: "high"
						});
						break;
					}
					for (const b of d.content ?? []) if (b?.type === "text" && typeof b.text === "string") current.userMessages.push({
						kind: "text",
						role: "user",
						text: b.text,
						tier: classifyText(b.text, { injected: isInjectedTemplate(b.text) }),
						injected: isInjectedTemplate(b.text)
					});
					break;
				case "assistant/message": {
					if (!current) break;
					if (!step) {
						step = {
							index: current.steps.length,
							blocks: []
						};
						current.steps.push(step);
					}
					const blocks = d.message?.content ?? [];
					const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => b.text).filter(Boolean).join("\n");
					if (reasoning) step.reasoning = step.reasoning ? `${step.reasoning}\n${reasoning}` : reasoning;
					for (const b of blocks) if (b?.type === "text" && typeof b.text === "string") step.blocks.push({
						kind: "text",
						role: "assistant",
						text: b.text,
						tier: classifyText(b.text, { injected: isInjectedTemplate(b.text) }),
						injected: isInjectedTemplate(b.text)
					});
					else if (b?.type === "tool-call") step.blocks.push({
						kind: "tool-call",
						callId: String(b.id ?? `call-${e.seq}`),
						name: String(b.name ?? "tool"),
						args: safeJson$2(b.arguments),
						rawArgs: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
						tier: "critical"
					});
					break;
				}
				case "tool/result": {
					if (!current || !step) break;
					const m = d.message ?? {};
					const out = (m.content ?? []).filter((b) => typeof b?.text === "string").map((b) => b.text).join("\n");
					step.blocks.push({
						kind: "tool-result",
						callId: String(m.toolCallId ?? m.source?.callId ?? `call-${e.seq}`),
						output: {
							text: out,
							originalLength: out.length
						},
						isError: m.isError === true,
						tier: "critical"
					});
					break;
				}
				case "model/selection":
					modelInfo = {
						provider: d.provider ? String(d.provider) : void 0,
						id: d.model ? String(d.model) : void 0
					};
					break;
				case "subagent/catalog":
				case "compaction/prune":
				case "compaction/summary":
				case "codex-bridge/meta":
					opaque.push({
						kind: e.type,
						seq: e.seq,
						payload: d
					});
					break;
				default: break;
			}
		}
		if (current) turns.push(current);
		return {
			session: {
				id: `dsh-${s.header.id}`,
				title: title || "(无标题)",
				cwd: s.header.cwd ?? "",
				createdAt: s.header.createdAt,
				updatedAt: row.mtime,
				origin: {
					client: "dsh",
					originalId: s.header.id,
					raw: {
						isSeeded: s.header.isSeeded,
						delegationDepth: s.header.delegationDepth,
						agentPreset: s.header.agentPreset,
						parentSession: s.header.parentSession
					}
				},
				parent: s.header.parentSession ? {
					client: "dsh",
					threadId: String(s.header.parentSession)
				} : void 0,
				model: modelInfo,
				turns,
				opaque: opaque.length > 0 ? opaque : void 0,
				warnings
			},
			warnings
		};
	}
	async write(session, opts = {}) {
		const cwd = opts.cwd ?? session.cwd ?? process.cwd();
		const sessionId = session.origin.client === "dsh" ? session.origin.originalId : `session-${crypto$1.randomUUID()}`;
		const events = [];
		let seq = 0;
		const push = (type, data, time, extra = {}) => {
			events.push({
				type,
				seq: seq++,
				time,
				data,
				...extra
			});
		};
		for (const turn of session.turns) {
			push("turn/start", { turn: turn.index + 1 }, turn.startedAt);
			push("step/start", {
				turn: turn.index + 1,
				step: 1
			}, turn.startedAt);
			for (const b of turn.userMessages) {
				if (b.kind !== "text") continue;
				push("user/message", {
					role: "user",
					id: `u-${seq}`,
					content: [{
						type: "text",
						text: b.text
					}]
				}, turn.startedAt, { surfaceOp: "append" });
			}
			for (const step of turn.steps) {
				if (step.reasoning) push("assistant/message", {
					turn: turn.index + 1,
					step: 1,
					message: {
						role: "assistant",
						id: `a-${seq}`,
						content: [{
							type: "reasoning",
							text: step.reasoning
						}],
						source: {
							kind: "model",
							provider: "dsh-bridge",
							model: session.model?.id ?? "imported",
							imported: true
						}
					},
					stream: []
				}, turn.endedAt ?? turn.startedAt, { surfaceOp: "append" });
				const textBlocks = step.blocks.filter((b) => b.kind === "text" && b.role === "assistant");
				const toolCalls = step.blocks.filter((b) => b.kind === "tool-call");
				if (textBlocks.length > 0 || toolCalls.length > 0) {
					const content = [];
					for (const b of textBlocks) content.push({
						type: "text",
						text: b.text
					});
					for (const b of toolCalls) content.push({
						type: "tool-call",
						id: b.callId,
						name: b.name,
						arguments: b.rawArgs ?? JSON.stringify(b.args ?? {})
					});
					push("assistant/message", {
						turn: turn.index + 1,
						step: 1,
						message: {
							role: "assistant",
							id: `a-${seq}`,
							content,
							source: {
								kind: "model",
								provider: "dsh-bridge",
								model: session.model?.id ?? "imported",
								imported: true
							}
						},
						stream: []
					}, turn.endedAt ?? turn.startedAt, { surfaceOp: "append" });
					for (const b of toolCalls) push("tool/call", {
						turn: turn.index + 1,
						step: 1,
						callId: b.callId,
						name: b.name,
						arguments: b.rawArgs ?? JSON.stringify(b.args ?? {})
					}, turn.endedAt ?? turn.startedAt);
				}
				for (const b of step.blocks) {
					if (b.kind !== "tool-result") continue;
					push("tool/result", {
						turn: turn.index + 1,
						step: 1,
						message: {
							role: "tool",
							id: `tr-${seq}`,
							toolCallId: b.callId,
							source: {
								kind: "tool",
								callId: b.callId
							},
							content: [{
								type: "text",
								text: b.output.text
							}],
							isError: b.isError
						}
					}, turn.endedAt ?? turn.startedAt, { surfaceOp: "append" });
				}
			}
			push("step/end", {
				turn: turn.index + 1,
				step: 1
			}, turn.endedAt ?? turn.startedAt);
			push("turn/end", {
				turn: turn.index + 1,
				reason: { kind: "completed" }
			}, turn.endedAt ?? turn.startedAt);
		}
		push("session/title", {
			title: (opts.title ?? session.title ?? "导入会话").slice(0, 200),
			messageSeqs: [],
			source: { kind: "user" }
		}, session.createdAt);
		if (session.model?.id) push("model/selection", {
			provider: session.model.provider ?? "dsh-bridge",
			model: session.model.id
		}, session.createdAt);
		const header = {
			version: 4,
			id: sessionId,
			createdAt: session.createdAt,
			isSeeded: false,
			delegationDepth: 0,
			cwd,
			agentPreset: "standard"
		};
		const targetDir = path.join(dshSessionsRoot(), projectKey(cwd), encodeSegment(sessionId));
		const file = await writeDshSessionFile({
			header,
			events
		}, targetDir);
		const warnings = [];
		try {
			await registerToWorkspace(sessionId, cwd);
			warnings.push("DSH 需要重启后才会在工作区列表看到该会话");
		} catch (e) {
			warnings.push(`会话已写入，但注册到工作区失败：${String(e?.message ?? e)}（重启 DSH 后可能仍不可见）`);
		}
		return {
			ok: true,
			targetId: sessionId,
			location: file,
			records: events.length,
			warnings
		};
	}
};
/**
* 把新会话注册进 DSH 的 workspace.json。
*
* DSH 的会话列表来自 `storages/workspace.json` 的 `tables.workspaces.<id>.sessionIds`，
* 而不是扫描 sessions 目录。不注册的话，文件在磁盘上但列表看不到。
*/
async function registerToWorkspace(sessionId, cwd) {
	const file = path.join(dshHome(), "storages", "workspace.json");
	let raw;
	try {
		raw = await fsp.readFile(file, "utf8");
	} catch {
		return;
	}
	const data = JSON.parse(raw);
	const tables = data?.tables?.workspaces;
	if (!tables) return;
	const norm = (p) => p.replace(/\//g, "\\").toLowerCase();
	const target = norm(cwd);
	for (const key of Object.keys(tables)) {
		const ws = tables[key];
		if (typeof ws?.path !== "string") continue;
		if (norm(ws.path) !== target) continue;
		const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
		if (ids.includes(sessionId)) return;
		ws.sessionIds = [sessionId, ...ids];
		ws.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await fsp.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
		return;
	}
}
function safeJson$2(s) {
	if (typeof s !== "string") return s ?? {};
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
}
const dshAdapter = new DshAdapter();
//#endregion
//#region src/adapters/codex/adapter.ts
/**
* adapters/codex/adapter.ts —— Codex 会话适配器
*
* 复用现有 `convert/codex-reader.ts` 与 `convert/dsh2codex.ts` 的部分逻辑。
* 存储：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` + `state_5.sqlite` 索引
*
* Codex rollout 行类型 → UIR：
*   session_meta       → session 元信息
*   turn_context       → turn 边界
*   response_item/message        → text 块
*   response_item/reasoning      → step.reasoning
*   response_item/function_call  → tool-call
*   response_item/function_call_output → tool-result
*   event_msg/item_completed     → 作为 opaque（UI 渲染源，保真用）
*/
function codexSessionsDir() {
	return path.join(codexHome(), "sessions");
}
/** 递归列 rollout 文件 */
function listRollouts() {
	const root = codexSessionsDir();
	const out = [];
	const walk = (d, depth) => {
		if (depth > 6) return;
		let ents;
		try {
			ents = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of ents) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p, depth + 1);
			else if (/^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) out.push(p);
		}
	};
	walk(root, 0);
	return out;
}
/** 读 rollout 文本（支持 .zst） */
function readRolloutText(file) {
	try {
		const buf = fs.readFileSync(file);
		if (!(buf.length >= 4 && buf[0] === 40 && buf[1] === 181 && buf[2] === 47 && buf[3] === 253)) return buf.toString("utf8");
		return __require("node:zlib").zstdDecompressSync(buf).toString("utf8");
	} catch {
		return null;
	}
}
/** 从文件名提取 thread id */
function threadIdFromFile(file) {
	const m = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
	return m ? m[0] : null;
}
var CodexAdapter = class {
	capability = {
		client: "codex",
		label: "Codex",
		canRead: true,
		canWrite: true,
		supportsSubagent: true,
		supportsImage: true,
		supportsFileChange: true,
		supportsBranching: false,
		lossyFields: ["加密内容 encrypted_content（仅占位）", "子代理会话需合并到父会话"]
	};
	probe() {
		const root = codexSessionsDir();
		if (!fs.existsSync(root)) return {
			available: false,
			reason: `未找到 Codex 会话目录：${root}`
		};
		return { available: true };
	}
	async list() {
		const files = listRollouts();
		const byThread = /* @__PURE__ */ new Map();
		for (const f of files) {
			const tid = threadIdFromFile(f);
			if (!tid) continue;
			try {
				const st = fs.statSync(f);
				const prev = byThread.get(tid);
				if (!prev || st.mtimeMs > prev.mtime) byThread.set(tid, {
					file: f,
					mtime: st.mtimeMs
				});
			} catch {}
		}
		const titleById = /* @__PURE__ */ new Map();
		try {
			const idx = path.join(codexHome(), "session_index.jsonl");
			if (fs.existsSync(idx)) for (const line of fs.readFileSync(idx, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const o = JSON.parse(line);
					if (o.id && o.thread_name) titleById.set(String(o.id), String(o.thread_name));
				} catch {}
			}
		} catch {}
		const out = [];
		for (const [tid, rec] of byThread) try {
			const st = fs.statSync(rec.file);
			out.push({
				client: "codex",
				id: tid,
				title: titleById.get(tid) ?? "(无标题)",
				cwd: "",
				createdAt: st.birthtimeMs,
				updatedAt: rec.mtime
			});
		} catch {}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	async read(opts) {
		const files = listRollouts();
		const target = files.find((f) => threadIdFromFile(f) === opts.sessionId) ?? files.find((f) => path.basename(f).includes(opts.sessionId));
		if (!target) throw new Error(`未找到 Codex 会话：${opts.sessionId}`);
		const text = readRolloutText(target);
		if (!text) throw new Error(`无法读取 Codex 会话文件：${target}`);
		const rows = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line));
			} catch {}
		}
		const warnings = [];
		const turns = [];
		const opaque = [];
		let current = null;
		let step = null;
		let title = "";
		let cwd = "";
		let createdAt = Date.now();
		let model;
		const ensureTurn = (ts) => {
			if (!current) {
				current = {
					index: turns.length,
					startedAt: ts,
					userMessages: [],
					steps: []
				};
				turns.push(current);
				step = null;
			}
			return current;
		};
		const ensureStep = (ts) => {
			const t = ensureTurn(ts);
			if (!step) {
				step = {
					index: t.steps.length,
					blocks: []
				};
				t.steps.push(step);
			}
			return step;
		};
		let seq = 0;
		for (const r of rows) {
			const ts = r.timestamp ? Date.parse(r.timestamp) : Date.now();
			switch (r.type) {
				case "session_meta": {
					const p = r.payload ?? {};
					cwd = String(p.cwd ?? "");
					createdAt = ts || Date.now();
					model = p.model_provider ? { provider: String(p.model_provider) } : void 0;
					break;
				}
				case "turn_context": {
					if (current) turns.push(current);
					current = {
						index: turns.length,
						startedAt: ts,
						userMessages: [],
						steps: []
					};
					step = null;
					turns.push(current);
					turns.pop();
					current.index = turns.length;
					turns.push(current);
					const p = r.payload ?? {};
					if (p.model) model = {
						...model ?? {},
						id: String(p.model)
					};
					break;
				}
				case "response_item": {
					const p = r.payload ?? {};
					switch (p.type) {
						case "message": {
							const t = ensureTurn(ts);
							const textOut = (p.content ?? []).filter((c) => typeof c?.text === "string").map((c) => c.text).join("\n");
							if (!textOut) break;
							if (p.role === "user") {
								t.userMessages.push({
									kind: "text",
									role: "user",
									text: textOut,
									tier: classifyText(textOut, { injected: isInjectedTemplate(textOut) }),
									injected: isInjectedTemplate(textOut)
								});
								if (!title && !isInjectedTemplate(textOut)) title = textOut.replace(/\s+/g, " ").slice(0, 80);
							} else if (p.role === "assistant") ensureStep(ts).blocks.push({
								kind: "text",
								role: "assistant",
								text: textOut,
								tier: classifyText(textOut, { injected: isInjectedTemplate(textOut) })
							});
							break;
						}
						case "reasoning": {
							const s = ensureStep(ts);
							const sum = (p.summary ?? []).map((x) => x?.text ?? "").join("\n");
							if (sum) s.reasoning = s.reasoning ? `${s.reasoning}\n${sum}` : sum;
							break;
						}
						case "function_call":
							ensureStep(ts).blocks.push({
								kind: "tool-call",
								callId: String(p.call_id ?? p.id ?? `call-${seq}`),
								name: String(p.name ?? "tool"),
								args: safeJson$1(p.arguments),
								rawArgs: typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {}),
								tier: "critical"
							});
							break;
						case "function_call_output": {
							const s = ensureStep(ts);
							const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
							s.blocks.push({
								kind: "tool-result",
								callId: String(p.call_id ?? `call-${seq}`),
								output: {
									text: out,
									originalLength: out.length
								},
								isError: false,
								tier: "critical"
							});
							break;
						}
						case "agent_message": {
							const s = ensureStep(ts);
							const textOut = (p.content ?? []).filter((c) => typeof c?.text === "string").map((c) => c.text).join("\n");
							if (textOut) s.blocks.push({
								kind: "text",
								role: "assistant",
								text: textOut,
								tier: "high"
							});
							break;
						}
						default:
							opaque.push({
								kind: `response_item/${p.type}`,
								seq: seq++,
								payload: p
							});
							break;
					}
					break;
				}
				case "event_msg": {
					const p = r.payload ?? {};
					if (p.type === "thread_name_updated" && p.thread_name) title = String(p.thread_name);
					else if (p.type === "item_completed") opaque.push({
						kind: "item_completed",
						seq: seq++,
						payload: p
					});
					break;
				}
				default: break;
			}
		}
		return {
			session: {
				id: `codex-${opts.sessionId}`,
				title: title || "(无标题)",
				cwd,
				createdAt,
				updatedAt: fs.statSync(target).mtimeMs,
				origin: {
					client: "codex",
					originalId: opts.sessionId,
					raw: { file: target }
				},
				model,
				turns,
				opaque: opaque.length > 0 ? opaque.slice(0, 500) : void 0,
				warnings
			},
			warnings
		};
	}
	async write(session, opts = {}) {
		const events = [];
		let seq = 0;
		const push = (type, data, time, extra = {}) => {
			events.push({
				type,
				seq: seq++,
				time,
				data,
				...extra
			});
		};
		for (const turn of session.turns) {
			push("turn/start", { turn: turn.index + 1 }, turn.startedAt);
			push("step/start", {
				turn: turn.index + 1,
				step: 1
			}, turn.startedAt);
			for (const b of turn.userMessages) {
				if (b.kind !== "text") continue;
				push("user/message", {
					role: "user",
					id: `u-${seq}`,
					content: [{
						type: "text",
						text: b.text
					}]
				}, turn.startedAt, { surfaceOp: "append" });
			}
			for (const step of turn.steps) {
				const content = [];
				if (step.reasoning) content.push({
					type: "reasoning",
					text: step.reasoning
				});
				for (const b of step.blocks) if (b.kind === "text" && b.role === "assistant") content.push({
					type: "text",
					text: b.text
				});
				else if (b.kind === "tool-call") content.push({
					type: "tool-call",
					id: b.callId,
					name: b.name,
					arguments: b.rawArgs ?? JSON.stringify(b.args ?? {})
				});
				if (content.length > 0) {
					push("assistant/message", {
						turn: turn.index + 1,
						step: 1,
						message: {
							role: "assistant",
							id: `a-${seq}`,
							content,
							source: {
								kind: "model",
								provider: "codex-bridge",
								model: session.model?.id ?? "imported",
								imported: true
							}
						},
						stream: []
					}, turn.endedAt ?? turn.startedAt, { surfaceOp: "append" });
					for (const b of step.blocks) if (b.kind === "tool-call") push("tool/call", {
						turn: turn.index + 1,
						step: 1,
						callId: b.callId,
						name: b.name,
						arguments: b.rawArgs ?? JSON.stringify(b.args ?? {})
					}, turn.endedAt ?? turn.startedAt);
				}
				for (const b of step.blocks) {
					if (b.kind !== "tool-result") continue;
					push("tool/result", {
						turn: turn.index + 1,
						step: 1,
						message: {
							role: "tool",
							id: `tr-${seq}`,
							toolCallId: b.callId,
							source: {
								kind: "tool",
								callId: b.callId
							},
							content: [{
								type: "text",
								text: b.output.text
							}],
							isError: b.isError
						}
					}, turn.endedAt ?? turn.startedAt, { surfaceOp: "append" });
				}
			}
			push("step/end", {
				turn: turn.index + 1,
				step: 1
			}, turn.endedAt ?? turn.startedAt);
			push("turn/end", {
				turn: turn.index + 1,
				reason: { kind: "completed" }
			}, turn.endedAt ?? turn.startedAt);
		}
		push("session/title", {
			title: (opts.title ?? session.title ?? "导入会话").slice(0, 200),
			messageSeqs: [],
			source: { kind: "user" }
		}, session.createdAt);
		const cwd = opts.cwd ?? session.cwd ?? process.cwd();
		const header = {
			version: 4,
			id: `session-codex-${crypto$1.randomUUID()}`,
			createdAt: session.createdAt,
			isSeeded: false,
			delegationDepth: 0,
			cwd,
			agentPreset: "standard"
		};
		const conv = dshToCodex({
			header,
			events
		}, {});
		const threadId = header.id.replace(/^session-codex-/, "");
		const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/:/g, "-");
		const now = /* @__PURE__ */ new Date();
		const dir = path.join(codexSessionsDir(), String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
		await fsp.mkdir(dir, { recursive: true });
		const file = path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
		await fsp.writeFile(file, conv.jsonl, "utf8");
		return {
			ok: true,
			targetId: threadId,
			location: file,
			records: conv.jsonl.split("\n").filter(Boolean).length,
			warnings: ["Codex 需重启并注册索引后才会显示该会话"]
		};
	}
};
function safeJson$1(s) {
	if (typeof s !== "string") return s ?? {};
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
}
const codexAdapter = new CodexAdapter();
//#endregion
//#region src/adapters/workbuddy/adapter.ts
/**
* adapters/workbuddy/adapter.ts —— WorkBuddy 会话适配器
*
* 复用现有 `convert/dsh2wb.ts`（UIR → WorkBuddy 行）与 `host/wb-store.ts`（持久化）。
* 存储：~/.workbuddy-ai/workbuddy.db（sessions/workspaces 表）+ projects/<cwd编码>/<id>.jsonl
*
* JSONL 行类型 → UIR：
*   session-meta        → session 元信息
*   message (user)      → turn.userMessages
*   message (assistant) → step.blocks (text)
*   reasoning           → step.reasoning
*   function_call       → tool-call
*   function_call_result→ tool-result
*   ai-title            → session.title
*/
function projectsDir() {
	return path.join(workbuddyHome(), "projects");
}
/** 动态加载 node:sqlite */
async function openDb(readOnly) {
	const mod = await import("node:sqlite");
	return readOnly ? new mod.DatabaseSync(workbuddyDbFile(), { readOnly: true }) : new mod.DatabaseSync(workbuddyDbFile());
}
var WorkbuddyAdapter = class {
	capability = {
		client: "workbuddy",
		label: "WorkBuddy",
		canRead: true,
		canWrite: true,
		supportsSubagent: false,
		supportsImage: true,
		supportsFileChange: true,
		supportsBranching: false,
		lossyFields: ["子代理结构（无对应概念）", "客户端私有 URI（如 zcode-artifact）"]
	};
	probe() {
		if (!workbuddyAvailable()) return {
			available: false,
			reason: `未找到 WorkBuddy 数据库：${workbuddyDbFile()}`
		};
		return { available: true };
	}
	async list() {
		const db = await openDb(true);
		try {
			return db.prepare("SELECT id, title, cwd, created_at, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC").all().map((r) => ({
				client: "workbuddy",
				id: String(r.id),
				title: String(r.title ?? "(无标题)"),
				cwd: String(r.cwd ?? ""),
				createdAt: Number(r.created_at ?? 0),
				updatedAt: Number(r.updated_at ?? 0)
			}));
		} finally {
			db.close();
		}
	}
	/** 找到会话的 JSONL 文件 */
	findJsonl(sessionId) {
		const root = projectsDir();
		let dirs = [];
		try {
			dirs = fs.readdirSync(root);
		} catch {
			return null;
		}
		for (const d of dirs) {
			const f = path.join(root, d, `${sessionId}.jsonl`);
			if (fs.existsSync(f)) return f;
		}
		return null;
	}
	async read(opts) {
		const db = await openDb(true);
		let row;
		try {
			row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(opts.sessionId);
		} finally {
			db.close();
		}
		if (!row) throw new Error(`未找到 WorkBuddy 会话：${opts.sessionId}`);
		const file = this.findJsonl(opts.sessionId);
		if (!file) throw new Error(`未找到 WorkBuddy 会话文件（会话 ${opts.sessionId}）`);
		const lines = [];
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				lines.push(JSON.parse(line));
			} catch {}
		}
		const warnings = [];
		const turns = [];
		const opaque = [];
		let current = null;
		let step = null;
		let title = String(row.title ?? "");
		let seq = 0;
		const callNames = /* @__PURE__ */ new Map();
		const ensureTurn = (ts) => {
			if (!current) {
				current = {
					index: turns.length,
					startedAt: ts,
					userMessages: [],
					steps: []
				};
				turns.push(current);
				step = null;
			}
			return current;
		};
		const ensureStep = (ts) => {
			const t = ensureTurn(ts);
			if (!step) {
				step = {
					index: t.steps.length,
					blocks: []
				};
				t.steps.push(step);
			}
			return step;
		};
		for (const l of lines) {
			const ts = Number(l.timestamp ?? Date.now());
			switch (l.type) {
				case "session-meta": break;
				case "ai-title":
					if (l.aiTitle) title = String(l.aiTitle);
					break;
				case "message": {
					const content = Array.isArray(l.content) ? l.content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("\n") : String(l.content ?? "");
					if (!content) break;
					if (l.role === "user") {
						ensureTurn(ts).userMessages.push({
							kind: "text",
							role: "user",
							text: content,
							tier: classifyText(content, { injected: isInjectedTemplate(content) }),
							injected: isInjectedTemplate(content)
						});
						if (!title && !isInjectedTemplate(content)) title = content.replace(/\s+/g, " ").slice(0, 80);
					} else if (l.role === "assistant") ensureStep(ts).blocks.push({
						kind: "text",
						role: "assistant",
						text: content,
						tier: classifyText(content, { injected: isInjectedTemplate(content) })
					});
					break;
				}
				case "reasoning": {
					const s = ensureStep(ts);
					const txt = Array.isArray(l.rawContent) ? l.rawContent.filter((c) => typeof c?.text === "string").map((c) => c.text).join("\n") : String(l.content ?? "");
					if (txt) s.reasoning = s.reasoning ? `${s.reasoning}\n${txt}` : txt;
					break;
				}
				case "function_call": {
					const s = ensureStep(ts);
					callNames.set(String(l.callId), String(l.name ?? "tool"));
					s.blocks.push({
						kind: "tool-call",
						callId: String(l.callId ?? `call-${seq}`),
						name: String(l.name ?? "tool"),
						args: safeJson(l.arguments),
						rawArgs: typeof l.arguments === "string" ? l.arguments : JSON.stringify(l.arguments ?? {}),
						tier: "critical"
					});
					break;
				}
				case "function_call_result": {
					const s = ensureStep(ts);
					const out = typeof l.output === "object" && l.output ? String(l.output.text ?? JSON.stringify(l.output)) : String(l.output ?? "");
					s.blocks.push({
						kind: "tool-result",
						callId: String(l.callId ?? `call-${seq}`),
						name: callNames.get(String(l.callId)),
						output: {
							text: out,
							originalLength: out.length
						},
						isError: l.status === "failed" || l.status === "error",
						tier: "critical"
					});
					break;
				}
				default:
					opaque.push({
						kind: String(l.type),
						seq: seq++,
						payload: l
					});
					break;
			}
		}
		return {
			session: {
				id: `wb-${opts.sessionId}`,
				title: title || "(无标题)",
				cwd: String(row.cwd ?? ""),
				createdAt: Number(row.created_at ?? Date.now()),
				updatedAt: Number(row.updated_at ?? Date.now()),
				origin: {
					client: "workbuddy",
					originalId: opts.sessionId,
					raw: {
						file,
						model: row.model,
						userId: row.user_id
					}
				},
				model: row.model ? { id: String(row.model) } : void 0,
				turns,
				opaque: opaque.length > 0 ? opaque.slice(0, 200) : void 0,
				warnings
			},
			warnings
		};
	}
	async write(session, opts = {}) {
		const events = [];
		let seq = 0;
		const push = (type, data, time, extra = {}) => {
			events.push({
				type,
				seq: seq++,
				time,
				data,
				...extra
			});
		};
		for (const turn of session.turns) {
			push("turn/start", { turn: turn.index + 1 }, turn.startedAt);
			push("step/start", {
				turn: turn.index + 1,
				step: 1
			}, turn.startedAt);
			for (const b of turn.userMessages) {
				if (b.kind !== "text") continue;
				push("user/message", {
					role: "user",
					id: `u-${seq}`,
					content: [{
						type: "text",
						text: b.text
					}]
				}, turn.startedAt, { surfaceOp: "append" });
			}
			for (const step of turn.steps) {
				const content = [];
				if (step.reasoning) content.push({
					type: "reasoning",
					text: step.reasoning
				});
				for (const b of step.blocks) if (b.kind === "text" && b.role === "assistant") content.push({
					type: "text",
					text: b.text
				});
				else if (b.kind === "tool-call") content.push({
					type: "tool-call",
					id: b.callId,
					name: b.name,
					arguments: b.rawArgs ?? JSON.stringify(b.args ?? {})
				});
				if (content.length > 0) {
					push("assistant/message", {
						turn: turn.index + 1,
						step: 1,
						message: {
							role: "assistant",
							id: `a-${seq}`,
							content,
							source: {
								kind: "model",
								provider: "wb-bridge",
								model: session.model?.id ?? "imported",
								imported: true
							}
						},
						stream: []
					}, turn.endedAt ?? turn.startedAt, { surfaceOp: "append" });
					for (const b of step.blocks) if (b.kind === "tool-call") push("tool/call", {
						turn: turn.index + 1,
						step: 1,
						callId: b.callId,
						name: b.name,
						arguments: b.rawArgs ?? JSON.stringify(b.args ?? {})
					}, turn.endedAt ?? turn.startedAt);
				}
				for (const b of step.blocks) {
					if (b.kind !== "tool-result") continue;
					push("tool/result", {
						turn: turn.index + 1,
						step: 1,
						message: {
							role: "tool",
							id: `tr-${seq}`,
							toolCallId: b.callId,
							source: {
								kind: "tool",
								callId: b.callId
							},
							content: [{
								type: "text",
								text: b.output.text
							}],
							isError: b.isError
						}
					}, turn.endedAt ?? turn.startedAt, { surfaceOp: "append" });
				}
			}
			push("step/end", {
				turn: turn.index + 1,
				step: 1
			}, turn.endedAt ?? turn.startedAt);
			push("turn/end", {
				turn: turn.index + 1,
				reason: { kind: "completed" }
			}, turn.endedAt ?? turn.startedAt);
		}
		push("session/title", {
			title: (opts.title ?? session.title ?? "导入会话").slice(0, 200),
			messageSeqs: [],
			source: { kind: "user" }
		}, session.createdAt);
		const w = await writeWorkbuddySession({
			header: {
				version: 4,
				id: `session-wb-${crypto$1.randomUUID()}`,
				createdAt: session.createdAt,
				isSeeded: false,
				delegationDepth: 0,
				cwd: opts.cwd ?? session.cwd ?? process.cwd(),
				agentPreset: "standard"
			},
			events
		}, {
			title: opts.title ?? session.title,
			cwd: opts.cwd ?? session.cwd
		});
		return {
			ok: w.ok,
			targetId: w.sessionId,
			location: w.jsonlPath,
			records: w.rows,
			warnings: ["WorkBuddy 需重启后才会在会话列表看到该会话"]
		};
	}
};
function safeJson(s) {
	if (typeof s !== "string") return s ?? {};
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
}
//#endregion
//#region src/adapters/registry.ts
/**
* 全部五端的 UIR 适配器。
*
* 每个适配器都实现 `probe / list / read / write`，
* 因此任意两端都能通过 `transferSession` 互转。
*/
const ADAPTERS = {
	"claude-code": claudeCodeAdapter,
	zcode: zcodeAdapter,
	dsh: dshAdapter,
	codex: codexAdapter,
	workbuddy: new WorkbuddyAdapter()
};
/** 按客户端获取适配器 */
function getAdapter(client) {
	return ADAPTERS[client] ?? null;
}
/** 列出已实现 UIR 适配器的客户端 */
function availableAdapters() {
	return Object.keys(ADAPTERS);
}
/** 能力矩阵（所有已注册适配器） */
function capabilityMatrix() {
	return availableAdapters().map((client) => ADAPTERS[client]?.capability).filter((c) => Boolean(c));
}
/** 列出所有可用客户端的会话 */
async function listAllSessions(opts = {}) {
	const targets = opts.clients ?? availableAdapters();
	const sessions = [];
	const errors = [];
	const limit = opts.limitPerClient ?? 50;
	for (const client of targets) {
		const adapter = getAdapter(client);
		if (!adapter) continue;
		const probe = adapter.probe();
		if (!probe.available) {
			errors.push({
				client,
				message: probe.reason ?? "不可用"
			});
			continue;
		}
		try {
			const list = await adapter.list();
			sessions.push(...list.slice(0, limit));
		} catch (e) {
			errors.push({
				client,
				message: String(e?.message ?? e)
			});
		}
	}
	return {
		sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
		errors
	};
}
/** 读取会话为 UIR */
async function readSession(client, sessionId) {
	const adapter = getAdapter(client);
	if (!adapter) throw new Error(`客户端 ${client} 尚未支持 UIR 读取（当前支持：${availableAdapters().join(", ")}）`);
	return adapter.read({ sessionId });
}
/** 把 UIR 写入指定客户端 */
async function writeSession(client, session, opts = {}) {
	const adapter = getAdapter(client);
	if (!adapter) throw new Error(`客户端 ${client} 尚未支持 UIR 写入（当前支持：${availableAdapters().join(", ")}）`);
	return adapter.write(session, opts);
}
/**
* 跨端转换：从一端读到 UIR，再写入另一端。
*
* 这是 N×N 互通的核心：不需要 N² 个转换器，只要 2N 个适配器。
*/
async function transferSession(params) {
	const read = await readSession(params.from, params.fromId);
	const write = await writeSession(params.to, read.session, {
		title: params.title,
		cwd: params.cwd
	});
	if (!write.ok) throw new Error(write.error?.message ?? "写入目标端失败");
	return {
		ok: true,
		source: {
			client: params.from,
			id: params.fromId,
			title: read.session.title,
			turns: read.session.turns.length
		},
		target: {
			client: params.to,
			id: write.targetId,
			location: write.location,
			records: write.records
		},
		warnings: [...read.warnings, ...write.warnings]
	};
}
/** 生成转换损失提示（中文） */
function describeLoss(from, to) {
	const matrix = capabilityMatrix();
	const src = matrix.find((c) => c.client === from);
	const dst = matrix.find((c) => c.client === to);
	if (!src || !dst) return [];
	const losses = [];
	if (src.supportsSubagent && !dst.supportsSubagent) losses.push(`${dst.label} 不支持子代理结构，子代理会话将被合并或跳过`);
	if (src.supportsBranching && !dst.supportsBranching) losses.push(`${dst.label} 不支持消息分支，分支将线性化`);
	if (src.supportsImage && !dst.supportsImage) losses.push(`${dst.label} 不支持图片，图片将丢失`);
	if (src.supportsFileChange && !dst.supportsFileChange) losses.push(`${dst.label} 不支持文件变更记录，变更历史将丢失`);
	for (const f of dst.lossyFields) losses.push(`${dst.label}：${f}`);
	return [...new Set(losses)];
}
/**
* 启发式估算（零依赖，误差约 ±15%）。
* 依据：中文约 1 token/字，英文约 4 字符/token，代码约 3 字符/token。
*/
function estimateTokensHeuristic(text) {
	if (!text) return 0;
	let cjk = 0;
	let ascii = 0;
	let other = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 128) ascii++;
		else if (c >= 19968 && c <= 40959 || c >= 12352 && c <= 12543 || c >= 44032 && c <= 55215) cjk++;
		else other++;
	}
	return Math.ceil(cjk * 1 + ascii / 3.8 + other / 1.5);
}
/**
* 估算 token 数。
* 当前实现使用启发式（零依赖，跨平台稳定）。
* 预留 tiktoken 接入点：若宿主环境提供精确分词，可通过 setEncoder 注入。
*/
function estimateTokens(text) {
	return estimateTokensHeuristic(text);
}
/** 安全余量：200k 预算按 92% 使用 */
const BUDGET_SAFETY_RATIO = .92;
/** 默认预算 */
const DEFAULT_BUDGET = 2e5;
/** 计算实际可用预算 */
function effectiveBudget(requested) {
	return Math.floor(Math.min(Math.max(requested ?? 2e5, 1), DEFAULT_BUDGET) * BUDGET_SAFETY_RATIO);
}
//#endregion
//#region src/budget/summarize.ts
const FENCE_RE = /```[\w+-]*\n[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]{1,200}`/g;
/**
* 文件路径正则（保留给 extractProtected 使用；单行内联匹配）。
*/
const PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>|*?`，。；：、）】]+/g;
/**
* 报错信息正则。
* 不要求行首（实测报错常出现在行中间），并覆盖常见形态：
*   Error: / Exception: / FATAL / panic / Traceback / XXX failed / error C1234
*/
const ERROR_RE = /(?:\b(?:Error|ERROR|Exception|FATAL|FAILED|panic|Traceback)\b[:：]?\s*[^\n]{0,200}|\berror\s+[A-Z]{1,4}\d{3,5}[^\n]{0,150}|\b[A-Za-z_][\w.]*\s+failed\b[^\n]{0,150})/g;
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g;
const CMD_RE = /(?:pwsh|powershell|bash|sh|cmd|node|npm|pnpm|git|python|npx)\s+(?:-[A-Za-z]+\s+)*[^\n]{3,300}/g;
/** 提取必须逐字保留的技术片段 */
function extractProtected(text) {
	const out = [];
	const push = (kind, arr) => {
		if (!arr) return;
		for (const m of arr) out.push({
			kind,
			text: m
		});
	};
	push("code", text.match(FENCE_RE));
	push("inline-code", text.match(INLINE_CODE_RE));
	push("path", text.match(PATH_RE));
	push("error", text.match(ERROR_RE));
	push("version", text.match(VERSION_RE));
	const seen = /* @__PURE__ */ new Set();
	return out.filter((p) => {
		const k = p.kind + "\0" + p.text;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}
/**
* 把 UIR 会话压缩成不超过预算的上下文文本。
*/
function summarizeSession(session, opts = {}) {
	const budget = effectiveBudget(opts.budget);
	const fidelity = opts.fidelity ?? "balanced";
	const stats = {
		originalTokens: 0,
		returnedTokens: 0,
		compressionRatio: 1,
		level: "L0",
		dropped: {
			narrative: 0,
			duplicates: 0,
			injected: 0,
			reasoning: 0
		},
		preserved: {
			codeBlocks: 0,
			commands: 0,
			paths: 0,
			errors: 0,
			toolCalls: 0
		},
		summarized: false
	};
	const originalText = renderFull(session);
	stats.originalTokens = estimateTokens(originalText);
	collectPreservedStats(session, stats);
	if (session.turns.length === 0) {
		stats.returnedTokens = stats.originalTokens;
		stats.level = "L3";
		return {
			context: originalText + "\n\n（无对话内容）",
			outline: [],
			stats
		};
	}
	if (stats.originalTokens <= budget || fidelity === "full" && stats.originalTokens <= budget * 1.05) {
		stats.returnedTokens = stats.originalTokens;
		stats.level = "L0";
		return {
			context: originalText,
			outline: buildOutline(session),
			stats
		};
	}
	const l1 = applyL1(session, stats);
	const l1Text = renderFull(l1);
	const l1Tokens = estimateTokens(l1Text);
	if (l1Tokens <= budget) {
		stats.returnedTokens = l1Tokens;
		stats.level = "L1";
		stats.summarized = true;
		finishRatio(stats);
		return {
			context: l1Text,
			outline: buildOutline(l1),
			stats
		};
	}
	const { context, level } = applyL2L3(l1, budget, fidelity, opts.focus ?? [], stats);
	stats.returnedTokens = estimateTokens(context);
	stats.level = level;
	stats.summarized = true;
	finishRatio(stats);
	return {
		context,
		outline: buildOutline(session),
		stats
	};
}
function finishRatio(stats) {
	stats.compressionRatio = stats.originalTokens > 0 ? Math.round(stats.returnedTokens / stats.originalTokens * 1e3) / 1e3 : 1;
}
/** 剥离注入模板 + 相邻重复去重 */
function applyL1(session, stats) {
	const out = {
		...session,
		turns: []
	};
	const seenTexts = /* @__PURE__ */ new Set();
	for (const turn of session.turns) {
		const newTurn = {
			...turn,
			userMessages: [],
			steps: []
		};
		for (const b of turn.userMessages) {
			if (b.kind === "text") {
				if (isInjectedTemplate(b.text)) {
					stats.dropped.injected += b.text.length;
					continue;
				}
				const key = b.text.trim();
				if (key.length > 40 && seenTexts.has(key)) {
					stats.dropped.duplicates += b.text.length;
					continue;
				}
				if (key.length > 40) seenTexts.add(key);
			}
			newTurn.userMessages.push(b);
		}
		for (const step of turn.steps) {
			const newStep = {
				...step,
				blocks: []
			};
			for (const b of step.blocks) {
				if (b.kind === "text" && isInjectedTemplate(b.text)) {
					stats.dropped.injected += b.text.length;
					continue;
				}
				newStep.blocks.push(b);
			}
			newTurn.steps.push(newStep);
		}
		out.turns.push(newTurn);
	}
	return out;
}
function applyL2L3(session, budget, fidelity, focus, stats) {
	const turns = session.turns;
	const n = turns.length;
	if (n === 0) return {
		context: renderHeader(session, stats) + "\n\n（无对话内容）",
		level: "L3"
	};
	const headerText = renderHeader(session, stats);
	const techIndexReserve = Math.min(Math.floor(budget * .18), 3e4);
	let remaining = budget - estimateTokens(headerText) - techIndexReserve - 200;
	const costs = turns.map((t) => ({
		turn: t,
		fullTokens: estimateTokens(renderTurnFull(t)),
		l2Tokens: estimateTokens(renderTurnL2(t, focus, {
			...stats,
			dropped: { ...stats.dropped },
			preserved: { ...stats.preserved }
		})),
		plan: "L3"
	}));
	const recentStart = Math.max(0, n - 3);
	for (let i = n - 1; i >= recentStart; i--) if (costs[i].fullTokens <= remaining) {
		costs[i].plan = "L0";
		remaining -= costs[i].fullTokens;
	}
	for (let i = recentStart - 1; i >= 0; i--) {
		if (costs[i].plan !== "L3") continue;
		if (costs[i].l2Tokens <= remaining) {
			costs[i].plan = "L2";
			remaining -= costs[i].l2Tokens;
		}
	}
	let upgraded = true;
	while (upgraded && remaining > 500) {
		upgraded = false;
		for (let i = n - 1; i >= 0; i--) {
			if (costs[i].plan !== "L2") continue;
			const delta = costs[i].fullTokens - costs[i].l2Tokens;
			if (delta <= remaining) {
				costs[i].plan = "L0";
				remaining -= delta;
				upgraded = true;
				break;
			}
		}
		if (upgraded) continue;
		for (let i = n - 1; i >= 0; i--) {
			if (costs[i].plan !== "L3") continue;
			if (costs[i].l2Tokens <= remaining) {
				costs[i].plan = "L2";
				remaining -= costs[i].l2Tokens;
				upgraded = true;
				break;
			}
		}
	}
	const parts = [headerText];
	const earlyTurns = costs.filter((c) => c.plan === "L3");
	if (earlyTurns.length > 0) parts.push(renderEarlySummary(earlyTurns.map((c) => c.turn)));
	for (const c of costs) {
		if (c.plan === "L3") continue;
		if (c.plan === "L0") parts.push(renderTurnFull(c.turn));
		else parts.push(renderTurnL2(c.turn, focus, stats));
	}
	const techIndex = buildTechIndex(session, Math.max(techIndexReserve, remaining));
	if (techIndex.text) {
		parts.push(techIndex.text);
		stats.preserved.techIndexEntries = techIndex.count;
	}
	return {
		context: parts.join("\n\n"),
		level: "L2"
	};
}
/**
* 构建「技术索引」——全文去重后的关键片段清单。
*
* 为什么需要：轮次级折叠（L3）会丢掉早期轮次的文本，
* 但其中的路径/命令/报错/版本号是用户明确要求「不能丢」的技术细节。
* 把它们去重后集中列出，用极小空间保住关键信息。
*/
function buildTechIndex(session, remainingTokens) {
	if (remainingTokens < 300) return {
		text: "",
		count: 0
	};
	const paths = /* @__PURE__ */ new Set();
	const commands = /* @__PURE__ */ new Set();
	const errors = /* @__PURE__ */ new Set();
	const versions = /* @__PURE__ */ new Set();
	const collect = (text) => {
		if (!text) return;
		for (const p of text.match(PATH_RE) ?? []) {
			const t = p.trim();
			if (t.length >= 8 && t.length <= 300) paths.add(t);
		}
		for (const c of text.match(CMD_RE) ?? []) {
			const t = c.trim();
			if (t.length >= 6 && t.length <= 300) commands.add(t);
		}
		for (const e of text.match(ERROR_RE) ?? []) {
			const t = e.trim();
			if (t.length >= 10 && t.length <= 400) errors.add(t);
		}
		for (const v of text.match(VERSION_RE) ?? []) if (/^\d+\.\d+/.test(v)) versions.add(v);
	};
	for (const turn of session.turns) {
		for (const b of turn.userMessages) if (b.kind === "text") collect(b.text);
		for (const step of turn.steps) {
			if (step.reasoning) collect(step.reasoning);
			for (const b of step.blocks) if (b.kind === "text") collect(b.text);
			else if (b.kind === "tool-call") collect(b.rawArgs ?? JSON.stringify(b.args ?? {}));
			else if (b.kind === "tool-result") collect(b.output.text);
			else if (b.kind === "file-change") {
				paths.add(b.path);
				if (b.diff) collect(b.diff);
			}
		}
	}
	const sections = [];
	let count = 0;
	const budgetChars = Math.floor(remainingTokens * 3.5);
	let used = 0;
	const addSection = (title, items, maxItems) => {
		if (items.length === 0) return;
		const picked = [];
		for (const it of items.slice(0, maxItems)) {
			if (used + it.length + 4 > budgetChars - 40) break;
			picked.push(it);
			used += it.length + 4;
		}
		if (picked.length === 0) return;
		sections.push(`### ${title}（${picked.length}${picked.length < items.length ? ` / 共 ${items.length}` : ""}）\n` + picked.map((x) => `- \`${x}\``).join("\n"));
		count += picked.length;
	};
	const fileNames = /* @__PURE__ */ new Set();
	const dirPaths = /* @__PURE__ */ new Set();
	for (const p of paths) {
		const segs = p.split(/[\\/]+/).filter(Boolean);
		if (segs.length === 0) continue;
		const base = segs[segs.length - 1];
		if (base && base.includes(".") && base.length <= 80) fileNames.add(base);
		if (segs.length >= 3) {
			const dir = segs.slice(0, -1).join("\\");
			if (dir.length >= 8 && dir.length <= 200) dirPaths.add(dir);
		}
	}
	addSection("报错信息", [...errors], 300);
	addSection("执行过的命令", [...commands], 500);
	addSection("涉及的文件", [...fileNames].sort((a, b) => a.localeCompare(b)), 3e3);
	addSection("关键目录", [...dirPaths].sort((a, b) => a.length - b.length), 2e3);
	addSection("版本号", [...versions].sort(), 500);
	if (sections.length === 0) return {
		text: "",
		count: 0
	};
	return {
		text: `\n## 技术索引（全文去重保留）\n\n${sections.join("\n\n")}`,
		count
	};
}
function renderHeader(session, stats) {
	const d = new Date(session.createdAt);
	const dateStr = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") : "未知时间";
	return [
		`# 会话上下文：${session.title || "(无标题)"}`,
		`> 来源 ${session.origin.client} · ${dateStr} · 工作目录 ${session.cwd || "(未知)"}`,
		`> 原始约 ${stats.originalTokens} tokens（压缩后见文末统计）`
	].join("\n");
}
/** L0：完整渲染 */
function renderFull(session) {
	const parts = [`# 会话上下文：${session.title || "(无标题)"}`];
	parts.push(`> 来源 ${session.origin.client} · 工作目录 ${session.cwd || "(未知)"}`);
	for (const turn of session.turns) parts.push(renderTurnFull(turn));
	return parts.join("\n\n");
}
function renderTurnFull(turn) {
	const lines = [`## 第 ${turn.index + 1} 轮`];
	for (const b of turn.userMessages) if (b.kind === "text") lines.push(`**用户**：${demoteHeadings(b.text)}`);
	for (const step of turn.steps) for (const b of step.blocks) lines.push(renderBlockFull(b));
	return lines.filter(Boolean).join("\n");
}
function renderBlockFull(b) {
	switch (b.kind) {
		case "text": return b.role === "assistant" ? `**助手**：${demoteHeadings(b.text)}` : `**${b.role}**：${demoteHeadings(b.text)}`;
		case "reasoning": return b.encrypted ? `> [加密思考 · 无法解码 · ${b.encryptedBytes ?? 0} 字节]` : `> 💭 ${b.text}`;
		case "tool-call": return `- 🔧 \`${b.name}\`(${b.rawArgs ?? JSON.stringify(b.args ?? {})})`;
		case "tool-result": return `- ${b.isError ? "⚠️" : "✅"} 结果：${b.output.text}`;
		case "file-change": return `- 📝 ${b.operation} \`${b.path}\`${b.diff ? "\n```diff\n" + b.diff + "\n```" : ""}`;
		case "image": return `- 🖼 图片 (${b.mime})`;
		case "compaction": return `- 🗜 上下文压缩：${b.summary}`;
		default: return "";
	}
}
/**
* L2：结构化渲染 —— 保留 P0 片段，压缩叙述。
*/
function renderTurnL2(turn, focus, stats) {
	const lines = [`## 第 ${turn.index + 1} 轮（摘要）`];
	for (const b of turn.userMessages) if (b.kind === "text") lines.push(`**用户**：${demoteHeadings(truncate(b.text, 1500))}`);
	for (const step of turn.steps) {
		if (step.reasoning) {
			const conclusion = extractConclusion(step.reasoning);
			if (conclusion) {
				stats.dropped.reasoning += Math.max(0, step.reasoning.length - conclusion.length);
				lines.push(`> 💭 ${conclusion}`);
			}
		}
		for (const b of step.blocks) switch (b.kind) {
			case "text": {
				if (b.role !== "assistant") break;
				const compressed = compressText(b.text, focus, stats);
				if (compressed) lines.push(`**助手**：${demoteHeadings(compressed)}`);
				break;
			}
			case "reasoning": {
				if (b.encrypted) break;
				const conclusion = extractConclusion(b.text);
				if (conclusion) {
					stats.dropped.reasoning += Math.max(0, b.text.length - conclusion.length);
					lines.push(`> 💭 ${conclusion}`);
				}
				break;
			}
			case "tool-call":
				lines.push(`- 🔧 \`${b.name}\` ${truncate(b.rawArgs ?? JSON.stringify(b.args ?? {}), 800)}`);
				break;
			case "tool-result": {
				const out = b.output.text;
				const preserved = truncatePreservingTech(out, 4e3, stats);
				lines.push(`  ${b.isError ? "⚠️ 错误" : "✅"}：${preserved}`);
				break;
			}
			case "file-change":
				lines.push(`- 📝 ${b.operation} \`${b.path}\``);
				break;
			case "image":
				lines.push(`- 🖼 图片 (${b.mime})`);
				break;
			default: break;
		}
	}
	return lines.join("\n");
}
/** L3：早期轮次折叠 */
function renderEarlySummary(turns) {
	if (turns.length === 0) return "";
	const first = turns[0].index + 1;
	const last = turns[turns.length - 1].index + 1;
	const intents = [];
	const files = /* @__PURE__ */ new Set();
	const tools = /* @__PURE__ */ new Set();
	for (const t of turns) {
		for (const b of t.userMessages) if (b.kind === "text") {
			const s = b.text.replace(/\s+/g, " ").trim().slice(0, 60);
			if (s) intents.push(s);
		}
		for (const step of t.steps) for (const b of step.blocks) {
			if (b.kind === "tool-call") tools.add(b.name);
			if (b.kind === "file-change") files.add(b.path);
		}
	}
	const lines = [`## 概览（第 ${first}–${last} 轮，已折叠）`, intents.length > 0 ? `- 用户诉求：${[...new Set(intents)].slice(0, 8).map((s) => `「${s}」`).join("、")}` : "- （无明确诉求记录）"];
	if (files.size > 0) lines.push(`- 涉及文件：${[...files].slice(0, 15).map((f) => `\`${f}\``).join("、")}${files.size > 15 ? ` 等 ${files.size} 个` : ""}`);
	if (tools.size > 0) lines.push(`- 使用工具：${[...tools].join("、")}`);
	return lines.join("\n");
}
/** 压缩叙述性文本：保留 P0 片段 + 首尾句 */
function compressText(text, focus, stats) {
	const f = analyzeText(text);
	if (text.length <= 400) return text;
	const techScore = f.codeBlocks * 10 + f.paths * 3 + f.errors * 8 + f.commands * 5;
	const keepChars = techScore > 10 ? 2e3 : techScore > 3 ? 1200 : 600;
	if (text.length <= keepChars) return text;
	const protectedPieces = extractProtected(text);
	const head = text.slice(0, Math.floor(keepChars * .6));
	const tail = text.slice(-Math.floor(keepChars * .25));
	const focusHits = [];
	for (const kw of focus) {
		const idx = text.indexOf(kw);
		if (idx >= 0) focusHits.push(text.slice(Math.max(0, idx - 100), Math.min(text.length, idx + 300)));
	}
	const droppedChars = text.length - (head.length + tail.length);
	stats.dropped.narrative += Math.max(0, droppedChars);
	const pieces = [head.trim()];
	if (focusHits.length > 0) pieces.push(`[关注点片段]\n${focusHits.join("\n…\n")}`);
	const missing = protectedPieces.filter((p) => !head.includes(p.text) && !tail.includes(p.text));
	if (missing.length > 0) pieces.push(`[关键细节]\n${missing.slice(0, 20).map((p) => p.text).join("\n")}`);
	pieces.push("…（此处省略部分叙述）…");
	pieces.push(tail.trim());
	return pieces.join("\n");
}
/** 截断但保留技术细节 */
function truncatePreservingTech(text, max, stats) {
	if (text.length <= max) return text;
	const head = text.slice(0, Math.floor(max * .7));
	const tail = text.slice(-Math.floor(max * .25));
	const missing = extractProtected(text).filter((p) => !head.includes(p.text) && !tail.includes(p.text));
	stats.dropped.narrative += Math.max(0, text.length - head.length - tail.length);
	let out = `${head.trim()}\n…（省略 ${text.length - head.length - tail.length} 字符）…\n${tail.trim()}`;
	if (missing.length > 0) out += `\n[关键细节]\n${missing.slice(0, 15).map((p) => p.text).join("\n")}`;
	return out;
}
/** 提取思考的结论句（最后一段判断性语句） */
function extractConclusion(reasoning) {
	if (!reasoning) return "";
	if (reasoning.length <= 300) return reasoning.trim();
	const lastParas = reasoning.split(/\n{2,}/).filter((p) => p.trim()).slice(-2).join("\n");
	const conclusion = lastParas.split(/(?<=[。.!?！？])\s+/).filter((s) => s.trim()).slice(-3).join(" ").trim();
	return conclusion.length > 20 ? conclusion.slice(0, 800) : lastParas.slice(0, 500).trim();
}
function truncate(s, max) {
	if (!s) return "";
	if (s.length <= max) return s;
	return s.slice(0, max) + `…（省略 ${s.length - max} 字符）`;
}
/**
* 降级原文里的 Markdown 标题，避免和本引擎的 `## 第 N 轮` 结构混淆。
* 做法：把行首的 `#` 替换为 `▪`（保留视觉层级感，但不被解析为标题）。
*/
function demoteHeadings(text) {
	if (!text) return text;
	return text.replace(/^(\s{0,3})(#{1,6})(\s+)/gm, (_m, indent, hashes, space) => `${indent}${"▪".repeat(hashes.length)}${space}`);
}
function collectPreservedStats(session, stats) {
	for (const turn of session.turns) {
		for (const b of turn.userMessages) if (b.kind === "text") {
			const f = analyzeText(b.text);
			stats.preserved.paths += f.paths;
			stats.preserved.errors += f.errors;
			stats.preserved.codeBlocks += f.codeBlocks;
			stats.preserved.commands += f.commands;
		}
		for (const step of turn.steps) for (const b of step.blocks) {
			if (b.kind === "tool-call") stats.preserved.toolCalls++;
			if (b.kind === "text") {
				const f = analyzeText(b.text);
				stats.preserved.paths += f.paths;
				stats.preserved.errors += f.errors;
				stats.preserved.codeBlocks += f.codeBlocks;
				stats.preserved.commands += f.commands;
			}
			if (b.kind === "tool-result") {
				const f = analyzeText(b.output.text);
				stats.preserved.paths += f.paths;
				stats.preserved.errors += f.errors;
			}
		}
	}
}
function buildOutline(session) {
	return session.turns.map((t) => {
		let intent = "";
		const files = /* @__PURE__ */ new Set();
		const tools = /* @__PURE__ */ new Set();
		for (const b of t.userMessages) if (b.kind === "text" && !intent) intent = b.text.replace(/\s+/g, " ").trim().slice(0, 100);
		for (const step of t.steps) for (const b of step.blocks) {
			if (b.kind === "tool-call") tools.add(b.name);
			if (b.kind === "file-change") files.add(b.path);
		}
		return {
			turn: t.index + 1,
			intent,
			files: [...files],
			tools: [...tools]
		};
	});
}
/** 生成统计摘要（人类可读） */
function formatStats(stats) {
	const pct = (n) => `${Math.round(n * 100)}%`;
	return [
		`原始 ${stats.originalTokens} tokens → 返回 ${stats.returnedTokens} tokens（保留 ${pct(stats.compressionRatio)}）`,
		`压缩级别 ${stats.level}${stats.summarized ? "（已摘要）" : "（未摘要）"}`,
		`保留：代码块 ${stats.preserved.codeBlocks} · 命令 ${stats.preserved.commands} · 路径 ${stats.preserved.paths} · 报错 ${stats.preserved.errors} · 工具调用 ${stats.preserved.toolCalls}`,
		`丢弃：注入模板 ${stats.dropped.injected} 字符 · 重复 ${stats.dropped.duplicates} 字符 · 叙述 ${stats.dropped.narrative} 字符 · 思考 ${stats.dropped.reasoning} 字符`
	].join("\n");
}
//#endregion
//#region src/mcp/protocol.ts
const JSON_RPC_ERRORS = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603
};
/** MCP 服务端 */
var McpServer = class {
	tools = /* @__PURE__ */ new Map();
	serverInfo;
	constructor(serverInfo) {
		this.serverInfo = serverInfo;
	}
	/** 注册工具 */
	tool(def, handler) {
		this.tools.set(def.name, {
			def,
			handler
		});
	}
	/** 已注册工具定义 */
	listTools() {
		return [...this.tools.values()].map((t) => t.def);
	}
	/**
	* 处理一条 JSON-RPC 请求，返回响应。
	* 通知（无 id）返回 null。
	*/
	async handle(req) {
		const isNotification = req.id === void 0 || req.id === null;
		const id = req.id ?? null;
		try {
			switch (req.method) {
				case "initialize": return {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: { tools: { listChanged: false } },
						serverInfo: this.serverInfo
					}
				};
				case "notifications/initialized":
				case "initialized": return null;
				case "ping": return {
					jsonrpc: "2.0",
					id,
					result: {}
				};
				case "tools/list": return {
					jsonrpc: "2.0",
					id,
					result: { tools: this.listTools() }
				};
				case "tools/call": {
					const params = req.params ?? {};
					const name = String(params.name ?? "");
					const entry = this.tools.get(name);
					if (!entry) return {
						jsonrpc: "2.0",
						id,
						error: {
							code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
							message: `未知工具：${name}`
						}
					};
					const args = params.arguments ?? {};
					try {
						return {
							jsonrpc: "2.0",
							id,
							result: await entry.handler(args)
						};
					} catch (e) {
						return {
							jsonrpc: "2.0",
							id,
							result: {
								content: [{
									type: "text",
									text: `工具执行失败：${String(e?.message ?? e)}`
								}],
								isError: true
							}
						};
					}
				}
				case "resources/list": return {
					jsonrpc: "2.0",
					id,
					result: { resources: [] }
				};
				case "prompts/list": return {
					jsonrpc: "2.0",
					id,
					result: { prompts: [] }
				};
				default:
					if (isNotification) return null;
					return {
						jsonrpc: "2.0",
						id,
						error: {
							code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
							message: `未知方法：${req.method}`
						}
					};
			}
		} catch (e) {
			if (isNotification) return null;
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: JSON_RPC_ERRORS.INTERNAL_ERROR,
					message: String(e?.message ?? e)
				}
			};
		}
	}
	/** 处理一行文本（JSON），返回响应行（可能为空） */
	async handleLine(line) {
		let req;
		try {
			req = JSON.parse(line);
		} catch {
			return JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: {
					code: JSON_RPC_ERRORS.PARSE_ERROR,
					message: "JSON 解析失败"
				}
			});
		}
		if (Array.isArray(req)) {
			const filtered = (await Promise.all(req.map((r) => this.handle(r)))).filter((r) => r !== null);
			return filtered.length > 0 ? JSON.stringify(filtered) : null;
		}
		const res = await this.handle(req);
		return res ? JSON.stringify(res) : null;
	}
};
/** 便捷构造文本结果 */
function textResult(text, isError = false) {
	return {
		content: [{
			type: "text",
			text
		}],
		...isError ? { isError: true } : {}
	};
}
//#endregion
//#region src/mcp/tools.ts
/**
* mcp/tools.ts —— MCP 工具注册
*
* 6 个工具：
*   list_sessions      列出会话（可按客户端/目录/关键字过滤）
*   get_context        获取压缩后的上下文（核心，200k 预算）
*   push_context       把客户端传来的对话写入目标端
*   transfer_session   端到端直接转换（不经客户端）
*   summarize_session  单独生成摘要
*   list_clients       列出可用客户端与能力
*/
/** 校验客户端类型 */
function assertClient(v, field) {
	const s = String(v ?? "");
	const valid = availableAdapters();
	if (!valid.includes(s)) throw new Error(`${field} 必须是以下之一：${valid.join(", ")}（收到：${s || "空"}）`);
	return s;
}
/** 把纯文本消息数组转成 UIR 会话（供 push_context 使用） */
function messagesToUir(params) {
	const now = Date.now();
	const turns = [];
	let current = null;
	let step = null;
	for (const m of params.messages) {
		const text = String(m.content ?? "");
		if (!text) continue;
		if (m.role === "user") {
			current = {
				index: turns.length,
				startedAt: now,
				userMessages: [{
					kind: "text",
					role: "user",
					text,
					tier: "high"
				}],
				steps: []
			};
			turns.push(current);
			step = {
				index: 0,
				blocks: []
			};
			current.steps.push(step);
		} else if (m.role === "assistant" && current && step) step.blocks.push({
			kind: "text",
			role: "assistant",
			text,
			tier: "high"
		});
		else if (m.role === "tool" && current && step) step.blocks.push({
			kind: "tool-result",
			callId: `call-${turns.length}`,
			output: { text },
			isError: false,
			tier: "critical"
		});
	}
	return {
		id: `mcp-${now}`,
		title: params.title ?? "(来自 MCP)",
		cwd: params.cwd ?? process.cwd(),
		createdAt: now,
		updatedAt: now,
		origin: {
			client: "mcp",
			originalId: `mcp-${now}`
		},
		turns
	};
}
/** 注册全部 MCP 工具 */
function registerTools(server) {
	server.tool({
		name: "list_clients",
		description: "列出本机可用的编程客户端（DSH / Codex / Zcode / Claude Code / WorkBuddy）及其能力与损失提示。",
		inputSchema: {
			type: "object",
			properties: {}
		}
	}, async () => {
		const clients = probeAllClients();
		const caps = capabilityMatrix();
		const platform = platformSupport();
		const lines = [];
		lines.push(`平台：${platform.note}`);
		lines.push("");
		lines.push("| 客户端 | 检测到 | 会话数 | 可读 | 可写 | 子代理 | 分支 |");
		lines.push("|---|---|---|---|---|---|---|");
		for (const c of clients) {
			const cap = caps.find((x) => x.client === c.kind);
			lines.push(`| ${c.label} | ${c.detected ? "✅" : "❌"} | ${c.sessionCount ?? "—"} | ${c.canRead ? "✅" : "—"} | ${c.canWrite ? "✅" : "—"} | ${cap?.supportsSubagent ? "✅" : "—"} | ${cap?.supportsBranching ? "✅" : "—"} |`);
		}
		const missing = clients.filter((c) => !c.detected);
		if (missing.length > 0) {
			lines.push("");
			lines.push("未检测到：");
			for (const c of missing) lines.push(`- ${c.label}：${c.reason ?? "未知原因"}`);
		}
		return textResult(lines.join("\n"));
	});
	server.tool({
		name: "list_sessions",
		description: "列出各客户端的会话。可按客户端、工作目录、关键字过滤。",
		inputSchema: {
			type: "object",
			properties: {
				client: {
					type: "string",
					description: "限定客户端（dsh/codex/zcode/claude-code/workbuddy），不传则全部"
				},
				query: {
					type: "string",
					description: "标题或路径关键字"
				},
				cwd: {
					type: "string",
					description: "按工作目录过滤（包含匹配）"
				},
				limit: {
					type: "number",
					description: "每端返回上限，默认 20"
				}
			}
		}
	}, async (args) => {
		const r = await listAllSessions({
			clients: args.client ? [assertClient(args.client, "client")] : void 0,
			limitPerClient: Math.min(Number(args.limit ?? 20) || 20, 100)
		});
		let sessions = r.sessions;
		if (args.query) {
			const q = String(args.query).toLowerCase();
			sessions = sessions.filter((s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
		}
		if (args.cwd) {
			const c = String(args.cwd).toLowerCase();
			sessions = sessions.filter((s) => s.cwd.toLowerCase().includes(c));
		}
		const lines = [];
		lines.push(`共 ${sessions.length} 个会话`);
		lines.push("");
		lines.push("| 客户端 | 会话 ID | 标题 | 轮次 | 更新 | 工作目录 |");
		lines.push("|---|---|---|---|---|---|");
		for (const s of sessions.slice(0, 200)) {
			const upd = new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ");
			lines.push(`| ${s.client} | \`${s.id}\` | ${s.title.slice(0, 50)} | ${s.turns ?? "—"} | ${upd} | \`${s.cwd.slice(0, 50)}\` |`);
		}
		if (r.errors.length > 0) {
			lines.push("");
			lines.push("部分客户端读取失败：");
			for (const e of r.errors) lines.push(`- ${e.client}：${e.message}`);
		}
		return textResult(lines.join("\n"));
	});
	server.tool({
		name: "get_context",
		description: "获取指定会话的上下文，自动压缩到 token 预算内（默认 200k，硬上限 200k）。技术细节（代码块、命令、路径、报错、参数）优先保留，超出预算时早期轮次折叠为摘要。",
		inputSchema: {
			type: "object",
			properties: {
				client: {
					type: "string",
					description: "客户端类型（必填）"
				},
				sessionId: {
					type: "string",
					description: "会话 ID（必填）"
				},
				budget: {
					type: "number",
					description: "token 预算，默认 200000，上限 200000"
				},
				fidelity: {
					type: "string",
					enum: [
						"full",
						"balanced",
						"compact"
					],
					description: "保真度，默认 balanced"
				},
				focus: {
					type: "array",
					items: { type: "string" },
					description: "关注点关键字（提升匹配内容保留优先级）"
				}
			},
			required: ["client", "sessionId"]
		}
	}, async (args) => {
		const client = assertClient(args.client, "client");
		const sessionId = String(args.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId 不能为空");
		const budget = Number(args.budget ?? 2e5);
		const read = await readSession(client, sessionId);
		const sum = summarizeSession(read.session, {
			budget,
			fidelity: args.fidelity,
			focus: Array.isArray(args.focus) ? args.focus.map(String) : void 0
		});
		return textResult([
			`<!-- 会话上下文：${read.session.title} -->`,
			`<!-- 来源 ${client} · ${read.session.turns.length} 轮 · 预算 ${budget}（有效 ${effectiveBudget(budget)}） -->`,
			`<!-- ${formatStats(sum.stats).replace(/\n/g, " | ")} -->`,
			""
		].join("\n") + sum.context);
	});
	server.tool({
		name: "push_context",
		description: "把当前对话内容写入指定客户端，成为该客户端的一个新会话。用于「在任意 MCP 客户端里干活，结果存回 DSH/Codex/Zcode 等」。",
		inputSchema: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description: "目标客户端（必填）"
				},
				title: {
					type: "string",
					description: "会话标题"
				},
				cwd: {
					type: "string",
					description: "工作目录（默认当前目录）"
				},
				messages: {
					type: "array",
					description: "对话消息数组",
					items: {
						type: "object",
						properties: {
							role: {
								type: "string",
								enum: [
									"user",
									"assistant",
									"tool"
								]
							},
							content: { type: "string" }
						},
						required: ["role", "content"]
					}
				}
			},
			required: ["target", "messages"]
		}
	}, async (args) => {
		const target = assertClient(args.target, "target");
		const messages = Array.isArray(args.messages) ? args.messages : [];
		if (messages.length === 0) throw new Error("messages 不能为空");
		const w = await writeSession(target, messagesToUir({
			messages,
			title: args.title ? String(args.title) : void 0,
			cwd: args.cwd ? String(args.cwd) : void 0,
			client: target
		}), {
			title: args.title ? String(args.title) : void 0,
			cwd: args.cwd ? String(args.cwd) : void 0
		});
		if (!w.ok) return textResult(`写入失败：${w.error?.message ?? "未知错误"}`, true);
		return textResult([
			`✅ 已写入 ${target}`,
			`- 会话 ID：\`${w.targetId}\``,
			`- 位置：\`${w.location}\``,
			`- 记录数：${w.records}`,
			w.warnings.length > 0 ? `- 提示：${w.warnings.join("；")}` : ""
		].filter(Boolean).join("\n"));
	});
	server.tool({
		name: "transfer_session",
		description: "把一个客户端的历史会话直接转换到另一个客户端（不经客户端传内容）。",
		inputSchema: {
			type: "object",
			properties: {
				from: {
					type: "string",
					description: "源客户端（必填）"
				},
				fromId: {
					type: "string",
					description: "源会话 ID（必填）"
				},
				to: {
					type: "string",
					description: "目标客户端（必填）"
				},
				title: {
					type: "string",
					description: "覆盖标题"
				},
				cwd: {
					type: "string",
					description: "覆盖工作目录"
				}
			},
			required: [
				"from",
				"fromId",
				"to"
			]
		}
	}, async (args) => {
		const from = assertClient(args.from, "from");
		const to = assertClient(args.to, "to");
		const fromId = String(args.fromId ?? "");
		if (!fromId) throw new Error("fromId 不能为空");
		if (from === to) throw new Error("源端与目标端相同，无需转换");
		const losses = describeLoss(from, to);
		const r = await transferSession({
			from,
			fromId,
			to,
			title: args.title ? String(args.title) : void 0,
			cwd: args.cwd ? String(args.cwd) : void 0
		});
		const lines = [
			`✅ ${from} → ${to} 转换完成`,
			`- 源会话：${r.source.title}（${r.source.turns} 轮）`,
			`- 目标 ID：\`${r.target.id}\``,
			`- 位置：\`${r.target.location}\``,
			`- 记录数：${r.target.records}`
		];
		if (losses.length > 0) {
			lines.push("", "⚠️ 本次转换的已知损失：");
			for (const l of losses) lines.push(`- ${l}`);
		}
		if (r.warnings.length > 0) {
			lines.push("", "提示：");
			for (const w of r.warnings) lines.push(`- ${w}`);
		}
		return textResult(lines.join("\n"));
	});
	server.tool({
		name: "summarize_session",
		description: "只生成会话摘要（不返回完整上下文），适合快速了解历史。",
		inputSchema: {
			type: "object",
			properties: {
				client: {
					type: "string",
					description: "客户端（必填）"
				},
				sessionId: {
					type: "string",
					description: "会话 ID（必填）"
				},
				budget: {
					type: "number",
					description: "摘要目标 token，默认 8000"
				}
			},
			required: ["client", "sessionId"]
		}
	}, async (args) => {
		const client = assertClient(args.client, "client");
		const sessionId = String(args.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId 不能为空");
		const budget = Number(args.budget ?? 8e3);
		const read = await readSession(client, sessionId);
		const sum = summarizeSession(read.session, {
			budget,
			fidelity: "compact"
		});
		const lines = [
			`# ${read.session.title}`,
			"",
			`来源 ${client} · ${read.session.turns.length} 轮 · 工作目录 \`${read.session.cwd}\``,
			"",
			formatStats(sum.stats),
			"",
			"## 轮次大纲",
			""
		];
		for (const o of sum.outline) {
			const files = o.files.length > 0 ? ` · 文件：${o.files.slice(0, 5).join(", ")}` : "";
			const tools = o.tools.length > 0 ? ` · 工具：${o.tools.join(", ")}` : "";
			lines.push(`- **第 ${o.turn} 轮**：${o.intent || "（无明确意图）"}${files}${tools}`);
		}
		lines.push("", "## 压缩上下文", "", sum.context);
		return textResult(lines.join("\n"));
	});
}
/** 创建并配置好工具的 MCP 服务端 */
function createBridgeMcpServer() {
	const server = new McpServer({
		name: "dsh-codex-bridge",
		version: "0.2.0"
	});
	registerTools(server);
	return server;
}
//#endregion
//#region src/host/routes.ts
const ROUTE_BASE = "/plugins/dsh-codex-bridge";
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
function hostIsLoopback(host) {
	if (!host) return false;
	let h = host.trim().toLowerCase();
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		return end !== -1 && LOOPBACK_HOSTS.has(h.slice(0, end + 1));
	}
	const colon = h.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
	return LOOPBACK_HOSTS.has(h);
}
function originIsLoopback(origin) {
	if (!origin || origin.trim() === "") return true;
	try {
		const u = new URL(origin);
		return LOOPBACK_HOSTS.has(u.hostname) || u.hostname === "::1";
	} catch {
		return false;
	}
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(payload);
}
async function readBody(req, limit = 64 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		const buf = c;
		size += buf.length;
		if (size > limit) throw new BridgeError("FILE_TOO_LARGE", void 0, {
			file: "请求体",
			size,
			limit
		});
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** 统一错误响应 */
function fail(res, e) {
	const be = e;
	if (be instanceof BridgeError) {
		json(res, 400, {
			ok: false,
			code: be.code,
			message: describeError(be.code, be.detail ?? {})
		});
		return;
	}
	json(res, 500, {
		ok: false,
		code: "SCAN_FAILED",
		message: describeError("SCAN_FAILED", { reason: String(e?.message ?? e) })
	});
}
/**
* 挂载路由。
* @param router 宿主提供的路由注册接口（由 index.ts 适配）
*/
function mountRoutes(router) {
	const guard = (req, res) => {
		if (!hostIsLoopback(req.headers.host)) {
			json(res, 403, {
				ok: false,
				message: "仅允许本机访问"
			});
			return false;
		}
		if (!originIsLoopback(req.headers.origin)) {
			json(res, 403, {
				ok: false,
				message: "来源不是本机页面"
			});
			return false;
		}
		return true;
	};
	router.get(`${ROUTE_BASE}/status`, async (req, res) => {
		if (!guard(req, res)) return;
		json(res, 200, {
			ok: true,
			codexDir: defaultCodexSessionsDir(),
			dshSessionsRoot: defaultDshSessionsRoot()
		});
	});
	router.get(`${ROUTE_BASE}/codex/sessions`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			json(res, 200, {
				ok: true,
				...await scanCodexSessions({ codexDir: new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("dir") ?? void 0 })
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/workspaces`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			json(res, 200, {
				ok: true,
				workspaces: await listWorkspaces()
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.post(`${ROUTE_BASE}/import`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const body = JSON.parse(await readBody(req));
			const files = Array.isArray(body.files) ? body.files : [];
			if (files.length === 0) throw new BridgeError("NO_SELECTION");
			const mode = body.mode === "overwrite" ? "overwrite" : "skip";
			const targetCwd = typeof body.targetCwd === "string" && body.targetCwd.trim() ? body.targetCwd : void 0;
			const r = await importMany(files, {
				dshSessionsRoot: body.dshSessionsRoot,
				mode,
				maxBytes: body.maxBytes,
				targetCwd
			});
			json(res, 200, {
				ok: true,
				succ: r.ok,
				failed: r.failed,
				results: r.results
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.post(`${ROUTE_BASE}/import-upload`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const body = JSON.parse(await readBody(req));
			const text = body.text ?? "";
			const fileName = body.fileName ?? "uploaded.jsonl";
			if (!text) throw new BridgeError("JSON_PARSE_FAILED", void 0, {
				file: fileName,
				line: 1
			});
			const mode = body.mode === "overwrite" ? "overwrite" : "skip";
			json(res, 200, {
				ok: true,
				...await importFromText(text, fileName, {
					dshSessionsRoot: body.dshSessionsRoot,
					mode
				})
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.post(`${ROUTE_BASE}/register-codex`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const body = JSON.parse(await readBody(req));
			let files = Array.isArray(body.files) ? body.files : [];
			if (files.length === 0) files = await listRolloutFiles(defaultCodexSessionsDir());
			if (files.length === 0) {
				json(res, 200, {
					ok: true,
					registered: [],
					skipped: [],
					failed: [],
					dbPath: "",
					indexPath: ""
				});
				return;
			}
			json(res, 200, {
				ok: true,
				...await registerToCodex(files)
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/dsh/sessions`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			json(res, 200, {
				ok: true,
				sessions: await listExportable(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("root") ?? void 0)
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.post(`${ROUTE_BASE}/export`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const body = JSON.parse(await readBody(req));
			const ids = Array.isArray(body.sessionIds) ? body.sessionIds : [];
			if (ids.length === 0) throw new BridgeError("NO_SELECTION");
			const r = await exportMany(ids, {
				dshSessionsRoot: body.dshSessionsRoot,
				codexSessionsDir: body.codexSessionsDir,
				doBackup: body.doBackup !== false
			});
			json(res, 200, {
				ok: true,
				succ: r.ok,
				failed: r.failed,
				backupDir: r.backupDir,
				outDir: r.outDir,
				results: r.results
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.post(`${ROUTE_BASE}/export-workbuddy`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const body = JSON.parse(await readBody(req));
			const ids = Array.isArray(body.sessionIds) ? body.sessionIds : [];
			if (ids.length === 0) throw new BridgeError("NO_SELECTION");
			const r = await exportManyToWorkbuddy(ids, { dshSessionsRoot: body.dshSessionsRoot });
			json(res, 200, {
				ok: true,
				succ: r.ok,
				failed: r.failed,
				results: r.results
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/workbuddy/status`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const available = workbuddyAvailable();
			const sessions = available ? await listWorkbuddySessions() : [];
			json(res, 200, {
				ok: true,
				available,
				sessionCount: sessions.length,
				sessions
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/logs`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const limit = Number(url.searchParams.get("limit") ?? 100) || 100;
			json(res, 200, {
				ok: true,
				logs: await readRecentLogs(Math.min(limit, 500))
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/clients`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			json(res, 200, {
				ok: true,
				clients: probeAllClients(),
				capabilities: capabilityMatrix(),
				uirAdapters: availableAdapters(),
				platform: platformSupport()
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/sessions/all`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const clientsParam = url.searchParams.get("clients");
			const clients = clientsParam ? clientsParam.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
			const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
			const r = await listAllSessions({
				clients,
				limitPerClient: Math.min(limit, 200)
			});
			json(res, 200, {
				ok: true,
				sessions: r.sessions,
				errors: r.errors
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/loss`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const from = url.searchParams.get("from");
			const to = url.searchParams.get("to");
			if (!from || !to) throw new BridgeError("NO_SELECTION", "缺少 from 或 to 参数");
			json(res, 200, {
				ok: true,
				losses: describeLoss(from, to)
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.post(`${ROUTE_BASE}/transfer`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const body = JSON.parse(await readBody(req));
			const from = body.from;
			const fromId = String(body.fromId ?? "");
			const to = body.to;
			if (!from || !fromId || !to) throw new BridgeError("NO_SELECTION", "缺少 from / fromId / to 参数");
			if (from === to) throw new BridgeError("CONVERT_FAILED", void 0, { reason: "源端与目标端相同，无需转换" });
			json(res, 200, {
				...await transferSession({
					from,
					fromId,
					to,
					title: typeof body.title === "string" ? body.title : void 0,
					cwd: typeof body.cwd === "string" ? body.cwd : void 0
				}),
				ok: true
			});
		} catch (e) {
			fail(res, e);
		}
	});
	router.post(`${ROUTE_BASE}/context/preview`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const body = JSON.parse(await readBody(req));
			const client = body.client;
			const sessionId = String(body.sessionId ?? "");
			if (!client || !sessionId) throw new BridgeError("NO_SELECTION", "缺少 client / sessionId 参数");
			const budget = Number(body.budget ?? 2e5);
			const read = await readSession(client, sessionId);
			const sum = summarizeSession(read.session, {
				budget,
				fidelity: body.fidelity,
				focus: Array.isArray(body.focus) ? body.focus.map(String) : void 0
			});
			json(res, 200, {
				ok: true,
				session: {
					client,
					id: sessionId,
					title: read.session.title,
					cwd: read.session.cwd,
					turns: read.session.turns.length
				},
				context: sum.context,
				outline: sum.outline,
				stats: sum.stats,
				statsText: formatStats(sum.stats),
				budget: {
					requested: budget,
					effective: effectiveBudget(budget)
				}
			});
		} catch (e) {
			fail(res, e);
		}
	});
	const mcpServer = createBridgeMcpServer();
	router.post(`${ROUTE_BASE}/mcp`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			const raw = await readBody(req);
			const out = await mcpServer.handleLine(raw);
			if (!out) {
				json(res, 200, {
					ok: true,
					notification: true
				});
				return;
			}
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(out);
		} catch (e) {
			fail(res, e);
		}
	});
	router.get(`${ROUTE_BASE}/mcp/tools`, async (req, res) => {
		if (!guard(req, res)) return;
		try {
			json(res, 200, {
				ok: true,
				tools: mcpServer.listTools()
			});
		} catch (e) {
			fail(res, e);
		}
	});
}
//#endregion
//#region src/index.ts
const name = "dsh-codex-bridge";
/** 配置 schema（对应 cordis.patch.yml 中的 config 段） */
const Config = z.object({
	/** Codex 根目录，留空=自动探测 %USERPROFILE%\.codex */
	codexHome: z.string().default(""),
	/** 导出输出目录，留空=<dsh-home>/codex-bridge/export */
	outputDir: z.string().default(""),
	/** 导出前是否备份 Codex 目录旧 JSONL */
	backupBeforeExport: z.boolean().default(true),
	/** 单文件上限（字节），超限跳过 */
	maxSessionBytes: z.number().default(256 * 1024 * 1024)
});
const inject = [];
/**
* 插件主体：向宿主 webServer 注册 HTTP 路由。
*
* ★ 官方模式（实测 dsh-workbuddy-connect）：webServer 用 ctx.inject 延迟获取，
*   不放进顶层 inject —— 顶层声明会导致 "pending (waiting for services)" 永不激活。
*/
function apply(ctx, config) {
	const anyCtx = ctx;
	const logger = anyCtx.logger ?? console;
	const adapter = {
		get: (path, handler) => {
			anyCtx.inject?.(["webServer"], (webCtx) => {
				webCtx.effect(() => webCtx.webServer.register({
					kind: "exact",
					path,
					handler
				}), `codex-bridge: GET ${path}`);
			});
		},
		post: (path, handler) => {
			anyCtx.inject?.(["webServer"], (webCtx) => {
				webCtx.effect(() => webCtx.webServer.register({
					kind: "exact",
					path,
					handler
				}), `codex-bridge: POST ${path}`);
			});
		}
	};
	try {
		mountRoutes(adapter);
		logger.info?.(`[${name}] 已排队路由注册（7 条，等待 webServer 就绪）`);
	} catch (e) {
		logger.error?.(`[${name}] 初始化失败：${String(e?.message ?? e)}`);
	}
}
//#endregion
export { Config, apply, inject, name };
