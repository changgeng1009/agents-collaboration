import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_ROOT, LOG_ROOT, guardedPath, sha256, readToolchainConfig } from '../src/policy.mjs';

const bridgeDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildId = randomUUID();
const outputRoot = guardedPath(ARTIFACT_ROOT, path.join(ARTIFACT_ROOT, 'extensions'), { mustExist: false });
fs.mkdirSync(outputRoot, { recursive: true });
const stage = guardedPath(ARTIFACT_ROOT, path.join(outputRoot, 'staging', buildId), { mustExist: false });
const unpacked = path.join(outputRoot, 'unpacked', buildId);
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(path.join(stage, 'src'), { recursive: true });
fs.mkdirSync(LOG_ROOT, { recursive: true });
const log = path.join(LOG_ROOT, `package-${buildId}.log`);
for (const name of ['package.json', 'package-lock.json', 'manifest.json']) fs.copyFileSync(path.join(bridgeDir, name), path.join(stage, name));
for (const name of ['policy.mjs', 'store.mjs', 'server.mjs']) fs.copyFileSync(path.join(bridgeDir, 'src', name), path.join(stage, 'src', name));
fs.writeFileSync(path.join(stage, '.mcpbignore'), '.npm-cache/\n*.log\n', 'utf8');

function run(executable, argv, cwd = stage) {
  fs.appendFileSync(log, JSON.stringify({ executable, argv, cwd }) + '\n', 'utf8');
  const result = spawnSync(executable, argv, { cwd, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  fs.appendFileSync(log, (result.stdout ?? '') + (result.stderr ?? '') + `\nexitCode=${result.status}\n`, 'utf8');
  if (result.error || result.status !== 0) throw result.error ?? new Error(`打包命令失败，见 ${log}`);
  return result.stdout;
}
// 依赖与缓存留在本项目，不执行安装生命周期脚本，不打包个人使用说明。
const npmCli = process.env.npm_execpath ?? readToolchainConfig().npmCli ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!path.isAbsolute(npmCli) || !fs.statSync(npmCli).isFile() || path.basename(npmCli) !== 'npm-cli.js') throw new Error('没有可核验的 npm CLI 文件。');
run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(bridgeDir, '.npm-cache')]);
const mcpb = path.join(bridgeDir, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
run(process.execPath, [mcpb, 'validate', path.join(stage, 'manifest.json')]);
const packageVersion = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8')).version;
const packagePath = path.join(outputRoot, `ai-collaboration-t1-${packageVersion}.mcpb`);
if (fs.existsSync(packagePath)) throw new Error('扩展包已存在；请更新版本或保留旧包后指定新的输出名称。');
run(process.execPath, [mcpb, 'pack', stage, packagePath]);
run(process.execPath, [mcpb, 'unpack', packagePath, unpacked]);
run(process.execPath, [mcpb, 'info', packagePath]);
const files = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const entry = path.join(dir, item.name);
    if (item.isDirectory()) walk(entry);
    else if (item.isFile()) files.push({ path: path.relative(unpacked, entry).replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(entry)), bytes: fs.statSync(entry).size });
    else throw new Error('包内出现非普通文件。');
  }
}
walk(unpacked);
const report = { buildId, builtAt: new Date().toISOString(), packagePath, packageSha256: sha256(fs.readFileSync(packagePath)), packageBytes: fs.statSync(packagePath).size,
  stage, unpacked, log, manifestValidated: true, signed: false, realClaudeInstalled: false, files,
  dependencies: { sdk: JSON.parse(fs.readFileSync(path.join(unpacked, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8')).version,
    zod: JSON.parse(fs.readFileSync(path.join(unpacked, 'node_modules', 'zod', 'package.json'), 'utf8')).version } };
fs.writeFileSync(path.join(LOG_ROOT, 'extension-package-manifest.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ packagePath, packageSha256: report.packageSha256, unpacked, log, files: files.length }, null, 2));
