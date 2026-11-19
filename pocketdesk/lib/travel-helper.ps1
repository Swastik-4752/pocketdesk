# PocketDesk Windows helper (Travel mode, screen peek, clipboard, find-my-laptop sound). Started by lib/winhelper.js,
# lives only while it is needed.
# Reads one JSON request per line on stdin ({ id, op, args }) and answers one JSON line ({ id, ok, result | error }).
# Everything here works without admin rights, on the user's own processes and the user's own power plan.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PdTravel {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessAffinityMask(IntPtr h, out UIntPtr p, out UIntPtr s);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessAffinityMask(IntPtr h, UIntPtr m);
  [StructLayout(LayoutKind.Sequential)] struct Throttle { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int cls, ref Throttle info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetLogicalProcessorInformationEx(int rel, IntPtr buf, ref uint len);

  const uint SUSPEND_RESUME = 0x0800, SET_INFORMATION = 0x0200, QUERY_LIMITED = 0x1000;
  const int ProcessPowerThrottling = 4;

  // Opens the process only if it is still the SAME process (same creation time), so a reused PID is never touched.
  static IntPtr Open(int pid, long created, uint access, out string err) {
    err = null;
    IntPtr h = OpenProcess(access | QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) { err = "cannot open (error " + Marshal.GetLastWin32Error() + ")"; return h; }
    long c, e, k, u;
    if (created != 0 && (!GetProcessTimes(h, out c, out e, out k, out u) || c != created)) {
      CloseHandle(h); err = "gone (a different program has that number now)"; return IntPtr.Zero;
    }
    return h;
  }

  public static long Created(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return 0;
    long c, e, k, u;
    bool ok = GetProcessTimes(h, out c, out e, out k, out u);
    CloseHandle(h);
    return ok ? c : 0;
  }

  public static string Suspend(int pid, long created) {
    string err; IntPtr h = Open(pid, created, SUSPEND_RESUME, out err);
    if (h == IntPtr.Zero) return err;
    int r = NtSuspendProcess(h); CloseHandle(h);
    return r == 0 ? null : "NTSTATUS 0x" + r.ToString("X8");
  }

  public static string Resume(int pid, long created) {
    string err; IntPtr h = Open(pid, created, SUSPEND_RESUME, out err);
    if (h == IntPtr.Zero) return err;
    int r = NtResumeProcess(h); CloseHandle(h);
    return r == 0 ? null : "NTSTATUS 0x" + r.ToString("X8");
  }

  // Limits the process to the given cores and (optionally) turns on Windows "efficiency mode" (EcoQoS) for it.
  // Returns the old core mask in prev so it can be put back.
  public static string Pin(int pid, long created, ulong mask, bool eco, out ulong prev) {
    prev = 0;
    string err; IntPtr h = Open(pid, created, SET_INFORMATION, out err);
    if (h == IntPtr.Zero) return err;
    try {
      UIntPtr p, s;
      if (!GetProcessAffinityMask(h, out p, out s)) return "cannot read cores (error " + Marshal.GetLastWin32Error() + ")";
      prev = p.ToUInt64();
      if (mask != 0 && !SetProcessAffinityMask(h, new UIntPtr(mask & s.ToUInt64()))) return "cannot set cores (error " + Marshal.GetLastWin32Error() + ")";
      if (eco) {
        Throttle t = new Throttle { Version = 1, ControlMask = 1, StateMask = 1 };
        SetProcessInformation(h, ProcessPowerThrottling, ref t, (uint)Marshal.SizeOf(typeof(Throttle)));
      }
      return null;
    } finally { CloseHandle(h); }
  }

  // Puts the old core mask back and hands efficiency mode back to Windows.
  public static string Unpin(int pid, long created, ulong mask) {
    string err; IntPtr h = Open(pid, created, SET_INFORMATION, out err);
    if (h == IntPtr.Zero) return err;
    try {
      Throttle t = new Throttle { Version = 1, ControlMask = 0, StateMask = 0 };
      SetProcessInformation(h, ProcessPowerThrottling, ref t, (uint)Marshal.SizeOf(typeof(Throttle)));
      if (mask != 0 && !SetProcessAffinityMask(h, new UIntPtr(mask))) return "cannot set cores (error " + Marshal.GetLastWin32Error() + ")";
      return null;
    } finally { CloseHandle(h); }
  }

  // One entry per physical core: efficiency class (higher = faster core) and its logical-processor mask (group 0).
  public static List<ulong[]> Cores() {
    var list = new List<ulong[]>();
    uint len = 0;
    GetLogicalProcessorInformationEx(0, IntPtr.Zero, ref len);
    IntPtr buf = Marshal.AllocHGlobal((int)len);
    try {
      if (!GetLogicalProcessorInformationEx(0, buf, ref len)) return list;
      int off = 0;
      while (off < len) {
        IntPtr p = new IntPtr(buf.ToInt64() + off);
        int size = Marshal.ReadInt32(p, 4);
        byte eff = Marshal.ReadByte(p, 9);
        ushort groups = (ushort)Marshal.ReadInt16(p, 30);
        if (groups > 0 && Marshal.ReadInt16(p, 32 + 8) == 0) {
          ulong mask = (ulong)Marshal.ReadInt64(p, 32);
          list.Add(new ulong[] { eff, mask });
        }
        if (size <= 0) break;
        off += size;
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return list;
  }
}
'@

$PowerKeys = @{
  cpuMax = @('SUB_PROCESSOR', 'PROCTHROTTLEMAX'); cpuMax1 = @('SUB_PROCESSOR', 'PROCTHROTTLEMAX1')
  freqMax = @('SUB_PROCESSOR', 'PROCFREQMAX'); freqMax1 = @('SUB_PROCESSOR', 'PROCFREQMAX1')
  boost = @('SUB_PROCESSOR', 'PERFBOOSTMODE'); epp = @('SUB_PROCESSOR', 'PERFEPP'); epp1 = @('SUB_PROCESSOR', 'PERFEPP1')
  lid = @('SUB_BUTTONS', 'LIDACTION'); saver = @('SUB_ENERGYSAVER', 'ESBATTTHRESHOLD')
}

function Get-Scheme {
  $o = powercfg /getactivescheme | Out-String
  if ($o -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { return $matches[1] }
  throw 'cannot read the active power plan'
}

function Op-PowerGet {
  $scheme = Get-Scheme
  $values = @{}
  foreach ($k in $PowerKeys.Keys) {
    $o = powercfg /qh $scheme $PowerKeys[$k][0] $PowerKeys[$k][1] 2>&1 | Out-String
    if ($o -match 'Current AC Power Setting Index: (0x[0-9a-fA-F]+)') {
      $ac = [Convert]::ToInt64($matches[1], 16)
      $null = $o -match 'Current DC Power Setting Index: (0x[0-9a-fA-F]+)'
      $values[$k] = @{ ac = $ac; dc = [Convert]::ToInt64($matches[1], 16) }
    }
  }
  return @{ scheme = $scheme; values = $values }
}

function Op-PowerSet($a) {
  $scheme = if ($a.scheme) { $a.scheme } else { Get-Scheme }
  $done = @()
  foreach ($p in $a.values.PSObject.Properties) {
    $k = $PowerKeys[$p.Name]
    if (-not $k) { continue }
    if ($null -ne $p.Value.ac) { powercfg /setacvalueindex $scheme $k[0] $k[1] ([int64]$p.Value.ac) | Out-Null }
    if ($null -ne $p.Value.dc) { powercfg /setdcvalueindex $scheme $k[0] $k[1] ([int64]$p.Value.dc) | Out-Null }
    $done += $p.Name
  }
  powercfg /setactive $scheme | Out-Null
  return @{ scheme = $scheme; set = $done }
}

function Op-Procs {
  $me = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $parents = @{}
  foreach ($c in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId) { $parents[[int]$c.ProcessId] = [int]$c.ParentProcessId }
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($p in [Diagnostics.Process]::GetProcesses()) {
    try {
      if ($p.Id -le 4) { continue }
      $path = $null; $win = $false; $cpu = 0; $desc = $null
      if ($p.SessionId -eq $me) {
        try { $path = $p.MainModule.FileName } catch { }
        try { $win = $p.MainWindowHandle -ne [IntPtr]::Zero } catch { }
        try { $cpu = [math]::Round($p.TotalProcessorTime.TotalSeconds) } catch { }
        if ($path -and $path -notlike "$env:SystemRoot\*") { try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch { } }
      }
      $out.Add(@{ pid = $p.Id; ppid = $parents[$p.Id]; name = $p.ProcessName; path = $path; session = $p.SessionId; own = ($p.SessionId -eq $me)
        created = [string][PdTravel]::Created($p.Id); memMb = [math]::Round($p.WorkingSet64 / 1MB); cpuSec = $cpu; window = $win; desc = $desc })
    } catch { }
  }
  return @{ session = $me; windir = $env:SystemRoot; procs = $out }
}

function Each($items, [scriptblock]$fn) {
  $res = @()
  foreach ($i in @($items)) {
    $err = & $fn $i
    $res += @{ pid = [int]$i.pid; ok = ($null -eq $err); error = $err }
  }
  return , $res
}

function Get-BtRadio {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $script:Await = { param($op, $type) $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(10000); $t.Result }
  $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
  $radios = & $script:Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  return $radios | Where-Object { $_.Kind -eq 'Bluetooth' } | Select-Object -First 1
}

function Op-Bluetooth($a) {
  $bt = Get-BtRadio
  if (-not $bt) { return @{ present = $false } }
  $before = [string]$bt.State
  if ($a -and $a.state) {
    $null = & $script:Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    $r = & $script:Await ($bt.SetStateAsync([Windows.Devices.Radios.RadioState]$a.state)) ([Windows.Devices.Radios.RadioAccessStatus])
    return @{ present = $true; before = $before; result = [string]$r }
  }
  return @{ present = $true; state = $before }
}


# ---------- screen peek, clipboard, find-my-laptop (compiled on first use, so Travel mode starts fast) ----------
$script:DeskReady = $false
function Ensure-Desk {
  if ($script:DeskReady) { return }
  Add-Type -AssemblyName System.Drawing, System.Windows.Forms
  Add-Type -Language CSharp -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int p, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

public static class PdDesk {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static bool dpi;

  // The whole desktop (all screens) as a JPEG, scaled to at most maxW pixels wide. Base64.
  public static string Shot(int maxW, long quality) {
    if (!dpi) { SetProcessDPIAware(); dpi = true; }
    Rectangle b = System.Windows.Forms.SystemInformation.VirtualScreen;
    using (var full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(b.Left, b.Top, 0, 0, full.Size, CopyPixelOperation.SourceCopy);
      int w = Math.Min(maxW, b.Width), h = (int)Math.Round((double)b.Height * w / b.Width);
      using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, w, h); }
        var codec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (var ms = new MemoryStream()) { small.Save(ms, codec, ps); return Convert.ToBase64String(ms.ToArray()); }
      }
    }
  }

  // The clipboard picture (if any) as PNG, at most maxW wide. Base64, or null.
  public static string ClipImage(int maxW) {
    if (!System.Windows.Forms.Clipboard.ContainsImage()) return null;
    using (var img = System.Windows.Forms.Clipboard.GetImage()) {
      if (img == null) return null;
      int w = Math.Min(maxW, img.Width), h = (int)Math.Round((double)img.Height * w / img.Width);
      using (var small = new Bitmap(img, w, h)) using (var ms = new MemoryStream()) { small.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
    }
  }

  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorCom() as IMMDeviceEnumerator;
    IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume v; Guid id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out v));
    return v;
  }
  public static float[] GetVolume() { var v = Vol(); float l; bool m; v.GetMasterVolumeLevelScalar(out l); v.GetMute(out m); return new float[] { l, m ? 1 : 0 }; }
  public static void SetVolume(float level, bool mute) { var v = Vol(); v.SetMute(mute, Guid.Empty); v.SetMasterVolumeLevelScalar(level, Guid.Empty); }
}
'@
  $script:DeskReady = $true
}

