using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class Native
{
    internal const uint GENERIC_READ=0x80000000,GENERIC_WRITE=0x40000000,OPEN_EXISTING=3,CREATE_NEW=1;
    internal static readonly IntPtr Invalid=new(-1);
    [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { public int Length;public IntPtr Descriptor;public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] internal struct SecurityCapabilities { public IntPtr Sid,Capabilities;public uint Count,Reserved; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct StartupInfo {public int Size;public string? Reserved,Desktop,Title;public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;public ushort Show,ReservedSize;public IntPtr ReservedData,Input,Output,Error;}
    [StructLayout(LayoutKind.Sequential)] internal struct StartupInfoEx {public StartupInfo Info;public IntPtr Attributes;}
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation {public IntPtr Process,Thread;public uint Pid,Tid;}
    [StructLayout(LayoutKind.Sequential)] internal struct FileInformation {public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
    [StructLayout(LayoutKind.Sequential)] internal struct BasicLimit {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorkingSet,MaxWorkingSet;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint Priority,Scheduling;}
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimit {public BasicLimit Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] internal static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] internal static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] internal static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
    [DllImport("advapi32.dll")] internal static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll")] internal static extern uint GetSecurityInfo(IntPtr handle,int kind,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll")] internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,uint revision,uint information,out IntPtr text,out uint length);
    [DllImport("advapi32.dll",SetLastError=true)] internal static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] internal static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,uint length,out uint required);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("advapi32.dll",SetLastError=true)] internal static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] internal static extern uint SetNamedSecurityInfo(string name,int kind,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
    [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern IntPtr CreateFile(string file,uint access,uint share,ref SecurityAttributes security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool ReadFile(IntPtr file,byte[] bytes,uint count,out uint read,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool WriteFile(IntPtr file,byte[] bytes,uint count,out uint written,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool FlushFileBuffers(IntPtr file);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetFileInformationByHandle(IntPtr file,out FileInformation info);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern uint GetFileType(IntPtr file);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupInfoEx startup,out ProcessInformation result);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern IntPtr CreateJobObject(IntPtr attributes,string? name);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    internal static void Check(bool ok,string operation){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),operation);}
    internal static object Token(IntPtr process)
    {
        Check(OpenProcessToken(process,8,out var token),"OpenProcessToken");
        try{return new {isAppContainer=TokenInt(token,29)!=0,appContainerSid=TokenSid(token,31),integritySid=TokenSid(token,25),capabilityCount=TokenInt(token,30)};}
        finally{CloseHandle(token);}
    }
    internal static int TokenInt(IntPtr token,int kind)
    {GetTokenInformation(token,kind,IntPtr.Zero,0,out var size);var buffer=Marshal.AllocHGlobal((int)size);try{Check(GetTokenInformation(token,kind,buffer,size,out _),"GetTokenInformation");return Marshal.ReadInt32(buffer);}finally{Marshal.FreeHGlobal(buffer);}}
    internal static string? TokenSid(IntPtr token,int kind)
    {GetTokenInformation(token,kind,IntPtr.Zero,0,out var size);var buffer=Marshal.AllocHGlobal((int)size);try{Check(GetTokenInformation(token,kind,buffer,size,out _),"GetTokenInformation");var sid=Marshal.ReadIntPtr(buffer);return sid==IntPtr.Zero?null:new SecurityIdentifier(sid).Value;}finally{Marshal.FreeHGlobal(buffer);}}
    internal static void LowIntegrity(string directory)
    {
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out var descriptor,out _),"ConvertStringSecurityDescriptor");
        try{Check(GetSecurityDescriptorSacl(descriptor,out var present,out var sacl,out _),"GetSecurityDescriptorSacl");if(!present)throw new InvalidOperationException("完整性标签缺失");var status=SetNamedSecurityInfo(directory,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl);if(status!=0)throw new Win32Exception((int)status,"SetNamedSecurityInfo LABEL");}
        finally{LocalFree(descriptor);}
    }
}
