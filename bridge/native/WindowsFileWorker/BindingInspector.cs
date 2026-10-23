using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using System.Text.Json;

internal sealed record DirectoryObservation(string path,uint volume,string fileId,string created,uint attributes,string sddl);
internal sealed record RuntimeFileObservation(string path,uint volume,string fileId,string created,string modified,long byteLength,string sha256);
internal sealed record BindingInspection(string schema,string sid,string profileFolder,DirectoryObservation[] directories,RuntimeFileObservation[] files);

// 只读复核：不创建profile、不修权限。持有目录句柄，复核同一对象的身份和安全描述符。
internal sealed class BindingInspector : IDisposable
{
    readonly List<(string Path,IntPtr Handle)> handles=new();
    readonly List<(string Path,IntPtr Handle)> fileHandles=new();
    readonly Prepared prepared;
    internal BindingInspection Observation {get;}
    internal BindingInspector(Configuration config,Prepared original)
    {
        prepared=original;
        try{
            if(original.TaskRoot!=Path.GetFullPath(config.TaskRoot)||original.ProfileName!=config.ProfileName||original.RuntimeDirectory!=Path.Combine(config.TaskRoot,".os-worker","runtime"))throw new InvalidOperationException("只读复核任务绑定不符");
            var status=Native.DeriveAppContainerSidFromAppContainerName(original.ProfileName,out var sid);
            try{if(status!=0)Marshal.ThrowExceptionForHR(status);if(sid==IntPtr.Zero||new SecurityIdentifier(sid).Value!=original.Sid)throw new InvalidOperationException("原profile SID不符");}finally{if(sid!=IntPtr.Zero)Native.FreeSid(sid);}
            var paths=new[]{config.TaskRoot,Path.Combine(config.TaskRoot,"inputs"),Path.Combine(config.TaskRoot,"work"),Path.Combine(config.TaskRoot,"outputs"),Path.Combine(config.TaskRoot,".os-worker"),original.RuntimeDirectory,Path.Combine(config.TaskRoot,".os-worker","frames"),Path.Combine(config.TaskRoot,"inputs","files"),Path.Combine(config.TaskRoot,"work","files"),Path.Combine(config.TaskRoot,"outputs","files"),original.ProfileFolder};
            foreach(var value in paths){
                var full=Path.GetFullPath(value);RejectLinks(full);
                var security=new Native.SecurityAttributes{Length=Marshal.SizeOf<Native.SecurityAttributes>()};
                var handle=Native.CreateFile(full,0x20000|0x80,1,ref security,Native.OPEN_EXISTING,0x02000000|0x00200000,IntPtr.Zero);
                if(handle==Native.Invalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"只读打开目录身份");
                handles.Add((full,handle));
            }
            foreach(var name in new[]{"WindowsFileWorker.dll","WindowsFileWorker.deps.json","WindowsFileWorker.runtimeconfig.json"}){
                var full=Path.Combine(original.RuntimeDirectory,name);RejectLinks(full);var security=new Native.SecurityAttributes{Length=Marshal.SizeOf<Native.SecurityAttributes>()};
                var handle=Native.CreateFile(full,Native.GENERIC_READ,1,ref security,Native.OPEN_EXISTING,0x00200000,IntPtr.Zero);
                if(handle==Native.Invalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"只读锁定实际runtime文件");fileHandles.Add((full,handle));
            }
            Observation=Capture();VerifyUnchanged();
        }catch{Dispose();throw;}
    }
    static void RejectLinks(string full)
    {
        for(var current=full;;current=Path.GetDirectoryName(current)??current){
            if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("只读复核拒绝目录联接");
            if(Path.GetPathRoot(current)==current)break;
        }
    }
    static DirectoryObservation Read(string path,IntPtr handle)
    {
        Native.Check(Native.GetFileInformationByHandle(handle,out var before),"inspect FileInformation");
        if((before.Attributes&0x10)==0||(before.Attributes&0x400)!=0||Native.GetFileType(handle)!=1)throw new InvalidOperationException("复核对象不是原普通目录");
        var result=Native.GetSecurityInfo(handle,1,0x17,out _,out _,out var dacl,out _,out var descriptor);
        if(result!=0)throw new Win32Exception((int)result,"inspect owner/DACL/label");
        string text;
        try{
            if(dacl==IntPtr.Zero)throw new InvalidOperationException("拒绝无DACL目录");
            Native.Check(Native.ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,0x17,out var sddl,out _),"inspect SDDL");
            try{text=Marshal.PtrToStringUni(sddl)??throw new InvalidOperationException("SDDL缺失");}finally{Native.LocalFree(sddl);}
            var binary=new byte[Native.GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,binary,0,binary.Length);var raw=new RawSecurityDescriptor(binary,0);
            if(raw.Owner==null||raw.DiscretionaryAcl==null||raw.DiscretionaryAcl.Count==0)throw new InvalidOperationException("目录owner或DACL缺失");
            if(path.EndsWith(Path.Combine("work","files"),StringComparison.OrdinalIgnoreCase)||path.EndsWith(Path.Combine("outputs","files"),StringComparison.OrdinalIgnoreCase)){
                if(raw.SystemAcl==null||!raw.SystemAcl.Cast<GenericAce>().Any(LowLabel))throw new InvalidOperationException("可写范围缺原低完整性标签");
            }
        }finally{Native.LocalFree(descriptor);}
        Native.Check(Native.GetFileInformationByHandle(handle,out var after),"inspect FileInformation after");
        if(before.Volume!=after.Volume||before.IndexHigh!=after.IndexHigh||before.IndexLow!=after.IndexLow||before.CreationHigh!=after.CreationHigh||before.CreationLow!=after.CreationLow||before.Attributes!=after.Attributes)throw new InvalidOperationException("复核中目录身份变化");
        return new(path,before.Volume,$"{before.IndexHigh:x8}{before.IndexLow:x8}",$"{before.CreationHigh:x8}{before.CreationLow:x8}",before.Attributes,text);
    }
    static bool LowLabel(GenericAce ace){if((byte)ace.AceType!=17||ace.BinaryLength<20)return false;var bytes=new byte[ace.BinaryLength];ace.GetBinaryForm(bytes,0);return (BitConverter.ToInt32(bytes,4)&1)!=0&&new SecurityIdentifier(bytes,8).Value=="S-1-16-4096";}
    static RuntimeFileObservation ReadRuntime(string path,IntPtr handle)
    {
        Native.Check(Native.GetFileInformationByHandle(handle,out var before),"inspect runtime identity");
        if(before.Links!=1||(before.Attributes&(0x10|0x400))!=0||Native.GetFileType(handle)!=1||before.SizeHigh!=0||before.SizeLow>16*1024*1024)throw new InvalidOperationException("runtime须为有界单链接普通文件");
        string digest;using(var stream=new FileStream(new SafeFileHandle(handle,false),FileAccess.Read)){stream.Position=0;digest=Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();}
        Native.Check(Native.GetFileInformationByHandle(handle,out var after),"inspect runtime identity after");
        if(before.Volume!=after.Volume||before.IndexHigh!=after.IndexHigh||before.IndexLow!=after.IndexLow||before.Links!=after.Links||before.Attributes!=after.Attributes||before.CreationHigh!=after.CreationHigh||before.CreationLow!=after.CreationLow||before.SizeHigh!=after.SizeHigh||before.SizeLow!=after.SizeLow||before.WriteHigh!=after.WriteHigh||before.WriteLow!=after.WriteLow)throw new InvalidOperationException("runtime读取时身份或字节变化");
        return new(path,before.Volume,$"{before.IndexHigh:x8}{before.IndexLow:x8}",$"{before.CreationHigh:x8}{before.CreationLow:x8}",$"{before.WriteHigh:x8}{before.WriteLow:x8}",before.SizeLow,digest);
    }
    BindingInspection Capture()=>new("windows_task_file_inspection_v1",prepared.Sid,Path.GetFullPath(prepared.ProfileFolder),handles.Select(item=>Read(item.Path,item.Handle)).ToArray(),fileHandles.Select(item=>ReadRuntime(item.Path,item.Handle)).ToArray());
    internal void VerifyExpected(JsonElement expected)
    {
        var value=expected.Deserialize<BindingInspection>()??throw new InvalidOperationException("外部复核基线缺失");
        if(JsonSerializer.Serialize(value)!=JsonSerializer.Serialize(Observation))throw new InvalidOperationException("当前目录/ACL/标签与外部受审基线不符");
        VerifyUnchanged();
    }
    internal void VerifyUnchanged()
    {
        foreach(var item in handles)RejectLinks(item.Path);
        foreach(var item in fileHandles)RejectLinks(item.Path);
        if(JsonSerializer.Serialize(Capture())!=JsonSerializer.Serialize(Observation))throw new InvalidOperationException("原生执行前目录或安全描述符发生变化");
    }
    public void Dispose(){foreach(var item in handles)Native.CloseHandle(item.Handle);handles.Clear();foreach(var item in fileHandles)Native.CloseHandle(item.Handle);fileHandles.Clear();}
}
