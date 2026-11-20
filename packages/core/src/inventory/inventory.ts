// The reference inventory (DESIGN §6.3): generations, the five coverage sets, and extraction. Pure over an
// InventorySource: no host I/O, no policy authority, no eligibility decision. It enumerates files itself and never
// consults an ignore file, so nothing can hide a file or a reference from it. Incomplete coverage always protects:
// a read error or a skipped file makes the generation incomplete and every candidate coverage-incomplete.
import { basename, dirname, extname, joinPath, normalizePath, stem, type EntryIdentity, type EntryTimes, type InventorySource, type SourceReadError } from "./source.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { sha256Hex } from "../primitives/sha256.ts";

export type CoverageSet = "vault" | "fleet" | "dependency" | "instruction" | "obsidian";
export type ReferenceKind = "link" | "path" | "ambiguous" | "canvas" | "base" | "name" | "ripple" | "dependency" | "instruction" | "obsidian" | "unresolved";
export type ObsidianDetail = "open-leaf" | "last-open" | "bookmark";
export type ExclusionReason = "git" | "node_modules" | "vendor" | "build" | "cache" | "log" | "dot-directory" | "reparse" | "archived-md" | "session-transcript" | "fleet-ignore-dir";
export type GenerationFlag = "fleet-exclusions-unpinned" | "change-time-unknown";

export interface InventoryRoot {
  id: string;
  /** Virtual root path as the source names it. */
  path: string;
  /** Host spellings that absolute path mentions may use for this root (drive letter with either slash, /d/ form, file:/// form). */
  hostPaths?: string[];
  sets: ("vault" | "fleet")[];
}
export interface InstructionRoot { id: string; path: string }
export interface FleetPolicy { textExt: string[]; ignoreDirs: string[]; maxBytes: number }
export interface InventoryPolicy {
  codeTypes: string[];
  commonStems: string[];
  /** Orrery's detector values, from the reference pack: a REQUIRED input with no default. null records fleet-exclusions-unpinned. */
  fleet: FleetPolicy | null;
  /** The focus target folder (virtual path), for path mentions resolved relative to it. */
  targetFolder?: string;
  /** Files above this are listed, not read (DESIGN §6.3: 64 MiB). */
  maxFileBytes?: number;
}
export interface InventoryConfig {
  roots: InventoryRoot[];
  /** Instruction-only roots outside the two main roots (the user profile's .claude and .codex), read-only, paths only. */
  instructionRoots?: InstructionRoot[];
  /** Windows scheduled-task action command lines: an injected input, never read from the machine. */
  scheduledTaskCommandLines?: string[];
  policy: InventoryPolicy;
  mode: "full" | "incremental";
  now: string;
  /** The previous generation, for an incremental read and for the time of the last full read. */
  previous?: { generation: GenerationRecord; files: InventoryFile[]; references: InventoryReference[] };
}

export interface GenerationRoot { id: string; path: string; sets: string[]; complete: boolean; readErrors: number }
export interface DeclaredExclusion { root: string; path: string; reason: ExclusionReason }
export interface ReadErrorRecord { root: string; path: string; code: SourceReadError | "invalid-structured-state" }
export interface OversizeRecord { root: string; path: string; size: number }
/** Every field DESIGN §6.3 lists under "Generations and completeness". */
export interface GenerationRecord {
  id: string;
  mode: "full" | "incremental";
  startedAt: string;
  finishedAt: string;
  lastFullReadAt: string | null;
  /** Persisted cache context. Missing on pre-key generations; those generations cannot establish reuse. */
  extractionConfigKey?: string;
  roots: GenerationRoot[];
  declaredExclusions: DeclaredExclusion[];
  filesRead: number;
  bytesRead: number;
  readErrors: ReadErrorRecord[];
  oversizeListed: OversizeRecord[];
  flags: GenerationFlag[];
  complete: boolean;
  incompleteRoots: string[];
}
export interface InventoryFile {
  path: string; root: string; sets: CoverageSet[]; identity: EntryIdentity | null; size: number | null; times: EntryTimes;
  /** HISTORICAL by Orrery's rot rule (ripple-rot.ts); the detector itself does not skip these, so the flag is recorded, not applied. */
  historical: boolean;
  read: "read" | "error" | "oversize" | "not-read";
}
export interface InventoryReference {
  id: string;
  /** A file path, or task:<n> for an injected scheduled-task command line. */
  source: string;
  target: string | null;
  kind: ReferenceKind;
  /** Every possible target of an ambiguous reference. */
  candidates?: string[];
  detail?: ObsidianDetail;
  token: string;
}
export interface Candidate { path: string; coverage: "complete" | "coverage-incomplete" }
export interface InventoryResult { generation: GenerationRecord; files: InventoryFile[]; references: InventoryReference[]; candidates: Candidate[] }

