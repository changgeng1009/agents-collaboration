import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, SOURCE_ROOT, fail, inside, sha256 } from './policy.mjs';
import { SessionFiles, sessionPath, readBoundedFile, validFileArguments } from './session-files.mjs';
import { WindowsTaskFiles } from './windows-task-files.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export const canonicalFileValue = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
export const taskFileScopeSha256 = scope => sha256(canonicalFileValue(scope));
export function taskFileDirectoryIdentity(directory) {
  const checked = sessionPath(directory), stat = fs.statSync(checked, { bigint: true });
  if (!stat.isDirectory()) fail('FILE_OS_DIRECTORY_CHANGED', '可信绑定必须使用原普通目录。');
  return { path: checked, realPath: fs.realpathSync(checked), dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}
function pinnedJson(pin, parent, limit = 262144) {
  if (!exact(pin, ['path', 'sha256']) || !path.isAbsolute(pin.path ?? '') || !inside(parent, pin.path) || !hash(pin.sha256)) fail('FILE_OS_CONFIGURATION_PIN', '文件worker只接受本命名空间私有区的准确pin。');
  const raw = readBoundedFile(sessionPath(pin.path), limit);
  if (raw.sha256 !== pin.sha256) fail('FILE_OS_CONFIGURATION_CHANGED', '文件worker的受审文件已变化。');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes)); } catch { fail('FILE_OS_CONFIGURATION_INVALID', '文件worker配置必须为有效有界JSON。'); }
}
function runtimeRootChecked(root) {
  const base = path.join(PROJECT_ROOT, 'bridge/runtime/collaboration-core');
  if (!path.isAbsolute(root ?? '') || !inside(base, root)) fail('FILE_OS_CONFIGURATION_SCOPE', '文件worker配置不能离开当前核心命名空间。');
  return sessionPath(root, false);
}
export function readTaskFileConfiguration(pin, { runtimeRoot } = {}) {
  const privateRoot = path.join(runtimeRootChecked(runtimeRoot), 'private-file-worker');
  const config = pinnedJson(pin, privateRoot);
  if (!exact(config, ['schema', 'dotnetExecutable', 'buildDirectory', 'binaryHashes', 'runtimePins', 'runtimeIdentities', 'allowedWorkspaceParent', 'tasks']) || config.schema !== 'windows_task_file_backend_configuration_v1') fail('FILE_OS_CONFIGURATION_INVALID', '文件worker配置字段不符合严格格式。');
  if (!path.isAbsolute(config.allowedWorkspaceParent ?? '') || !inside(path.join(PROJECT_ROOT, 'task-workspaces'), config.allowedWorkspaceParent) || !Array.isArray(config.tasks) || !config.tasks.length || config.tasks.length > 16) fail('FILE_OS_CONFIGURATION_INVALID', '文件worker必须明确选择至多16个准确任务。');
  sessionPath(config.allowedWorkspaceParent);
  if (!path.isAbsolute(config.dotnetExecutable ?? '') || path.basename(config.dotnetExecutable).toLowerCase() !== 'dotnet.exe' || !path.isAbsolute(config.buildDirectory ?? '') || !exact(config.binaryHashes, ['dotnet', 'WindowsFileWorker.dll', 'WindowsFileWorker.deps.json', 'WindowsFileWorker.runtimeconfig.json']) || !Object.values(config.binaryHashes).every(hash)) fail('FILE_OS_BINARY_INVALID', '文件worker必须固定真实dotnet及全部入口哈希。');
  if (!Array.isArray(config.runtimePins) || !config.runtimePins.length || config.runtimePins.length > 4096) fail('FILE_OS_BINARY_INVALID', '托管runtime须提供有界的完整受审依赖清单。');
  const runtimePaths = new Set();
  for (const item of config.runtimePins) {
    if (!exact(item, ['relativePath', 'sha256']) || typeof item.relativePath !== 'string' || !hash(item.sha256) || path.isAbsolute(item.relativePath) || !inside(path.dirname(config.dotnetExecutable), path.resolve(path.dirname(config.dotnetExecutable), item.relativePath)) || runtimePaths.has(item.relativePath.toLowerCase())) fail('FILE_OS_BINARY_INVALID', 'runtime清单包含越界、重复或未固定的文件。');
    runtimePaths.add(item.relativePath.toLowerCase());
  }
  checkRuntimeTree(config);
  const keys = new Set(), roots = new Set();
  for (const task of config.tasks) {
    if (!exact(task, ['groupId', 'taskId', 'workspaceId', 'taskRoot', 'rootIdentity', 'workspaceMarkerSha256', 'scopeSha256', 'manifestPin']) || ![task.groupId, task.taskId, task.workspaceId].every(id) || !hash(task.workspaceMarkerSha256) || !hash(task.scopeSha256) || task.taskRoot !== path.join(PROJECT_ROOT, 'task-workspaces', task.workspaceId) || !inside(config.allowedWorkspaceParent, task.taskRoot) || task.taskRoot === config.allowedWorkspaceParent) fail('FILE_OS_TASK_SELECTION', '只允许受审的新任务准确标识及原目录。');
    const key = `${task.groupId}:${task.taskId}`;
    if (keys.has(key) || roots.has(task.taskRoot.toLowerCase())) fail('FILE_OS_TASK_SELECTION', '同一任务或目录不得重复选择。');
    keys.add(key); roots.add(task.taskRoot.toLowerCase());
    if (canonicalFileValue(task.rootIdentity) !== canonicalFileValue(taskFileDirectoryIdentity(task.taskRoot))) fail('FILE_OS_DIRECTORY_CHANGED', '受审任务根身份已变化。');
    pinnedJson(task.manifestPin, privateRoot);
  }
  return { config, privateRoot, pin: structuredClone(pin), runtimeRoot: runtimeRootChecked(runtimeRoot) };
}
function checkExternalFile(file, expected) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha256(fs.readFileSync(file)) !== expected) fail('FILE_OS_RUNTIME_CHANGED', '受审运行程序或依赖已变化。');
  // 外部运行时也拒绝祖先联接；不能借固定文件名换到别的程序树。
  for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('FILE_OS_RUNTIME_CHANGED', '运行程序路径包含联接。');
    if (cursor === path.dirname(cursor)) break;
  }
}
export function taskFileRuntimeDirectoryIdentity(directory){
  for(let cursor=path.resolve(directory);;cursor=path.dirname(cursor)){if(fs.lstatSync(cursor).isSymbolicLink())fail('FILE_OS_RUNTIME_CHANGED','runtime祖先目录包含联接。');if(cursor===path.dirname(cursor))break;}
  const stat=fs.statSync(directory,{bigint:true});if(!stat.isDirectory())fail('FILE_OS_RUNTIME_CHANGED','runtime范围不是目录。');
  return{path:path.resolve(directory),realPath:fs.realpathSync(directory),dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};
}
function checkRuntimeTree(config) {
  const root=path.dirname(config.dotnetExecutable),options=JSON.parse(fs.readFileSync(path.join(config.buildDirectory,'WindowsFileWorker.runtimeconfig.json'),'utf8')).runtimeOptions;
  if(options?.rollForward!=='Disable'||options.framework?.name!=='Microsoft.NETCore.App'||!/^\d+\.\d+\.\d+$/.test(options.framework?.version??''))fail('FILE_OS_BINARY_INVALID','恢复runtime必须固定精确框架，禁止自动roll-forward。');
  const directories={dotnetRoot:root,fxrRoot:path.join(root,'host','fxr'),frameworkRoot:path.join(root,'shared','Microsoft.NETCore.App',options.framework.version)};
  if(!exact(config.runtimeIdentities,Object.keys(directories))||Object.entries(directories).some(([name,value])=>canonicalFileValue(taskFileRuntimeDirectoryIdentity(value))!==canonicalFileValue(config.runtimeIdentities[name])))fail('FILE_OS_RUNTIME_CHANGED','runtime根、host或精确framework目录身份已改变。');
  const required=new Set(['dotnet.exe']);
  function walk(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isSymbolicLink())fail('FILE_OS_RUNTIME_CHANGED','runtime树拒绝联接。');if(item.isDirectory())walk(file);else if(item.isFile())required.add(path.relative(root,file).toLowerCase());else fail('FILE_OS_RUNTIME_CHANGED','runtime树包含非普通文件。');}}
  walk(path.join(root,'host','fxr'));walk(path.join(root,'shared','Microsoft.NETCore.App',options.framework.version));
  const pins=new Map(config.runtimePins.map(item=>[path.normalize(item.relativePath).toLowerCase(),item.sha256]));
  if(pins.size!==required.size||[...required].some(name=>!pins.has(name)))fail('FILE_OS_BINARY_INVALID','runtime清单必须覆盖host/fxr和精确框架完整目录。');
  checkExternalFile(config.dotnetExecutable,config.binaryHashes.dotnet);
  for(const [name,expected]of pins)checkExternalFile(path.join(root,name),expected);
  for(const name of ['WindowsFileWorker.dll','WindowsFileWorker.deps.json','WindowsFileWorker.runtimeconfig.json'])checkExternalFile(path.join(config.buildDirectory,name),config.binaryHashes[name]);
}

