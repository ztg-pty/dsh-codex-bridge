# Codex 会话桥接（dsh-codex-bridge）

打通 **Codex** / **DeepSeek Harness（DSH）** / **WorkBuddy AI** 三端会话，支持双向导入导出。

> 完整文档、安装脚本与踩坑记录见仓库根目录 [README.md](../README.md)。

---

## 功能

### 导入 Codex 会话（Codex → DSH）
1. 自动扫描本机 `%USERPROFILE%\.codex`（含 `archived_sessions` 归档目录）
2. 以 Codex 官方 `session_index.jsonl` 为准列出会话，**自动去重**，标题用 `thread_name`
3. 用户勾选（默认不选）+ 选择目标 DSH 工作区
4. 完成后会话出现在对应工作区，可立即发消息继续

### 导出至 Codex（DSH → Codex）
1. 弹出会话列表，**手动勾选**（绝不自动全选）
2. 导出为 OpenAI 兼容 JSONL（含 UI 渲染所需的 `item_completed` 事件）
3. **导出瞬间自动备份** Codex 目录中的旧版 JSONL
4. 完成后提示：需手动复制到 Codex 原目录 + 备份位置
5. 复制后点「注册到 Codex 索引」，自动补 `threads` 表与 `session_index.jsonl`

> 插件**不会**直接写入 Codex 会话目录，避免破坏正在进行的会话。

### 导出至 WorkBuddy（DSH → WorkBuddy）
1. 手动勾选会话
2. **直接写入** WorkBuddy 本地存储（数据库 + 会话 JSONL，写入前自动备份）
3. 重启 WorkBuddy 即可在会话列表看到

---

## 安装

```bash
# 1. 构建
cd plugin
npm install
npm run build        # 产出 lib/index.js + lib/client.js

# 2. 链接到 DSH profile
cd ~/.dsh/profiles/desktop
# 在 package.json 的 dsh.profile.bundles 中加入：
#   "dsh-codex-bridge"
# 并把插件包放到 node_modules 下（或 npm link / file: 依赖）

# 3. 重启 DSH
```

注册文件 `cordis.patch.yml` 会自动把插件插入配置树：

```yaml
- insert:
    - id: codex-bridge
      name: dsh-codex-bridge
      config:
        codexHome: ""              # 留空 = 自动探测
        outputDir: ""              # 留空 = <dsh-home>/codex-bridge/export
        backupBeforeExport: true
        maxSessionBytes: 268435456 # 256 MB
```

---

## 目录结构

```
plugin/
├── package.json                    # 插件清单（dsh.bundle + dsh.client 双入口）
├── cordis.patch.yml                # 服务端注册
├── tsconfig.json / vitest.config.ts
├── src/
│   ├── index.ts                    # 服务端入口：apply(ctx, config)
│   ├── client.ts                   # 浏览器入口：注册设置页
│   ├── shims.d.ts                  # cordis / schemastery 最小类型声明
│   ├── convert/                    # ★ 纯转换内核（无 IO，可单测）
│   │   ├── codex-reader.ts         # 读 rollout（明文 .jsonl / 压缩 .zst）
│   │   ├── codex2dsh.ts            # Codex → DSH
│   │   ├── dsh2codex.ts            # DSH → Codex
│   │   ├── dsh-store.ts            # DSH v4 多 frame zstd 读写
│   │   └── toolmap.ts              # 工具名/参数双向映射
│   ├── host/
│   │   ├── routes.ts               # HTTP 路由（loopback 校验）
│   │   ├── import.ts               # 扫描 + 导入编排
│   │   ├── export.ts               # 导出 + 备份编排
│   │   ├── oplog.ts                # 操作日志（NDJSON，不含正文）
│   │   └── paths.ts                # 路径探测
│   ├── io/adapter.ts               # 桌面 / Web 双环境适配
│   ├── client/                     # React UI
│   │   ├── SettingsPage.tsx        # 插件独立设置页
│   │   ├── ImportDialog.tsx
│   │   ├── ExportDialog.tsx
│   │   └── LogPanel.tsx
│   └── shared/
│       ├── types.ts                # 双端类型定义
│       └── errors.ts               # 错误码 + 中文文案
└── test/convert.spec.ts            # 17 项单元测试
```

---

## 关键技术点（均经真实数据实测）

### 1. DSH 会话是多帧 zstd

