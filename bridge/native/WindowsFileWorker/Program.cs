using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

internal sealed record Configuration(string TaskRoot,string AllowedParent,string ProfileName,string BuildDirectory,string DotnetRoot);
internal sealed record Prepared(string TaskRoot,string ProfileName,string Sid,string ProfileFolder,string RuntimeDirectory,string[] AclPaths);
internal sealed record Job(string Operation,string Target,string? Text,string ExpectedSid,string? ChildExecutable=null,string? Canary=null,string? Input=null,string? Work=null,string? Outputs=null);
internal static class Program
{
    static readonly JsonSerializerOptions Json=new(){PropertyNameCaseInsensitive=true};
    static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    static string PathIn(string parent,string file)
    {var root=Path.GetFullPath(parent);var full=Path.GetFullPath(file);var relative=Path.GetRelativePath(root,full);if(relative==".."||relative.StartsWith(".."+Path.DirectorySeparatorChar)||Path.IsPathRooted(relative))throw new InvalidOperationException("路径不在固定任务根");var current=root;foreach(var part in relative.Split(Path.DirectorySeparatorChar)){current=Path.Combine(current,part);if((Directory.Exists(current)||File.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("拒绝路径重解析点");}return full;}
    static void WriteNew(string file,object value)
    {using var stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read);JsonSerializer.Serialize(stream,value,Json);stream.Flush(true);}
    static T Read<T>(string file)=>JsonSerializer.Deserialize<T>(File.ReadAllBytes(file),Json)??throw new InvalidOperationException("配置缺失");
    static string Control(Configuration config)=>Path.Combine(config.TaskRoot,".os-worker");
    static void Validate(Configuration config)
    {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("Windows API需要Windows");
        if(PathIn(config.AllowedParent,config.TaskRoot)==Path.GetFullPath(config.AllowedParent)||!Directory.Exists(config.TaskRoot))throw new InvalidOperationException("只能绑定新任务子目录");
        if(!System.Text.RegularExpressions.Regex.IsMatch(config.ProfileName,"^collaboration[.]t10[.][a-f0-9]{32}$"))throw new InvalidOperationException("必须新的T10独立profile名称");
        foreach(var area in new[]{"inputs","work","outputs"})if(!Directory.Exists(PathIn(config.TaskRoot,Path.Combine(config.TaskRoot,area,"files"))))throw new InvalidOperationException("任务文件范围未准备");
    }
    static void DirectoryAcl(string directory,string? package,FileSystemRights rights)
    {
        var owner=WindowsIdentity.GetCurrent().User??throw new InvalidOperationException("缺当前用户SID");
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);acl.SetOwner(owner);
        foreach(var sid in new[]{owner,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null)})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        if(package!=null)acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(package),rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        FileSystemAclExtensions.SetAccessControl(new DirectoryInfo(directory),acl);
    }
    static Prepared Prepare(Configuration config)
    {
        Validate(config);var control=PathIn(config.TaskRoot,Control(config));Directory.CreateDirectory(control);
        WriteNew(Path.Combine(control,"profile-create-intent.json"),new{atUtc=DateTimeOffset.UtcNow,config.ProfileName,operation="CreateAppContainerProfile",capabilityCount=0,automaticRetry=false});
        var status=Native.CreateAppContainerProfile(config.ProfileName,config.ProfileName,"独立任务文件worker；不授予网络能力",IntPtr.Zero,0,out var sid);
        string? sidText=null;try{if(sid!=IntPtr.Zero)sidText=new SecurityIdentifier(sid).Value;}finally{if(sid!=IntPtr.Zero)Native.FreeSid(sid);}
        WriteNew(Path.Combine(control,"profile-create-result.json"),new{atUtc=DateTimeOffset.UtcNow,hresult=status,sid=sidText,created=status==0,config.ProfileName,profileRetained=true});
        if(status!=0||sidText==null)Marshal.ThrowExceptionForHR(status);
        if(sidText==null)throw new InvalidOperationException("profile没有SID");
        var folderStatus=Native.GetAppContainerFolderPath(sidText,out var folderPointer);if(folderStatus!=0)Marshal.ThrowExceptionForHR(folderStatus);var profileFolder=Marshal.PtrToStringUni(folderPointer)??"";Marshal.FreeCoTaskMem(folderPointer);
        var runtime=Path.Combine(control,"runtime");Directory.CreateDirectory(runtime);var frames=Path.Combine(control,"frames");Directory.CreateDirectory(frames);
        foreach(var name in new[]{"WindowsFileWorker.dll","WindowsFileWorker.deps.json","WindowsFileWorker.runtimeconfig.json"})File.Copy(Path.Combine(config.BuildDirectory,name),Path.Combine(runtime,name),false);
        // 仅当前任务的新目录；不修改系统、平台数据或项目其它目录的ACL。
        var aclPaths=new[]{config.TaskRoot,control,runtime,frames,Path.Combine(config.TaskRoot,"inputs","files"),Path.Combine(config.TaskRoot,"work","files"),Path.Combine(config.TaskRoot,"outputs","files")};
        object[] AclSnapshot()=>aclPaths.Select(directory=>(object)new{path=directory,sddl=FileSystemAclExtensions.GetAccessControl(new DirectoryInfo(directory)).GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group)}).ToArray();
        WriteNew(Path.Combine(control,"acl-before.json"),AclSnapshot());
        DirectoryAcl(config.TaskRoot,sidText,FileSystemRights.Traverse|FileSystemRights.ReadAttributes|FileSystemRights.Synchronize);
        DirectoryAcl(control,sidText,FileSystemRights.Traverse|FileSystemRights.ReadAttributes|FileSystemRights.Synchronize);
        DirectoryAcl(runtime,sidText,FileSystemRights.ReadAndExecute);
        DirectoryAcl(frames,sidText,FileSystemRights.ReadAndExecute);
        DirectoryAcl(Path.Combine(config.TaskRoot,"inputs","files"),sidText,FileSystemRights.ReadAndExecute);
        foreach(var area in new[]{"work","outputs"}){var folder=Path.Combine(config.TaskRoot,area,"files");DirectoryAcl(folder,sidText,FileSystemRights.Modify);Native.LowIntegrity(folder);}
        WriteNew(Path.Combine(control,"acl-after.json"),new{directories=AclSnapshot(),lowIntegrityAppliedTo=new[]{Path.Combine(config.TaskRoot,"work","files"),Path.Combine(config.TaskRoot,"outputs","files")},scope="new_task_only",globalAclChanged=false});
        var prepared=new Prepared(Path.GetFullPath(config.TaskRoot),config.ProfileName,sidText,profileFolder,runtime,aclPaths);WriteNew(Path.Combine(control,"prepared-state.json"),prepared);return prepared;
    }
    static object Launch(Configuration config,Prepared prepared,Job request)
    {
        Validate(config);if(prepared.TaskRoot!=Path.GetFullPath(config.TaskRoot)||prepared.ProfileName!=config.ProfileName||request.ExpectedSid!=prepared.Sid)throw new InvalidOperationException("原任务/profile/SID绑定不符");
        var derive=Native.DeriveAppContainerSidFromAppContainerName(prepared.ProfileName,out var sid);if(derive!=0)Marshal.ThrowExceptionForHR(derive);
        Native.ProcessInformation process=default;IntPtr attributes=IntPtr.Zero,capsPointer=IntPtr.Zero,handlesPointer=IntPtr.Zero,environment=IntPtr.Zero,jobHandle=IntPtr.Zero;var inherited=new List<IntPtr>();
        var operationId=Guid.NewGuid().ToString("N");var output=Path.Combine(config.TaskRoot,"work","files","worker-"+operationId+".stdout");var error=Path.Combine(config.TaskRoot,"work","files","worker-"+operationId+".stderr");
        try{
            if(new SecurityIdentifier(sid).Value!=prepared.Sid)throw new InvalidOperationException("profile SID变化");
            var security=new Native.SecurityAttributes{Length=Marshal.SizeOf<Native.SecurityAttributes>(),Inherit=1};
            foreach(var file in new[]{"NUL",output,error}){var handle=Native.CreateFile(file,file=="NUL"?Native.GENERIC_READ:Native.GENERIC_WRITE,3,ref security,file=="NUL"?Native.OPEN_EXISTING:Native.CREATE_NEW,0x80,IntPtr.Zero);if(handle==Native.Invalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateFile stdio");inherited.Add(handle);}
            UIntPtr size=UIntPtr.Zero;Native.InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);attributes=Marshal.AllocHGlobal((int)size);Native.Check(Native.InitializeProcThreadAttributeList(attributes,2,0,ref size),"InitializeProcThreadAttributeList");
            var caps=new Native.SecurityCapabilities{Sid=sid,Capabilities=IntPtr.Zero,Count=0,Reserved=0};capsPointer=Marshal.AllocHGlobal(Marshal.SizeOf<Native.SecurityCapabilities>());Marshal.StructureToPtr(caps,capsPointer,false);
            Native.Check(Native.UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20009),capsPointer,(UIntPtr)Marshal.SizeOf<Native.SecurityCapabilities>(),IntPtr.Zero,IntPtr.Zero),"Update SECURITY_CAPABILITIES");
            handlesPointer=Marshal.AllocHGlobal(IntPtr.Size*inherited.Count);for(var i=0;i<inherited.Count;i++)Marshal.WriteIntPtr(handlesPointer,i*IntPtr.Size,inherited[i]);
            Native.Check(Native.UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handlesPointer,(UIntPtr)(IntPtr.Size*inherited.Count),IntPtr.Zero,IntPtr.Zero),"Update HANDLE_LIST");
            var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase){{"SystemRoot",Environment.GetFolderPath(Environment.SpecialFolder.Windows)},{"DOTNET_ROOT",config.DotnetRoot},{"DOTNET_EnableDiagnostics","0"},{"DOTNET_CLI_TELEMETRY_OPTOUT","1"},{"DOTNET_SKIP_FIRST_TIME_EXPERIENCE","1"},{"TEMP",Path.Combine(config.TaskRoot,"work","files")},{"TMP",Path.Combine(config.TaskRoot,"work","files")}};
            env["LOCALAPPDATA"]=prepared.ProfileFolder;
            environment=Marshal.StringToHGlobalUni(string.Join('\0',env.Select(pair=>pair.Key+"="+pair.Value))+"\0\0");
            var executable=Path.Combine(config.DotnetRoot,"dotnet.exe");var assembly=Path.Combine(prepared.RuntimeDirectory,"WindowsFileWorker.dll");var frame=Path.Combine(Control(config),"frames",operationId+".json");WriteNew(frame,request);
            var startup=new Native.StartupInfoEx{Info=new Native.StartupInfo{Size=Marshal.SizeOf<Native.StartupInfoEx>(),Flags=0x100,Input=inherited[0],Output=inherited[1],Error=inherited[2]},Attributes=attributes};
            Native.Check(Native.CreateProcess(executable,new StringBuilder('"'+executable+"\" \""+assembly+"\" --worker-file \""+frame+"\""),IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x4|0x8000000,environment,config.TaskRoot,ref startup,out process),"CreateProcess AppContainer");
            var token=Native.Token(process.Process);var tokenJson=JsonSerializer.SerializeToElement(token);if(!tokenJson.GetProperty("isAppContainer").GetBoolean()||tokenJson.GetProperty("appContainerSid").GetString()!=prepared.Sid||tokenJson.GetProperty("integritySid").GetString()!="S-1-16-4096"||tokenJson.GetProperty("capabilityCount").GetInt32()!=0)throw new InvalidOperationException("实际子进程token不符合AppContainer低完整性零能力");
            jobHandle=Native.CreateJobObject(IntPtr.Zero,null);Native.Check(jobHandle!=IntPtr.Zero,"CreateJobObject");var limits=new Native.ExtendedLimit{Basic=new Native.BasicLimit{Flags=0x2000}};Native.Check(Native.SetInformationJobObject(jobHandle,9,ref limits,(uint)Marshal.SizeOf<Native.ExtendedLimit>()),"SetInformationJobObject");Native.Check(Native.AssignProcessToJobObject(jobHandle,process.Process),"AssignProcessToJobObject");
            if(Native.ResumeThread(process.Thread)==uint.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");
            var wait=Native.WaitForSingleObject(process.Process,30000);if(wait!=0)throw new TimeoutException("文件worker超时，结果未知不重试");Native.Check(Native.GetExitCodeProcess(process.Process,out var exitCode),"GetExitCodeProcess");
            foreach(var handle in inherited)Native.CloseHandle(handle);inherited.Clear();
            var stdout=File.ReadAllText(output);var stderr=File.ReadAllText(error);if(stdout.Length>1024*1024||stderr.Length>1024*1024)throw new InvalidOperationException("worker输出超限");
            return new{operationId,pid=process.Pid,token,exitCode,outputFile=output,errorFile=error,workerResult=string.IsNullOrWhiteSpace(stdout)?(JsonElement?)null:JsonSerializer.Deserialize<JsonElement>(stdout),stderr,networkCapabilitiesGranted=false,loopbackExemptionChanged=false,platformOsIsolationVerified=false};
        }finally{
            if(process.Process!=IntPtr.Zero){Native.GetExitCodeProcess(process.Process,out var code);if(code==259)Native.TerminateProcess(process.Process,90);Native.CloseHandle(process.Process);}if(process.Thread!=IntPtr.Zero)Native.CloseHandle(process.Thread);if(jobHandle!=IntPtr.Zero)Native.CloseHandle(jobHandle);
            foreach(var handle in inherited)Native.CloseHandle(handle);if(attributes!=IntPtr.Zero){Native.DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}if(capsPointer!=IntPtr.Zero)Marshal.FreeHGlobal(capsPointer);if(handlesPointer!=IntPtr.Zero)Marshal.FreeHGlobal(handlesPointer);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);if(sid!=IntPtr.Zero)Native.FreeSid(sid);
        }
    }
    static byte[] ReadNative(string file)
    {
        var security=new Native.SecurityAttributes{Length=Marshal.SizeOf<Native.SecurityAttributes>()};var handle=Native.CreateFile(file,Native.GENERIC_READ,1,ref security,Native.OPEN_EXISTING,0x00200000,IntPtr.Zero);if(handle==Native.Invalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateFileW READ");
        try{Native.Check(Native.GetFileInformationByHandle(handle,out var info),"GetFileInformationByHandle");if(Native.GetFileType(handle)!=1||info.Links!=1||(info.Attributes&(0x400|0x10))!=0||info.SizeHigh!=0||info.SizeLow>32768)throw new InvalidOperationException("文件不是有界单链接普通文件");var bytes=new byte[info.SizeLow];Native.Check(Native.ReadFile(handle,bytes,(uint)bytes.Length,out var count,IntPtr.Zero),"ReadFile");if(count!=bytes.Length)throw new InvalidOperationException("读取不完整");Native.Check(Native.GetFileInformationByHandle(handle,out var after),"GetFileInformationByHandle after");if(info.Volume!=after.Volume||info.IndexHigh!=after.IndexHigh||info.IndexLow!=after.IndexLow||info.Links!=after.Links||info.Attributes!=after.Attributes||info.SizeHigh!=after.SizeHigh||info.SizeLow!=after.SizeLow||info.CreationHigh!=after.CreationHigh||info.CreationLow!=after.CreationLow||info.WriteHigh!=after.WriteHigh||info.WriteLow!=after.WriteLow)throw new InvalidOperationException("文件身份/大小/写时间变化");return bytes;}finally{Native.CloseHandle(handle);}
    }
    static object WriteNative(string file,string text)
    {
        var bytes=new UTF8Encoding(false,true).GetBytes(text);if(bytes.Length>32768)throw new InvalidOperationException("正文超界");var security=new Native.SecurityAttributes{Length=Marshal.SizeOf<Native.SecurityAttributes>()};var handle=Native.CreateFile(file,Native.GENERIC_WRITE,0,ref security,Native.CREATE_NEW,0x80,IntPtr.Zero);if(handle==Native.Invalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateFileW WRITE");
        try{Native.Check(Native.WriteFile(handle,bytes,(uint)bytes.Length,out var written,IntPtr.Zero),"WriteFile");if(written!=bytes.Length)throw new InvalidOperationException("写入不完整");Native.Check(Native.FlushFileBuffers(handle),"FlushFileBuffers");}finally{Native.CloseHandle(handle);}var readback=ReadNative(file);if(Hash(readback)!=Hash(bytes))throw new InvalidOperationException("写后读回不符");return new{created=true,overwritten=false,sha256=Hash(readback),byteLength=readback.Length};
    }
    static object ProbeOpen(string file,uint access,uint creation)
    {
        // 直接调用Win32，没有项目路径或区域过滤，拒绝须由OS返回。
        var security=new Native.SecurityAttributes{Length=Marshal.SizeOf<Native.SecurityAttributes>()};var handle=Native.CreateFile(file,access,3,ref security,creation,0x80,IntPtr.Zero);var code=handle==Native.Invalid?Marshal.GetLastWin32Error():0;if(handle!=Native.Invalid)Native.CloseHandle(handle);return new{file,requestedAccess=access,creation,opened=code==0,win32Error=code};
    }
    static object Worker(Job job)
    {
        var token=Native.Token(Native.GetCurrentProcess());var element=JsonSerializer.SerializeToElement(token);if(!element.GetProperty("isAppContainer").GetBoolean()||element.GetProperty("appContainerSid").GetString()!=job.ExpectedSid||element.GetProperty("integritySid").GetString()!="S-1-16-4096"||element.GetProperty("capabilityCount").GetInt32()!=0)throw new InvalidOperationException("worker未处于预期AppContainer低完整性零能力，不执行文件操作");
        if(job.Operation=="read"){var bytes=ReadNative(job.Target);return new{token,pid=Environment.ProcessId,operation="read",text=new UTF8Encoding(false,true).GetString(bytes),sha256=Hash(bytes),byteLength=bytes.Length};}
        if(job.Operation=="write")return new{token,pid=Environment.ProcessId,operation="write",result=WriteNative(job.Target,job.Text??"")};
        if(job.Operation is "probe" or "child_probe"){
            var results=new Dictionary<string,object>{{"inputRead",ProbeOpen(job.Input!,Native.GENERIC_READ,Native.OPEN_EXISTING)},{"inputWrite",ProbeOpen(job.Input!,Native.GENERIC_WRITE,Native.OPEN_EXISTING)},{"outsideRead",ProbeOpen(job.Canary!,Native.GENERIC_READ,Native.OPEN_EXISTING)},{"outsideWrite",ProbeOpen(job.Canary!,Native.GENERIC_WRITE,Native.OPEN_EXISTING)},{"outsideNew",ProbeOpen(Path.Combine(Path.GetDirectoryName(job.Canary!)!,"forbidden-new.txt"),Native.GENERIC_WRITE,Native.CREATE_NEW)},{"workWrite",WriteNative(Path.Combine(job.Work!,Guid.NewGuid().ToString("N")+".txt"),"合成work")},{"outputsWrite",WriteNative(Path.Combine(job.Outputs!,Guid.NewGuid().ToString("N")+".txt"),"合成outputs")}};
            object? child=null;if(job.Operation=="probe"){
                var childJob=job with{Operation="child_probe"};var start=new ProcessStartInfo{FileName=job.ChildExecutable!,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};start.ArgumentList.Add(typeof(Program).Assembly.Location);start.ArgumentList.Add("--worker");start.ArgumentList.Add(Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(childJob,Json)));using var process=Process.Start(start)??throw new InvalidOperationException("子进程未启动");var output=process.StandardOutput.ReadToEnd();var error=process.StandardError.ReadToEnd();if(!process.WaitForExit(10000))throw new TimeoutException("probe子进程未结束");child=new{pid=process.Id,exitCode=process.ExitCode,result=string.IsNullOrWhiteSpace(output)?(JsonElement?)null:JsonSerializer.Deserialize<JsonElement>(output),stderr=error};
            }return new{token,pid=Environment.ProcessId,nativePathFiltersApplied=false,results,child};
        }
        throw new InvalidOperationException("不支持的固定文件操作");
    }
    static int Main(string[] args)
    {
        try{
            if(args.Length==1&&args[0]=="--preflight"){var name="collaboration.t10."+Guid.NewGuid().ToString("N");var status=Native.DeriveAppContainerSidFromAppContainerName(name,out var sid);string? text=null;try{if(sid!=IntPtr.Zero)text=new SecurityIdentifier(sid).Value;}finally{if(sid!=IntPtr.Zero)Native.FreeSid(sid);}Console.WriteLine(JsonSerializer.Serialize(new{status="preflight_only",os=Environment.OSVersion.ToString(),framework=RuntimeInformation.FrameworkDescription,deriveHresult=status,derivedSid=text,profileCreated=false,aclChanged=false}));return status==0?0:1;}
            object result;
            if(args.Length==2&&args[0]=="--worker")result=Worker(JsonSerializer.Deserialize<Job>(Convert.FromBase64String(args[1]),Json)??throw new InvalidOperationException("worker请求缺失"));
            else if(args.Length==2&&args[0]=="--worker-file"){if(new FileInfo(args[1]).Length>262144)throw new InvalidOperationException("文件请求帧超界");result=Worker(Read<Job>(args[1]));}
            else if(args.Length==2&&args[0]=="--prepare")result=Prepare(Read<Configuration>(args[1]));
            else if(args.Length==3&&args[0]=="--run"){var config=Read<Configuration>(args[1]);var prepared=Read<Prepared>(Path.Combine(Control(config),"prepared-state.json"));result=Launch(config,prepared,Read<Job>(args[2]));}
            else throw new InvalidOperationException("必须显式preflight/prepare/run，不执行任意命令");
            Console.WriteLine(JsonSerializer.Serialize(result,Json));return 0;
        }catch(Exception error){Console.WriteLine(JsonSerializer.Serialize(new{status="failed_or_blocked",error=error.Message,win32Error=error is Win32Exception native?native.NativeErrorCode:(int?)null,hresult=error.HResult,automaticRetry=false,osIsolationVerified=false}));return 1;}
    }
}
