# 实际安装验证报告

> 验证环境：本机 DSH 0.2.1-rc.2 desktop profile
> 说明：由于我本身运行在 DSH 内，重启会中断本会话，因此由用户手动重启完成最终加载验证。

---

## ✅ 最终验收通过（2026-10-18 10:34）

截图确认的完整效果：

| 项目 | 结果 |
|---|---|
| 会话标题 | ✅「设计模块化城市地图系统」（Codex 官方 thread_name，不再是「未命名」） |
| 历史加载 | ✅ 工具调用 / 12 个子智能体 / 思考过程 / 模型回复全部正常渲染 |
| 导入说明 | ✅ 可靠性提示正常显示 |
| 继续对话 | ✅ 发消息后模型正常回复，并能总结项目进度 |
| 归属工作区 | ✅ 出现在 FPS_Extraction 工作区 |

### 历史加载打通过程中修复的 6 个格式问题

DSH 的会话加载是**分层校验**，每修一层才暴露下一层（错误信息逐层定位）：

| # | 问题 | DSH 报错 / 校验点 | 修复 |
|---|---|---|---|
| 1 | 会话目录名不对 | 派生索引扫不到 | 用 `projectKey(cwd)` 编码目录名（逐字复刻 DSH 实现） |
| 2 | header.cwd 与工作区不匹配 | `candidateMatches` 过滤 | header.cwd 设为目标工作区路径 |
| 3 | 未注册进 workspace.json | 工作区列表不含该会话 | 导入后写 `sessionIds` |
| 4 | header 缺 `type:"session"` | `isHeaderLine` 判否 → 会话被跳过 | 物理层首行补 `type:"session"` |
| 5 | `assistant/message` 缺 `stream` | `invalid settlement fields` | 补 `stream: []` |
| 6 | meta 事件含 `undefined` | `not losslessly JSON-serializable` | 递归 `stripUndefined` |
| 7 | 缺 `session/title` 事件 | 标题显示「未命名」 | 生成 title 事件 |
| 8 | title 的 messageSeqs 与 source 不匹配 | `messageSeqs must be empty exactly for a user title` | `source.kind='user'` + 空数组 |

### 已知的非插件问题

**首次对话偶发 400**：
```
400 workbuddy upstream client: The model cannot handle this request. Please type "client"
INVALID_REQUEST
```
- **性质**：上游模型代理（workbuddy）拒绝，非插件数据结构问题
- **证据**：重试即成功；同会话历史已正确加载、模型能读懂上下文
- **可能原因**：首次请求上下文过大（实测 193k tokens，含大量工具调用与思考内容）
- **应对**：重试即可；若频繁出现，可减少单次导入的超大会话数量

### 验证方式说明

本次修复全部用 DSH **真实校验器**验证，而非推测：
- `restoreReleasedV4Artifact`（物理层 + 格式 + 关系校验）
- `Session.create`（历史加载路径，报错就来自这里）
- 逐字复刻 `isHeaderLine` 校验物理层首行

两个真实会话（普通 + 含 24 处加密子代理内容）全部通过。

---

## 📌 历史记录：早期阶段性进展（2026-10-17 23:06）

当时验证到"能导入到磁盘"，但尚未打通 DSH 显示与历史加载：

```
✅ 扫描  扫描完成：140 个会话，跳过 0 个
✅ 导出  导出成功：1020 行 / 145 条消息 / 354 次工具调用
✅ 导入  导入成功：1 轮 / 6 条消息 / 4 次工具调用  （.zst 压缩格式）
```

> 该阶段会话写入 `--codex-import--` 目录（错误命名），后续已修正为 `projectKey(cwd)`。

插件路由 `GET /plugins/dsh-codex-bridge/status` 返回 200，真实目录路径正确。

---

## ✅ 终极根因（第 8 轮发现，终于定位）

### 问题 8：client bundle 多了 `default` 导出 → `inject` 被 unwrapExports 吞掉

**这是前面 5、6、7 轮修复都没解决 UI 的真正原因。**

宿主的插件 face 解析（`dsh-web-frontend` 里的 `unwrapExports`）：

```js
function unwrapExports(e) {
  if (e == null) return e;
  e = e.default ?? e;          // ★ 一旦有 default，就取 default 对象
  if (!e.__esModule) return e;
  return e.default ?? e;
}
```

我们的 client bundle 因 `src/client.ts` 末尾有 `export default { name, apply }`，
esbuild 多打了一个 `default` 导出。于是 `unwrapExports` 取到 `default` 对象——
它**只有 name/apply，没有 inject**。fiber 拿不到 `inject` 清单 → 不知道要等
`slots/locale` 服务 → 永不激活 → 卡片不注册 → UI 空白。

对照官方 `dsh-workbuddy-connect`：它的 factory 返回 **只有 `apply / inject / name`
三个具名成员，没有 default**，所以 unwrap 后 inject 完整保留。

**修复**：删除 `src/client.ts` 的 `export default`，只保留具名导出。

修复后实测（模拟宿主真实 unwrap 链路）：

