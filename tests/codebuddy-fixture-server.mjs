import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { McpServer } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { CodeBuddyCliAdapter } from '../bridge/src/codebuddy-cli-adapter.mjs';
import { SessionController } from '../bridge/src/session-store.mjs';
import { registerSessionTools } from '../bridge/src/session-tools.mjs';
import { PROJECT_ROOT, SOURCE_ROOT, sha256 } from '../bridge/src/policy.mjs';

if (process.env.COLLAB_TEST_MODE !== '1' || PROJECT_ROOT === SOURCE_ROOT) throw new Error('会话样本只限隔离本地测试。');
const { values } = parseArgs({ options:{ role:{type:'string',default:'manager'},behavior:{type:'string',default:'normal'} } });
const cliScript=path.join(PROJECT_ROOT,'fixture-cli','bin','codebuddy');
const bundle=path.join(PROJECT_ROOT,'fixture-cli','dist','codebuddy-headless.js');
const adapter=new CodeBuddyCliAdapter({enabled:true,acceptedProductMode:true,nodeExecutable:process.execPath,cliScript,
  nodeSha256:sha256(fs.readFileSync(process.execPath)),cliSha256:sha256(fs.readFileSync(cliScript)),headlessSha256:sha256(fs.readFileSync(bundle)),timeoutMs:3000,maxOutputBytes:8192});
adapter.evidenceLevel='local_test';
const controller=new SessionController({actor:values.role,testAdapter:adapter,testHooks:values.behavior==='crash_after_claim'?{afterClaim:()=>process.exit(91)}:{}});
const server=new McpServer({name:'local_codebuddy_fixture_not_platform',version:'0.1.6'});
const registered=registerSessionTools(server,{actor:values.role,controllerFactory:()=>controller});
await server.connect(new StdioServerTransport());
process.once('exit',()=>registered.close());
