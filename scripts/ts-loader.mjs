/**
 * scripts/ts-loader.mjs —— 让 `.js` 导入解析到同名 `.ts`（仅用于开发/自检）
 *
 * 配合 ts-register.mjs 使用：Node 的 --experimental-strip-types 会剥掉类型，
 * 但源码里 import './foo.js' 指向的其实是 foo.ts，需要这个 resolve 钩子。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const base = new URL(specifier, context.parentURL);
    const tsUrl = base.href.replace(/\.js$/, '.ts');
    try {
      return await nextResolve(tsUrl, context);
    } catch { /* 回落到原 .js */ }
  }
  return nextResolve(specifier, context);
}
