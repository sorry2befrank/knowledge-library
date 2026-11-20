// kl-fs: the native helper behind the Windows Fs adapter (DESIGN §2.3, §6.8, §9.3).
// One JSON request per stdin line, one JSON reply per stdout line, correlated by "id". Diagnostics never go to stdout.
// Primitives only: exclusive open with no sharing, hashing through the handle, create-new, append, flush,
// read-only attribute, non-replacing rename, delete disposition through the verified handle (never delete-on-close),
// identity by volume serial and file ID, link count, reparse detection along the whole path, ChangeTime,
// the supported-volume check, and DPAPI (CurrentUser) protect/unprotect for the token store.
// Nothing here decides eligibility or movement; the TypeScript adapter and later orchestration do.
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;

namespace KlFs;

static class Win32
{
    public const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, DELETE = 0x00010000, FILE_WRITE_ATTRIBUTES = 0x0100, FILE_READ_ATTRIBUTES = 0x0080, SYNCHRONIZE = 0x00100000;
    public const uint FILE_LIST_DIRECTORY = 0x0001;
    public const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
    public const uint OPEN_EXISTING = 3, CREATE_NEW = 1;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000, FILE_ATTRIBUTE_NORMAL = 0x80;
    public const uint FILE_ATTRIBUTE_READONLY = 0x1, FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
    public const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
    public const int FileBasicInfo = 0, FileStandardInfo = 1, FileRenameInfo = 3, FileDispositionInfo = 4, FileAttributeTagInfo = 9, FileIdInfo = 18;
    public const uint DRIVE_REMOVABLE = 2, DRIVE_FIXED = 3, DRIVE_REMOTE = 4, DRIVE_CDROM = 5, DRIVE_RAMDISK = 6;
    public const uint CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder? volumeName, uint volumeNameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fsName, uint fsNameSize);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint toRead, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, uint toWrite, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long newPosition, uint method);
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CryptProtectData(ref DataBlob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("ntdll.dll")] public static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatusBlock status, IntPtr allocationSize, uint fileAttributes, uint share, uint disposition, uint options, IntPtr eaBuffer, uint eaLength);
    [DllImport("ntdll.dll")] public static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatusBlock status, IntPtr information, uint length, int informationClass);
    [DllImport("ntdll.dll")] public static extern uint RtlNtStatusToDosError(int status);
#if DEBUG
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputLength, IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
#endif

    [StructLayout(LayoutKind.Sequential)] public struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] public struct ObjectAttributes { public uint Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] public struct IoStatusBlock { public IntPtr Status; public UIntPtr Information; }

    [StructLayout(LayoutKind.Sequential)]
    public struct DataBlob { public uint Size; public IntPtr Data; }
}

sealed class HelperError : Exception
{
    public string Code { get; }
    public string Effect { get; }
    public HelperError(string code, string effect = "none") : base(code) { Code = code; Effect = effect; }
    public static HelperError FromWin32(int error, string fallback = "io-error") => error switch
    {
        2 or 3 => new HelperError("not-found"),
        5 => new HelperError("access-denied"),
        32 => new HelperError("in-use"),
        80 or 183 => new HelperError("already-exists"),
        17 => new HelperError("cross-volume"),
        _ => new HelperError(fallback),
    };
}

sealed record Identity(string VolumeSerial, string FileId);
sealed record Component(Identity? Identity, bool Reparse, bool Directory, bool Exists);
sealed record HandleInfo(Identity Identity, int Links, long Bytes, bool ReadOnly, bool Directory, bool Reparse, bool DeletePending, long Created, long Modified, long Changed, string VolumeKind, bool Supported, uint DriveType, string Fs);

sealed class Held : IDisposable
{
    public required SafeFileHandle Handle;
    public required bool Created;
    public required string FullPath;
    public required ParentLocks Parents;
    public void Dispose() { Handle.Dispose(); Parents.Dispose(); }
}

/** Ancestors are held without delete sharing from volume root through the file's parent.
 * Read-data access makes the share restriction effective (attributes alone do not).
 * Directory writes must be shared for the kernel's rename target open; all subsequent
 * child opens and effects are relative to retained handles, never a resolved full path. */