// 仅可信本地准备流程调用，不挂到任何成员工具。manifest完成后仍须由manager准确SHA审查。
export function prepareTaskFileBinding(worker,task,{runtimeRoot,manifestFile,approvalPin}={}){
  const privateRoot=path.join(runtimeRootChecked(runtimeRoot),'private-file-worker');
  const approval=pinnedJson(approvalPin,privateRoot);
  if(!exact(approval,['schema','permission','groupId','taskId','workspaceId','workspaceMarkerSha256','scopeSha256','taskRoot','rootIdentity','allowedWorkspaceParent','dotnetExecutable','buildDirectory','binaryHashesSha256','manifestFile','expiresAt'])||approval.schema!=='windows_task_file_prepare_approval_v1'||approval.permission!=='prepare_file_worker_once'||approval.groupId!==task.groupId||approval.taskId!==task.taskId||approval.workspaceId!==task.workspace.taskId||approval.workspaceMarkerSha256!==task.workspace.markerSha256||approval.scopeSha256!==taskFileScopeSha256(task.scope)||approval.taskRoot!==task.workspace.cwd||canonicalFileValue(approval.rootIdentity)!==canonicalFileValue(taskFileDirectoryIdentity(task.workspace.cwd))||approval.allowedWorkspaceParent!==worker.allowedParent||approval.dotnetExecutable!==worker.dotnetExecutable||approval.buildDirectory!==worker.buildDirectory||approval.binaryHashesSha256!==sha256(canonicalFileValue(worker.binaryHashes))||approval.manifestFile!==manifestFile||!Number.isFinite(Date.parse(approval.expiresAt))||Date.parse(approval.expiresAt)<=Date.now()||!worker.profileCreationAccepted)fail('FILE_OS_PREPARE_APPROVAL','首次准备必须有准确任务、程序和输出绑定的一次受审批准。');
  if(!path.isAbsolute(manifestFile??'')||!inside(privateRoot,manifestFile)||inside(task.workspace.cwd,manifestFile))fail('FILE_OS_CONFIGURATION_SCOPE','manifest必须在任务可写区之外的可信私有区。');
  sessionPath(manifestFile,false);fs.mkdirSync(path.dirname(manifestFile),{recursive:true});
  // 先独占最终目标；已有manifest而intent缺失时也必须在任何OS准备前拒绝。
  const fd=fs.openSync(manifestFile,'wx',0o600),original=fs.fstatSync(fd,{bigint:true});
  try{
    const intentFile=manifestFile+'.intent.json';const fdIntent=fs.openSync(intentFile,'wx',0o600);try{fs.writeFileSync(fdIntent,JSON.stringify({state:'unknown',approvalSha256:approvalPin.sha256,groupId:task.groupId,taskId:task.taskId,workspaceBinding:task.workspace.markerSha256,automaticRetry:false}));fs.fsyncSync(fdIntent);}finally{fs.closeSync(fdIntent);}
    worker.prepareTask(task);
    const binding=worker.binding(task.workspace),inspection=worker.inspect(binding.configFile,task.workspace.cwd);
    const evidencePins=['broker-config.json','prepared-state.json','profile-create-intent.json','profile-create-result.json','acl-before.json','acl-after.json'].map(name=>({name,sha256:readBoundedFile(path.join(binding.directory,name),262144).sha256}));
    const runtimeFileIdentities=Object.fromEntries(Object.keys(binding.runtimeHashes).map(name=>[name,readBoundedFile(path.join(binding.runtimeDirectory,name),16*1024*1024).identity]));
    const manifest={schema:'windows_task_file_binding_v1',groupId:task.groupId,taskId:task.taskId,workspaceId:task.workspace.taskId,workspaceMarkerSha256:task.workspace.markerSha256,scopeSha256:taskFileScopeSha256(task.scope),profileName:binding.profileName,sid:binding.sid,profileFolder:binding.profileFolder,runtimeDirectory:binding.runtimeDirectory,runtimeFileIdentities,evidencePins,inspection};
    const bytes=Buffer.from(JSON.stringify(manifest)),current=fs.lstatSync(manifestFile,{bigint:true});
    if(!current.isFile()||current.nlink!==1n||current.dev!==original.dev||current.ino!==original.ino||current.birthtimeNs!==original.birthtimeNs||current.size!==0n)fail('FILE_OS_BINDING_CHANGED','manifest预留目标已变化；保留unknown，不写入别的对象。');
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);if(readBoundedFile(manifestFile,262144).sha256!==sha256(bytes))fail('FILE_OS_BINDING_CHANGED','manifest写后读回不符，不能自动补写。');
    return{manifestPin:{path:manifestFile,sha256:sha256(bytes)},reviewRequired:true,workerOsIsolationVerified:false,platformOsIsolationVerified:false};
  }finally{fs.closeSync(fd);}
}
export function createTaskFileBackend(pin, { runtimeRoot, testHooks = null } = {}) {
  if (testHooks && (process.env.COLLAB_TEST_MODE !== '1' || PROJECT_ROOT === SOURCE_ROOT)) fail('FILE_OS_FIXTURE_FORBIDDEN', '测试观察器只能在显式隔离测试根注入。');
  const reviewed = readTaskFileConfiguration(pin, { runtimeRoot }), { config, privateRoot } = reviewed;
  const worker = new WindowsTaskFiles({ ...config, profileCreationAccepted: false, restorationOnly: true, testHooks });
  const selectors = new Map(config.tasks.map(task => [`${task.groupId}:${task.taskId}`, task]));
  function selected(task) { return selectors.get(`${task.groupId}:${task.taskId}`); }
  function verify(task) {
    const fresh = readTaskFileConfiguration(pin, { runtimeRoot });
    if (canonicalFileValue(fresh.config) !== canonicalFileValue(config)) fail('FILE_OS_CONFIGURATION_CHANGED', '当前配置不再等于原启动配置。');
    const selection = selected(task);
    if (!selection || task.workspace?.taskId !== selection.workspaceId || task.workspace.cwd !== selection.taskRoot || task.workspace.markerSha256 !== selection.workspaceMarkerSha256 || taskFileScopeSha256(task.scope) !== selection.scopeSha256) fail('FILE_OS_BINDING_INVALID', '当前任务、marker或文件scope与原受审绑定不符。');
    new SessionFiles({ workspace: task.workspace, scope: task.scope });
    const manifest = pinnedJson(selection.manifestPin, privateRoot);
    if (!exact(manifest, ['schema', 'groupId', 'taskId', 'workspaceId', 'workspaceMarkerSha256', 'scopeSha256', 'profileName', 'sid', 'profileFolder', 'runtimeDirectory', 'runtimeFileIdentities', 'evidencePins', 'inspection']) || manifest.schema !== 'windows_task_file_binding_v1' || ['groupId','taskId','workspaceId','workspaceMarkerSha256','scopeSha256'].some(key => manifest[key] !== selection[key]) || !/^collaboration\.t10\.[a-f0-9]{32}$/.test(manifest.profileName) || !/^S-1-15-2-/.test(manifest.sid)) fail('FILE_OS_BINDING_INVALID', '外部manifest不是当前准确任务的已审绑定。');
    const directory = sessionPath(path.join(task.workspace.cwd, '.os-worker'));
    const required = ['broker-config.json', 'prepared-state.json', 'profile-create-intent.json', 'profile-create-result.json', 'acl-before.json', 'acl-after.json'];
    if (!Array.isArray(manifest.evidencePins) || manifest.evidencePins.length !== required.length || new Set(manifest.evidencePins.map(item => item.name)).size !== required.length) fail('FILE_OS_BINDING_INVALID', '原准备证据不完整，不能恢复unknown或partial。');
    for (const name of required) {
      const item = manifest.evidencePins.find(value => value.name === name);
      if (!exact(item, ['name', 'sha256']) || !hash(item.sha256) || readBoundedFile(path.join(directory, name), 262144).sha256 !== item.sha256) fail('FILE_OS_BINDING_CHANGED', '原准备证据已变化或缺失。');
    }
    const broker = JSON.parse(readBoundedFile(path.join(directory, 'broker-config.json')).bytes);
    const prepared = JSON.parse(readBoundedFile(path.join(directory, 'prepared-state.json')).bytes);
    const result = JSON.parse(readBoundedFile(path.join(directory, 'profile-create-result.json')).bytes);
    if (!exact(broker, ['TaskRoot','AllowedParent','ProfileName','BuildDirectory','DotnetRoot']) || broker.TaskRoot !== selection.taskRoot || broker.AllowedParent !== config.allowedWorkspaceParent || broker.ProfileName !== manifest.profileName || broker.BuildDirectory !== config.buildDirectory || broker.DotnetRoot !== path.dirname(config.dotnetExecutable) || prepared.TaskRoot !== selection.taskRoot || prepared.ProfileName !== manifest.profileName || prepared.Sid !== manifest.sid || prepared.ProfileFolder !== manifest.profileFolder || prepared.RuntimeDirectory !== path.join(directory, 'runtime') || manifest.runtimeDirectory !== prepared.RuntimeDirectory || result.created !== true || result.hresult !== 0 || result.sid !== manifest.sid || result.ProfileName !== manifest.profileName) fail('FILE_OS_BINDING_INVALID', '原prepare终态、程序目录或profile不符合可信manifest。');
    worker.checkBinaries();
    for (const item of config.runtimePins) checkExternalFile(path.resolve(path.dirname(config.dotnetExecutable), item.relativePath), item.sha256);
    const names=['WindowsFileWorker.dll','WindowsFileWorker.deps.json','WindowsFileWorker.runtimeconfig.json'];
    if(!exact(manifest.runtimeFileIdentities,names))fail('FILE_OS_RUNTIME_CHANGED','manifest缺准确runtime文件身份。');
    for(const name of names){const raw=readBoundedFile(path.join(manifest.runtimeDirectory,name),16*1024*1024);if(raw.sha256!==config.binaryHashes[name]||canonicalFileValue(raw.identity)!==canonicalFileValue(manifest.runtimeFileIdentities[name]))fail('FILE_OS_RUNTIME_CHANGED','runtime文件字节或原文件身份改变。');}
    const observed = worker.inspect(path.join(directory, 'broker-config.json'), task.workspace.cwd);
    if (!manifest.inspection || canonicalFileValue(observed) !== canonicalFileValue(manifest.inspection)) fail('FILE_OS_INSPECTION_CHANGED', '当前目录、ACL、完整性或profile观察与受审manifest不符。');
    return { workspaceBinding: selection.workspaceMarkerSha256, configFile: path.join(directory, 'broker-config.json'), directory, sid: manifest.sid, profileName: manifest.profileName, profileFolder: manifest.profileFolder, runtimeDirectory: manifest.runtimeDirectory, runtimeFileIdentities:structuredClone(manifest.runtimeFileIdentities),runtimeHashes: Object.fromEntries(Object.entries(config.binaryHashes).filter(([name]) => name !== 'dotnet')), inspection: structuredClone(manifest.inspection) };
  }
  function operate(task, args, operation) {
    if(!validFileArguments(operation==='read'?'read_task_file':'write_task_file',args))fail('FILE_ARGUMENT_INVALID','只接收当前任务有界文件参数，inputs保持只读。');
    if (!selected(task)) fail('FILE_OS_TASK_NOT_SELECTED', '当前任务不在准确OS文件worker清单。');
    // 每次用当前task重新验证并更换闭包，不能沿用首次恢复时的旧scope。
    worker.restoreTask(task, () => verify(task));
    return worker[operation](task, args);
  }
  return { selectionMode: 'exact_tasks', configurationPin: structuredClone(pin), runtimeRoot: reviewed.runtimeRoot,
    appliesTo: task => !!selected(task), read: (task, args) => operate(task, args, 'read'), write: (task, args) => operate(task, args, 'write'),
    capabilities(task) { return { ...worker.capabilities(task.workspace), taskSelected: !!selected(task) }; },
    restoreTask(task) { worker.restoreTask(task, () => verify(task)); return worker.capabilities(task.workspace); }
  };
}

