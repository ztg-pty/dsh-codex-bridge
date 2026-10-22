/**
 * scripts/ts-register.mjs —— 让 Node 能直接 import .ts 文件（仅用于开发/自检）
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-register.mjs <script.mjs>
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(path.join(__dirname, 'ts-loader.mjs')).href);
