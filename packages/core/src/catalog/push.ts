// Text push protocol (DESIGN §3.5/§3.8). Staging never publishes a version;
// every durable transition is an apply operation, and commit is one transaction.
import type { Catalog, SaveResult, PreparedSave } from "./catalog.ts";
import type { Actor } from "./acl.ts";
import { aclPredicate } from "./acl.ts";
import { ApplyRefused, findPushReuseSource, pushFallbackSource, type PushReuseSource } from "./apply.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { sha256Hex } from "../primitives/sha256.ts";
import { mintId } from "../primitives/ids.ts";
import { getValue } from "./ledger.ts";
import { versionCitation } from "../primitives/citation.ts";
import type { Op, PushDisposition } from "./ops.ts";
import { hasScope, SCOPE_FOR, validCollectionIds } from "../auth/tokens.ts";
import { ADMISSION_RULE_CODES } from "../admission/guard.ts";

export const TEXT_PUSH_TTL_MS = 30 * 86400000;
export const TEXT_PUSH_MAX_BYTES = 16 * 1024 * 1024;
export interface ManifestEntry { relPath: string; sha256: string; size: number; mtime: string; gitTracked: boolean; lastKnownVer?: number }
export interface PushManifest { folderId: string; collection: string; device: string; identity: { volumeSerial: string; rootFileId: string }; scanComplete: boolean; heldLocal: Record<string, number>; entries: ManifestEntry[] }
export type PushResult = (Extract<SaveResult,{ok:true}> | PushDisposition | {ok:false;status:"pending";reason:"custody-pending"|"reuse-failed"}) & {n:number;relPath:string};
interface PushRow { pushId: string; principal: string; grant_h: string; manifest_h: string; folderId: string; collectionId: string; createdAt: string; expiresAt: string; state: string }
interface ItemRow { n: number; sha256: string; state: string; result_h: string | null }
interface Visible { noteId: string; ver: number; sha256: string; relPath: string; custody: string; status: string; noteStatus: string; localState: string; held: number }
const safePath = (s: string) => s.length <= 1024 && !s.includes("\\") && !s.startsWith("/") && !s.includes(":") && !/[\x00-\x1f]/.test(s) && s.split("/").every(p => p !== "" && p !== "." && p !== "..") && /\.(md|markdown|txt)$/i.test(s);
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export class PushAdmissionRejected extends ApplyRefused {
  readonly ruleCodes: string[];
  constructor(ruleCodes:string[]) { super("manifest-guard-rejected");this.ruleCodes=ruleCodes; }
}

export class TextPush {
  readonly catalog: Catalog;
  constructor(catalog: Catalog) { this.catalog = catalog; }

  private requireReadyPolicy() {
    // Empty manifests still change catalog state (notably absence). Policy
    // readiness cannot depend on there being an entry to run through admission.
    const g=this.catalog.guard({content:"",requestId:"manifest"});
    if (!g.admitted || g.outcome === "rejected") throw new PushAdmissionRejected(g.ruleCodes);
  }

  private active(actor: Actor, grant: string) {
    const t = this.catalog.db.get<{ principal: string; client_class: string; scopes: string; revokedAt: string | null; expiresAt: string }>("SELECT principal,client_class,scopes,revokedAt,expiresAt FROM tokens WHERE hash=?", [grant]);
    if (actor.clientClass !== "kl-device" || !t || t.client_class !== "kl-device" || t.principal !== actor.principal || t.revokedAt || t.expiresAt <= this.catalog.clock.now() || this.catalog.acl(actor).status !== "active" || !hasScope(JSON.parse(t.scopes),SCOPE_FOR.save) || !hasScope(JSON.parse(t.scopes),SCOPE_FOR.read)) throw new ApplyRefused("not-found");
  }

