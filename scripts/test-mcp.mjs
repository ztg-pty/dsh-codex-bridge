/**
 * scripts/test-mcp.mjs —— MCP Server 冒烟测试（可移植版）
 *
 * 用法（仓库根目录）：
 *   node scripts/test-mcp.mjs
 *
 * 会启动 lib/mcp-stdio.js，依次测试 initialize / tools/list / 各工具调用 / 错误处理。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MCP = path.join(ROOT, 'plugin', 'lib', 'mcp-stdio.js');

if (!await import('node:fs').then((fs) => fs.existsSync(MCP))) {
  console.error(`❌ 未找到 ${MCP}\n   请先在 plugin/ 下运行 npm run build`);
  process.exit(1);
}

console.log('=== 启动 MCP Server ===');
const child = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'pipe'], cwd: path.join(ROOT, 'plugin') });

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 忽略非 JSON 输出 */ }
  }
});

child.stderr.on('data', (d) => {
  const s = d.toString('utf8').trim();
  if (s) console.log('  [stderr]', s.slice(0, 160));
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`超时: ${method}`)); }
    }, 30000);
  });
}

await new Promise((r) => setTimeout(r, 800));

console.log('\n=== 1. initialize ===');
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
console.log('  协议版本:', init.result?.protocolVersion);
console.log('  服务名:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);

console.log('\n=== 2. tools/list ===');
const tools = await rpc('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log('  工具数:', names.length);
names.forEach((n) => console.log('   -', n));

console.log('\n=== 3. list_clients ===');
const r1 = await rpc('tools/call', { name: 'list_clients', arguments: {} });
console.log((r1.result?.content?.[0]?.text ?? '').split('\n').slice(0, 10).join('\n'));

console.log('\n=== 4. list_sessions（limit 2）===');
const r2 = await rpc('tools/call', { name: 'list_sessions', arguments: { limit: 2 } });
console.log((r2.result?.content?.[0]?.text ?? '').split('\n').slice(0, 8).join('\n'));

console.log('\n=== 5. 错误处理：未知工具 ===');
const r3 = await rpc('tools/call', { name: 'not_exist', arguments: {} });
console.log('  错误码:', r3.error?.code, '| 消息:', r3.error?.message);

console.log('\n=== 6. 错误处理：非法 client ===');
const r4 = await rpc('tools/call', { name: 'get_context', arguments: { client: 'xxx', sessionId: 'y' } });
console.log('  isError:', r4.result?.isError, '|', (r4.result?.content?.[0]?.text ?? '').slice(0, 100));

console.log('\n=== 7. ping ===');
const r5 = await rpc('ping', {});
console.log('  result:', JSON.stringify(r5.result));

child.kill();
console.log('\n✅ MCP 冒烟测试完成');
