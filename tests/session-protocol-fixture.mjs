import fs from 'node:fs';
import path from 'node:path';

// 仅本地协议样本，不连接网络或模型，不构成平台权限验收。
let input = ''; for await (const bytes of process.stdin) input += bytes.toString('utf8');
const prompt = JSON.parse(input);
const cwd = process.cwd(), stateFile = path.join(cwd, 'work', 'fixture-context.json');
const argv = process.argv.slice(2), resumeAt = argv.indexOf('--resume');
fs.appendFileSync(path.join(cwd, 'work', 'fixture-launches.jsonl'), JSON.stringify({ argv, source: 'local_test', prompt: input }) + '\n', 'utf8');
const id = prompt.largeId ? '900719925474099312345' : `fixture_native_${path.basename(cwd)}`;
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : null;
if (resumed !== null && resumed !== id) process.exit(9);
let previous = []; if (fs.existsSync(stateFile)) previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
previous.push(prompt.text ?? '中文协议样本'); fs.writeFileSync(stateFile, JSON.stringify(previous), 'utf8');
const emit = event => process.stdout.write(JSON.stringify({ ...event, fixture_only: true }) + '\n');
if (prompt.scenario !== 'missing_init') emit({ type: 'system', subtype: 'init', session_id: prompt.scenario === 'numeric_id' ? 9007199254740992 : id,
  cwd: prompt.scenario === 'wrong_cwd' ? path.dirname(cwd) : cwd,
  ...(prompt.scenario === 'missing_tools' ? {} : { tools: prompt.scenario === 'tool_violation' ? ['Bash'] : [] }),
  ...(prompt.scenario === 'missing_mcp' ? {} : { mcp_servers: prompt.scenario === 'mcp_violation' ? [{ name: 'fixture' }] : [] }) });
if (prompt.scenario === 'timeout') await new Promise(resolve => setTimeout(resolve, 10000));
if (prompt.delayMs) await new Promise(resolve => setTimeout(resolve, prompt.delayMs));
if (prompt.scenario === 'output_limit') { process.stdout.write('x'.repeat(10000)); process.exit(0); }
if (prompt.scenario === 'incomplete_json') { process.stdout.write('{"type":"result",'); process.exit(0); }
emit({ type: 'assistant', session_id: id, message: { content: [{ type: 'text', text: previous.join(' / ') }] }, api_key: 'sk-' + 'fixture_redaction_value' });
if (prompt.scenario !== 'missing_result') emit({ type: 'result', subtype: prompt.scenario === 'error_result' ? 'error_during_execution' : 'success',
  is_error: prompt.scenario === 'error_result', session_id: prompt.scenario === 'wrong_id' ? id + '_other' : id, result: previous.join(' / '), usage: { input_tokens: 3, output_tokens: 5 } });
if (prompt.scenario === 'nonzero') process.exit(7);