  private registered(actor: Actor, m: PushManifest, grant: string) {
    const token = this.catalog.db.get<{ collection_ids: string | null }>("SELECT collection_ids FROM tokens WHERE hash=?", [grant]);
    if (!token) throw new ApplyRefused("not-found");
    if (token.collection_ids !== null) {
      let ids: unknown; try { ids = JSON.parse(token.collection_ids); } catch { throw new ApplyRefused("not-found"); }
      if (!validCollectionIds(ids) || !ids.includes(m.collection)) throw new ApplyRefused("not-found");
    }
    const f = this.catalog.db.get<{ device: string; volumeSerial: string; rootFileId: string; owner_principal: string; collectionId: string }>("SELECT device,volumeSerial,rootFileId,owner_principal,collectionId FROM folders WHERE folderId=?", [m.folderId]);
    if (!f || f.owner_principal !== actor.principal || f.device !== m.device || f.volumeSerial !== m.identity.volumeSerial || f.rootFileId !== m.identity.rootFileId || f.collectionId !== m.collection || !this.catalog.canUseCollection(this.catalog.acl(actor), this.catalog.collectionRow(m.collection))) throw new ApplyRefused("not-found");
  }

  private owned(actor: Actor, grant: string, pushId: string) {
    this.active(actor, grant);
    const p = this.catalog.db.get<PushRow>("SELECT * FROM text_pushes WHERE pushId=?", [pushId]);
    if (!p || p.principal !== actor.principal || p.grant_h !== grant || p.state === "expired") throw new ApplyRefused("not-found");
    if (p.state === "open" && p.expiresAt <= this.catalog.clock.now()) { this.catalog.apply(actor, { kind: "system" }, { kind: "push.expire", pushId }); throw new ApplyRefused("push-expired"); }
    const manifest = JSON.parse(getValue(this.catalog.db, p.manifest_h)!) as PushManifest;
    this.registered(actor, manifest, grant);
    this.requireReadyPolicy();
    return { p, manifest };
  }

  private visible(actor: Actor, m: PushManifest): Visible[] {
    const acl = aclPredicate(this.catalog.acl(actor));
    return this.catalog.db.all<Visible>(`SELECT n.noteId,n.currentVer AS ver,v.sha256,pv.text AS relPath,v.custody,v.vstatus AS status,n.status AS noteStatus,v.localState,v.held FROM notes n JOIN versions v ON v.noteId=n.noteId AND v.ver=n.currentVer JOIN collections col ON col.collectionId=n.collectionId JOIN aliases a ON a.noteId=n.noteId JOIN values_ pv ON pv.hash=a.path_h WHERE n.folderId=? AND n.collectionId=? AND n.status NOT IN ('withdrawn','purge-pending') AND a.valid_to IS NULL AND (a.owner IS NULL OR a.owner=?) AND ${acl.sql}`, [m.folderId, m.collection, actor.principal, ...acl.params]);
  }

  /** Expiry is independent of the original caller and releases all pending fences. */
  expire() {
    for (const p of this.catalog.db.all<{ pushId: string }>("SELECT pushId FROM text_pushes WHERE state='open' AND expiresAt<=?", [this.catalog.clock.now()])) this.catalog.apply({ principal: "system", clientClass: "kl-device" }, { kind: "system" }, { kind: "push.expire", pushId: p.pushId });
  }