function Op-Screenshot($a) {
  Ensure-Desk
  $w = 1280; if ($a -and $a.width) { $w = [Math]::Max(320, [Math]::Min(3840, [int]$a.width)) }
  $q = 60; if ($a -and $a.quality) { $q = [Math]::Max(20, [Math]::Min(90, [int]$a.quality)) }
  try { return @{ jpeg = [PdDesk]::Shot($w, [int64]$q) } }
  catch { throw 'Nothing to show: the laptop screen is off (lid closed, no monitor) or locked.' }
}

function Op-ClipGet {
  Ensure-Desk
  $img = $null
  try { $img = [PdDesk]::ClipImage(2000) } catch { }
  $text = $null
  try { $text = Get-Clipboard -Raw -Format Text } catch { }
  return @{ text = $text; png = $img }
}

function Op-ClipSet($a) {
  Ensure-Desk
  $t = [string]$a.text
  if ($t.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($t) }
  return @{ ok = $true; length = $t.Length }
}

$script:Player = $null
$script:VolBefore = $null
function Op-SoundStart($a) {
  Ensure-Desk
  if (-not $script:Player) {
    try { $script:VolBefore = [PdDesk]::GetVolume() } catch { $script:VolBefore = $null }
    $file = Join-Path $env:WINDIR 'Media\Alarm02.wav'
    if (-not (Test-Path $file)) { $file = Join-Path $env:WINDIR 'Media\Windows Notify System Generic.wav' }
    $script:Player = New-Object System.Media.SoundPlayer $file
    $script:Player.PlayLooping()
  }
  $loud = $true
  try { [PdDesk]::SetVolume(1.0, $false) } catch { $loud = $false }
  return @{ playing = $true; fullVolume = $loud }
}

