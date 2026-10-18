import z from "@deepseek-ai/schemastery";
import fsp, { stat } from "node:fs/promises";
import path from "node:path";
import fs, { createReadStream } from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import crypto$1 from "node:crypto";
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
/** 读取 WorkBuddy 的 user_id（从现有会话取，导入的会话需要归属同一用户） */
function readUserId(db) {
	const row = db.prepare("SELECT user_id FROM sessions LIMIT 1").get();
	if (row?.user_id) return String(row.user_id);
	throw new BridgeError("UNSUPPORTED_ENV", void 0, { reason: "WorkBuddy 中没有任何会话，无法确定用户 ID。请先在 WorkBuddy 里创建并打开一个会话，再重试。" });
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
function readRolloutText(file) {
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
		const text = readRolloutText(file);
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
		const text = readRolloutText(file);
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