```
factory keys:  [apply, inject, name]      ← 无 default
unwrap inject: ["slots","locale","remote","remote.session"]   ← 完整保留
fiber 等待服务: slots, locale, remote, remote.session
apply 执行 → settings.section / plugin-settings.item / plugins.bundle.config 全部注册 ✅
```

---

## 历史问题清单（已全部修复）

### 问题 5：client bundle 不是 ESM —— 导致整个 web boot 失败（严重）

**现象**：安装后 DSH 无法启动，报 `web boot: 1 entry did not activate`
日志：`Uncaught SyntaxError: Unexpected token 'export'`

**根因**：DSH 前端用自定义 `__ModuleLoader__` 协议加载插件 client bundle，
**不是 ESM**。我打出的 ESM 产物末尾的 `export {...}` 在非模块脚本中是语法错误。

**修复**：新增 `scripts/build-client.mjs`，产出符合协议的 bundle：

```js
window.__ModuleLoader__.load({
  id: "dsh-codex-bridge",
  factory: (require) => {
    var module = { exports: {} };
    let react = require("react");   // react 由宿主 require 注入
    // ...bundle 代码...
    exports.apply = apply;
    return module.exports;
  }
});
```

### 问题 6：inject 声明了不存在的服务 —— 插件永不激活

**现象**：`启用失败：dsh: warning: 1 entry did not activate codex-bridge:
pending (waiting for services: server, logger)`

**根因**：我在顶层写了 `inject: ['server', 'logger']`，但 DSH 里没有这两个服务名。

**修复**（实测官方插件 dsh-workbuddy-connect 的真实写法）：
- 顶层 `inject = []`（官方只声明它真正需要的 `["llm"]`）
- webServer 用 **`ctx.inject(['webServer'], (webCtx) => {...})` 延迟获取**
- logger 由 cordis 内置（ctx.logger），无需声明

### 问题 7：路由前缀不对

**根因**：官方插件的路由路径是 `/plugins/<包名>/status`，
宿主把 `/plugins` 前缀（kind: 'prefix'）统一挂给 client-modules，
插件自有 HTTP API 也走这个命名空间。我之前用 `/codex-bridge` 不在约定内。

**修复**：`ROUTE_BASE = '/plugins/dsh-codex-bridge'`，UI 的 apiBase 同步。

---

## 一、安装结果

### 已安装位置
```
C:\Users\admin\.dsh\profiles\desktop\node_modules\dsh-codex-bridge\
├── lib\index.js    62.10 KB   ← 服务端入口
├── lib\client.js  125.40 KB   ← 客户端入口（自包含）
├── lib\index.d.ts
├── cordis.patch.yml
├── package.json
├── locale\{zh,en}.json
├── assets\icon.svg
└── README.md
```

### profile 变更

**`package.json`**
```jsonc
"dependencies": {
  "dsh-workbuddy-connect": "github:masknull/dsh-workbuddy-connect",
  "dsh-codex-bridge": "file:../../../../codex-dsh-bridge/plugin"   // 新增
},
"dsh": { "profile": { "bundles": [
  ..., "dsh-codex-bridge"    // 新增到末尾
]}}
```

**`cordis.patch.yml`**
```yaml
- insert:
    - id: codex-bridge
      name: dsh-codex-bridge
      config:
        codexHome: ""
        outputDir: ""
        backupBeforeExport: true
        maxSessionBytes: 268435456
```

### 一键回滚
```powershell
cd C:\Users\admin\codex-dsh-bridge
.\rollback.ps1
```
原始配置已备份在 `C:\Users\admin\.dsh\profiles\desktop\.codex-bridge-backup\`。

---

## 二、静态验证：14/14 通过

| # | 检查项 | 结果 |
|---|---|---|
| 1 | package.json 可解析 | ✅ dsh-codex-bridge@0.1.0，displayName=Codex 会话桥接 |
| 2 | dsh.bundle 声明 | ✅ ./cordis.patch.yml 存在 |
| 3 | dsh.client 声明 | ✅ inject 4 项，platform=web |
| 4 | engines.dsh 匹配 | ✅ 0.2.1-rc.2 |
| 5 | profile 已声明 bundle | ✅ 7 个，末尾为本插件 |
| 6 | profile patch 已插入 | ✅ insert{id:codex-bridge} |
| 7 | 插件自带 patch 格式 | ✅ |
| 8 | 服务端入口可加载 | ✅ exports: Config, apply, inject, name |
| 9 | inject 声明 | ✅ ["server","logger"] |
| 10 | apply 在 mock ctx 注册路由 | ✅ 7 条路由 |
| 11 | 客户端自包含（无裸 import） | ✅ |
| 12 | 客户端 apply 注册槽位 | ✅ settings.section → plugin-settings.item |
| 13 | 构建产物存在 | ✅ |
| 14 | 原始配置备份存在 | ✅ 3 个文件 |

---

## 三、HTTP 接口端到端验证：12/12 通过

用插件**已构建的 lib/index.js** 起独立 HTTP 服务（随机端口，不影响运行中的 DSH），跑真实数据：

| # | 接口 / 场景 | 结果 |
|---|---|---|
| 1 | `GET /status` | ✅ codexDir 正确探测 |
| 2 | `GET /codex/sessions` | ✅ **扫描到 140 个真实会话**，跳过 0 |
| 3 | 列表时间倒序 | ✅ |
| 4 | `POST /import` | ✅ 成功导入 2 个真实会话 |
| 5 | 导入产物过 DSH 官方校验器 | ✅ 2/2 通过 |
| 6 | 重复导入拦截 | ✅ 返回「该会话已导入过」 |
| 7 | `GET /dsh/sessions` | ✅ 列出 2 个可导出会话 |
| 8 | `POST /export` + 备份 | ✅ 导出 1 个，**备份 140 个 Codex 文件** |
| 9 | 导出 JSONL 格式 | ✅ 1020 行，工具调用 354/354 配对 |
| 10 | `GET /logs` | ✅ 11 条（import 6 / export 2 / scan 2 / backup 1） |
| 11 | 非 loopback Origin 拦截 | ✅ 403「来源不是本机页面」 |
| 12 | 空选择提示 | ✅「请至少勾选一个会话。」 |

---

## 四、验证中发现并修复的 3 个真实问题

这三个问题**只有在实际安装验证时才会暴露**，之前的单元测试和源码级集成测试都发现不了。

### 问题 1：`schemastery` 包名错误

```
❌ Cannot find package 'schemastery' imported from ...\lib\index.js
```

我用的是 `import z from 'schemastery'`，但 DSH 里的真实包名是**带作用域**的：

```ts
// ❌ 之前
import type { App } from 'cordis';
import { z } from 'schemastery';

