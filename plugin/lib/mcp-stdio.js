import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto$1 from "node:crypto";
import os from "node:os";
import zlib from "node:zlib";
//#region \0rolldown/runtime.js
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
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
//#region src/convert/toolmap.ts
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
	const threadId = xMeta.sessionId ?? deriveThreadId(header.id);
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
function deriveThreadId(dshId) {
	const m = dshId.match(/^session-codex-(.+)$/);
	if (m) return m[1];
	return dshId.replace(/^session-/, "");
}
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
/** 安全余量：预算按 92% 使用（留出客户端包装开销） */
const BUDGET_SAFETY_RATIO = .92;
/** 默认预算（未指定模型/预算时） */
const DEFAULT_BUDGET = 2e5;
/** 硬上限：允许的最大预算（2M，覆盖 Gemini 1.5 Pro 等） */
const MAX_BUDGET = 2e6;
/**
* 模型上下文长度预设表。
*
* 键为小写匹配片段（按顺序匹配，先具体后通用）。
* 数值为**模型总上下文窗口**（不是可用输出），预算会再乘安全系数。
*/
const MODEL_CONTEXT_PRESETS = [
	{
		match: "claude-opus-4",
		context: 2e5,
		label: "Claude Opus 4"
	},
	{
		match: "claude-sonnet-4",
		context: 2e5,
		label: "Claude Sonnet 4"
	},
	{
		match: "claude-3-7",
		context: 2e5,
		label: "Claude 3.7"
	},
	{
		match: "claude-3-5",
		context: 2e5,
		label: "Claude 3.5"
	},
	{
		match: "claude",
		context: 2e5,
		label: "Claude"
	},
	{
		match: "gpt-5",
		context: 4e5,
		label: "GPT-5"
	},
	{
		match: "gpt-4.1",
		context: 1e6,
		label: "GPT-4.1"
	},
	{
		match: "gpt-4o",
		context: 128e3,
		label: "GPT-4o"
	},
	{
		match: "gpt-4-turbo",
		context: 128e3,
		label: "GPT-4 Turbo"
	},
	{
		match: "gpt-4",
		context: 128e3,
		label: "GPT-4"
	},
	{
		match: "o1",
		context: 2e5,
		label: "o1"
	},
	{
		match: "o3",
		context: 2e5,
		label: "o3"
	},
	{
		match: "gemini-2",
		context: 1e6,
		label: "Gemini 2"
	},
	{
		match: "gemini-1.5-pro",
		context: 2e6,
		label: "Gemini 1.5 Pro"
	},
	{
		match: "gemini",
		context: 1e6,
		label: "Gemini"
	},
	{
		match: "deepseek-v4",
		context: 256e3,
		label: "DeepSeek V4"
	},
	{
		match: "deepseek-v3",
		context: 128e3,
		label: "DeepSeek V3"
	},
	{
		match: "deepseek",
		context: 128e3,
		label: "DeepSeek"
	},
	{
		match: "glm-5",
		context: 2e5,
		label: "GLM-5"
	},
	{
		match: "glm-4.6",
		context: 2e5,
		label: "GLM-4.6"
	},
	{
		match: "glm-4",
		context: 128e3,
		label: "GLM-4"
	},
	{
		match: "glm",
		context: 128e3,
		label: "GLM"
	},
	{
		match: "kimi-k2",
		context: 256e3,
		label: "Kimi K2"
	},
	{
		match: "kimi",
		context: 128e3,
		label: "Kimi"
	},
	{
		match: "qwen",
		context: 128e3,
		label: "Qwen"
	},
	{
		match: "minimax",
		context: 2e5,
		label: "MiniMax"
	},
	{
		match: "doubao",
		context: 128e3,
		label: "豆包"
	},
	{
		match: "hunyuan",
		context: 128e3,
		label: "混元"
	},
	{
		match: "yi-",
		context: 2e5,
		label: "Yi"
	},
	{
		match: "llama",
		context: 128e3,
		label: "Llama"
	},
	{
		match: "mistral",
		context: 128e3,
		label: "Mistral"
	}
];
/** 按模型名查上下文长度（未匹配返回 undefined） */
function contextForModel(model) {
	if (!model) return void 0;
	const m = model.toLowerCase();
	for (const p of MODEL_CONTEXT_PRESETS) if (m.includes(p.match)) return {
		context: p.context,
		label: p.label
	};
}
/**
* 解析预算。
*
* 优先级：显式 budget > 模型预设 > 默认 200k
* 上限：MAX_BUDGET
*/
function resolveBudget(opts = {}) {
	let requested;
	let source;
	let modelPreset;
	if (opts.budget != null && Number.isFinite(opts.budget) && opts.budget > 0) {
		requested = Math.floor(opts.budget);
		source = "explicit";
	} else {
		const preset = contextForModel(opts.model);
		if (preset) {
			requested = preset.context;
			modelPreset = preset;
			source = "model";
		} else {
			requested = DEFAULT_BUDGET;
			source = "default";
		}
	}
	let clamped = false;
	if (requested > 2e6) {
		requested = MAX_BUDGET;
		clamped = true;
		source = "clamped";
	}
	if (requested < 1) requested = 1;
	return {
		requested,
		effective: Math.floor(requested * BUDGET_SAFETY_RATIO),
		source,
		modelPreset,
		clamped
	};
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
*
* 预算来源优先级：opts.budget > opts.model 预设 > 默认 200k
*/
function summarizeSession(session, opts = {}) {
	const budgetInfo = resolveBudget({
		budget: opts.budget,
		model: opts.model
	});
	const budget = budgetInfo.effective;
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
			stats,
			budget: budgetInfo
		};
	}
	if (stats.originalTokens <= budget || fidelity === "full" && stats.originalTokens <= budget * 1.05) {
		stats.returnedTokens = stats.originalTokens;
		stats.level = "L0";
		return {
			context: originalText,
			outline: buildOutline(session),
			stats,
			budget: budgetInfo
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
			stats,
			budget: budgetInfo
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
		stats,
		budget: budgetInfo
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
		description: "获取指定会话的上下文，自动压缩到 token 预算内。预算可由 `model`（按模型上下文窗口自动定）或 `budget`（显式 token 数）指定，默认 200k。技术细节（代码块、命令、路径、报错、参数）优先保留，超出预算时早期轮次折叠为摘要。",
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
				model: {
					type: "string",
					description: "模型名（可选）。按模型上下文窗口自动定预算，如 claude-sonnet-4-5→200k、gpt-4.1→1M、gemini-1.5-pro→2M、deepseek-v4→256k、glm-5→200k。与 budget 同时传时 budget 优先。"
				},
				budget: {
					type: "number",
					description: "显式 token 预算（可选，优先级最高，上限 2M）"
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
		const model = args.model ? String(args.model) : void 0;
		const budgetArg = args.budget != null ? Number(args.budget) : void 0;
		const budgetInfo = resolveBudget({
			budget: budgetArg,
			model
		});
		const read = await readSession(client, sessionId);
		const sum = summarizeSession(read.session, {
			budget: budgetArg,
			model,
			fidelity: args.fidelity,
			focus: Array.isArray(args.focus) ? args.focus.map(String) : void 0
		});
		const sourceText = budgetInfo.source === "model" ? `模型 ${model} → ${budgetInfo.modelPreset?.label ?? "预设"} ${budgetInfo.modelPreset?.context ?? budgetInfo.requested}` : budgetInfo.source === "explicit" ? `显式指定 ${budgetInfo.requested}` : budgetInfo.source === "clamped" ? `已裁剪到上限 ${budgetInfo.requested}` : `默认 ${budgetInfo.requested}`;
		return textResult([
			`<!-- 会话上下文：${read.session.title} -->`,
			`<!-- 来源 ${client} · ${read.session.turns.length} 轮 · 预算 ${budgetInfo.effective}（${sourceText}，安全系数 92%） -->`,
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
				},
				model: {
					type: "string",
					description: "模型名（可选，用于自动定预算；显式 budget 优先）"
				}
			},
			required: ["client", "sessionId"]
		}
	}, async (args) => {
		const client = assertClient(args.client, "client");
		const sessionId = String(args.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId 不能为空");
		const budget = args.budget != null ? Number(args.budget) : 8e3;
		const model = args.model ? String(args.model) : void 0;
		const read = await readSession(client, sessionId);
		const sum = summarizeSession(read.session, {
			budget,
			model,
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
	server.tool({
		name: "list_models",
		description: "列出内置的模型上下文长度预设。调用 get_context 时可传 model 名自动定预算，也可直接传 budget（显式 token 数，优先级更高）。",
		inputSchema: {
			type: "object",
			properties: { query: {
				type: "string",
				description: "按名称过滤（可选）"
			} }
		}
	}, async (args) => {
		const q = args.query ? String(args.query).toLowerCase() : "";
		const rows = MODEL_CONTEXT_PRESETS.filter((p) => !q || p.match.includes(q) || p.label.toLowerCase().includes(q));
		const lines = [
			"# 模型上下文长度预设",
			"",
			`默认预算：${DEFAULT_BUDGET.toLocaleString()} tokens（未指定 model / budget 时）`,
			`安全系数：92%（实际可用 = 上下文 × 0.92）`,
			`硬上限：2,000,000 tokens`,
			"",
			"| 匹配片段 | 上下文窗口 | 实际可用 | 模型 |",
			"|---|---|---|---|"
		];
		for (const p of rows) lines.push(`| \`${p.match}\` | ${p.context.toLocaleString()} | ${Math.floor(p.context * .92).toLocaleString()} | ${p.label} |`);
		lines.push("");
		lines.push("用法示例：");
		lines.push("- `get_context({ client, sessionId, model: \"claude-sonnet-4-5\" })` → 按 200k 预算");
		lines.push("- `get_context({ client, sessionId, budget: 500000 })` → 显式 500k");
		lines.push("- 两者同时传时，`budget` 优先");
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
//#region src/mcp/stdio-entry.ts
/**
* mcp/stdio-entry.ts —— MCP Server stdio 入口
*
* 独立进程运行，通过 stdin/stdout 与 MCP 客户端通信（每行一个 JSON-RPC）。
* 构建产物：`lib/mcp-stdio.js`，由 `bin/mcp-stdio.js` 转发。
*
* ⚠️ stdout 只能输出协议消息！所有日志必须写 stderr。
*/
const server = createBridgeMcpServer();
function log(msg) {
	process.stderr.write(`[dsh-codex-bridge-mcp] ${msg}\n`);
}
log(`启动：${server.listTools().length} 个工具（${server.listTools().map((t) => t.name).join(", ")}）`);
const rl = createInterface({
	input: process.stdin,
	crlfDelay: Infinity
});
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	(async () => {
		try {
			const out = await server.handleLine(trimmed);
			if (out) process.stdout.write(out + "\n");
		} catch (e) {
			log(`处理失败：${String(e?.message ?? e)}`);
		}
	})();
});
rl.on("close", () => {
	log("stdin 关闭，退出");
	process.exit(0);
});
process.on("SIGINT", () => {
	log("收到 SIGINT，退出");
	process.exit(0);
});
process.on("uncaughtException", (e) => {
	log(`未捕获异常：${e?.message ?? e}`);
});
process.on("unhandledRejection", (e) => {
	log(`未处理拒绝：${String(e)}`);
});
//#endregion
export {};
