import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    dts: true,
    outDir: 'lib',
    // 产物必须是 .js（package.json 的 main/exports 指向 lib/index.js）
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    // 服务端：宿主提供 cordis / schemastery，不打包
    external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
  },
  {
    entry: { client: 'src/client.ts' },
    format: ['esm'],
    platform: 'browser',
    dts: false,
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    // 客户端：必须自包含，react 也要打进去（DSH 前端不提供裸模块解析）
    noExternal: [/^react/, /^react-dom/],
  },
]);
