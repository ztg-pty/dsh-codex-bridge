# DSH 会话桥接（dsh-codex-bridge）

把 **Codex**、**DeepSeek Harness（DSH）**、**WorkBuddy AI** 三端的会话历史互相打通。

> 一个 DSH 插件：在 DSH 的插件设置里点几下，就能把 Codex 的历史会话导进来继续聊；
> 也能把 DSH 的会话导出到 Codex 或直接写入 WorkBuddy。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-green)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## 功能

### 1. 导入：Codex → DSH

- 自动扫描本机 Codex 会话目录（`~/.codex`，**同时扫描 `archived_sessions` 归档目录**）
- 以 Codex 官方索引 `session_index.jsonl` 为准列出会话，**自动去重**（一个 thread 的多个 turn 分片合并）
- 标题使用 Codex 维护的 `thread_name`，不是猜的
- 支持关键字 / 日期筛选，手动勾选（**默认不选中**）
- 导入时选择**目标 DSH 工作区**，导入后即可在聊天列表打开、继续对话
- 加密内容（Codex 的 `encrypted_content`）以 `[加密内容 · 无法解码 · N 字节]` 占位，不破坏结构
- 子代理会话合并进父会话（子代理内容挂 catalog，不单独导入）

### 2. 导出：DSH → Codex

- 手动多选（**不会自动全选**）
- 导出为 OpenAI 兼容 JSONL，**包含 UI 渲染所需的 `item_completed` 事件**
- 导出瞬间**自动备份** Codex 目录中的旧 JSONL
- 插件**不直接写入** Codex 会话目录（避免破坏进行中的会话），由你手动复制
- 复制后点「**注册到 Codex 索引**」，自动补 `state_5.sqlite` 的 `threads` 表与 `session_index.jsonl`
- 文件名严格遵循 Codex canonical 格式 `rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl`

### 3. 导出：DSH → WorkBuddy

- 手动多选，**直接写入** WorkBuddy 本地存储（数据库 + 会话 JSONL）
- 自动处理 WorkBuddy 的 `sessions` / `workspaces` 表和项目目录命名
- 重启 WorkBuddy 即可在会话列表看到

### 4. 其他

- 全程**中文错误提示**（不会出现裸错误码）
- 所有导入 / 导出 / 备份操作都写**操作日志**（插件内可查看，落盘 NDJSON，4MB 自动轮转）
- 只监听 loopback + 校验 Host/Origin，写操作仅接受 POST

---

## 安装

### 前置条件

| 项目 | 要求 |
|---|---|
| DSH | 桌面版 `0.2.1-rc.2`（其他版本接口可能不同） |
| Node.js | `^22.19.0` 或 `>=24`（需要内置 `node:sqlite`） |
| 系统 | Windows（路径与编码逻辑针对 Windows 实现） |

### 方式一：脚本安装（推荐）

