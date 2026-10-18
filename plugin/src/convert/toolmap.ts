/**
 * convert/toolmap.ts —— Codex 工具名 ↔ DSH 工具名映射
 *
 * 实测两种 Codex 工具形态：
 *   - function_call       → arguments 是 JSON 字符串，output 是字符串
 *   - custom_tool_call    → input 是原始 JS 代码，output 是数组
 *
 * 实测出现的 Codex 工具名（样本线程统计）：
 *   exec(190) exec_command(41) followup_task(22) spawn_agent(12)
 *   send_message(10) request_user_input_async(4) view_image(3) list_agents(2) sleep(2) shell(1)
 */

export interface MappedTool {
  /** DSH 侧工具名 */
  name: string;
  /** 规范化后的 arguments（JSON 字符串） */
  arguments: string;
  /** 是否发生了语义降级（参数结构不一致，历史结果不可重放） */
  degraded: boolean;
  /** 降级原因，展示给用户 */
  note?: string;
}

/** 把 Codex 的 arguments(JSON 字符串) 安全解析为对象 */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * function_call 形态的映射表。
 * 关键点：exec_command 的 shell 命令 → DSH 的 pwsh(command)。
 */
const FUNCTION_MAP: Record<string, (a: Record<string, unknown>) => MappedTool> = {
  // 命令执行：Codex {cmd|command, shell, workdir} → DSH {command}
  exec_command: (a) => {
    const cmd = String(a.cmd ?? a.command ?? '');
    return {
      name: 'pwsh',
      arguments: JSON.stringify({ command: cmd }),
      degraded: false,
    };
  },
  shell: (a) => {
    const cmd = String(a.command ?? a.cmd ?? '');
    return { name: 'pwsh', arguments: JSON.stringify({ command: cmd }), degraded: false };
  },
  // 文件读取：参数几乎同构
  read_file: (a) => ({
    name: 'read',
    arguments: JSON.stringify({ file_path: a.file_path ?? a.path ?? '' }),
    degraded: false,
  }),
  view_image: (a) => ({
    name: 'read_image',
    arguments: JSON.stringify({ file_path: a.path ?? a.file_path ?? '' }),
    degraded: false,
  }),
  apply_patch: (a) => ({
    name: 'edit',
    arguments: JSON.stringify({ patch: a.input ?? a.patch ?? '' }),
    degraded: true,
    note: 'patch 文本无法还原为 DSH edit 的「文件路径+替换」结构',
  }),
  update_plan: (a) => ({
    name: 'todo_write',
    arguments: JSON.stringify({ todos: a.plan ?? a.todos ?? [] }),
    degraded: true,
    note: '计划结构不同，仅保留内容',
  }),
  // 子代理相关：DSH 有对应概念但调用协议不同
  spawn_agent: (a) => ({
    name: 'spawn_teammate',
    arguments: JSON.stringify({
      name: String(a.task_name ?? 'subagent'),
      description: String(a.task_name ?? ''),
      prompt: '[加密内容 · 无法解码]',
    }),
    degraded: true,
    note: '任务内容在 Codex 中加密，子代理创建参数无法完整还原',
  }),
  send_message: (a) => ({
    name: 'send_message',
    arguments: JSON.stringify({ target: a.agent_id ?? a.target, message: a.message ?? '' }),
    degraded: false,
  }),
  list_agents: () => ({ name: 'list_agents', arguments: '{}', degraded: false }),
  followup_task: (a) => ({
    name: 'send_message',
    arguments: JSON.stringify({ target: a.agent_id ?? a.task_name, message: a.message ?? '' }),
    degraded: true,
    note: 'Codex followup_task 语义映射为 DSH send_message',
  }),
  request_user_input_async: (a) => ({
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: a.questions ?? [] }),
    degraded: true,
    note: '异步提问语义不同',
  }),
  sleep: (a) => ({
    name: 'sleep',
    arguments: JSON.stringify({ ms: a.ms ?? a.duration_ms ?? 0 }),
    degraded: false,
  }),
};

/**
 * custom_tool_call 形态的映射。
 * 实测 custom tool 只有 `exec`（JS 内联执行），input 是原始代码字符串。
 */
function mapCustomTool(name: string, input: string): MappedTool {
  if (name === 'exec') {
    return {
      name: 'pwsh',
      arguments: JSON.stringify({ command: input }),
      degraded: true,
      note: 'Codex 的 JS 内联执行脚本无法直接转为 shell 命令，以原文保留',
    };
  }
  return {
    name: `codex_${sanitize(name)}`,
    arguments: JSON.stringify({ input }),
    degraded: true,
    note: '未知的 Codex custom tool，原样保留',
  };
}

function sanitize(name: string): string {
  return (name || 'unknown').replace(/[^A-Za-z0-9_]/g, '_');
}

/** 映射 function_call */
export function mapFunctionCall(name: string, rawArguments: string): MappedTool {
  const args = safeParseArgs(rawArguments);
  const fn = FUNCTION_MAP[name];
  if (fn) return fn(args);
  // 未知工具：保留原名与原始参数，标记为不可重放
  return {
    name: sanitize(name),
    arguments: rawArguments || '{}',
    degraded: true,
    note: `未知的 Codex 工具「${name}」，原样保留`,
  };
}

/** 映射 custom_tool_call */
export function mapCustomToolCall(name: string, input: string): MappedTool {
  return mapCustomTool(name, input);
}

/** 反向映射：DSH 工具名 → Codex 工具名（导出时用） */
const REVERSE: Record<string, string> = {
  pwsh: 'exec_command',
  bash: 'exec_command',
  read: 'read_file',
  read_image: 'view_image',
  edit: 'apply_patch',
  write: 'apply_patch',
  todo_write: 'update_plan',
  spawn_teammate: 'spawn_agent',
  send_message: 'send_message',
  list_agents: 'list_agents',
  ask_user_question: 'request_user_input_async',
};

export function reverseToolName(dshName: string): string {
  return REVERSE[dshName] ?? dshName;
}

/**
 * 反向参数映射：DSH {command} → Codex {cmd, shell, workdir}
 * Codex exec_command 必填 cmd。
 */
export function reverseArguments(dshName: string, rawArguments: string): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(rawArguments || '{}'); } catch { /* 保留原文 */ }
  if (dshName === 'pwsh' || dshName === 'bash') {
    return JSON.stringify({
      cmd: String(args.command ?? ''),
      shell: 'powershell',
      ...(args.workdir ? { workdir: args.workdir } : {}),
    });
  }
  return rawArguments || '{}';
}
