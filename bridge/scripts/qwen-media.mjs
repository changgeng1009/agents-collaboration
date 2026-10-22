import {parseArgs} from 'node:util';
import {QwenMediaAdapter,loadQwenConfig,readonlyPlanSha256,safeFailureCode} from '../src/qwen-media-adapter.mjs';

// 独立可信宿主入口，不向成员MCP新增模型权限；配置文件由宿主显式提供。
try {
 const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string'},request:{type:'string'},kind:{type:'string'},review:{type:'string'},operation:{type:'string'},query:{type:'string'},recover:{type:'boolean',default:false}}});
 const configFile=values.config ?? process.env.QWEN_MEDIA_HOST_CONFIG;
 const adapter=new QwenMediaAdapter(loadQwenConfig(configFile));let result;
 switch(positionals[0]) {
  case 'preflight':result=adapter.preflight(values.request?adapter.readRequest(values.request):null);break;
  case 'readonly-plan':{const plan=adapter.readonlyPlan();result={plan,planSha256:readonlyPlanSha256(plan)};break;}
  case 'readonly-auth':result=await adapter.readonlyAuth(values.kind,values.review);break;
  case 'execute':result=await adapter.execute(adapter.readRequest(values.request));break;
  case 'status':result=await adapter.status(values.operation,values.query,{recover:values.recover});break;
  case 'recover-plan':result=adapter.recoveryPlan(adapter.readRequest(values.request));break;
  case 'recover':result=await adapter.recover(adapter.readRequest(values.request));break;
  default:throw Object.assign(new Error(),{code:'QWEN_COMMAND_INVALID'});
 }
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(failure){process.stderr.write(JSON.stringify({status:'stopped',code:safeFailureCode(failure),automaticRetry:false})+'\n');process.exitCode=1;}