// ✅ 修正后（实测于 DSH node_modules）
import type { App } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
```

### 问题 2：客户端 bundle 不自包含

```
❌ Cannot find package 'react' imported from ...\lib\client.js
```

`package.json` 把 react 列在 peerDependencies，tsdown 默认视为外部依赖。但 DSH 前端**不提供裸模块解析**，浏览器端 bundle 必须自包含。

```ts
// ✅ 修正：客户端把 react 内联打包
{
  entry: { client: 'src/client.ts' },
  platform: 'browser',
  noExternal: [/^react/, /^react-dom/],   // 关键
}
```
产物从 29 KB → 125 KB（含 react），且无任何裸 import。

### 问题 3：`ok` 字段被覆盖

```ts
json(res, 200, { ...r, ok: true })   // ❌ r.ok 是成功条数，覆盖了表示请求成功的 ok
```
导致导出成功时显示「导出 true 个」。改为：

```ts
json(res, 200, { ok: true, succ: r.ok, failed: r.failed, ... })
```

### 问题 4：构建产物扩展名

tsdown 默认输出 `index.mjs`，但 `package.json` 的 `main` 指向 `lib/index.js`。
通过 `outExtensions: () => ({ js: '.js', dts: '.d.ts' })` 修正。

---

## 五、重启后需要确认的事项

插件已就位，**重启 DSH 后**请检查：

### 1. 插件是否出现在插件列表
设置 → 插件，应看到 **「Codex 会话桥接」**（来自 `package.json` 的 `displayName`）。

### 2. 点击名称能否进入设置页
应看到：
- 环境徽章（桌面端 / Web 端）
- Codex 目录与 DSH 会话目录路径
- 【导入 CodeX 会话】【导出至 Codex】两个按钮
- 操作日志入口

### 3. 接口是否可访问
浏览器打开或在控制台执行：
```js
fetch('/codex-bridge/status').then(r=>r.json()).then(console.log)
```
预期返回 `{ ok:true, codexDir:"C:\\Users\\admin\\.codex\\sessions", ... }`。

### ⚠️ 最可能出现问题的两处

| 风险 | 表现 | 排查 |
|---|---|---|
| **`apply()` 拿不到 `server` 服务** | 设置页能打开，但点按钮报「无法连接到插件服务」 | 检查 DSH 日志有无 `[dsh-codex-bridge] 未找到 webserver 服务`。我的实现按 `dsh-workbuddy-connect` 的做法取 `ctx.server ?? ctx.webserver`，若实际服务名不同需调整 |
| **槽位 API 不匹配** | 插件列表中看不到入口，或设置页空白 | 检查 DSH 控制台有无 `[codex-bridge] 设置页注册失败` |

这两处是目前**唯一未经真实宿主验证**的部分——因为验证它们必须重启 DSH，而我就运行在里面。

---

## 六、验证脚本清单

| 脚本 | 用途 | 结果 |
|---|---|---|
| `p0/verify-install.mjs` | 安装静态验证（14 项） | ✅ 14/14 |
| `p0/verify-api.mjs` | HTTP 接口端到端（12 项，真实数据） | ✅ 12/12 |
| `p0/integration.mjs` | 源码级集成（11 项，真实数据） | ✅ 11/11 |
| `plugin/test/convert.spec.ts` | 单元测试（17 项） | ✅ 17/17 |
| `rollback.ps1` | 一键回滚 | 备用 |
