import { describe, it, expect } from 'vitest';
import { generateFixtures } from '../fixtures/gen.ts';
import { newCatalog, issueToken } from './helpers/load.ts';
import { sha256Hex } from '../packages/core/src/primitives/sha256.ts';

describe('narrowing checkpoint acknowledgement', () => {
  function fixture() {
    const f = newCatalog(generateFixtures());
    const token = issueToken(f.catalog, 'frank', 'cc-bearer', [], 'checkpoint');
    const r = f.catalog.apply({principal:'system',clientClass:'kl-device'}, {kind:'system'},
      {kind:'token.revoke',tokenHash:sha256Hex(token),reason:'owner'});
    const seq = (r.result as {authzSeq:number}).authzSeq;
    return {...f,seq,key:`authz/${String(seq).padStart(12,'0')}.json`};
  }
  it('refuses an absent or forged checkpoint intent', async () => {
    const f=fixture();
    await expect(f.catalog.acknowledge(f.seq+999)).rejects.toThrow(/not acknowledged/);
    f.catalog.db.run("DELETE FROM outbox WHERE idempotencyKey=?",[`authz:${f.seq}`]);
    await expect(f.catalog.acknowledge(f.seq)).rejects.toThrow(/not acknowledged/);
  });
  it('refuses immutable wrong bytes and remains pending', async () => {
    const f=fixture(); await f.mirror.put(f.key,new TextEncoder().encode('{}'));
    await expect(f.catalog.acknowledge(f.seq)).rejects.toThrow(/not acknowledged/);
    expect(f.catalog.db.get<{state:string}>("SELECT state FROM outbox WHERE idempotencyKey=?",[`authz:${f.seq}`])?.state).toBe('pending');
  });
  it('refuses when readback fails even after the object was written', async () => {
    const f=fixture(); f.mirror.failWhenGet=k=>k===f.key;
    await expect(f.catalog.acknowledge(f.seq)).rejects.toThrow(/not acknowledged/);
    f.mirror.failWhenGet=null; await expect(f.catalog.acknowledge(f.seq)).resolves.toBeUndefined();
    await expect(f.catalog.acknowledge(f.seq)).resolves.toBeUndefined();
    f.mirror.objects.delete(f.key);
    await expect(f.catalog.acknowledge(f.seq)).rejects.toThrow(/not acknowledged/);
  });
});