const VAULT_EXT = new Set([".md", ".markdown", ".txt"]);
const INSTRUCTION_EXT = new Set([".md", ".json", ".yaml", ".yml", ".toml"]);
const INSTRUCTION_DIRS = new Set([".claude", ".codex", ".remember", ".github"]);
const EXCLUDED_DIRS: Record<string, ExclusionReason> = { ".git": "git", node_modules: "node_modules", vendor: "vendor", build: "build", cache: "cache", log: "log", logs: "log" };
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const UNPINNED_FLEET_MAX_BYTES = 512 * 1024;
const HISTORICAL_SEGMENTS = new Set(["_understudy", "turnover", ".remember", "rejected", "accepted"]);
const HISTORICAL_SUFFIXES = ["understudy.md", "sweep-log.md", "passdown.md"];

const nfcLower = (s: string) => s.normalize("NFC").toLowerCase();
export function isHistorical(path: string): boolean {
  const lower = nfcLower(path).replace(/\\/g, "/");
  if (lower.split("/").some((seg) => HISTORICAL_SEGMENTS.has(seg))) return true;
  return HISTORICAL_SUFFIXES.some((s) => lower.endsWith(s));
}
/** Orrery's ripple token (armillary-loop.mjs tokenFor): the last two path components joined by '/', or the basename when that is shorter than 5 characters. */
export function rippleToken(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const two = parts.slice(-2).join("/");
  return two.length >= 5 ? two : parts[parts.length - 1] ?? "";
}

interface Index { byPath: Map<string, string>; byBasename: Map<string, string[]>; byStem: Map<string, string[]> }

