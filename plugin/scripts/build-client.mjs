/**
 * scripts/build-client.mjs —— 生成 DSH 前端要求的客户端 bundle
 *
 * ⚠️ 真实格式（实测于 dsh-workbuddy-connect/lib/client.js）：
 *   DSH 前端用自定义 __ModuleLoader__ 加载插件，**不是 ESM**。
 *   bundle 必须是一个 IIFE，形如：
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-codex-bridge",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       let react = require("react");
 *       ...
 *       exports.apply = apply;
 *       return module.exports;
 *     }
 *   });
 *
 * 之前用 ESM 产物（末尾 export {...}）会导致：
 *   Uncaught SyntaxError: Unexpected token 'export'
 *   → web boot: 1 entry did not activate
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const ENTRY = path.join(ROOT, 'src/client.ts');
const OUT = path.join(ROOT, 'lib/client.js');
const PKG_NAME = 'dsh-codex-bridge';

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  jsx: 'automatic',
  // react 由宿主提供，通过 factory 的 require 注入
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  logLevel: 'info',
});

let code = result.outputFiles[0].text;

// 1. 去掉 ESM 的 import 语句，改为从工厂函数参数取
const imports = [];
code = code.replace(/^import\s+(.*?)\s+from\s+["']([^"']+)["'];?\s*$/gm, (m, clause, spec) => {
  imports.push({ clause, spec });
  return '';
});

// 2. 去掉 export 语句，收集导出名
const exportNames = [];
code = code.replace(/^export\s*\{([^}]*)\};?\s*$/gm, (m, inner) => {
  for (const part of inner.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const ao = p.match(/^(.*?)\s+as\s+(.*)$/);
    exportNames.push(ao ? { local: ao[1].trim(), exported: ao[2].trim() } : { local: p, exported: p });
  }
  return '';
});
code = code.replace(/^export\s+default\s+/gm, 'const __default_export__ = ');

// 3. 生成 require 声明（★ 去重：同一 spec 只声明一次）
const uniqueSpecs = [...new Map(imports.map((i) => [i.spec, i])).values()];
const requireDecls = uniqueSpecs.map(({ spec }) => {
  const safe = spec.replace(/[^a-zA-Z0-9_]/g, '_');
  return `let ${safe} = require(${JSON.stringify(spec)});`;
}).join('\n\t\t');

// 4. 具名导入改写为从命名空间取值（避免重复声明与 { a as b } 语法）
code = imports.reduce((acc, { clause, spec }) => {
  const safe = spec.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!clause.trim().startsWith('{')) {
    // 默认导入：let React5 = require('react') 已由 requireDecls 提供
    return acc;
  }
  const inner = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'));
  const decls = inner.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const m = item.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
    return m ? `const ${m[2]} = ${safe}[${JSON.stringify(m[1])}];` : `const ${item} = ${safe}[${JSON.stringify(item)}];`;
  }).join(' ');
  return decls + '\n' + acc;
}, code);

const exportAssign = exportNames.map(({ local, exported }) =>
  exported === 'default'
    ? `exports.default = ${local === 'default' ? '__default_export__' : local};`
    : `exports.${exported} = ${local};`
).join('\n\t\t');

const wrapped = `/* ${PKG_NAME} — DSH client bundle
 * 由 scripts/build-client.mjs 生成，使用 DSH 的 __ModuleLoader__ 协议。
 * ⚠️ 不要手改；改了 src 后重新执行 npm run build:client
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${requireDecls}

${code}

\t\t${exportAssign}
\t\treturn module.exports;
\t}
});
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, wrapped, 'utf8');
console.log(`✅ client bundle: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log(`   导入: ${imports.map((i) => i.spec).join(', ') || '(无)'}`);
console.log(`   导出: ${exportNames.map((e) => e.exported).join(', ')}`);
