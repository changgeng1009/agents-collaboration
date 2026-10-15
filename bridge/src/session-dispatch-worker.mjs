import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PROJECT_ROOT, SOURCE_ROOT } from './policy.mjs';
import { SessionController } from './session-store.mjs';
import { CodeBuddyCliAdapter } from './codebuddy-cli-adapter.mjs';
import { SessionDispatcher } from './session-dispatch.mjs';
import { readBoundedFile } from './session-files.mjs';

if (!process.send) throw new Error('受管执行器只接受新建 IPC 子进程。');
const { values } = parseArgs({ options: { db: { type: 'string' }, 'dispatch-id': { type: 'string' } } });
let fixtureConfig = null, testAdapter = null;
if (process.env.COLLAB_DISPATCH_FIXTURE_FILE) {
  if (process.env.COLLAB_TEST_MODE !== '1' || PROJECT_ROOT === SOURCE_ROOT) throw new Error('fixture 配置不能进入正式执行。');
  fixtureConfig = JSON.parse(readBoundedFile(process.env.COLLAB_DISPATCH_FIXTURE_FILE).bytes.toString('utf8'));
  const relative = path.relative(PROJECT_ROOT, fixtureConfig.cliScript);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('fixture 入口越出隔离根。');
  testAdapter = new CodeBuddyCliAdapter(fixtureConfig); testAdapter.evidenceLevel = 'local_test';
}
const controller = new SessionController({ actor: 'manager', dbPath: values.db, testAdapter });
const dispatcher = new SessionDispatcher({ controller, fixtureConfig });
const inputTimer = setTimeout(() => { controller.close(); process.exit(2); }, 7000);
process.once('message', async message => {
  clearTimeout(inputTimer);
  try { await dispatcher.runWorker(values['dispatch-id'], message?.token); }
  catch { process.exitCode = 1; }
  finally { controller.close(); if (process.connected) process.disconnect(); }
});