export async function runInventory(source: InventorySource, config: InventoryConfig): Promise<InventoryResult> {
  const startedAt = config.now;
  // Include every extraction input, preserving array order because root resolution order is significant.
  // Time/mode/previous are execution state, not extraction settings. The version pins parser semantics.
  const extractionConfigKey = sha256Hex(canonicalJson({
    format: "kl-inventory-extraction/v1", roots: config.roots, instructionRoots: config.instructionRoots ?? [],
    policy: config.policy, scheduledTaskCommandLines: config.scheduledTaskCommandLines ?? [],
  }));
  const maxFileBytes = config.policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const codeTypes = new Set(config.policy.codeTypes.map((e) => e.toLowerCase()));
  const commonStems = new Set(config.policy.commonStems.map(nfcLower));
  const flags: GenerationFlag[] = [];
  if (!config.policy.fleet) flags.push("fleet-exclusions-unpinned");
  const fleetExt = config.policy.fleet ? new Set(config.policy.fleet.textExt.map((e) => e.toLowerCase())) : null;
  const fleetIgnore = new Set((config.policy.fleet?.ignoreDirs ?? []).map(nfcLower));
  const fleetMax = config.policy.fleet?.maxBytes ?? UNPINNED_FLEET_MAX_BYTES;

  const files: InventoryFile[] = [];
  const declaredExclusions: DeclaredExclusion[] = [];
  const readErrors: ReadErrorRecord[] = [];
  const oversizeListed: OversizeRecord[] = [];
  const rootRecords: GenerationRoot[] = [];
  let filesRead = 0, bytesRead = 0;
  const texts = new Map<string, string>();

  // ---- walk every root; the inventory finds files only through list()
  type RootSpec = { id: string; path: string; sets: ("vault" | "fleet")[]; instructionOnly: boolean };
  const specs: RootSpec[] = [...config.roots.map((r) => ({ id: r.id, path: r.path, sets: r.sets, instructionOnly: false })), ...(config.instructionRoots ?? []).map((r) => ({ id: r.id, path: r.path, sets: [] as ("vault" | "fleet")[], instructionOnly: true }))];
  for (const root of specs) {
    const errorsBefore = readErrors.length, oversizeBefore = oversizeListed.length;
    let listFailed = false;
    const walk = async (dir: string, underInstruction: boolean, underDot: boolean, fleetIgnored: boolean): Promise<void> => {
      const listed = await source.list(dir);
      if (!listed.ok) { readErrors.push({ root: root.id, path: dir, code: listed.code }); listFailed = true; return; }
      for (const e of listed.entries) {
        const path = joinPath(dir, e.name);
        const lowerName = nfcLower(e.name);
        if (e.kind === "reparse") { declaredExclusions.push({ root: root.id, path, reason: "reparse" }); continue; }
        if (e.kind === "directory") {
          const excluded = EXCLUDED_DIRS[lowerName];
          if (excluded) { declaredExclusions.push({ root: root.id, path, reason: excluded }); continue; }
          if (lowerName === "sessions" && underInstruction && nfcLower(basename(dir)) === ".codex") { declaredExclusions.push({ root: root.id, path, reason: "session-transcript" }); continue; }
          const isInstructionDir = INSTRUCTION_DIRS.has(lowerName);
          const isObsidian = lowerName === ".obsidian" && root.sets.includes("vault");
          if (lowerName.startsWith(".") && !isInstructionDir && !isObsidian && !root.instructionOnly) { declaredExclusions.push({ root: root.id, path, reason: "dot-directory" }); continue; }
          await walk(path, underInstruction || isInstructionDir || root.instructionOnly, underDot || lowerName.startsWith("."), fleetIgnored || fleetIgnore.has(lowerName));
          continue;
        }
        if (e.readError) { readErrors.push({ root: root.id, path, code: e.readError }); files.push({ path, root: root.id, sets: [], identity: e.identity, size: e.size, times: e.times, historical: isHistorical(path), read: "error" }); continue; }
        const ext = extname(path);
        const sets: CoverageSet[] = [];
        if (lowerName === "archived.md") { declaredExclusions.push({ root: root.id, path, reason: "archived-md" }); continue; }
        if (ext === ".jsonl") { declaredExclusions.push({ root: root.id, path, reason: "session-transcript" }); continue; }
        const inObsidianDir = nfcLower(basename(dir)) === ".obsidian" && root.sets.includes("vault");
        if (root.sets.includes("vault") && !underDot && VAULT_EXT.has(ext)) sets.push("vault");
        if (root.sets.includes("vault") && ((inObsidianDir && (lowerName === "workspace.json" || lowerName === "bookmarks.json")) || ((ext === ".canvas" || ext === ".base") && !underDot))) sets.push("obsidian");
        if (root.sets.includes("fleet") && !underDot) {
          const extOk = fleetExt ? fleetExt.has(ext) : true;
          if (extOk && fleetIgnored) declaredExclusions.push({ root: root.id, path, reason: "fleet-ignore-dir" });
          else if (extOk && (e.size ?? 0) <= fleetMax) sets.push("fleet");
        }
        if (!root.instructionOnly && !underDot && codeTypes.has(ext)) sets.push("dependency");
        if ((underInstruction || root.instructionOnly) && (INSTRUCTION_EXT.has(ext) || (root.instructionOnly && codeTypes.has(ext)))) sets.push("instruction");
        if (sets.length === 0) continue;
        const file: InventoryFile = { path, root: root.id, sets, identity: e.identity, size: e.size, times: e.times, historical: isHistorical(path), read: "not-read" };
        files.push(file);
      }
    };
    await walk(root.path, false, false, false);
    rootRecords.push({ id: root.id, path: root.path, sets: root.instructionOnly ? ["instruction"] : root.sets, complete: !listFailed && readErrors.length === errorsBefore && oversizeListed.length === oversizeBefore, readErrors: readErrors.length - errorsBefore });
  }

  // ---- read: resolved references depend on the whole vault path universe, not just their source file.
  // A new/deleted/renamed target can resolve a missing link, create ambiguity, or add a name/ripple match.
  // We do not persist raw source text, so conservatively reread all sources when that universe changes.
  const targetPaths = (entries: InventoryFile[]) => entries.filter((f) => f.sets.includes("vault")).map((f) => f.path).sort();
  const sameTargets = config.previous?.generation.complete === true
    && config.previous.generation.extractionConfigKey === extractionConfigKey
    && JSON.stringify(targetPaths(files)) === JSON.stringify(targetPaths(config.previous.files));
  const prevFiles = new Map((config.previous?.files ?? []).map((f) => [f.path, f]));
  const reuse = new Set<string>();
  for (const f of files) {
    if (f.read === "error") continue;
    const prev = config.mode === "incremental" ? prevFiles.get(f.path) : undefined;
    const unchanged = sameTargets && prev && prev.read === "read"
      && prev.root === f.root && JSON.stringify(prev.sets) === JSON.stringify(f.sets)
      && prev.identity && f.identity && f.identity.fileId !== "" && f.identity.volumeSerial !== ""
      && prev.identity.fileId === f.identity.fileId && prev.identity.volumeSerial === f.identity.volumeSerial
      && f.size !== null && prev.size === f.size
      && f.times.modified !== null && prev.times.modified === f.times.modified
      && f.times.changed !== null && prev.times.changed === f.times.changed
      && f.times.created !== null && prev.times.created === f.times.created;
    if (f.times.changed === null && config.mode === "incremental" && !flags.includes("change-time-unknown")) flags.push("change-time-unknown");
    if (unchanged) { reuse.add(f.path); f.read = "read"; continue; }
    const limit = f.sets.length === 1 && f.sets[0] === "fleet" ? fleetMax : maxFileBytes;
    const r = await source.readShared(f.path, limit);
    if (r.ok) { f.read = "read"; filesRead++; bytesRead += r.size; texts.set(f.path, new TextDecoder("utf-8", { fatal: false }).decode(r.bytes)); }
    else if (r.code === "oversize") { f.read = "oversize"; oversizeListed.push({ root: f.root, path: f.path, size: r.size ?? -1 }); }
    else { f.read = "error"; readErrors.push({ root: f.root, path: f.path, code: r.code }); }
  }
  // ---- extraction
  const index = buildIndex(files);
  const vaultRoots = config.roots.filter((r) => r.sets.includes("vault"));
  const references: InventoryReference[] = [];
  const emit = (ref: Omit<InventoryReference, "id">) => { references.push({ id: "", ...ref }); };
  const resolveVaultPath = (p: string, fromDir: string): string | undefined => resolvePathToken(p, fromDir, config, vaultRoots, index);
  const vaultFiles = files.filter((f) => f.sets.includes("vault") && f.read !== "error");
  for (const f of files) {
    if (reuse.has(f.path)) { for (const r of config.previous!.references.filter((x) => x.source === f.path)) emit({ source: r.source, target: r.target, kind: r.kind, candidates: r.candidates, detail: r.detail, token: r.token }); continue; }
    const text = texts.get(f.path);
    if (text === undefined) continue;
    const fromDir = dirname(f.path);
    if (f.sets.includes("obsidian")) {
      if (!extractObsidian(f, text, index, vaultRoots, config, emit)) {
        f.read = "error";
        readErrors.push({ root: f.root, path: f.path, code: "invalid-structured-state" });
      }
      continue;
    }
    if (f.sets.includes("vault")) extractLinks(f.path, text, fromDir, index, resolveVaultPath, emit);
    if (f.sets.includes("vault") || f.sets.includes("dependency") || f.sets.includes("instruction")) extractPathMentions(f.path, text, fromDir, index, resolveVaultPath, f.sets, emit);
    if (f.sets.includes("vault")) extractNameMentions(f.path, text, index, commonStems, "name", emit);
    if (f.sets.includes("dependency")) extractNameMentions(f.path, text, index, commonStems, "dependency", emit);
    if (f.sets.includes("instruction")) extractNameMentions(f.path, text, index, commonStems, "instruction", emit);
    if (f.sets.includes("fleet")) extractRipple(f.path, text, vaultFiles, emit);
  }
  (config.scheduledTaskCommandLines ?? []).forEach((line, i) => { const src = `task:${i}`; extractPathMentions(src, line, "", index, (p) => resolveVaultPath(p, ""), ["instruction"], emit); extractNameMentions(src, line, index, commonStems, "instruction", emit); });
  // deterministic ids and order; duplicates collapse
  const seen = new Set<string>();
  const unique = references.filter((r) => { const k = `${r.source}|${r.kind}|${r.target}|${r.detail ?? ""}|${(r.candidates ?? []).join(",")}|${r.token}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.target ?? "") < (b.target ?? "") ? -1 : (a.target ?? "") > (b.target ?? "") ? 1 : a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  unique.forEach((r, i) => { r.id = `r${String(i + 1).padStart(6, "0")}`; });

  // Parsing required structured state is part of coverage, even when the underlying read succeeded.
  for (const rr of rootRecords) { const bad = files.some((f) => f.root === rr.id && (f.read === "error" || f.read === "oversize")) || readErrors.some((e) => e.root === rr.id); rr.readErrors = readErrors.filter((e) => e.root === rr.id).length; rr.complete = !bad; }
  const incompleteRoots = rootRecords.filter((r) => !r.complete).map((r) => r.id);
  const complete = incompleteRoots.length === 0;
  const generation: GenerationRecord = {
    id: `gen-${startedAt.replace(/[^0-9]/g, "")}-${config.mode}`, mode: config.mode, startedAt, finishedAt: config.now,
    lastFullReadAt: config.mode === "full" ? config.now : (config.previous?.generation.lastFullReadAt ?? null), extractionConfigKey,
    roots: rootRecords, declaredExclusions, filesRead, bytesRead, readErrors, oversizeListed, flags, complete, incompleteRoots,
  };
  const candidates: Candidate[] = vaultFiles.map((f) => ({ path: f.path, coverage: complete ? "complete" : "coverage-incomplete" }));
  return { generation, files, references: unique, candidates };
}

function buildIndex(files: InventoryFile[]): Index {
  const byPath = new Map<string, string>(), byBasename = new Map<string, string[]>(), byStem = new Map<string, string[]>();
  for (const f of files) {
    if (!f.sets.includes("vault")) continue;
    byPath.set(nfcLower(f.path), f.path);
    const b = nfcLower(basename(f.path)); byBasename.set(b, [...(byBasename.get(b) ?? []), f.path]);
    const s = nfcLower(stem(f.path)); byStem.set(s, [...(byStem.get(s) ?? []), f.path]);
  }
  return { byPath, byBasename, byStem };
}

/** The four resolutions of DESIGN §6.3 for a path-shaped token: absolute, relative to the mentioning file, relative to the target folder, relative to the vault root. Case-insensitive after NFC. */
function resolvePathToken(token: string, fromDir: string, config: InventoryConfig, vaultRoots: InventoryRoot[], index: Index): string | undefined {
  let t = token.trim().replace(/^<|>$/g, "");
  if (/^file:\/\/\//i.test(t)) { try { t = decodeURIComponent(t.replace(/^file:\/\/\//i, "")); } catch { t = t.replace(/^file:\/\/\//i, ""); } }
  else { try { t = decodeURIComponent(t); } catch { /* keep as is */ } }
  t = t.replace(/\\/g, "/");
  const lower = nfcLower(t);
  const tryPath = (p: string) => index.byPath.get(nfcLower(normalizePath(joinPath(p))));
  // absolute: a root's host spelling, with either slash, a /d/ form, or the virtual root itself
  for (const r of vaultRoots) {
    const spellings = [r.path, ...(r.hostPaths ?? [])].flatMap((h) => { const hs = h.replace(/\\/g, "/"); const m = /^([a-z]):\//i.exec(hs); return m ? [hs, `/${m[1]!.toLowerCase()}/${hs.slice(3)}`] : [hs]; });
    for (const s of spellings) { const sl = nfcLower(s).replace(/\/$/, ""); if (lower === sl || lower.startsWith(sl + "/")) { const hit = tryPath(r.path + "/" + t.slice(sl.length).replace(/^\/+/, "")); if (hit) return hit; } }
  }
  if (/^([a-z]:\/|\/[a-z]\/)/i.test(lower)) return undefined; // absolute under no known root
  const rel = t.replace(/^\.\//, "");
  const candidates = [fromDir ? joinPath(fromDir, rel) : undefined, config.policy.targetFolder ? joinPath(config.policy.targetFolder, rel) : undefined, ...vaultRoots.map((r) => joinPath(r.path, rel))];
  for (const c of candidates) { if (!c) continue; const hit = tryPath(c) ?? (extname(c) === "" ? tryPath(c + ".md") : undefined); if (hit) return hit; }
  return undefined;
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK = /\[[^\]]*\]\(<?([^)\s>]+)>?\)/g;
const REFDEF = /^\s*\[[^\]]+\]:\s*<?(\S+)>?/gm;
function extractLinks(sourcePath: string, text: string, fromDir: string, index: Index, resolve: (p: string, fromDir: string) => string | undefined, emit: (r: Omit<InventoryReference, "id">) => void): void {
  const targets: string[] = [];
  for (const m of text.matchAll(WIKILINK)) targets.push(m[1]!.trim());
  for (const m of text.matchAll(MDLINK)) if (!/^[a-z]+:/i.test(m[1]!) || /^file:/i.test(m[1]!)) targets.push(m[1]!);
  for (const m of text.matchAll(REFDEF)) if (!/^[a-z]+:/i.test(m[1]!) || /^file:/i.test(m[1]!)) targets.push(m[1]!);
  for (const raw of targets) {
    const t = raw.replace(/#.*$/, "").replace(/\?.*$/, "");
    if (!t) continue;
    if (t.includes("/") || t.includes("\\")) {
      const hit = resolve(t, fromDir);
      if (hit && hit !== sourcePath) { emit({ source: sourcePath, target: hit, kind: "link", token: raw }); continue; }
      const cands = (index.byBasename.get(nfcLower(basename(t.replace(/\\/g, "/")))) ?? index.byStem.get(nfcLower(basename(t.replace(/\\/g, "/")))) ?? []).filter((c) => c !== sourcePath);
      if (cands.length) emit({ source: sourcePath, target: null, kind: "ambiguous", candidates: [...cands].sort(), token: raw });
      else emit({ source: sourcePath, target: null, kind: "unresolved", token: raw });
      continue;
    }
    // Obsidian name rules: a bare name resolves by basename (with or without .md); several files of that name are ambiguous
    const key = nfcLower(t);
    const cands = [...new Set([...(index.byBasename.get(key) ?? []), ...(index.byStem.get(key) ?? []), ...(index.byBasename.get(key + ".md") ?? [])])].filter((c) => c !== sourcePath).sort();
    if (cands.length === 1) emit({ source: sourcePath, target: cands[0]!, kind: "link", token: raw });
    else if (cands.length > 1) emit({ source: sourcePath, target: null, kind: "ambiguous", candidates: cands, token: raw });
    else emit({ source: sourcePath, target: null, kind: "unresolved", token: raw });
  }
}

// A path-shaped token: an optional absolute prefix (file:///X:/, X:/ or X:\, /x/, ./ or ../, or a leading /), one or more
// directory segments, and a final component with an extension (a URL-encoded dot included). Decoded and resolved later.
const SEG = "[^\\s\"'<>()\\[\\]|`,;:]";
const PATH_TOKEN = new RegExp(`(?:file:\\/\\/\\/[A-Za-z]:[\\\\/]|[A-Za-z]:[\\\\/]|\\/[a-z]\\/|\\.{1,2}[\\\\/]|\\/)?(?:${SEG}+[\\\\/])+${SEG}+(?:\\.|%2E)[A-Za-z0-9]{1,8}`, "gi");
function extractPathMentions(sourcePath: string, text: string, fromDir: string, index: Index, resolve: (p: string, fromDir: string) => string | undefined, sets: CoverageSet[], emit: (r: Omit<InventoryReference, "id">) => void): void {
  const kind: ReferenceKind = sets.includes("instruction") ? "instruction" : sets.includes("dependency") && !sets.includes("vault") ? "dependency" : "path";
  for (const m of text.matchAll(PATH_TOKEN)) {
    const token = m[0];
    const hit = resolve(token, fromDir);
    if (hit) { if (hit !== sourcePath) emit({ source: sourcePath, target: hit, kind, token }); continue; }
    const b = nfcLower(basename(token.replace(/\\/g, "/")));
    const cands = (index.byBasename.get(b) ?? []).filter((c) => c !== sourcePath);
    if (cands.length) emit({ source: sourcePath, target: null, kind: kind === "path" ? "ambiguous" : kind, candidates: [...cands].sort(), token });
  }
}

const WORD = /[A-Za-z0-9_][A-Za-z0-9_\-.]*[A-Za-z0-9_]|[A-Za-z0-9_]/g;
function extractNameMentions(sourcePath: string, text: string, index: Index, commonStems: Set<string>, kind: "name" | "dependency" | "instruction", emit: (r: Omit<InventoryReference, "id">) => void): void {
  const seen = new Set<string>();
  // "bare": a name inside a link or a path-shaped token is that link or path mention, not a name mention
  const bare = text.replace(WIKILINK, " ").replace(MDLINK, " ").replace(REFDEF, " ").replace(PATH_TOKEN, " ");
  for (const m of bare.matchAll(WORD)) {
    const tok = nfcLower(m[0]);
    if (seen.has(tok)) continue; seen.add(tok);
    const byName = index.byBasename.get(tok);
    const byStem = !byName && !commonStems.has(tok) ? index.byStem.get(tok) : undefined;
    for (const target of byName ?? byStem ?? []) if (target !== sourcePath) emit({ source: sourcePath, target, kind, token: m[0] });
  }
}

function extractRipple(sourcePath: string, text: string, vaultFiles: InventoryFile[], emit: (r: Omit<InventoryReference, "id">) => void): void {
  const lower = nfcLower(text).replace(/\\/g, "/");
  for (const f of vaultFiles) {
    if (f.path === sourcePath) continue;
    const token = rippleToken(f.path);
    if (token.length >= 4 && lower.includes(nfcLower(token))) { emit({ source: sourcePath, target: f.path, kind: "ripple", token }); continue; }
    const b = nfcLower(basename(f.path));
    if (new RegExp(`[^\\s"'<>()[\\]|\`]*/${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`).test(lower)) emit({ source: sourcePath, target: f.path, kind: "ripple", token: `/${basename(f.path)}` });
  }
}

function extractObsidian(f: InventoryFile, text: string, index: Index, vaultRoots: InventoryRoot[], config: InventoryConfig, emit: (r: Omit<InventoryReference, "id">) => void): boolean {
  const name = nfcLower(basename(f.path)), ext = extname(f.path);
  const resolve = (p: string) => resolvePathToken(p, "", config, vaultRoots, index) ?? (extname(p) === "" ? resolvePathToken(p + ".md", "", config, vaultRoots, index) : undefined);
  const put = (p: unknown, kind: ReferenceKind, detail?: ObsidianDetail) => {
    if (typeof p !== "string" || !p) return;
    const hit = resolve(p);
    if (hit && hit !== f.path) emit({ source: f.path, target: hit, kind, detail, token: p });
    else { const cands = (index.byBasename.get(nfcLower(basename(p))) ?? []).filter((c) => c !== f.path); if (cands.length) emit({ source: f.path, target: null, kind: "ambiguous", candidates: [...cands].sort(), detail, token: p }); }
  };
  let json: unknown;
  if (ext === ".json" || ext === ".canvas") {
    try { json = JSON.parse(text); } catch { return false; }
    if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
  }
  if (name === "workspace.json") {
    let valid = true;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (k === "file") { if (typeof x !== "string") valid = false; else put(x, "obsidian", "open-leaf"); }
          else if (k === "lastOpenFiles") {
            if (!Array.isArray(x) || x.some((p) => typeof p !== "string")) valid = false;
            else x.forEach((p) => put(p, "obsidian", "last-open"));
          } else walk(x);
        }
      }
    };
    walk(json);
    return valid;
  } else if (name === "bookmarks.json") {
    let valid = true;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if ("path" in o) { if (typeof o.path !== "string") valid = false; else put(o.path, "obsidian", "bookmark"); }
        for (const x of Object.values(o)) walk(x);
      }
    };
    walk(json);
    return valid;
  } else if (ext === ".canvas") {
    const nodes = (json as { nodes?: { file?: unknown }[] }).nodes;
    if (nodes === undefined) return true;
    if (!Array.isArray(nodes) || nodes.some((n) => !n || typeof n !== "object" || Array.isArray(n) || ("file" in n && typeof n.file !== "string"))) return false;
    for (const n of nodes) put(n.file, "canvas");
  } else if (ext === ".base") {
    // Obsidian Bases are YAML-like: every quoted or bare path-shaped value ending in a vault extension is a reference.
    for (const m of text.matchAll(/["']?([^\s"':]+\.(?:md|markdown|txt))["']?/gi)) put(m[1], "base");
  }
  return true;
}
