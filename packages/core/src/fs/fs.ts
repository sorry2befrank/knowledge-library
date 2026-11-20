// Proposed portable Fs contract only. No native adapter, executor, or I/O exists here.
// Opaque handles must also be authenticated by each adapter at runtime (private registry).
declare const scopeBrand: unique symbol;
declare const handleBrand: unique symbol;
export type ScopeId = string & {
    readonly [scopeBrand]: true;
};
/** Structured relative path; never a host absolute path or authority by itself. */
export interface FsPath {
    readonly scope: ScopeId;
    readonly segments: readonly string[];
}
export interface FileIdentity {
    readonly volumeSerial: string;
    readonly fileId: string;
}
export interface ParentIdentity {
    /** Empty segments denotes the registered scope root. */
    readonly segments: readonly string[];
    readonly identity: FileIdentity;
}
/** Includes the registered root and every parent, in root-to-leaf order. */
export interface ParentGuard {
    readonly scope: ScopeId;
    readonly parents: readonly ParentIdentity[];
}
export interface FileGuard {
    readonly parents: ParentGuard;
    readonly identity: FileIdentity;
}
export type FsTime = bigint; // Exact counter/FILETIME units; never floating-point milliseconds.
export interface FileTimes {
    readonly created: FsTime | null;
    readonly modified: FsTime | null;
    readonly changed: FsTime | null; // Unknown is not unchanged; inventory must require a full read.
}
export type VolumeKind = "ntfs" | "refs" | "network" | "other" | "unknown";
export interface PathSnapshot {
    readonly path: FsPath;
    readonly kind: "file" | "directory" | "reparse";
    readonly identity: FileIdentity | null;
    readonly parents: readonly ParentIdentity[] | null;
    readonly volumeKind: VolumeKind;
    readonly supportedLocalVolume: boolean | null;
    readonly hardLinks: number | null;
    readonly bytes: number | null;
    readonly readOnly: boolean | null;
    readonly times: FileTimes;
    readonly anyReparseComponent: boolean | null;
}
export type Access = "read" | "read-delete" | "read-attributes" | "read-delete-attributes";
export interface FileHandle {
    readonly [handleBrand]: "existing";
}
export interface CreatedHandle {
    readonly [handleBrand]: "created";
}
export type Handle = FileHandle | CreatedHandle;
export interface HandleSnapshot {
    readonly identity: FileIdentity;
    readonly hardLinks: 1;
    readonly bytes: number;
    readonly readOnly: boolean;
    readonly times: FileTimes;
}
export type UnsupportedFeature = "volume" | "identity" | "parent-binding" | "exclusive-open" | "nonreplace-rename" | "delete-disposition" | "durable-flush" | "path-normalization" | "power-loss";
export type FsCode = "not-found" | "already-exists" | "not-file" | "path-invalid" | "identity-changed" | "parent-changed" | "volume-changed" | "reparse" | "hard-linked" | "in-use" | "read-only" | "invalid-handle" | "closed-handle" | "access-denied" | "cross-volume" | "limit" | "io-error" | "unsupported";
export type FsResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly code: FsCode;
    readonly effect: "none" | "unknown";
    readonly unsupported?: UnsupportedFeature;
};
export interface ReadChunk {
    /** Fresh independent bytes. Modifying them cannot modify the file. */
    readonly bytes: Uint8Array;
    readonly eof: boolean;
}
/**
 * Physical primitives for a future reviewed executor, not eligibility or movement authority.
 * No caller-supplied verified/authenticated flags, overwrite, path-unlink, or DeleteOnClose option.
 * A production adapter remains unavailable until native A22/A26 conformance is established.
 */
export interface Fs {
    readonly implementation: "memory-model" | "windows-native";
    inspect(path: FsPath): Promise<FsResult<PathSnapshot>>;
    /**
     * Bind exact volume/file/all-parent identities. Refuse unsafe links/reparse/unknown volumes.
     * No read, write, or delete sharing; the bound source and parent identities remain protected.
     * Even read-only external open handles cause the custody source to stay local as in-use.
     */
    openExclusive(path: FsPath, expected: FileGuard, access: Access): Promise<FsResult<FileHandle>>;
    /** Atomic create-new, never opens/truncates an existing entry, including a ghost or hard link. */
    createNew(path: FsPath, expectedParents: ParentGuard): Promise<FsResult<CreatedHandle>>;
    statHandle(handle: Handle): Promise<FsResult<HandleSnapshot>>;
    /** Bounded reads/hashes always refer to the held identity, never a newly resolved pathname. */
    read(handle: Handle, offset: number, maxBytes: number): Promise<FsResult<ReadChunk>>;
    hash(handle: Handle): Promise<FsResult<{
        readonly sha256: string;
        readonly bytes: number;
    }>>;
    /** Only the adapter-minted fresh create handle can receive bytes; bytes are copied, not aliased. */
    appendCreated(handle: CreatedHandle, bytes: Uint8Array): Promise<FsResult<void>>;
    flushCreated(handle: CreatedHandle): Promise<FsResult<void>>;
    setReadOnly(handle: Handle, value: boolean): Promise<FsResult<void>>;
    /** Same-volume atomic placement, refusing any existing target; caller verifies staging hash. */
    renameNoReplace(handle: Handle, destination: FsPath, expectedParents: ParentGuard): Promise<FsResult<FileIdentity>>;
    /**
     * Explicit disposition through a current read-delete handle, not a pathname or open-time flag.
     * Only future safeMove/purge/zero-byte-ghost orchestration may call this after its own gates.
     * Marking disposition is an effect: a later crash/close can finish deletion; never report rollback.
     */
    setDeleteDisposition(handle: FileHandle): Promise<FsResult<void>>;
    close(handle: Handle): Promise<FsResult<void>>;
}