sealed class ParentLocks : IDisposable
{
    readonly List<SafeFileHandle> handles = new();
    public readonly List<Component> Components = new();
    public SafeFileHandle Parent => handles[^1];
    public static ParentLocks Acquire(string root, string[] segments, JsonArray? expected)
    {
        if (!Path.IsPathFullyQualified(root) || segments.Any(s => string.IsNullOrEmpty(s) || s is "." or ".." || s.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0)) throw new HelperError("path-invalid");
        if (expected is null || expected.Count != Math.Max(1, segments.Length)) throw new HelperError("parent-changed");
        var fullRoot = Path.GetFullPath(root);
        var anchor = Path.GetPathRoot(fullRoot) ?? throw new HelperError("path-invalid");
        var rootParts = fullRoot[anchor.Length..].Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
        var paths = new List<string> { anchor };
        foreach (var part in rootParts) paths.Add(Path.Combine(paths[^1], part));
        var scopeIndex = paths.Count - 1;
        foreach (var part in segments.Take(Math.Max(0, segments.Length - 1))) paths.Add(Path.Combine(paths[^1], part));
        if (paths.Count > 256) throw new HelperError("limit");
        var locks = new ParentLocks();
        try
        {
            for (var i = 0; i < paths.Count; i++)
            {
                var access = Win32.FILE_LIST_DIRECTORY | Win32.FILE_READ_ATTRIBUTES;
                var share = Win32.FILE_SHARE_READ | Win32.FILE_SHARE_WRITE;
                var h = i == 0
                    ? Native.Open(paths[i], access, share, Win32.OPEN_EXISTING, Win32.FILE_FLAG_BACKUP_SEMANTICS | Win32.FILE_FLAG_OPEN_REPARSE_POINT)
                    : Native.OpenRelative(locks.Parent, Path.GetFileName(paths[i]), access, share, false, true);
                locks.handles.Add(h);
                var info = Native.InfoOf(h);
                if (info.Reparse) throw new HelperError("reparse");
                if (!info.Directory) throw new HelperError("not-file");
                if (!info.Supported) throw new HelperError("unsupported");
                if (i < scopeIndex) continue;
                var at = i - scopeIndex;
                var guard = expected[at] as JsonObject ?? throw new HelperError("parent-changed");
                var names = guard["segments"] as JsonArray ?? throw new HelperError("parent-changed");
                if (names.Count != at || names.Where((n, j) => n is not JsonValue v || !v.TryGetValue<string>(out var name) || !StringComparer.OrdinalIgnoreCase.Equals(name, segments[j])).Any()) throw new HelperError("parent-changed");
                var identity = guard["identity"] as JsonObject ?? throw new HelperError("parent-changed");
                if (identity["volumeSerial"]?.GetValue<string>() != info.Identity.VolumeSerial) throw new HelperError("volume-changed");
                if (identity["fileId"]?.GetValue<string>() != info.Identity.FileId) throw new HelperError("parent-changed");
                locks.Components.Add(new Component(info.Identity, false, true, true));
            }
            return locks;
        }
        catch { locks.Dispose(); throw; }
    }
    public void Validate()
    {
        foreach (var h in handles)
        {
            var info = Native.InfoOf(h);
            if (info.Reparse) throw new HelperError("reparse");
            if (!info.Directory || !info.Supported) throw new HelperError("unsupported");
        }
    }
    public void Dispose() { for (var i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); handles.Clear(); }
}

