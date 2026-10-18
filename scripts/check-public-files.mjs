import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// 此白名单只包含公开开发文件；不遍历运行数据、日志、文档或认证目录。
export const PUBLIC_FILES = [
  'bridge/src/collaboration-media.mjs',
  'bridge/src/collaboration-workspaces.mjs',
  'bridge/src/market-expert-adapter.mjs',
  'bridge/src/market-expert-task-server.mjs',
  'tests/collaboration-media.integration.mjs',
  'tests/collaboration-media-archive.integration.mjs',
  'tests/child-process-group.mjs',
  'tests/market-expert.integration.mjs',
  'tests/market-expert-protocol-fixture.mjs',
  'bridge/src/collaboration-file-boundary.mjs',
  'bridge/src/windows-task-files.mjs',
  'bridge/src/collaboration-routes.mjs',
  'bridge/src/collaboration-independent-check.mjs',
  'bridge/scripts/build-windows-file-worker.ps1',
  'bridge/native/WindowsFileWorker/Native.cs',
  'bridge/native/WindowsFileWorker/Program.cs',
  'bridge/native/WindowsFileWorker/WindowsFileWorker.csproj',
  'tests/windows-file-isolation.integration.mjs',
  'tests/collaboration-routes.integration.mjs',
  '.gitignore', '.gitattributes', 'AGENTS.md', 'README.md',
  'bridge/package.json', 'bridge/package-lock.json', 'bridge/manifest.json',
  'bridge/src/policy.mjs', 'bridge/src/store.mjs', 'bridge/src/server.mjs',
  'bridge/src/codex-adapter.mjs', 'bridge/src/live-codex-once.mjs', 'bridge/src/doubao-http-probe.mjs',
  'bridge/src/partner-store.mjs', 'bridge/src/partner-server.mjs',
  'bridge/src/session-capabilities.mjs', 'bridge/src/claude-code-adapter.mjs', 'bridge/src/session-store.mjs', 'bridge/src/session-tools.mjs', 'bridge/src/stdio-audit.mjs',
  'bridge/src/session-files.mjs', 'bridge/src/session-file-server.mjs', 'bridge/src/session-dispatch.mjs', 'bridge/src/session-dispatch-worker.mjs',
  'bridge/src/codebuddy-cli-adapter.mjs', 'bridge/src/codebuddy-audit.mjs', 'bridge/src/codebuddy-probe-server.mjs',
  'bridge/src/cowork-store.mjs', 'bridge/src/cowork-server.mjs',
  'bridge/src/task-loop-store.mjs', 'bridge/src/task-loop-server.mjs',
  'bridge/src/collaboration-store.mjs', 'bridge/src/collaboration-inbox.mjs', 'bridge/src/collaboration-tools.mjs', 'bridge/src/collaboration-meetings.mjs',
  'bridge/src/collaboration-execution.mjs', 'bridge/src/collaboration-provider.mjs', 'bridge/src/collaboration-execution-worker.mjs',
  'bridge/src/collaboration-file-server.mjs', 'bridge/src/collaboration-service.mjs',
  'bridge/scripts/call-tool.mjs', 'bridge/scripts/package-extension.mjs', 'bridge/scripts/start-doubao-probe.ps1',
  'bridge/scripts/call-partner-tool.mjs',
  'bridge/scripts/call-cowork-tool.mjs',
  'tests/test-context.mjs', 'tests/channel.integration.mjs', 'tests/doubao-http-probe.integration.mjs',
  'tests/live-codex-preflight.mjs', 'tests/extension.smoke.mjs', 'tests/partner-channel.integration.mjs',
  'tests/session-protocol-fixture.mjs', 'tests/session-fixture-server.mjs', 'tests/session-control.integration.mjs', 'tests/stdio-audit.integration.mjs',
  'tests/codebuddy-session.integration.mjs', 'tests/codebuddy-fixture-server.mjs', 'tests/codebuddy-protocol-fixture.cjs',
  'tests/cowork-file-loop.integration.mjs', 'tests/task-loop.integration.mjs', 'tests/task-loop-restart.integration.mjs', 'tests/session-automation.integration.mjs',
  'tests/collaboration-core.integration.mjs', 'tests/collaboration-inbox.integration.mjs', 'tests/collaboration-mcp.integration.mjs', 'tests/collaboration-execution.integration.mjs', 'tests/collaboration-service.integration.mjs', 'scripts/check-public-files.mjs'
];

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const { values } = parseArgs({ options: { 'forbidden-term': { type: 'string', multiple: true }, 'output-file': { type: 'string' } } });
const rules = [
  ['absolute_windows_path', /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n'"`<>]+/],
  ['personal_home_path', /(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+/],
  ['actual_uuid_literal', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['credential_literal', /(?:\bsk-[A-Za-z0-9_-]{16,}|\bsess-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_-]{24,})/],
  ['private_instructions', /(?:Install\x20Extension|Set\x2DClipboard|\u5b89\u88c5\u8bf4\u660e\u89c1|\u8fde\u63a5\u8bf4\u660e\u89c1)/]
];
const findings = [];
for (const relative of PUBLIC_FILES) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) { findings.push({ file: relative, rule: 'missing_public_file' }); continue; }
  const actualRelative = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
  if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative) || !fs.statSync(absolute).isFile()) { findings.push({ file: relative, rule: 'public_file_scope' }); continue; }
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const [name, pattern] of rules) if (pattern.test(line)) findings.push({ file: relative, line: index + 1, rule: name });
    if ((values['forbidden-term'] ?? []).some(term => term && line.toLowerCase().includes(term.toLowerCase()))) findings.push({ file: relative, line: index + 1, rule: 'configured_private_marker' });
  }
}
const output = { status: findings.length ? 'rejected' : 'passed', checkedAt: new Date().toISOString(), fileCount: PUBLIC_FILES.length, files: PUBLIC_FILES, findings,
  matchedContentsPrinted: false, scannedRuntimeOrAuthentication: false };
if (values['output-file']) {
  const outputPath = path.resolve(values['output-file']);
  const relative = path.relative(path.join(root, 'logs'), outputPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('扫描报告只能写入本项目本地日志目录。');
  const parent = path.dirname(outputPath);
  if (!fs.existsSync(parent)) throw new Error('扫描报告目录须预先存在。');
  const actualRelative = path.relative(fs.realpathSync(path.join(root, 'logs')), fs.realpathSync(parent));
  if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) throw new Error('扫描报告真实目录越界。');
  if (fs.existsSync(outputPath) && (fs.lstatSync(outputPath).isSymbolicLink() || !fs.statSync(outputPath).isFile())) throw new Error('扫描报告不能覆盖链接或非普通文件。');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
}
console.log(JSON.stringify({ status: output.status, fileCount: output.fileCount, findings: output.findings, matchedContentsPrinted: false }, null, 2));
if (findings.length) process.exitCode = 1;
