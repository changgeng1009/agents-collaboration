import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CODE_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const base = path.resolve(process.env.COLLAB_TEST_ROOT ?? path.join(CODE_ROOT, 'bridge', 'runtime', 'local-tests'));
const relative = path.relative(CODE_ROOT, base);
if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('隔离测试目录必须位于源码项目内。');
let ancestor = base;
while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
const realRelative = path.relative(fs.realpathSync(CODE_ROOT), fs.realpathSync(ancestor));
if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('隔离测试目录的真实路径越界。');
export const FIXTURE_ROOT = path.join(base, randomUUID());
fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
process.env.COLLAB_PROJECT_ROOT = FIXTURE_ROOT;
process.env.COLLAB_TEST_MODE = '1';