// pin只从核心可信execution记录读取；task内file-binding与成员参数不能增加权限。
export function restoreExecutionFileBackend(store, context, { testHooks = null } = {}) {
  const recorded = context.intent.fileWorkerContext;
  if (!recorded) return false;
  const base=path.join(PROJECT_ROOT,'bridge/runtime/collaboration-core');
  const namespaceAllowed=typeof recorded.runtimeRoot==='string'&&(recorded.runtimeRoot===store.runtimeRoot||store.runtimeRoot===base&&path.dirname(recorded.runtimeRoot)===base&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(path.basename(recorded.runtimeRoot)))&&inside(recorded.runtimeRoot,store.dbPath);
  if (!exact(recorded, ['pin', 'runtimeRoot', 'workspaceBinding', 'scopeSha256']) || !namespaceAllowed || recorded.workspaceBinding !== context.task.workspace.markerSha256 || recorded.scopeSha256 !== taskFileScopeSha256(context.task.scope)) fail('FILE_OS_EXECUTION_PIN', '文件租约的可信backend绑定与当前执行不符。');
  if (store.fileWorker && (canonicalFileValue(store.fileWorker.configurationPin) !== canonicalFileValue(recorded.pin) || store.fileWorker.runtimeRoot !== recorded.runtimeRoot)) fail('FILE_OS_EXECUTION_PIN', '租约不能替换原核心文件backend。');
  const backend = store.fileWorker ?? createTaskFileBackend(recorded.pin, { runtimeRoot: recorded.runtimeRoot, testHooks });
  if (!backend.appliesTo(context.task)) fail('FILE_OS_TASK_NOT_SELECTED', '租约任务不在受审backend清单。');
  backend.restoreTask(context.task); store.fileWorker = backend; return true;
}
