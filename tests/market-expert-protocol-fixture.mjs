// 此文件仅模拟CLI协议；没有模型、平台账号或生成调用。
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1],configuration=JSON.parse(fs.readFileSync(value('--mcp-config'),'utf8')),server=configuration.mcpServers.market_task;
const sdk=path.resolve(path.dirname(server.args[0]),'../node_modules/@modelcontextprotocol/sdk/dist/esm/client');
const{Client}=await import(pathToFileURL(path.join(sdk,'index.js')).href),{StdioClientTransport}=await import(pathToFileURL(path.join(sdk,'stdio.js')).href);
const chunks=[];for await(const bytes of process.stdin)chunks.push(bytes);const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const sessionId=input.wrongId?'synthetic_changed_session':args.includes('--resume')?value('--resume'):'synthetic_market_session';
const emit=value=>process.stdout.write(JSON.stringify({session_id:sessionId,...value})+'\n');
const peer=new Client({name:'synthetic_market_protocol_fixture',version:'0.2.4'}),transport=new StdioClientTransport({command:server.command,args:server.args,cwd:process.cwd(),env:{...process.env,...server.env},stderr:'pipe'});
try{await peer.connect(transport);const tools=(await peer.listTools()).tools.map(tool=>`mcp__market_task__${tool.name}`);emit({type:'system',subtype:'init',model:input.wrongInitModel?'synthetic_other_model':value('--model'),cwd:process.cwd(),tools:input.extraTool?[...tools,'Read']:tools,mcp_servers:[{name:'market_task',status:'connected'}]});
 const binding=JSON.parse(fs.readFileSync(server.args[2],'utf8')),base={groupId:binding.groupId,taskId:binding.taskId};let i=0;
 for(const[name,argumentsValue]of[['get_task',base],['read_task_file',{...base,area:'inputs',relativePath:binding.inputPaths[0]}],['start_task',{...base,requestId:`fixture_start_${input.round}`}],['submit_task_result',{...base,requestId:`fixture_submit_${input.round}`,text:`合成第${input.round}轮处理，不代表专家或真实模型执行`,sourceIds:[]}]]){
  const result=await peer.callTool({name,arguments:argumentsValue});if(result.isError)throw new Error('合成MCP调用被拒绝');emit({type:'assistant',message:{model:input.wrongAssistantModel?'synthetic_other_model':value('--model'),content:[{type:'tool_use',id:`synthetic_${++i}`,name:`mcp__market_task__${name}`,input:argumentsValue}]}});
 }
 emit({type:'result',subtype:'success',is_error:false,result:`合成第${input.round}轮，未调用模型`});
}catch{process.exitCode=2;}finally{await peer.close();}