static class Native
{
    static string Ext(string path) => path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path : (path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path[2..] : @"\\?\" + path);

    public static SafeFileHandle Open(string fullPath, uint access, uint share, uint disposition, uint flags)
    {
        var h = Win32.CreateFileW(Ext(fullPath), access, share, IntPtr.Zero, disposition, flags, IntPtr.Zero);
        if (h.IsInvalid) { var e = Marshal.GetLastWin32Error(); h.Dispose(); throw HelperError.FromWin32(e); }
        return h;
    }

    static HelperError NtError(int status, bool mayMutate = false)
    {
        if ((uint)status is 0xc000050b or 0xc0000275 or 0xc0000279) return new HelperError("reparse");
        var error = HelperError.FromWin32((int)Win32.RtlNtStatusToDosError(status));
        // Only mapped pre-effect refusals establish none. Unknown native I/O errors
        // cannot establish that create/rename left no artifact, even without a handle.
        return new HelperError(error.Code, mayMutate && error.Code == "io-error" ? "unknown" : "none");
    }

    /** A single leaf under an already verified directory. OBJ_DONT_REPARSE forbids following
     * a reparse during object-name parsing; OPEN_REPARSE_POINT also exposes a leaf's own tag. */
    public static SafeFileHandle OpenRelative(SafeFileHandle parent, string leaf, uint access, uint share, bool create, bool? directory = false)
    {
        if (string.IsNullOrEmpty(leaf) || leaf is "." or ".." || leaf.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0 || leaf.Length > 32766) throw new HelperError("path-invalid");
        var name = Marshal.StringToHGlobalUni(leaf);
        var text = new Win32.UnicodeString { Length = checked((ushort)(leaf.Length * 2)), MaximumLength = checked((ushort)(leaf.Length * 2 + 2)), Buffer = name };
        var textPtr = Marshal.AllocHGlobal(Marshal.SizeOf<Win32.UnicodeString>());
        var added = false;
        try
        {
            Marshal.StructureToPtr(text, textPtr, false);
            parent.DangerousAddRef(ref added);
            var attributes = new Win32.ObjectAttributes { Length = (uint)Marshal.SizeOf<Win32.ObjectAttributes>(), RootDirectory = parent.DangerousGetHandle(), ObjectName = textPtr, Attributes = 0x40 | 0x1000 }; // CASE_INSENSITIVE | DONT_REPARSE
            const uint synchronous = 0x20, openReparse = 0x00200000, directoryFile = 1, nonDirectoryFile = 0x40;
            var result = Win32.NtCreateFile(out var h, access | Win32.SYNCHRONIZE, ref attributes, out _, IntPtr.Zero, Win32.FILE_ATTRIBUTE_NORMAL, share, create ? 2u : 1u, synchronous | openReparse | (directory == true ? directoryFile : directory == false ? nonDirectoryFile : 0u), IntPtr.Zero, 0);
            // Synchronous handles must not return STATUS_PENDING. Stop the process rather
            // than release buffers that an unexpected outstanding request might still use.
            // The client observes channel loss and reports unknown effects.
            if (result == 0x103) Environment.Exit(3);
            if (result > 0) { h?.Dispose(); throw new HelperError("io-error", "unknown"); }
            if (result < 0)
            {
                var hadHandle = h is not null && !h.IsInvalid;
                h?.Dispose();
                var error = NtError(result, create);
                throw new HelperError(error.Code, create && hadHandle ? "unknown" : error.Effect);
            }
            if (h.IsInvalid) { h.Dispose(); throw new HelperError("io-error", create ? "unknown" : "none"); }
            return h;
        }
        finally { if (added) parent.DangerousRelease(); Marshal.FreeHGlobal(textPtr); Marshal.FreeHGlobal(name); }
    }


    /** A successful metadata-only open proves an existing single leaf without following it.
     * An inaccessible, missing, redirected or uncertain probe proves nothing. */
    public static bool ProvesExistingLeaf(ParentLocks parents, string leaf)
    {
        try
        {
            parents.Validate();
            using var existing = OpenRelative(parents.Parent, leaf, Win32.FILE_READ_ATTRIBUTES,
                Win32.FILE_SHARE_READ | Win32.FILE_SHARE_WRITE | Win32.FILE_SHARE_DELETE, false, null);
            parents.Validate();
            return true;
        }
        catch (HelperError) { return false; }
    }

#if DEBUG
    /** Test attacker: convert an existing empty synthetic directory in place, with no delete access. */
    public static void SetJunctionForTest(string directory, string target)
    {
        var full = Path.GetFullPath(target);
        var substitute = Encoding.Unicode.GetBytes(@"\??\" + full);
        var print = Encoding.Unicode.GetBytes(full);
        var dataLength = checked((ushort)(8 + substitute.Length + 2 + print.Length + 2));
        var buffer = Marshal.AllocHGlobal(dataLength + 8);
        try
        {
            for (var i = 0; i < dataLength + 8; i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteInt32(buffer, 0, unchecked((int)0xa0000003));
            Marshal.WriteInt16(buffer, 4, (short)dataLength);
            Marshal.WriteInt16(buffer, 10, checked((short)substitute.Length));
            Marshal.WriteInt16(buffer, 12, checked((short)(substitute.Length + 2)));
            Marshal.WriteInt16(buffer, 14, checked((short)print.Length));
            Marshal.Copy(substitute, 0, buffer + 16, substitute.Length);
            Marshal.Copy(print, 0, buffer + 16 + substitute.Length + 2, print.Length);
            using var h = Open(directory, Win32.FILE_WRITE_ATTRIBUTES, Win32.FILE_SHARE_READ | Win32.FILE_SHARE_WRITE | Win32.FILE_SHARE_DELETE, Win32.OPEN_EXISTING, Win32.FILE_FLAG_BACKUP_SEMANTICS | Win32.FILE_FLAG_OPEN_REPARSE_POINT);
            if (!Win32.DeviceIoControl(h, 0x000900a4, buffer, (uint)(dataLength + 8), IntPtr.Zero, 0, out _, IntPtr.Zero)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
#endif

    static T Query<T>(SafeFileHandle h, int cls, int size, Func<IntPtr, T> read)
    {
        var buf = Marshal.AllocHGlobal(size);
        try
        {
            if (!Win32.GetFileInformationByHandleEx(h, cls, buf, (uint)size)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
            return read(buf);
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    public static Identity IdentityOf(SafeFileHandle h) => Query(h, Win32.FileIdInfo, 24, buf =>
    {
        var serial = (ulong)Marshal.ReadInt64(buf, 0);
        var id = new byte[16]; Marshal.Copy(buf + 8, id, 0, 16);
        return new Identity(serial.ToString("x16"), Convert.ToHexString(id).ToLowerInvariant());
    });

    public static HandleInfo InfoOf(SafeFileHandle h)
    {
        var identity = IdentityOf(h);
        var (links, bytes, deletePending, directory) = Query(h, Win32.FileStandardInfo, 24, buf => (Marshal.ReadInt32(buf, 16), Marshal.ReadInt64(buf, 8), Marshal.ReadByte(buf, 20) != 0, Marshal.ReadByte(buf, 21) != 0));
        var (created, modified, changed, attrs) = Query(h, Win32.FileBasicInfo, 40, buf => (Marshal.ReadInt64(buf, 0), Marshal.ReadInt64(buf, 16), Marshal.ReadInt64(buf, 24), (uint)Marshal.ReadInt32(buf, 32)));
        var tagAttrs = Query(h, Win32.FileAttributeTagInfo, 8, buf => (uint)Marshal.ReadInt32(buf, 0));
        var fsName = new StringBuilder(64);
        if (!Win32.GetVolumeInformationByHandleW(h, null, 0, out _, out _, out _, fsName, 64)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        var fs = fsName.ToString();
        var final = new StringBuilder(32768);
        var n = Win32.GetFinalPathNameByHandleW(h, final, 32768, 0);
        if (n == 0 || n > 32768) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        var finalPath = final.ToString();
        uint driveType;
        if (finalPath.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) driveType = Win32.DRIVE_REMOTE;
        else
        {
            var bare = finalPath.StartsWith(@"\\?\", StringComparison.Ordinal) ? finalPath[4..] : finalPath;
            driveType = bare.Length >= 2 && bare[1] == ':' ? Win32.GetDriveTypeW(bare[..2] + @"\") : 0;
        }
        var kind = driveType == Win32.DRIVE_REMOTE ? "network" : fs.Equals("NTFS", StringComparison.OrdinalIgnoreCase) ? "ntfs" : fs.Equals("ReFS", StringComparison.OrdinalIgnoreCase) ? "refs" : fs.Length == 0 ? "unknown" : "other";
        var supported = (kind == "ntfs" || kind == "refs") && driveType == Win32.DRIVE_FIXED;
        var reparse = (tagAttrs & Win32.FILE_ATTRIBUTE_REPARSE_POINT) != 0;
        return new HandleInfo(identity, links, bytes, (attrs & Win32.FILE_ATTRIBUTE_READONLY) != 0, directory, reparse, deletePending, created, modified, changed, kind, supported, driveType, fs);
    }

    /** The scope root and every parent directory, root first: identity (by a directory handle) and whether the component is a reparse point. */
    public static List<Component> Components(string root, string[] segments)
    {
        var list = new List<Component>();
        for (var i = 0; i < Math.Max(1, segments.Length); i++)
        {
            var path = Path.Combine(new[] { root }.Concat(segments.Take(i)).ToArray());
            list.Add(ComponentOf(path));
        }
        return list;
    }

    public static Component ComponentOf(string path)
    {
        var attrs = Win32.GetFileAttributesW(Ext(path));
        if (attrs == Win32.INVALID_FILE_ATTRIBUTES) return new Component(null, false, false, false);
        var reparse = (attrs & Win32.FILE_ATTRIBUTE_REPARSE_POINT) != 0;
        var directory = (attrs & Win32.FILE_ATTRIBUTE_DIRECTORY) != 0;
        try
        {
            using var h = Open(path, Win32.FILE_READ_ATTRIBUTES, Win32.FILE_SHARE_READ | Win32.FILE_SHARE_WRITE | Win32.FILE_SHARE_DELETE, Win32.OPEN_EXISTING, Win32.FILE_FLAG_BACKUP_SEMANTICS | Win32.FILE_FLAG_OPEN_REPARSE_POINT);
            return new Component(IdentityOf(h), reparse, directory, true);
        }
        catch (HelperError) { return new Component(null, reparse, directory, true); }
    }

    public static byte[] ReadAt(SafeFileHandle h, long offset, int max)
    {
        if (!Win32.SetFilePointerEx(h, offset, out _, 0)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        var buf = new byte[max];
        if (!Win32.ReadFile(h, buf, (uint)max, out var read, IntPtr.Zero)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        if (read == max) return buf;
        var exact = new byte[read]; Array.Copy(buf, exact, read); return exact;
    }

    public static (string Sha256, long Bytes) Hash(SafeFileHandle h)
    {
        if (!Win32.SetFilePointerEx(h, 0, out _, 0)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buf = new byte[1 << 16]; long total = 0;
        while (true)
        {
            if (!Win32.ReadFile(h, buf, (uint)buf.Length, out var read, IntPtr.Zero)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
            if (read == 0) break;
            sha.AppendData(buf, 0, (int)read); total += read;
        }
        return (Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant(), total);
    }

    public static void Append(SafeFileHandle h, byte[] data)
    {
        if (!Win32.SetFilePointerEx(h, 0, out _, 2)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        var offset = 0;
        while (offset < data.Length)
        {
            var chunk = data.Skip(offset).ToArray();
            if (!Win32.WriteFile(h, chunk, (uint)chunk.Length, out var written, IntPtr.Zero)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
            if (written == 0) throw new HelperError("io-error", "unknown");
            offset += (int)written;
        }
    }

    public static void SetReadOnly(SafeFileHandle h, bool value)
    {
        var buf = Marshal.AllocHGlobal(40);
        try
        {
            if (!Win32.GetFileInformationByHandleEx(h, Win32.FileBasicInfo, buf, 40)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
            var attrs = (uint)Marshal.ReadInt32(buf, 32);
            attrs = value ? attrs | Win32.FILE_ATTRIBUTE_READONLY : attrs & ~Win32.FILE_ATTRIBUTE_READONLY;
            if (attrs == 0) attrs = Win32.FILE_ATTRIBUTE_NORMAL;
            // leave every time at 0 so the kernel keeps them; only the attributes change
            for (var i = 0; i < 32; i += 8) Marshal.WriteInt64(buf, i, 0);
            Marshal.WriteInt32(buf, 32, (int)attrs);
            if (!Win32.SetFileInformationByHandle(h, Win32.FileBasicInfo, buf, 40)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    /** Test seeding only: set LastWriteTime exactly (FILETIME ticks), or ChangeTime cannot be compared across a same-size edit. */
    public static void SetModified(SafeFileHandle h, long modified)
    {
        var buf = Marshal.AllocHGlobal(40);
        try
        {
            for (var i = 0; i < 40; i += 8) Marshal.WriteInt64(buf, i, 0);
            Marshal.WriteInt64(buf, 16, modified);
            if (!Win32.SetFileInformationByHandle(h, Win32.FileBasicInfo, buf, 40)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    public static void RenameNoReplace(SafeFileHandle h, SafeFileHandle parent, string leaf)
    {
        var nameBytes = Encoding.Unicode.GetBytes(leaf);
        var rootOffset = IntPtr.Size == 8 ? 8 : 4;
        var lengthOffset = rootOffset + IntPtr.Size;
        var nameOffset = lengthOffset + 4;
        var size = nameOffset + nameBytes.Length + 2;
        var buf = Marshal.AllocHGlobal(size);
        var added = false;
        try
        {
            parent.DangerousAddRef(ref added);
            for (var i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
            Marshal.WriteByte(buf, 0, 0);                 // ReplaceIfExists = FALSE
            Marshal.WriteIntPtr(buf, rootOffset, parent.DangerousGetHandle());
            Marshal.WriteInt32(buf, lengthOffset, nameBytes.Length);
            Marshal.Copy(nameBytes, 0, buf + nameOffset, nameBytes.Length);
            // The Win32 wrapper rejects the non-null root on supported hosts; use the native
            // relative rename primitive, with the checked directory retained through completion.
            var result = Win32.NtSetInformationFile(h, out _, buf, (uint)size, 10); // FileRenameInformation
            if (result == 0x103) Environment.Exit(3);
            if (result > 0) throw new HelperError("io-error", "unknown");
            if (result < 0) throw NtError(result, true);
        }
        finally { if (added) parent.DangerousRelease(); Marshal.FreeHGlobal(buf); }
    }

    public static void SetDeleteDisposition(SafeFileHandle h)
    {
        var buf = Marshal.AllocHGlobal(4);
        try
        {
            Marshal.WriteInt32(buf, 0, 1); // DeleteFile = TRUE; FileDispositionInfo, never FILE_FLAG_DELETE_ON_CLOSE
            if (!Win32.SetFileInformationByHandle(h, Win32.FileDispositionInfo, buf, 4)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    public static byte[] Dpapi(byte[] input, bool protect)
    {
        var inPtr = Marshal.AllocHGlobal(input.Length == 0 ? 1 : input.Length);
        try
        {
            Marshal.Copy(input, 0, inPtr, input.Length);
            var blob = new Win32.DataBlob { Size = (uint)input.Length, Data = inPtr };
            var ok = protect ? Win32.CryptProtectData(ref blob, "kl token", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, Win32.CRYPTPROTECT_UI_FORBIDDEN, out var output)
                             : Win32.CryptUnprotectData(ref blob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, Win32.CRYPTPROTECT_UI_FORBIDDEN, out output);
            if (!ok) throw new HelperError(protect ? "dpapi-protect-failed" : "dpapi-unprotect-failed");
            try { var result = new byte[output.Size]; Marshal.Copy(output.Data, result, 0, (int)output.Size); return result; }
            finally { Win32.LocalFree(output.Data); }
        }
        finally { Marshal.FreeHGlobal(inPtr); }
    }
}

static class Program
{
    static readonly Dictionary<int, Held> Handles = new();
    static int NextHandle = 1;
    static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    static string Str(JsonNode? n, string key) => n?[key]?.GetValue<string>() ?? throw new HelperError("invalid-request");
    static string[] Segments(JsonNode? n, string key) => n?[key]?.AsArray().Select(x => x!.GetValue<string>()).ToArray() ?? throw new HelperError("invalid-request");
    static string Full(string root, string[] segments) => Path.Combine(new[] { root }.Concat(segments).ToArray());

    static uint AccessMask(string access) => access switch
    {
        "read" => Win32.GENERIC_READ,
        "read-delete" => Win32.GENERIC_READ | Win32.DELETE,
        "read-attributes" => Win32.GENERIC_READ | Win32.FILE_WRITE_ATTRIBUTES,
        "read-delete-attributes" => Win32.GENERIC_READ | Win32.DELETE | Win32.FILE_WRITE_ATTRIBUTES,
        _ => throw new HelperError("access-denied"),
    };

    static JsonNode InfoNode(HandleInfo i) => JsonSerializer.SerializeToNode(new
    {
        identity = new { volumeSerial = i.Identity.VolumeSerial, fileId = i.Identity.FileId },
        links = i.Links, bytes = i.Bytes, readOnly = i.ReadOnly, directory = i.Directory, reparse = i.Reparse, deletePending = i.DeletePending,
        times = new { created = i.Created.ToString(), modified = i.Modified.ToString(), changed = i.Changed.ToString() },
        volume = new { kind = i.VolumeKind, supported = i.Supported, driveType = i.DriveType, fs = i.Fs },
    }, JsonOpts)!;
    static JsonNode ComponentsNode(IEnumerable<Component> cs) => JsonSerializer.SerializeToNode(cs.Select(c => new { identity = c.Identity is null ? null : new { volumeSerial = c.Identity.VolumeSerial, fileId = c.Identity.FileId }, reparse = c.Reparse, directory = c.Directory, exists = c.Exists }), JsonOpts)!;

    static Held Get(JsonNode? req)
    {
        var id = req?["h"]?.GetValue<int>() ?? throw new HelperError("invalid-handle");
        return Handles.TryGetValue(id, out var h) ? h : throw new HelperError("invalid-handle");
    }

    static void CheckFile(HandleInfo info, JsonNode? expected = null)
    {
        if (!info.Supported) throw new HelperError("unsupported");
        if (info.Directory) throw new HelperError("not-file");
        if (info.Reparse) throw new HelperError("reparse");
        if (info.Links != 1) throw new HelperError("hard-linked");
        if (expected is null) return;
        if (expected["volumeSerial"]?.GetValue<string>() != info.Identity.VolumeSerial) throw new HelperError("volume-changed");
        if (expected["fileId"]?.GetValue<string>() != info.Identity.FileId) throw new HelperError("identity-changed");
    }

    static JsonArray ParentExpectations(string root, string[] segments) => new(Native.Components(root, segments).Select((c, i) => JsonSerializer.SerializeToNode(new
    {
        segments = segments.Take(i), identity = c.Identity is null ? null : new { volumeSerial = c.Identity.VolumeSerial, fileId = c.Identity.FileId },
    }, JsonOpts)).ToArray());

    static void PauseParentsForTest(JsonNode req)
    {
#if DEBUG
        if (req["testPauseParents"]?.GetValue<bool>() == true)
        {
            Console.Out.WriteLine("{\"testPause\":\"parents-held\"}"); Console.Out.Flush();
            if (Console.In.ReadLine() != "resume") throw new HelperError("io-error");
        }
#endif
    }

    static JsonNode? Handle(JsonNode req)
    {
        var op = Str(req, "op");
        switch (op)
        {
            case "ping": return JsonValue.Create("pong");
            case "inspect":
            {
                var root = Str(req, "root"); var segs = Segments(req, "segments"); var full = Full(root, segs);
                var components = Native.Components(root, segs);
                var attrs = Win32.GetFileAttributesW(full.StartsWith(@"\\?\") ? full : @"\\?\" + full);
                if (attrs == Win32.INVALID_FILE_ATTRIBUTES) return JsonSerializer.SerializeToNode(new { exists = false, components = ComponentsNode(components) }, JsonOpts);
                var reparse = (attrs & Win32.FILE_ATTRIBUTE_REPARSE_POINT) != 0;
                var directory = (attrs & Win32.FILE_ATTRIBUTE_DIRECTORY) != 0;
                HandleInfo? info = null;
                try
                {
                    using var h = Native.Open(full, Win32.FILE_READ_ATTRIBUTES, Win32.FILE_SHARE_READ | Win32.FILE_SHARE_WRITE | Win32.FILE_SHARE_DELETE, Win32.OPEN_EXISTING, Win32.FILE_FLAG_BACKUP_SEMANTICS | Win32.FILE_FLAG_OPEN_REPARSE_POINT);
                    info = Native.InfoOf(h);
                }
                catch (HelperError) { }
                return JsonSerializer.SerializeToNode(new { exists = true, reparse, directory, info = info is null ? null : InfoNode(info), components = ComponentsNode(components) }, JsonOpts);
            }
            case "openBound":
            {
                var root = Str(req, "root"); var segs = Segments(req, "segments"); var full = Full(root, segs);
                var parents = ParentLocks.Acquire(root, segs, req["parents"] as JsonArray);
                SafeFileHandle? h = null; int? id = null;
                try
                {
                    PauseParentsForTest(req);
                    var expected = req["identity"] as JsonObject ?? throw new HelperError("identity-changed");
                    h = Native.OpenRelative(parents.Parent, segs.LastOrDefault() ?? throw new HelperError("not-file"), AccessMask(Str(req, "access")), 0, false);
                    var info = Native.InfoOf(h); CheckFile(info, expected); parents.Validate();
                    id = NextHandle++;
                    Handles[id.Value] = new Held { Handle = h, Created = false, FullPath = full, Parents = parents };
                    return JsonSerializer.SerializeToNode(new { h = id.Value, info = InfoNode(info), components = ComponentsNode(parents.Components) }, JsonOpts);
                }
                catch { if (id is not null) Handles.Remove(id.Value); h?.Dispose(); parents.Dispose(); throw; }
            }
            case "createNewBound":
            {
                var root = Str(req, "root"); var segs = Segments(req, "segments"); var full = Full(root, segs);
                if (segs.Length == 0) throw new HelperError("path-invalid");
                var parents = ParentLocks.Acquire(root, segs, req["parents"] as JsonArray);
                SafeFileHandle? h = null; int? id = null; var handedOff = false;
                try
                {
                    PauseParentsForTest(req);
                    try
                    {
#if DEBUG
                        // Synthetic refusal-routing control only: no ACL or create effect is issued.
                        if (req["testCreateAccessDenied"]?.GetValue<bool>() == true) throw new HelperError("access-denied");
#endif
                        h = Native.OpenRelative(parents.Parent, segs[^1], Win32.GENERIC_READ | Win32.GENERIC_WRITE | Win32.DELETE | Win32.FILE_WRITE_ATTRIBUTES, 0, true);
                    }
                    catch (HelperError e) when (e.Code == "access-denied" && e.Effect == "none")
                    {
                        // Some existing directories/junctions fail FILE_NON_DIRECTORY_FILE before
                        // collision classification. Only a separate bound open establishes existence.
                        if (Native.ProvesExistingLeaf(parents, segs[^1])) throw new HelperError("already-exists");
                        throw;
                    }
                    var info = Native.InfoOf(h); CheckFile(info); parents.Validate();
                    id = NextHandle++;
                    Handles[id.Value] = new Held { Handle = h, Created = true, FullPath = full, Parents = parents };
                    var result = JsonSerializer.SerializeToNode(new { h = id.Value, info = InfoNode(info), components = ComponentsNode(parents.Components) }, JsonOpts);
                    handedOff = true;
                    return result;
                }
                catch (HelperError e) { throw new HelperError(e.Code, h is null ? e.Effect : "unknown"); }
                finally
                {
                    // A successful handoff owns both handle sets. Every failed handoff releases them, but never unlinks a created artifact.
                    if (!handedOff) { if (id is not null) Handles.Remove(id.Value); h?.Dispose(); parents.Dispose(); }
                }
            }
            case "stat": return InfoNode(Native.InfoOf(Get(req).Handle));
            case "components": return ComponentsNode(Native.Components(Str(req, "root"), Segments(req, "segments")));
            case "read":
            {
                var held = Get(req);
                var offset = req["offset"]!.GetValue<long>(); var max = req["max"]!.GetValue<int>();
                var bytes = Native.ReadAt(held.Handle, offset, max);
                var info = Native.InfoOf(held.Handle);
                return JsonSerializer.SerializeToNode(new { data = Convert.ToBase64String(bytes), eof = offset + max >= info.Bytes }, JsonOpts);
            }
            case "hash": { var (sha, bytes) = Native.Hash(Get(req).Handle); return JsonSerializer.SerializeToNode(new { sha256 = sha, bytes }, JsonOpts); }
            case "append":
            {
                var held = Get(req); if (!held.Created) throw new HelperError("access-denied"); CheckFile(Native.InfoOf(held.Handle));
                var data = Convert.FromBase64String(Str(req, "data"));
                try { Native.Append(held.Handle, data); return JsonValue.Create(true); }
                catch (HelperError e) { throw new HelperError(e.Code, "unknown"); }
            }
            case "flush": { var held = Get(req); CheckFile(Native.InfoOf(held.Handle)); if (!Win32.FlushFileBuffers(held.Handle)) throw new HelperError(HelperError.FromWin32(Marshal.GetLastWin32Error()).Code, "unknown"); return JsonValue.Create(true); }
            case "readOnly":
            {
                var held = Get(req); CheckFile(Native.InfoOf(held.Handle)); var value = req["value"]!.GetValue<bool>();
                try { Native.SetReadOnly(held.Handle, value); return JsonValue.Create(true); }
                catch (HelperError e) { throw new HelperError(e.Code, "unknown"); }
            }
            case "setModified": { Native.SetModified(Get(req).Handle, long.Parse(Str(req, "modified"))); return JsonValue.Create(true); }
            case "renameBound":
            {
                var held = Get(req); CheckFile(Native.InfoOf(held.Handle));
                var root = Str(req, "root"); var segs = Segments(req, "segments");
                if (segs.Length == 0) throw new HelperError("path-invalid");
                var parents = ParentLocks.Acquire(root, segs, req["parents"] as JsonArray);
                var renamed = false;
                try
                {
                    PauseParentsForTest(req);
                    if (parents.Components[0].Identity!.VolumeSerial != Native.IdentityOf(held.Handle).VolumeSerial) throw new HelperError("cross-volume");
                    Native.RenameNoReplace(held.Handle, parents.Parent, segs[^1]);
                    renamed = true;
                    var old = held.Parents; held.Parents = parents; old.Dispose();
                    held.FullPath = Full(root, segs);
                    parents.Validate();
                    return InfoNode(Native.InfoOf(held.Handle));
                }
                catch (HelperError e) { throw new HelperError(e.Code, renamed ? "unknown" : e.Effect); }
                finally { if (!renamed) parents.Dispose(); }
            }
            case "dispose":
            {
                var held = Get(req); if (held.Created) throw new HelperError("access-denied");
                var info = Native.InfoOf(held.Handle);
                if (info.ReadOnly) throw new HelperError("read-only");
                if (info.Links != 1) throw new HelperError("hard-linked");
                Native.SetDeleteDisposition(held.Handle);
                return JsonValue.Create(true);
            }
            case "close":
            {
                var id = req["h"]?.GetValue<int>() ?? throw new HelperError("invalid-handle");
                if (!Handles.Remove(id, out var held)) throw new HelperError("invalid-handle");
                held.Dispose();
                return JsonValue.Create(true);
            }
            case "dpapi-protect": return JsonValue.Create(Convert.ToBase64String(Native.Dpapi(Convert.FromBase64String(Str(req, "data")), true)));
            case "dpapi-unprotect": return JsonValue.Create(Convert.ToBase64String(Native.Dpapi(Convert.FromBase64String(Str(req, "data")), false)));
#if DEBUG
            case "test-set-junction": Native.SetJunctionForTest(Str(req, "path"), Str(req, "target")); return JsonValue.Create(true);
#endif
            case "sequence":
                try { return Sequence(req); }
                catch (HelperError e) { throw new HelperError(e.Code, "unknown"); }
            case "hold-delete-on-close":
            {
                // Control program for the kill test: a holder whose handle has DeleteOnClose. Killed, it loses the file. kl-fs itself never uses this option.
                var stream = new FileStream(Str(req, "path"), FileMode.Open, FileAccess.Read, FileShare.None, 4096, FileOptions.DeleteOnClose);
                Console.Out.WriteLine(JsonSerializer.Serialize(new { id = req["id"], ok = true, value = new { holding = true } }, JsonOpts)); Console.Out.Flush();
                Thread.Sleep(Timeout.Infinite); GC.KeepAlive(stream);
                return null;
            }
            default: throw new HelperError("unknown-op");
        }
    }

    /** Test-only §6.8 steps 1–5 from the primitives above, with a pause point after each step that only a Debug build honours. */
    static JsonNode Sequence(JsonNode req)
    {
        var root = Str(req, "root"); var src = Segments(req, "src"); var held = Segments(req, "held"); var expectedSha = Str(req, "sha");
        var pauseAfter = req["pauseAfter"]?.GetValue<int>() ?? 0;
        void Report(int step) { Console.Out.WriteLine(JsonSerializer.Serialize(new { step, done = true }, JsonOpts)); Console.Out.Flush(); }
        void Pause(int step)
        {
#if DEBUG
            if (pauseAfter == step) { Console.Out.WriteLine(JsonSerializer.Serialize(new { paused = step }, JsonOpts)); Console.Out.Flush(); Thread.Sleep(Timeout.Infinite); }
#endif
        }
        // 1. exclusive open of the source with read and DELETE, no sharing, no delete-on-close
        using var sourceParents = ParentLocks.Acquire(root, src, ParentExpectations(root, src));
        using var source = Native.OpenRelative(sourceParents.Parent, src[^1], Win32.GENERIC_READ | Win32.DELETE, 0, false);
        var info = Native.InfoOf(source);
        if (info.Reparse || info.Links != 1 || !info.Supported) throw new HelperError(info.Reparse ? "reparse" : info.Links != 1 ? "hard-linked" : "unsupported");
        if (Native.Components(root, src).Any(c => c.Reparse)) throw new HelperError("reparse");
        Report(1); Pause(1);
        // 2. identity and hash through that handle
        var (sha, _) = Native.Hash(source);
        if (sha != expectedSha) throw new HelperError("identity-changed");
        Report(2); Pause(2);
        // 3. create-new held copy, written from the step-1 handle, flushed
        using var copyParents = ParentLocks.Acquire(root, held, ParentExpectations(root, held));
        using var copy = Native.OpenRelative(copyParents.Parent, held[^1], Win32.GENERIC_READ | Win32.GENERIC_WRITE | Win32.DELETE | Win32.FILE_WRITE_ATTRIBUTES, 0, true);
        var buf = new byte[1 << 16]; long pos = 0;
        while (true) { var chunk = Native.ReadAt(source, pos, buf.Length); if (chunk.Length == 0) break; Native.Append(copy, chunk); pos += chunk.Length; }
        if (!Win32.FlushFileBuffers(copy)) throw HelperError.FromWin32(Marshal.GetLastWin32Error());
        Report(3); Pause(3);
        // 4. re-hash the held copy through its handle and set it read-only
        var (copySha, _) = Native.Hash(copy);
        if (copySha != expectedSha) throw new HelperError("identity-changed");
        Native.SetReadOnly(copy, true);
        copy.Dispose();
        Report(4); Pause(4);
        // 5. only now: delete disposition through the verified source handle, then close
        var again = Native.InfoOf(source);
        if (again.Links != 1 || again.Identity != info.Identity) throw new HelperError("identity-changed");
        Native.SetDeleteDisposition(source);
        source.Dispose();
        Report(5);
        return JsonValue.Create(true);
    }

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--version") { Console.Out.WriteLine("kl-fs 0.1.0-s2e"); return 0; }
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("kl-fs: Windows only"); return 2; }
        var stdin = Console.In; var stdout = Console.Out;
        string? line;
        try
        {
        while ((line = stdin.ReadLine()) is not null)
        {
            if (line.Trim().Length == 0) continue;
            JsonNode? req = null; JsonNode? id = null;
            try
            {
                req = JsonNode.Parse(line) ?? throw new HelperError("invalid-request");
                id = req["id"]?.DeepClone();
                var value = Handle(req);
                if (value is null) continue; // a blocking control command answered for itself
                stdout.WriteLine(new JsonObject { ["id"] = id, ["ok"] = true, ["value"] = value }.ToJsonString());
            }
            catch (HelperError e) { stdout.WriteLine(new JsonObject { ["id"] = id?.DeepClone(), ["ok"] = false, ["code"] = e.Code, ["effect"] = e.Effect }.ToJsonString()); }
            catch (Exception e) { Console.Error.WriteLine("kl-fs: " + e.GetType().Name + ": " + e.Message); stdout.WriteLine(new JsonObject { ["id"] = id?.DeepClone(), ["ok"] = false, ["code"] = "io-error", ["effect"] = "unknown" }.ToJsonString()); }
            stdout.Flush();
        }
        }
        finally { foreach (var h in Handles.Values) h.Dispose(); Handles.Clear(); }
        return 0;
    }
}
