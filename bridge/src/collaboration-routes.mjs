// 仅描述正式产品合同与可信启动前提；本模块不发请求，不读取认证，不切换产品模式。
const workBuddyApi='https://open.workbuddy.cn/docs/openapi';
const scheduledGuide='https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Automation-Guide';
const blocked=(code,message)=>({code,message});
export function executionRoute({platform,mode,operation,localFixture=false,authorization={}}){
 const route={platform,mode,operation,mechanism:'external_api',contractStatus:'unavailable',implemented:false,runtimeVerified:false,modelStartedVerified:false,passiveWakeVerified:false,automaticModeSwitch:false,automaticRetry:false,nativeField:null,cwdContract:'unavailable',sources:[],requiredScopes:[],missingPrerequisites:[],blocker:null};
 if(platform==='claude')route.blocker=blocked('CLAUDE_PAUSED','Claude 正式接入和执行暂停。');
 else if(platform==='doubao')route.blocker=blocked('DOUBAO_CONTRACT_UNAVAILABLE','豆包正式外部创建、续接及被动唤醒合同未取得。');
 else if(platform!=='workbuddy')route.blocker=blocked('PLATFORM_CONTRACT_UNAVAILABLE','该平台没有本核心审查过的正式执行合同。');
 else if(mode==='codebuddy_cli'){
  route.mechanism='historical_independent_cli';route.contractStatus='historical_compatibility';
  if(localFixture){route.implemented=true;route.evidenceLevel='local_test';route.blocker=null;}
  else route.blocker=blocked('CODEBUDDY_ROUTE_CANCELLED','独立 CodeBuddy 路线已取消，不能替代桌面入口。');
 }else if(mode==='desktop'){
  route.sources=[workBuddyApi];route.blocker=blocked('WORKBUDDY_DESKTOP_NATIVE_CONTRACT_UNAVAILABLE','桌面模式没有已审查的外部原生建聊、指定会话续接和本机 cwd 合同。');
 }else if(mode==='desktop_local_native_schedule'){
  route.mechanism='scheduled_product_trigger';route.contractStatus='documentation_only';route.sources=[scheduledGuide];route.cwdContract='product_workspace_selection';
  route.blocker=blocked('WORKBUDDY_SCHEDULED_EXTERNAL_CONTROL_UNAVAILABLE','官方产品内定时任务可触发新任务；外部原生编号选择、续接和本核心调度接口未提供。');
 }else if(mode==='localassistant'){
  route.sources=[workBuddyApi];route.contractStatus='documented_partial';route.messageField='message_id';
  route.requiredScopes=operation!=='post_assistant_message'?['user.localassistant.readable']:['user.localassistant.invokable'];
  route.documentedOperations=['get_assistant_status','post_assistant_message','read_assistant_messages'];
  route.missingPrerequisites=['approved_third_party_application','owner_oauth_2_1',...route.requiredScopes.map(scope=>`scope:${scope}`),'online_localassistant'];
  route.blocker=blocked('WORKBUDDY_LOCALASSISTANT_NATIVE_CONTRACT_UNAVAILABLE','本地助理 message_id 是消息字段，不能指定桌面原生会话；未提供本机 cwd 或专家选择合同。');
  if(route.documentedOperations.includes(operation)){
   route.missingPrerequisites=route.missingPrerequisites.filter(item=>item==='approved_third_party_application'?!authorization.approvedApplication:item==='owner_oauth_2_1'?!authorization.ownerOAuth:item==='online_localassistant'?!authorization.online:!authorization.scopes?.includes(item.slice(6)));
   route.blocker=blocked(route.missingPrerequisites.length?'WORKBUDDY_OAUTH_SCOPE_REQUIRED':'WORKBUDDY_PROVIDER_NOT_IMPLEMENTED',route.missingPrerequisites.length?'尚未取得本人授权、应用准入、指定Scope或在线状态。':'正式消息合同已描述；当前没有实现或调用本地助理 provider。');
  }
 }else if(mode==='cloud'){
  route.sources=[workBuddyApi];route.contractStatus='documented';route.nativeField='task_id';route.cwdContract='cloud_sandbox_only';
  route.documentedOperations=['create_conversation','send_to_conversation'];route.missingPrerequisites=['approved_third_party_application','owner_oauth_2_1','cloud_mode_explicit_acceptance','cloud_workspace_contract','implemented_official_provider'];
  route.blocker=blocked('WORKBUDDY_CLOUD_LOCAL_CWD_UNSUPPORTED','云端 task_id/ACP 是独立云模式，不能绑定本机任务目录；应用准入、OAuth和正式provider未就绪。');
 }else route.blocker=blocked('PROVIDER_MODE_UNSUPPORTED','当前产品模式没有已审查的正式执行路由，不能静默切换。');
 return route;
}
export function platformRoutes(platform,mode){return ['create_conversation','send_to_conversation','passive_wake'].map(operation=>executionRoute({platform,mode,operation}));}
