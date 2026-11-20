// SYNTHETIC LOCAL TEST FIXTURE ONLY. This file is never a production entrypoint.
// Enrollment occurs only in this fixture's constructor, from test-provided bindings.
// There is no enrollment, token issuance, fault injection, or setup HTTP route.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState, Request as WorkerRequest, Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';
import { Catalog, tokenScopes, parseToken, clientClassFor, type Actor, type TokenKind } from '@kl/core/worker';
import { createApiHandler } from '../../apps/api/src/handler.ts';
import { R2ObjectStore, type ArchiveBucket } from '../../apps/api/src/cloudflare/r2-store.ts';
import { openDurableSql } from '../../apps/api/src/cloudflare/sql-driver.ts';
import { OutboxScheduler } from '../../apps/api/src/cloudflare/outbox-scheduler.ts';

interface Env {
  SYNTHETIC_FIXTURE: string;
  DEVICE_TOKEN: string;
  CONNECTOR_TOKEN: string;
  CODEX_TOKEN?: string;
  OUTBOX_SCHEDULER?: string;
  OUTBOX_MIN_DELAY?: string;
  FIXTURE_VOLUME?: string;
  FIXTURE_ROOT_ID?: string;
  COPY_FIXTURE_VOLUME?: string;
  COPY_FIXTURE_ROOT_ID?: string;
  ARCHIVE: ArchiveBucket;
  MIRROR: ArchiveBucket;
  LIBRARY: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}

export class ArchiveWorkflowHarness extends DurableObject<Env> {
  private readonly api: (request: Request) => Promise<Response>;
  private readonly scheduler?: OutboxScheduler;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (env.SYNTHETIC_FIXTURE !== 'archive-workflow-tests-only') throw new Error('Fixture binding required');
    const db = openDurableSql(ctx.storage);
    const catalog = new Catalog({ db, blobStore: new R2ObjectStore(env.ARCHIVE), mirror: new R2ObjectStore(env.MIRROR),
      denyRules: { segments: ['private-fixture'], libraryExtensionSegments: [], ledgers: [], badFile: '^\\.env$',
        contentPatterns: [{ code: 'synthetic.secret', pattern: 'SYNTHETIC_FORBIDDEN_MATERIAL' }],
        studentContentSignatures: [], studentPathSignatures: [], clientNamesOverlay: [], foundersSegments: [] } });
    const actor: Actor = { principal: 'fixture-owner', clientClass: 'kl-device' };
    if (!db.get('SELECT id FROM principals WHERE id=?', [actor.principal])) {
      const bootstrap = 'synthetic-local-fixture-bootstrap';
      catalog.enableSetup(bootstrap);
      catalog.apply(actor, { kind: 'setup' }, { kind: 'principal.create', id: actor.principal,
        email: 'owner@fixture.invalid', allowedClasses: ['team'] });
      catalog.apply(actor, { kind: 'setup' }, { kind: 'collection.create', collectionId: 'col:archive-fixture', class: 'team' });
      db.run('INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES(?,?,?,?,?,?,?)',
        ['folder:archive-fixture', 'fixture-device', env.FIXTURE_VOLUME ?? 'fixture-volume', env.FIXTURE_ROOT_ID ?? 'fixture-root', 'synthetic-path-hash', actor.principal, 'col:archive-fixture']);
      if (env.COPY_FIXTURE_VOLUME && env.COPY_FIXTURE_ROOT_ID) db.run('INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES(?,?,?,?,?,?,?)',
        ['folder:archive-copy-fixture', 'fixture-device', env.COPY_FIXTURE_VOLUME, env.COPY_FIXTURE_ROOT_ID, 'synthetic-copy-path-hash', actor.principal, 'col:archive-fixture']);
      // Issue the connector first: the device token seals setup by design.
      const tokens: [string, TokenKind][] = [[env.CONNECTOR_TOKEN, 'cc-bearer']];
      if (env.CODEX_TOKEN) tokens.push([env.CODEX_TOKEN, 'cx-bearer']);
      tokens.push([env.DEVICE_TOKEN, 'kl-device']);
      for (const [token, kind] of tokens) {
        const parsed = parseToken(token);
        if (!parsed.ok) throw new Error('Malformed synthetic token binding');
        catalog.apply(actor, { kind: 'setup', bootstrapSecret: bootstrap }, { kind: 'token.issue', tokenHash: parsed.hash,
          principal: actor.principal, tokenKind: kind, scopes: tokenScopes(kind), clientClass: clientClassFor(kind),
          expiresAt: '2099-01-01T00:00:00.000Z' });
      }
      catalog.sealSetup();
    }
    this.api = createApiHandler({ catalog });
    if (env.OUTBOX_SCHEDULER === 'enabled') {
      this.scheduler = new OutboxScheduler({ catalog, alarms: ctx.storage,
        minDelayMs: env.OUTBOX_MIN_DELAY ? Number(env.OUTBOX_MIN_DELAY) : undefined });
      // Only storage initialization is held here. External outbox effects run in alarm().
      ctx.blockConcurrencyWhile(() => this.scheduler!.recover());
    }
  }
  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    // The API needs the standard fetch surface only. Reconstruct it without buffering the body;
    // Worker-only properties and the Node/DOM request declaration do not share a type identity.
    const init: RequestInit & { duplex?: 'half' } = { method: request.method,
      headers: Object.fromEntries(request.headers), body: request.body as ReadableStream<Uint8Array> | null };
    if (request.body) init.duplex = 'half';
    // In workerd the global Response constructor used by the portable handler is the host Response.
    const portable = new Request(request.url, init);
    return await (this.scheduler ? this.scheduler.run(() => this.api(portable)) : this.api(portable)) as WorkerResponse;
  }
  override async alarm(): Promise<void> {
    await this.scheduler?.alarm();
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.LIBRARY.get(env.LIBRARY.idFromName('synthetic-archive-workflow')).fetch(request);
  },
};