  diff(actor: Actor, grant: string, body: unknown) {
    this.active(actor, grant);
    if (!object(body) || typeof body.snapshotId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/.test(body.snapshotId) || typeof body.folderId !== "string" || !/^folder:[A-Za-z0-9._-]{1,80}$/.test(body.folderId) || typeof body.collection !== "string" || typeof body.device !== "string" || !object(body.identity) || typeof body.identity.volumeSerial !== "string" || typeof body.identity.rootFileId !== "string" || typeof body.scanComplete !== "boolean" || !object(body.heldLocal) || !Array.isArray(body.entries) || body.entries.length > 10000) throw new ApplyRefused("invalid-args");
    this.requireReadyPolicy();
    const entries: ManifestEntry[] = [];
    const names = new Set<string>();
    for (const e of body.entries) {
      if (!object(e) || typeof e.relPath !== "string" || names.has(e.relPath.toLowerCase()) || typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256) || !Number.isSafeInteger(e.size) || (e.size as number) < 0 || (e.size as number) > TEXT_PUSH_MAX_BYTES || typeof e.mtime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(e.mtime) || !Number.isFinite(Date.parse(e.mtime)) || Date.parse(e.mtime) > Date.parse(this.catalog.clock.now()) + 300000 || typeof e.gitTracked !== "boolean" || (e.lastKnownVer !== undefined && (!Number.isSafeInteger(e.lastKnownVer) || (e.lastKnownVer as number) < 1))) throw new ApplyRefused("invalid-args");
      // Manifest metadata is data too: do not durably retain guard-denied paths.
      const g = this.catalog.guard({ content: "", path: e.relPath, requestedCollection: body.collection, requestId: "manifest", fields: { mtime: e.mtime } });
      if (!g.admitted || g.outcome === "rejected") throw new PushAdmissionRejected(g.ruleCodes);
      if(!safePath(e.relPath)) throw new ApplyRefused("invalid-args");
      names.add(e.relPath.toLowerCase());
      entries.push({ relPath: e.relPath, sha256: e.sha256, size: e.size as number, mtime: e.mtime, gitTracked: e.gitTracked, ...(e.lastKnownVer === undefined ? {} : { lastKnownVer: e.lastKnownVer as number }) });
    }
    const heldLocal: Record<string, number> = {};
    // Counts-only diagnostics may name only rules known to this server's trusted
    // policy. A syntactically bounded caller key could otherwise persist a token.
    const heldCodes = new Set<string>([...ADMISSION_RULE_CODES, ...this.catalog.denyRules.contentPatterns.map(rule => rule.code), "secret.gitleaks"]);
    for (const [k,v] of Object.entries(body.heldLocal)) { if (!heldCodes.has(k) || !Number.isSafeInteger(v) || (v as number) < 0) throw new ApplyRefused("invalid-args"); heldLocal[k] = v as number; }
    const manifest: PushManifest = { folderId: body.folderId, collection: body.collection, device: body.device, identity: { volumeSerial: body.identity.volumeSerial, rootFileId: body.identity.rootFileId }, scanComplete: body.scanComplete, heldLocal, entries };
    this.registered(actor, manifest, grant);
    const snapshotHash = sha256Hex(body.snapshotId);
    const prior = this.catalog.db.get<PushRow>("SELECT * FROM text_pushes WHERE principal=? AND grant_h=? AND snapshot_h=?", [actor.principal,grant,snapshotHash]);
    if (prior && prior.manifest_h !== sha256Hex(canonicalJson(manifest))) throw new ApplyRefused("snapshot-conflict");
    if (prior?.state === "expired") throw new ApplyRefused("push-expired");
    const pushId = prior?.pushId ?? mintId(this.catalog.random);
    if (!prior) this.catalog.apply(actor, { kind: "principal" }, { kind: "push.open", pushId, grant, snapshotHash, manifest, expiresAt: new Date(Date.parse(this.catalog.clock.now()) + TEXT_PUSH_TTL_MS).toISOString() });
    const { p } = this.owned(actor, grant, pushId);
    const visible = this.visible(actor, manifest);
    const rows = this.catalog.db.all<ItemRow>("SELECT * FROM text_push_items WHERE pushId=? ORDER BY n", [pushId]);
    const missing: object[] = [], unchanged: object[] = [], reusable: object[] = [], diverged: object[] = [];
    entries.forEach((e,n) => {
      const v = visible.find(v => v.relPath === e.relPath && v.sha256 === e.sha256 && v.custody !== "received" && !v.held);
      const item = rows[n];
      if (item?.state === "reuse-failed") missing.push({n,...e});
      else if (v) unchanged.push({ n, relPath:e.relPath, noteId:v.noteId, ver:v.ver, sha256:v.sha256, cite:versionCitation(v.noteId,v.ver,v.sha256), custody:v.custody });
      else if ((item?.state === "missing" || item?.state === "reserved") && findPushReuseSource(this.catalog.db,actor,manifest.collection,e.sha256,e.size)) reusable.push({n,relPath:e.relPath,sha256:e.sha256,size:e.size});
      else if (item?.state === "missing" || item?.state === "reserved") missing.push({n,...e});
      const current = visible.find(v => v.relPath === e.relPath);
      if (current && e.lastKnownVer !== undefined && e.lastKnownVer !== current.ver) diverged.push({n,relPath:e.relPath,currentVer:current.ver,lastKnownVer:e.lastKnownVer});
    });
    const comparisons = this.comparisons(manifest, visible);
    return { pushId, expiresAt:p.expiresAt, state:p.state, missing, unchanged, reusable, diverged, ...comparisons };
  }

  private comparisons(m: PushManifest, visible: Visible[]) {
    const complete = m.scanComplete && Object.values(m.heldLocal).every(n => n === 0);
    const vanished = complete ? visible.filter(v => !m.entries.some(e => e.relPath === v.relPath)).map(v => ({ relPath:v.relPath,noteId:v.noteId,ver:v.ver })) : [];
    const exactMoves: { noteId:string;ver:number;from:string;to:string }[] = [], moveQuestions: object[] = [];
    if (complete) for (const e of m.entries.filter(e => !visible.some(v => v.relPath === e.relPath))) {
      const candidates = visible.filter(v => v.sha256 === e.sha256 && vanished.some(x => x.noteId === v.noteId) && v.custody !== "received" && !v.held);
      const destinations = m.entries.filter(x => x.sha256 === e.sha256 && !visible.some(v => v.relPath === x.relPath));
      if (candidates.length === 1 && destinations.length === 1 && candidates[0]!.noteStatus === "current" && candidates[0]!.status === "current" && candidates[0]!.localState === "present" && this.catalog.moveEligibility(candidates[0]!.noteId,candidates[0]!.ver)) exactMoves.push({noteId:candidates[0]!.noteId,ver:candidates[0]!.ver,from:candidates[0]!.relPath,to:e.relPath});
      else if (candidates.length) moveQuestions.push({relPath:e.relPath,candidates:candidates.map(v => ({noteId:v.noteId,ver:v.ver,from:v.relPath}))});
    }
    return { exactMoves, moveQuestions, vanished };
  }

  private disposition(plan: SaveResult | PreparedSave, collection: string): PushDisposition | undefined {
    if("prepared" in plan) {
      if(plan.op.held) return {ok:false,status:"held",reason:"review",...(plan.reason ? {ruleCodes:plan.reason.split(",")} : {})};
      if(plan.op.collectionId!==collection) return {ok:false,status:"rerouted",reason:"destination-changed"};
    } else if(!plan.ok) return plan.status==="rejected" ? {ok:false,status:"refused",reason:"guard-rejected",ruleCodes:plan.ruleCodes} : {ok:false,status:"refused",reason:plan.reason};
    else if(plan.status==="held") return {ok:false,status:"held",reason:"review"};
    return undefined;
  }

  async stage(actor: Actor, grant: string, pushId: string, n: number, bytes: Uint8Array): Promise<Record<string,unknown>> {
    const {p,manifest} = this.owned(actor,grant,pushId);
    const e = manifest.entries[n];
    if (!Number.isInteger(n) || n < 0 || !e || p.state !== "open") throw new ApplyRefused("not-found");
    const existing=this.catalog.db.get<ItemRow>("SELECT * FROM text_push_items WHERE pushId=? AND n=?",[pushId,n]);
    if(existing?.state==='terminal' && existing.result_h) return {n,relPath:e.relPath,...JSON.parse(getValue(this.catalog.db,existing.result_h)!)};
    if (bytes.byteLength !== e.size || sha256Hex(bytes) !== e.sha256) return {ok:false,n,status:"rejected",ruleCodes:["digest-mismatch"]};
    try { new TextDecoder("utf-8", {fatal:true}).decode(bytes); } catch { return {ok:false,n,status:"rejected",ruleCodes:["invalid-utf8"]}; }
    const source=pushFallbackSource(this.catalog.db,existing?.result_h ?? null);
    const sourceAllowed=() => {
      if(!source) return existing?.state!=='reuse-failed';
      const current=findPushReuseSource(this.catalog.db,actor,manifest.collection,e.sha256,e.size,source);
      return !!current && current.privacyClass===source.privacyClass;
    };
    const refuseSource=() => {
      this.owned(actor,grant,pushId);
      const disposition:PushDisposition={ok:false,status:"refused",reason:"review"};
      this.catalog.apply(actor,{kind:"principal"},{kind:"push.disposition",pushId,grant,n,disposition});
      return {n,relPath:e.relPath,...disposition};
    };
    if(!sourceAllowed()) return refuseSource();
    const plan = await this.catalog.prepareSave(actor,{content:bytes,path:e.relPath,collection:manifest.collection,folderId:manifest.folderId,observedMtime:e.mtime,baseVer:e.lastKnownVer,...(source?{derivedFrom:[versionCitation(source.noteId,source.ver,e.sha256)]}:{})},{grant,push:true},TEXT_PUSH_MAX_BYTES);
    this.owned(actor,grant,pushId);
    if(!sourceAllowed()) return refuseSource();
    const disposition=this.disposition(plan,manifest.collection);
    if(disposition){this.owned(actor,grant,pushId);this.catalog.apply(actor,{kind:"principal"},{kind:"push.disposition",pushId,grant,n,disposition});return {n,relPath:e.relPath,...disposition};}
    const guard = "prepared" in plan ? plan.admitted : this.catalog.guard({content:bytes,path:e.relPath,requestedCollection:manifest.collection,requestId:mintId(this.catalog.random)}).admitted;
    if (!guard) return {ok:false,n,status:"rejected",ruleCodes:["guard-rejected"]};
    this.owned(actor,grant,pushId);
    this.catalog.apply(actor,{kind:"principal"},{kind:"push.reserve",pushId,grant,n});
    await this.catalog.blobs.put(guard);
    // An existing object is not trusted just because put-if-absent found it.
    const stored = await this.catalog.blobs.get(e.sha256);
    if (!stored || stored.byteLength !== e.size || sha256Hex(stored) !== e.sha256) throw new ApplyRefused("unavailable-storage");
    this.owned(actor,grant,pushId);
    const staged=this.catalog.apply(actor,{kind:"principal"},{kind:"push.stage",pushId,grant,n});
    if(staged.result?.ok===false) return {n,relPath:e.relPath,...staged.result};
    return {ok:true,n,sha256:e.sha256,status:"staged"};
  }

  async commit(actor: Actor, grant: string, pushId: string, attempt = 0): Promise<{pushId:string;results:(PushResult & {reused?:boolean})[];missing:number[];partial:boolean;reusedBytes:number;counts:{admitted:number;deduplicated:number;reused:number;missing:number;heldLocal:number}}> {
    const {p,manifest} = this.owned(actor,grant,pushId);
    const rows = this.catalog.db.all<ItemRow>("SELECT * FROM text_push_items WHERE pushId=? ORDER BY n",[pushId]);
    const pendingCustody=new Set<number>();
    if (p.state === "open") {
      const visible = this.visible(actor,manifest);
      const comparisons = this.comparisons(manifest,visible);
      const items: Extract<Op,{kind:"push.commit"}>["items"] = [];
      const candidates: {item:ItemRow;move:typeof comparisons.exactMoves[number]|undefined;source:PushReuseSource|undefined}[]=[];
      // Reserve every eligible item synchronously, before the first storage read.
      // The session's durable pending references survive outages and restarts.
      for (const item of rows) {
        if (item.state === "committed" || item.state === "terminal" || item.state === "reuse-failed") continue;
        const e = manifest.entries[item.n]!;
        const same = visible.find(v => v.relPath === e.relPath && v.sha256 === e.sha256 && v.custody !== "received");
        const move = comparisons.exactMoves.find(v => v.to === e.relPath);
        const source=item.state==='staged' ? pushFallbackSource(this.catalog.db,item.result_h) : !same ? findPushReuseSource(this.catalog.db,actor,manifest.collection,e.sha256,e.size,move) : undefined;
        if (item.state !== "staged" && !same && !source) continue;
        if(item.state!=="staged") this.catalog.apply(actor,{kind:"principal"},{kind:"push.reserve",pushId,grant,n:item.n});
        candidates.push({item,move,source});
      }
      const expectedGeneration=this.catalog.head().seq;
      for (const {item,move,source} of candidates) {
        const e=manifest.entries[item.n]!;
        const failReuse=() => items.push(item.state==='staged'
          ? {n:item.n,disposition:{ok:false,status:"refused",reason:"review"}}
          : {n:item.n,reuseFailed:true,reuseSource:source});
        let bytes: Uint8Array | undefined;
        try { bytes = await this.catalog.blobs.get(e.sha256); }
        catch(error) { if(!source || item.state==='staged') throw error; this.owned(actor,grant,pushId);failReuse();continue; }
        this.owned(actor,grant,pushId);
        if(source) {
          const current=findPushReuseSource(this.catalog.db,actor,manifest.collection,e.sha256,e.size,source);
          if(!current || current.privacyClass!==source.privacyClass) {failReuse();continue;}
        }
        if (!bytes || bytes.byteLength !== e.size || sha256Hex(bytes) !== e.sha256) {
          if(source && item.state!=='staged'){failReuse();continue;}
          throw new ApplyRefused("unavailable-storage");
        }
        const reused=!!source && item.state!=='staged';
        const plan = await this.catalog.prepareSave(actor,{content:bytes,path:move?.from ?? e.relPath,collection:manifest.collection,folderId:manifest.folderId,observedMtime:e.mtime,baseVer:move?.ver ?? e.lastKnownVer,...(source?{derivedFrom:[versionCitation(source.noteId,source.ver,e.sha256)]}:{})},{grant,push:true},TEXT_PUSH_MAX_BYTES);
        const disposition=this.disposition(plan,manifest.collection);
        if(disposition){items.push(reused ? {n:item.n,reuseFailed:true,reuseSource:source} : {n:item.n,disposition});continue;}
        if (!("prepared" in plan)) {if(!plan.ok) throw new ApplyRefused("push-item-conflict");items.push({n:item.n,reused,reuseSource:source,result:plan as unknown as Record<string,unknown>});}
        else {
          // A prior commit may have lost its first custody check. Recheck the
          // exact readable twin before deduplication, without wedging siblings.
          const v=plan.op,current=v.noteId?this.catalog.db.get<{currentVer:number}>("SELECT currentVer FROM notes WHERE noteId=?",[v.noteId]):undefined;
          if(v.noteId && current) {
            const acl=aclPredicate(this.catalog.acl(actor));
            const twins=this.catalog.db.all<{ver:number;custody:string}>(`SELECT v.ver,v.custody FROM versions v JOIN notes n ON n.noteId=v.noteId JOIN collections col ON col.collectionId=n.collectionId WHERE v.noteId=? AND v.sha256=? AND (v.ver=? OR v.parentVer IS ?) AND ${acl.sql}`,[v.noteId,v.sha256,current.currentVer,v.baseVer ?? current.currentVer,...acl.params]);
            let pending=false;
            for(const twin of twins) if(twin.custody==='received' && await this.catalog.verifyCustody(v.noteId,twin.ver)==='received') pending=true;
            if(pending){pendingCustody.add(item.n);continue;}
          }
          items.push({n:item.n,reused,reuseSource:source,reason:plan.reason,version:{...v,pendingRefId:`push:${pushId}:${item.n}`}});
        }
      }
      this.owned(actor,grant,pushId);
      try { this.catalog.apply(actor,{kind:"principal"},{kind:"push.commit",pushId,grant,expectedGeneration,items,absent:comparisons.vanished.filter(v => !comparisons.exactMoves.some(m => m.noteId === v.noteId)),moves:comparisons.exactMoves.filter(m => items.some(i => manifest.entries[i.n]!.relPath === m.to) || rows.some(r=>r.state==="committed" && manifest.entries[r.n]!.relPath===m.to))}); }
      catch(e) { if(e instanceof ApplyRefused && e.code==="push-catalog-changed" && attempt<2) return this.commit(actor,grant,pushId,attempt+1); throw e; }
    }
    const results: (PushResult & {reused?:boolean})[] = [];
    for (const row of this.catalog.db.all<ItemRow>("SELECT * FROM text_push_items WHERE pushId=? ORDER BY n",[pushId])) {
      if(row.state==='reuse-failed'){results.push({ok:false,status:"pending",reason:"reuse-failed",n:row.n,relPath:manifest.entries[row.n]!.relPath});continue;}
      if(row.state==='terminal' && row.result_h){results.push({...JSON.parse(getValue(this.catalog.db,row.result_h)!) as PushDisposition,n:row.n,relPath:manifest.entries[row.n]!.relPath});continue;}
      if (row.state !== "committed" || !row.result_h) {if(pendingCustody.has(row.n)) results.push({ok:false,status:"pending",reason:"custody-pending",n:row.n,relPath:manifest.entries[row.n]!.relPath});continue;}
      const result = JSON.parse(getValue(this.catalog.db,row.result_h)!) as Extract<SaveResult,{ok:true}> & {reused?:boolean};
      // Re-check current visibility before returning even a historical receipt.
      const check = this.catalog.db.get<{noteId:string;held:number;vstatus:"current"|"sibling"|"proposed-edit"}>(`SELECT v.noteId,v.held,v.vstatus FROM versions v JOIN notes n ON n.noteId=v.noteId JOIN collections col ON col.collectionId=n.collectionId WHERE v.noteId=? AND v.ver=? AND n.status NOT IN ('withdrawn','purge-pending') AND ${aclPredicate(this.catalog.acl(actor)).sql}`,[result.noteId,result.ver,...aclPredicate(this.catalog.acl(actor)).params]);
      if (!check) throw new ApplyRefused("not-found");
      const custody = await this.catalog.verifyCustody(result.noteId,result.ver);
      results.push({...result,reused:result.reused===true,custody,status:check.held?"held":check.vstatus,...(check.held?{reason:result.reason??"review"}:{}),n:row.n,relPath:manifest.entries[row.n]!.relPath});
    }
    this.owned(actor,grant,pushId);
    // Custody dispatch awaited storage. A revocation/withdrawal in that interval
    // must suppress the whole receipt, including counts and formerly visible cites.
    const finalAcl=aclPredicate(this.catalog.acl(actor));
    for(const result of results) if(result.ok) {
      const current=this.catalog.db.get<{held:number;vstatus:"current"|"sibling"|"proposed-edit"}>(`SELECT v.held,v.vstatus FROM versions v JOIN notes n ON n.noteId=v.noteId JOIN collections col ON col.collectionId=n.collectionId WHERE v.noteId=? AND v.ver=? AND n.status NOT IN ('withdrawn','purge-pending') AND ${finalAcl.sql}`,[result.noteId,result.ver,...finalAcl.params]);
      if(!current) throw new ApplyRefused("not-found");
      result.status=current.held?"held":current.vstatus;
      if(current.held) result.reason=result.reason??"review";
    }
    const missing = rows.filter(r => !results.some(i => i.n === r.n && (i.ok || i.status!=='pending'))).map(r => r.n);
    return {pushId,results,missing,partial:missing.length > 0 || results.some(r => !r.ok || r.custody === "received" || r.status !== "current") || !manifest.scanComplete || Object.values(manifest.heldLocal).some(n => n > 0),reusedBytes:results.reduce((sum,r)=>sum+(r.ok && r.reused?manifest.entries[r.n]!.size:0),0),counts:{admitted:results.filter(r=>r.ok).length,reused:results.filter(r=>r.ok && r.reused).length,deduplicated:results.filter(r => r.ok && r.deduped).length,missing:missing.length,heldLocal:Object.values(manifest.heldLocal).reduce((a,b)=>a+b,0)}};
  }
}