function Op-SoundStop {
  $was = [bool]$script:Player
  if ($script:Player) { $script:Player.Stop(); $script:Player.Dispose(); $script:Player = $null }
  if ($script:VolBefore) { try { [PdDesk]::SetVolume($script:VolBefore[0], [bool]$script:VolBefore[1]) } catch { } ; $script:VolBefore = $null }
  return @{ stopped = $was }
}

function Handle($req) {
  $a = $req.args
  switch ($req.op) {
    'ping' { return @{ pong = $true; pid = $PID; sta = ([Threading.Thread]::CurrentThread.ApartmentState -eq 'STA') } }
    'cores' { return @{ logical = [Environment]::ProcessorCount; cores = @([PdTravel]::Cores() | ForEach-Object { @{ eff = [int]$_[0]; mask = [string]$_[1] } }) } }
    'procs' { return Op-Procs }
    'suspend' { return Each $a.items { param($i) [PdTravel]::Suspend([int]$i.pid, [int64]$i.created) } }
    'resume' { return Each $a.items { param($i) [PdTravel]::Resume([int]$i.pid, [int64]$i.created) } }
    'pin' {
      $res = @()
      foreach ($i in @($a.items)) {
        $prev = [uint64]0
        $err = [PdTravel]::Pin([int]$i.pid, [int64]$i.created, [uint64]$a.mask, [bool]$a.eco, [ref]$prev)
        $res += @{ pid = [int]$i.pid; ok = ($null -eq $err); error = $err; prev = [string]$prev }
      }
      return , $res
    }
    'unpin' { return Each $a.items { param($i) [PdTravel]::Unpin([int]$i.pid, [int64]$i.created, [uint64]$i.mask) } }
    'powerGet' { return Op-PowerGet }
    'powerSet' { return Op-PowerSet $a }
    'bluetooth' { return Op-Bluetooth $a }
    'bootTime' { return @{ at = [string]((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')) } }
    'screenshot' { return Op-Screenshot $a }
    'clipGet' { return Op-ClipGet }
    'clipSet' { return Op-ClipSet $a }
    'soundStart' { return Op-SoundStart $a }
    'soundStop' { return Op-SoundStop }
    'volumeGet' { Ensure-Desk; $v = [PdDesk]::GetVolume(); return @{ level = [double]$v[0]; muted = [bool]$v[1] } }
    default { throw "unknown op $($req.op)" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $res = Handle $req
    $json = ConvertTo-Json -InputObject @{ id = $id; ok = $true; result = $res } -Depth 8 -Compress
  } catch {
    $json = ConvertTo-Json -InputObject @{ id = $id; ok = $false; error = $_.Exception.Message } -Depth 4 -Compress
  }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
