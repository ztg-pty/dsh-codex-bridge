/**
 * scripts/acceptance.mjs —— 验收自检（可移植版）
 *
 * 用法（仓库根目录）：
 *   node --experimental-strip-types --import ./scripts/ts-register.mjs scripts/acceptance.mjs
 *
 * 检查 6 组目标：UI / 五端适配器 / MCP / 可移植性 / 构建部署 / 中文错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugin');
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
const DEPLOYED = process.env.DSH_PROFILE_DIR
  ? path.join(process.env.DSH_PROFILE_DIR, 'node_modules/dsh-codex-bridge')
  : path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-codex-bridge');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ════════ 目标 1：UI ════════
console.log('════════ 目标 1：UI 界面 ════════');
check('TransferDialog.tsx 存在', fs.existsSync(path.join(PLUGIN, 'src', 'client', 'TransferDialog.tsx')));
const settings = fs.readFileSync(path.join(PLUGIN, 'src', 'client', 'SettingsPage.tsx'), 'utf8');
check('SettingsPage 接入 TransferDialog', settings.includes('TransferDialog'));
check('SettingsPage 显示客户端状态', settings.includes('/clients'));

const clientBundlePath = path.join(DEPLOYED, 'lib', 'client.js');
if (fs.existsSync(clientBundlePath)) {
  const b = fs.readFileSync(clientBundlePath, 'utf8');
  // esbuild 会把中文转义成 \uXXXX
  const hasUI = b.includes('TransferDialog')
    && b.includes('doTransfer')
    && b.includes('context/preview')
    && (b.includes('\\u8DE8\\u7AEF\\u8F6C\\u6362') || b.includes('跨端转换'));
  check('已部署 client bundle 含跨端 UI', hasUI, `${(b.length / 1024).toFixed(0)} KB`);
} else {
  check('已部署 client bundle', false, `未找到 ${clientBundlePath}（请先运行 install.ps1）`);
}

// ════════ 目标 2：五端适配器 ════════
console.log('\n════════ 目标 2：五端 UIR 适配器 ════════');
const reg = await import(pathToFileURL(path.join(PLUGIN, 'src', 'adapters', 'registry.ts')).href);
const adapters = reg.availableAdapters();
check('五端全部注册', adapters.length === 5, adapters.join(', '));
for (const c of ['dsh', 'codex', 'zcode', 'claude-code', 'workbuddy']) {
  check(`  ${c} 适配器文件`, fs.existsSync(path.join(PLUGIN, 'src', 'adapters', c, 'adapter.ts')));
}
const all = await reg.listAllSessions({ limitPerClient: 1 });
check('会话列表可用', all.sessions.length > 0 || all.errors.length > 0, `${all.sessions.length} 个会话`);
const byClient = {};
all.sessions.forEach((s) => { byClient[s.client] = (byClient[s.client] || 0) + 1; });
check('多端会话可读', Object.keys(byClient).length >= 2, JSON.stringify(byClient));

// ════════ 目标 3：MCP ════════
console.log('\n════════ 目标 3：MCP Server ════════');
for (const f of ['protocol.ts', 'tools.ts', 'stdio-entry.ts']) {
  check(f, fs.existsSync(path.join(PLUGIN, 'src', 'mcp', f)));
}
check('bin/mcp-stdio.js', fs.existsSync(path.join(PLUGIN, 'bin', 'mcp-stdio.js')));
const deployedMcp = path.join(DEPLOYED, 'lib', 'mcp-stdio.js');
check('已部署 mcp-stdio.js', fs.existsSync(deployedMcp));
const routes = fs.readFileSync(path.join(PLUGIN, 'src', 'host', 'routes.ts'), 'utf8');
check('HTTP MCP 端点', routes.includes('/mcp'));
check('MCP 工具调试端点', routes.includes('mcp/tools'));

if (fs.existsSync(deployedMcp)) {
  console.log('\n  ── 实际启动 MCP 握手 ──');
  const mcpOk = await new Promise((resolve) => {
    const child = spawn(process.execPath, [deployedMcp], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve(false); } }, 15000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('"serverInfo"')) {
        done = true; clearTimeout(timer); child.kill();
        resolve(buf.includes('dsh-codex-bridge'));
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });
  check('  MCP 握手成功', mcpOk);
}

// ════════ 目标 4：可移植性 ════════
console.log('\n════════ 目标 4：可移植性 ════════');
function scanHardcoded(dir, exts) {
  const bad = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|^lib$|\.git/.test(e.name)) walk(p); }
      else if (exts.some((x) => e.name.endsWith(x))) {
        const t = fs.readFileSync(p, 'utf8');
        if (/C:\\\\Users|C:\/Users\/admin|D:\\\\workbuddy/.test(t)) bad.push(p.replace(PLUGIN, ''));
      }
    }
  };
  walk(dir);
  return bad;
}
const hard = scanHardcoded(path.join(PLUGIN, 'src'), ['.ts', '.tsx']);
check('源码无硬编码用户路径', hard.length === 0, hard.join(', ') || '扫描通过');
const clientsSrc = fs.readFileSync(path.join(PLUGIN, 'src', 'host', 'clients.ts'), 'utf8');
check('支持环境变量覆盖', ['DSH_HOME', 'CODEX_HOME', 'ZCODE_HOME', 'CLAUDE_HOME', 'WORKBUDDY_HOME'].every((v) => clientsSrc.includes(v)));

// ════════ 目标 5：构建部署 ════════
console.log('\n════════ 目标 5：测试 / 构建 / 部署 ════════');
check('单元测试文件', fs.existsSync(path.join(PLUGIN, 'test', 'budget.spec.ts'))
  && fs.existsSync(path.join(PLUGIN, 'test', 'convert.spec.ts')));
for (const f of ['index.js', 'client.js', 'mcp-stdio.js', 'index.d.ts']) {
  const p = path.join(DEPLOYED, 'lib', f);
  check(`  部署产物 ${f}`, fs.existsSync(p), fs.existsSync(p) ? `${(fs.statSync(p).size / 1024).toFixed(0)} KB` : '');
}

// ════════ 目标 6：中文错误 ════════
console.log('\n════════ 目标 6：中文错误提示 ════════');
const errSrc = fs.readFileSync(path.join(PLUGIN, 'src', 'shared', 'errors.ts'), 'utf8');
check('错误信息为中文', /[\u4e00-\u9fff]/.test(errSrc));
check('routes 使用 describeError', routes.includes('describeError') || routes.includes('BridgeError'));

// ════════ 汇总 ════════
console.log('\n════════ 汇总 ════════');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} 项通过`);
if (passed < results.length) {
  console.log('\n未通过项：');
  results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name} ${r.detail}`));
  process.exitCode = 1;
}