单个 `session.v4.jsonl.zstd` 由**多个独立 zstd frame 顺序追加**组成。
实测：4,334,982 字节 = 2,305 帧 = 3,980 行。

```ts
// ❌ 错误：只得到第一帧（214 字节 header）
zstdDecompressSync(整个文件)

// ✅ 正确：按魔数切帧
const cuts = findFrameOffsets(buf);      // 扫描 28 B5 2F FD
for (const [start, end] of ranges) text += decompress(buf.subarray(start, end));
```

### 2. `seq` 必须稠密

```js
if (event.seq !== index) throw new SessionFormatError(`format v4 event ${index} is not dense`);
```
生成事件时 `seq = 数组下标`，从 0 开始，不能跳号。

### 3. 会话头是严格白名单

只允许：`version` `id` `createdAt` `isSeeded` `delegationDepth` `cwd` `parentSession` `origin` `agentPreset`。

**任何自定义字段都会导致加载失败**。Codex 独有元数据改用 `ignorable: true` 的专用事件承载：

```ts
{ type: 'codex-bridge/meta', seq: n, time, ignorable: true, data: { ... } }
```

### 4. `source.kind` 约束

- 必须非空字符串
- **`'plugin'` 被硬拒**
- 子代理消息用 `{ kind:'agent-message', form:'relay', senderSessionId }`

### 5. 工具调用三处一致

同一个 `callId` 必须同时出现在：
- `assistant/message` 的 `tool-call` 内容块
- `tool/call` 事件
- `tool/result` 事件（`message.toolCallId === message.source.callId`）

### 6. 加密内容占位

Codex 中约 70% 的 `agent_message` 正文是加密的（`encrypted_content`）。
处理方式：替换为合法 text 块，**不破坏结构**。

```ts
{ type: 'text', text: `[加密内容 · 无法解码 · ${bytes} 字节]` }
```

---

## 错误提示（全部中文）

| 错误码 | 中文提示 |
|---|---|
| `CODEX_DIR_NOT_FOUND` | 未找到 Codex 会话目录（预期位置：…），请确认 Codex 已安装并至少使用过一次 |
| `PERMISSION_DENIED` | 权限不足：无法读取 …，请检查文件夹权限 |
| `FILE_CORRUPTED` | 文件已损坏：… 数据无法解压，该会话已跳过 |
| `JSON_PARSE_FAILED` | JSON 解析失败：… 第 N 行格式错误，该行已跳过 |
| `FILE_TOO_LARGE` | 会话文件过大：…，为避免内存耗尽已跳过 |
| `DSH_SESSION_EXISTS` | 该会话已导入过（目标 ID：…），请选择跳过或覆盖 |
| `NO_SELECTION` | 请至少勾选一个会话。 |
| `WEB_MODE_LIMIT` | 当前为 Web 模式，浏览器无法访问本机目录，请改用上传/下载 |

---

## 桌面端 vs Web 端

| 能力 | 桌面端 | Web 端 |
|---|---|---|
| 扫描本机目录 | ✅ | ❌（不强行读取） |
| 本地文件读写 | ✅ | ❌ |
| 导入 | 目录扫描 | 文件上传 |
| 导出 | 写本地文件 | Blob 下载 |

UI 自动检测环境并切换，两套模式复用同一套转换内核。

---

## 测试

```bash
npm run typecheck   # tsc，0 错误
npm test            # 17 项单元测试
```

集成验证（真实数据）：
- 扫描 140 个真实 Codex 会话（含 36 个子代理）
- 导入产物通过 DSH 官方校验器 `restoreReleasedV4Artifact`
- 导出 JSONL 的 `function_call` / `output` 数量配对
- 往返一致性（导出→再导入，thread id 保持）

---

## 已知限制

1. **加密内容不可还原**：Codex 的 `encrypted_content` 需要 Codex 侧密钥，插件不尝试解密，以占位符呈现。
2. **子代理默认不单独导入**：只导父会话（含子代理最终交付的明文内容），`subagent/catalog` 以 `one-shot` 声明。
3. **工具语义降级**：`apply_patch`→`edit`、`exec`(JS)→`pwsh` 等无法完全等价，导入后会在会话中提示"历史结果不可重放"。
4. **不写 Codex 目录**：导出只产出文件 + 备份，需手动复制。