```powershell
git clone https://github.com/<your-name>/dsh-codex-bridge.git
cd dsh-codex-bridge
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

脚本会：
1. 把插件目录登记到 DSH desktop profile 的 `package.json`
2. 复制构建产物到 profile 的 `node_modules`
3. 备份原有配置（可用 `scripts/rollback.ps1` 回滚）

### 方式二：手动安装

1. 找到 DSH desktop profile（通常 `%USERPROFILE%\.dsh\profiles\desktop`）
2. 把本仓库 `plugin/` 目录复制到 `<profile>/node_modules/dsh-codex-bridge`
3. 编辑 `<profile>/package.json`：
   - `dependencies` 加 `"dsh-codex-bridge": "file:<本仓库>/plugin"`
   - `dsh.bundles` 数组加 `"dsh-codex-bridge"`
4. **重启 DSH**

安装后：DSH → 插件 → 找到「Codex 会话桥接」。

> 修改了插件代码？需要 `cd plugin && npm install && npm run build` 重新构建 `lib/`，然后重启 DSH。

---

## 使用

### 导入 Codex 会话

1. 插件卡片 → **导入 Codex 会话**
2. 等待扫描（列出 Codex 索引里的会话，按更新时间倒序）
3. 勾选要导入的会话 → **下一步：选择目标工作区**
4. 选一个 DSH 工作区（或手动输入路径）
5. 选择「已存在时」行为：跳过 / 覆盖
6. **开始导入** → 回到对应工作区的聊天列表即可打开

### 导出到 Codex

1. 插件卡片 → **导出到 Codex / WorkBuddy**
2. 目标选 **Codex**
3. 勾选会话 → 确认导出
4. 复制生成的 JSONL 到 `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\`
5. 回到插件点「**注册到 Codex 索引**」
6. 重启 Codex

### 导出到 WorkBuddy

1. 目标选 **WorkBuddy**
2. 勾选会话 → 确认导出（自动备份数据库后直接写入）
3. **重启 WorkBuddy**

---

## 项目结构

```
dsh-codex-bridge/
├── plugin/                     # DSH 插件（npm 包）
│   ├── src/
│   │   ├── index.ts            # 服务端入口（cordis 插件）
│   │   ├── client.ts           # 浏览器端入口（__ModuleLoader__ 协议）
│   │   ├── client/             # React 设置页与对话框
│   │   ├── convert/
│   │   │   ├── codex-reader.ts # 读 Codex rollout（含 .zst 多帧解压）
│   │   │   ├── codex2dsh.ts    # Codex → DSH 事件流
│   │   │   ├── dsh2codex.ts    # DSH → Codex rollout
│   │   │   ├── dsh2wb.ts       # DSH → WorkBuddy JSONL
│   │   │   ├── dsh-store.ts    # DSH v4 会话读写（zstd 多帧）
│   │   │   └── toolmap.ts      # 工具名双向映射
│   │   ├── host/
│   │   │   ├── import.ts       # 扫描 / 导入 / 注册工作区
│   │   │   ├── export.ts       # 导出 / 备份
│   │   │   ├── codex-index.ts  # 写 Codex 索引（threads 表 + session_index）
│   │   │   ├── wb-store.ts     # 写 WorkBuddy 存储
│   │   │   ├── paths.ts        # 路径与编码（projectKey 等）
│   │   │   ├── routes.ts       # HTTP 路由
│   │   │   └── oplog.ts        # 操作日志
│   │   └── shared/             # 类型与中文错误信息
│   ├── scripts/build-client.mjs  # 客户端打包（DSH 专用格式）
│   ├── test/                   # vitest 单元测试
│   └── lib/                    # 构建产物（已提交，可直接安装）
├── docs/                       # 逆向与验证文档
└── scripts/                    # 安装 / 回滚脚本
```

---

## 技术要点（踩过的坑）

这些是逆向 DSH / Codex / WorkBuddy 时验证出来的硬约束，改代码前建议先看 [`docs/`](docs/)。

### DSH 侧

| 约束 | 说明 |
|---|---|
| 会话目录名 | 必须是 `projectKey(cwd)` 编码（`D:\UE Save\x` → `--D-UE~0020Save-x--`），否则 DSH 发现不了 |
| header 首行 | 物理层必须带 `type:"session"`，否则 `isHeaderLine` 判否、会话被静默跳过 |
| `assistant/message` | 必须含 `stream` 数组，否则加载历史报 `invalid settlement fields` |
| 事件序列化 | 不能有 `undefined` 值（`not losslessly JSON-serializable`） |
| `session/title` | `source.kind==='user'` 时 `messageSeqs` 必须为空，否则报错 |
| `seq` | 必须从 0 开始稠密递增 |
| 工作区归属 | 需写入 `storages/workspace.json` 的 `sessionIds`，且 DSH 只在启动时读 |
| 客户端打包 | 必须用 `window.__ModuleLoader__.load({id, factory})`，且**不能有 `export default`**（会丢 `inject`） |
| 服务注入 | 插件顶层 `inject` 必须是 `[]`，用 `ctx.inject(['webServer'], ...)` |
| 路由命名空间 | `/plugins/<包名>/...` |

### Codex 侧

| 约束 | 说明 |
|---|---|
| 会话列表来源 | `state_5.sqlite` 的 `threads` 表（**不是扫描目录**） |
| 消息渲染来源 | rollout 里的 `event_msg/item_completed`（缺失 → `Couldn't load messages`） |
| 文件名 | 必须 `rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl`（**无毫秒、无 Z**） |
| `rollout_path` | `\\?\F:\...` 长路径格式，且是 **realpath 后**的路径 |
| `base_instructions` | 必需（system prompt），缺失影响加载/续聊 |

### WorkBuddy 侧

| 约束 | 说明 |
|---|---|
| 存储位置 | `~/.workbuddy-ai/workbuddy.db` + `projects/<cwd编码>/<sessionId>.jsonl` |
| 写入顺序 | **必须先写数据库再写文件**，否则项目目录会被当垃圾清理 |
| 目录名 | `D:/UE Save/x` → `d-UE Save-x`（盘符小写，冒号与斜杠都变 `-`） |
| 必需字段 | `sessions` 表必填 `cwd` / `user_id` / `created_at` / `updated_at` |
| 记录结构 | 有 `parentId` 链；`content` 用 `input_text`/`output_text`；推理用 `rawContent[].reasoning_text` |

更多细节见 [`docs/SPEC.md`](docs/SPEC.md)、[`docs/CODEX-DEEP-DIVE.md`](docs/CODEX-DEEP-DIVE.md)、[`docs/P0-VALIDATION-REPORT.md`](docs/P0-VALIDATION-REPORT.md)。

---

## 开发

```bash
cd plugin
npm install
npm run typecheck   # 类型检查
npm test            # 单元测试（17 个）
npm run build       # 构建 lib/index.js + lib/client.js
```

构建产物：
- `lib/index.js` —— 服务端插件
- `lib/client.js` —— 浏览器端（`__ModuleLoader__` IIFE 格式）
- `lib/index.d.ts` —— 类型声明

---

## 已知限制

- **DSH 重启才生效**：插件是 host 插件，改代码后必须重启 DSH
- **导入的会话需要重启 DSH 后才会出现在工作区**（`workspace.json` 只在启动时读）
- **Codex / WorkBuddy 也需要重启**才能看到写入的会话（同样只在启动时读索引）
- 工具名映射是有损的：`exec_command` → `pwsh`、`apply_patch` → `edit`，历史工具结果标记为「不可重放」
- 子代理会话合并进父会话，不单独导入
- Codex 的 `encrypted_content` 无法解码，只能占位
- 仅支持 Windows（路径编码逻辑）

## 免责声明

本项目通过逆向分析 DSH / Codex / WorkBuddy 的本地存储格式实现互通，**会写入这三个应用的本地数据**。
虽然实现了自动备份，但仍建议：

- 操作前自行备份 `~/.dsh`、`~/.codex`、`~/.workbuddy-ai`
- 不要在应用正在写入会话时批量操作
- 应用版本升级可能改变存储格式，升级后请先小样本验证

使用本工具造成的任何数据问题，作者不承担责任。

## License

[MIT](LICENSE)
