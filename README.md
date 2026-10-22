# DSH 会话桥接（dsh-codex-bridge）

把 **Codex**、**DeepSeek Harness（DSH）**、**Zcode**、**Claude Code**、**WorkBuddy AI** 五端的会话历史互相打通，并提供 **MCP Server** 让任意支持 MCP 的客户端接入。

> 一个 DSH 插件 + 一个独立 MCP 服务：
> 在任意客户端里干活，历史随时搬到另一端继续。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-green)
![MCP](https://img.shields.io/badge/MCP-2024--11--05-purple)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## 功能总览

| 能力 | 说明 |
|---|---|
| **五端互通** | Codex / DSH / Zcode / Claude Code / WorkBuddy 任意两端互转（20 条路径） |
| **上下文压缩** | 自动压到 200k token 内，技术细节（代码/命令/路径/报错）优先保留 |
| **MCP Server** | 6 个工具，任意 MCP 客户端可取/存上下文 |
| **UI 界面** | DSH 插件内可视化操作：跨端转换、上下文预览、日志 |
| **安全** | 写入前自动备份、转换前显示损失提示、全程中文错误信息 |

### 架构：N×N 靠 UIR 枢纽

```
   Codex ──┐                    ┌── Codex
     DSH ──┤                    ├── DSH
   Zcode ──┼──▶  UIR  ◀─────────┼── Zcode
Claude CC ─┤  统一中间表示       ├── Claude CC
WorkBuddy ─┘                    └── WorkBuddy
                    ▲
                    │
              MCP Server（通用接入）
```

不需要 N² 个转换器，只需 2N 个适配器（每端一读一写）。

---

## 安装

### 前置条件

| 项目 | 要求 |
|---|---|
| DSH | 桌面版 `0.2.1-rc.2` |
| Node.js | `^22.19.0` 或 `>=24`（需要内置 `node:sqlite`） |
| 系统 | Windows（路径编码逻辑已实测；macOS/Linux 兼容但未真机验证） |

### 方式一：一键安装（推荐）

```powershell
git clone https://github.com/ztg-pty/dsh-codex-bridge.git
cd dsh-codex-bridge
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

**无需构建**：`plugin/lib/` 已包含编译好的产物（`index.js` / `client.js` / `mcp-stdio.js`），
clone 下来直接就能装。

脚本会自动：
1. 备份 profile 原有配置（可用 `scripts/rollback.ps1` 回滚）
2. 复制插件到 `<profile>/node_modules/dsh-codex-bridge`
3. 登记到 profile 的 `dependencies` 与 `dsh.bundles`
4. 提示重启 DSH

> 如果 DSH profile 不在默认位置，可用环境变量指定：
> ```powershell
> $env:DSH_PROFILE_DIR = "D:\path\to\profile"
> powershell -ExecutionPolicy Bypass -File scripts/install.ps1
> ```

### 方式二：手动安装

1. 把 `plugin/` 复制到 `<DSH profile>/node_modules/dsh-codex-bridge`
2. 在 profile 的 `package.json` 里：
   - `dependencies` 加 `"dsh-codex-bridge": "file:<路径>/plugin"`
   - `dsh.bundles` 加 `"dsh-codex-bridge"`
3. **重启 DSH**

### 验证安装

```bash
node --experimental-strip-types --import ./scripts/ts-register.mjs scripts/acceptance.mjs
```

会自检 29 项（UI / 五端适配器 / MCP / 可移植性 / 构建部署 / 中文错误），全部通过即安装成功。

### 卸载 / 回滚

```powershell
powershell -ExecutionPolicy Bypass -File scripts/rollback.ps1
```

---

## 使用

### 一、UI 操作（DSH 插件内）

打开 插件 → **会话桥接**，三个入口：

1. **跨端转换 / 上下文预览**
   - 选源客户端 → 选会话 → 选目标客户端
   - 自动显示「转换会丢失什么」
   - 可先「预览压缩上下文」并下载 Markdown
   - 点「开始转换」

2. **导入 Codex 会话** —— Codex → DSH（选目标工作区）

3. **导出至 Codex / WorkBuddy** —— DSH → 目标端

### 二、MCP 接入（任意客户端）

MCP Server 有两种运行方式：

**方式 A：stdio（推荐，最通用）**

```bash
node <插件目录>/bin/mcp-stdio.js
```

在各客户端配置：

<details>
<summary>Claude Code</summary>

```bash
claude mcp add dsh-bridge -- node "C:/path/to/plugin/bin/mcp-stdio.js"
```
</details>

<details>
<summary>Cursor</summary>

在 `.cursor/mcp.json`：
```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "node",
      "args": ["C:/path/to/plugin/bin/mcp-stdio.js"]
    }
  }
}
```
</details>

<details>
<summary>Cline / Continue / 其他</summary>

同上格式：`command` + `args` 指向 `bin/mcp-stdio.js`。
</details>

**方式 B：HTTP（复用 DSH 插件服务）**

DSH 运行时，MCP 端点：
```
POST http://127.0.0.1:<DSH端口>/plugins/dsh-codex-bridge/mcp
GET  http://127.0.0.1:<DSH端口>/plugins/dsh-codex-bridge/mcp/tools   （调试用）
```

### 三、MCP 工具清单

| 工具 | 用途 |
|---|---|
| `list_clients` | 列出可用客户端与能力矩阵 |
| `list_sessions` | 列会话（可按客户端/目录/关键字过滤） |
| `get_context` | **核心**：取压缩上下文（默认 200k 预算） |
| `push_context` | 把当前对话写入目标端 |
| `transfer_session` | 端到端直接转换 |
| `summarize_session` | 只生成摘要 |

**典型用法**（在 Claude Code / Cursor 里说）：

> 「把 DSH 里『城市地图系统』那个会话的上下文拉进来」
> → 客户端调 `list_sessions` → `get_context`

> 「把这段对话存到 Zcode」
> → 客户端调 `push_context({ target: 'zcode', messages: [...] })`

---

## 上下文压缩（核心能力）

**目标**：返还近乎完整的信息，但不超过 200k token；技术细节不丢失。

### 四级流水线

```
L0 原始   → 未超预算直接返回
L1 去冗余 → 剥离环境注入模板、去重（无损）
L2 结构化 → 每条消息压成 {意图, 关键操作, 结果}，P0 片段逐字保留
L3 骨架   → 早期轮次折叠成摘要句
```

### 保留优先级

| 等级 | 内容 | 处理 |
|---|---|---|
| **P0** | 代码块、命令、文件路径、报错、版本号、参数 | **逐字保留** |
| P1 | 工具调用序列、决策理由 | 保留，结果可截断 |
| P2 | 叙述性解释、过程思考 | 压成一句 |
| P3 | 客套话、环境注入模板 | 丢弃 |

### 技术索引

即使早期轮次被折叠，其中的**文件、目录、命令、报错、版本号**会被去重后集中列在末尾的「技术索引」里。

### 实测数据（真实会话）

会话「Blender 写实城市建模」（**133 万 tokens**，44 轮）压缩到 200k 预算：

```
预算利用率    99.9%（182,712 / 184,000）
报错保留      50%
命令保留      45%
技术索引      814 条（含全部 761 个可识别文件名）
```

---

## 五端存储格式（实测）

| 客户端 | 存储位置 | 结构 |
|---|---|---|
| **DSH** | `~/.dsh/sessions/<projectKey>/<id>/session.v4.jsonl.zstd` | 多帧 zstd + v4 事件流 |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `state_5.sqlite` | JSONL + SQLite 索引 |
| **Zcode** | `~/.zcode/cli/db/db.sqlite` | SQLite（session/message/part 三表） |
| **Claude Code** | `~/.claude/projects/<cwd编码>/<id>.jsonl` | JSONL + parentUuid 链 |
| **WorkBuddy** | `~/.workbuddy-ai/workbuddy.db` + `projects/<编码>/<id>.jsonl` | SQLite + JSONL |

所有路径从 `os.homedir()` + 环境变量推导，支持覆盖：
`DSH_HOME` / `CODEX_HOME` / `ZCODE_HOME` / `CLAUDE_HOME` / `WORKBUDDY_HOME`

---

## 项目结构

```
dsh-codex-bridge/
├── plugin/
│   ├── src/
│   │   ├── uir/                 # 统一中间表示
│   │   │   ├── types.ts         # UIR 类型 + 适配器接口
│   │   │   └── helpers.ts       # 价值分级、特征检测、校验
│   │   ├── adapters/            # 五端适配器
│   │   │   ├── registry.ts      # 注册表 + 跨端转换
│   │   │   ├── dsh/adapter.ts
│   │   │   ├── codex/adapter.ts
│   │   │   ├── zcode/adapter.ts
│   │   │   ├── claude-code/adapter.ts
│   │   │   └── workbuddy/adapter.ts
│   │   ├── budget/              # Token 预算与压缩
│   │   │   ├── tokens.ts
│   │   │   └── summarize.ts
│   │   ├── mcp/                 # MCP Server
│   │   │   ├── protocol.ts      # JSON-RPC 2.0 + MCP 方法
│   │   │   ├── tools.ts         # 6 个工具
│   │   │   └── stdio-entry.ts   # stdio 入口
│   │   ├── client/              # React UI
│   │   ├── host/                # 路由、日志、客户端探测
│   │   └── convert/             # 底层格式读写
│   ├── bin/mcp-stdio.js         # MCP CLI 入口
│   ├── lib/                     # 构建产物（已提交，可直接安装）
│   └── test/                    # 35 个单元测试
├── docs/                        # 架构与验证文档
└── scripts/                     # 安装 / 回滚 / 推送
```

---

## 技术要点（踩过的坑）

### DSH 侧

| 约束 | 说明 |
|---|---|
| 会话目录名 | 必须是 `projectKey(cwd)`（`D:\UE Save\x` → `--D-UE~0020Save-x--`） |
| header 首行 | 物理层必须带 `type:"session"` |
| `assistant/message` | 必须含 `stream` 数组 |
| 事件序列化 | 不能有 `undefined` 值 |
| `session/title` | `source.kind==='user'` 时 `messageSeqs` 必须为空 |
| 客户端打包 | 用 `__ModuleLoader__.load`，**不能有 `export default`** |
| 服务注入 | 顶层 `inject` 必须是 `[]`，用 `ctx.inject(['webServer'], ...)` |

### Codex 侧

| 约束 | 说明 |
|---|---|
| 会话列表 | 读 `state_5.sqlite` 的 `threads` 表（**不是扫目录**） |
| UI 渲染 | 依赖 rollout 里的 `event_msg/item_completed` |
| 文件名 | 必须 `rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl`（无毫秒无 Z） |
| `rollout_path` | `\\?\` 长路径 + realpath |

### Zcode 侧

| 约束 | 说明 |
|---|---|
| 结构 | `session` / `message` / `part` 三表，类型在 `part.data.type` |
| `title_source` | CHECK 约束只允许 `default/first_input/generated/custom` |
| 模型信息 | 在 `session_entry` 的 `runtime/model_selection`，嵌套 `modelSelection` |
| 写入风险 | 数据库 400MB+ 且可能运行中 → **写入前强制备份** |

### Claude Code 侧

| 约束 | 说明 |
|---|---|
| 目录编码 | `D:\UE Save\fpsys\FPS_Extraction` → `D--UE-Save-fpsys-FPS-Extraction` |
| 消息树 | `parentUuid` 链（跨端会线性化） |
| 标题 | 需过滤 `<command-name>` 等 CLI 标记 |

### WorkBuddy 侧

| 约束 | 说明 |
|---|---|
| 写入顺序 | **必须先写数据库再写文件**，否则目录被清理 |
| 目录名 | `D:/x` → `d-x`（盘符小写） |
| `user_id` | 三级兜底：会话行 → `user-<uuid>-personal` 目录 → 报错 |

---

## 开发

```bash
cd plugin
npm install
npm run typecheck   # 类型检查
npm test            # 35 个单元测试
npm run build       # 构建 index.js + client.js + mcp-stdio.js
```

## 已知限制

- **各客户端需重启**才能看到写入的会话（都只在启动时读索引）
- 工具名映射有损：`exec_command` → `pwsh`、`apply_patch` → `edit`
- 子代理会话合并进父会话，不单独导入
- 加密内容（Codex `encrypted_content`、DSH 加密思考）只能占位
- Claude Code 的消息分支（`parentUuid` 树）跨端时线性化
- 仅 Windows 完整实测

## 免责声明

本项目通过逆向分析各客户端本地存储格式实现互通，**会写入这些应用的本地数据**。
虽然实现了自动备份，但仍建议：

- 操作前自行备份 `~/.dsh`、`~/.codex`、`~/.zcode`、`~/.claude`、`~/.workbuddy-ai`
- 不要在应用正在写入会话时批量操作
- 客户端版本升级可能改变存储格式，升级后请先小样本验证

使用本工具造成的任何数据问题，作者不承担责任。

## License

[MIT](LICENSE)
