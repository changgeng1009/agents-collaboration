import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readConfiguration} from '../src/configured-collaboration-service.mjs';
import {CollaborationStore} from '../src/collaboration-store.mjs';
import {fail} from '../src/policy.mjs';

// 仅由可信宿主调用，准备准确grant上下文。没有API认证读取或平台执行入口。
export function prepareCoreMediaGrant(configurationPin,reservationId){
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reservationId??''))fail('CORE_MEDIA_RESERVATION_INVALID','须指定已有准确reservation。');
 const {config,dbPath,coreMedia}=readConfiguration(configurationPin);if(!coreMedia)fail('CORE_MEDIA_DISABLED','原v1服务配置不启用独立媒体。');
 const store=new CollaborationStore({dbPath,runtimeNamespace:config.runtimeNamespace,preparedWorkspaces:config.preparedWorkspaces,coreMedia});
 try{return store.coreMedia.plan(reservationId);}finally{store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{'configuration-file':{type:'string'},'configuration-sha256':{type:'string'},'reservation-id':{type:'string'}}});
 try{console.log(JSON.stringify(prepareCoreMediaGrant({path:values['configuration-file'],sha256:values['configuration-sha256']},values['reservation-id'])));}
 catch(e){console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'CORE_MEDIA_PLAN_UNKNOWN',generationRequests:0,credentialReads:0}));process.exitCode=1;}
}
