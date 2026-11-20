import { describe,it,expect } from 'vitest';
import { Catalog, authenticate, verifyEnrollment, signEnrollment, sha256Hex, type VerifiedEnrollment } from '@kl/core';
import { createApiHandler } from '../apps/api/src/handler.ts';
import { enrollmentFixture } from './helpers/enrollment.ts';

describe('one-shot signed enrollment',()=>{
  it('atomically creates the entire grant set, requires verified checkpoint, and permits metadata-only identical retry',async()=>{
    const f=await enrollmentFixture();
    try {
      const result=f.catalog.enroll(f.grant), seq=result.result.authzSeq as number;
      expect(result.result.state).toBe('pending');
      expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM tokens')?.n).toBe(3);
      for(const t of f.tokens) expect(authenticate(f.db,t.token,f.trust.now())).toMatchObject({ok:false,reason:'enrollment-pending'});
      await f.catalog.acknowledgeEnrollment(seq);
      for(const t of f.tokens) expect(authenticate(f.db,t.token,f.trust.now())).toMatchObject({ok:true,tokenKind:t.kind,collectionIds:['col:fixture']});
      expect(f.catalog.enroll(f.grant).result).toMatchObject({state:'active',replay:true,authzSeq:seq});
      expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM tokens')?.n).toBe(3);
      expect(f.db.get('SELECT usedAt FROM approvals WHERE receiptId=?',[f.claims.receiptId])).toEqual({usedAt:f.trust.now()});
      expect(()=>f.catalog.enableSetup('synthetic-new-bootstrap-secret')).toThrow('setup-already-consumed');
    }finally{f.db.close();}
  });
  it('never treats a caller-shaped verification marker as authority',async()=>{
    const f=await enrollmentFixture();try{
      expect(()=>f.catalog.enroll({...f.grant} as VerifiedEnrollment)).toThrow('enrollment-unverified');
      expect(()=>f.catalog.apply({principal:f.claims.principal,clientClass:'kl-device'},{kind:'principal'},{kind:'enrollment.initialize',grant:f.grant})).toThrow('enrollment-required');
    }finally{f.db.close();}
  });
  it('checks expiry again inside the transaction',async()=>{
    const f=await enrollmentFixture(),transaction=f.db.transaction;try{
      f.db.transaction=fn=>transaction(()=>{f.setTime(f.claims.expiresAt);return fn();});
      expect(()=>f.catalog.enroll(f.grant)).toThrow('enrollment-expired');
      expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM tokens')?.n).toBe(0);
    }finally{f.db.close();}
  });
  it.each(['origin','environment','libraryId'] as const)('refuses wrong audience %s',async field=>{
    const f=await enrollmentFixture();try{
      const trust={...f.trust,audience:{...f.trust.audience,[field]:field==='origin'?'https://other.invalid':field==='environment'?'production':'other-library'}};
      await expect(verifyEnrollment(f.approval,f.acceptance,trust as typeof f.trust)).rejects.toThrow('enrollment-audience-mismatch');
    }finally{f.db.close();}
  });
  it('refuses wrong signature, policy receipt, policy key, and stale policy epoch',async()=>{
    const f=await enrollmentFixture();try{
      await expect(verifyEnrollment({...f.approval,sig:'A'.repeat(86)},f.acceptance,f.trust)).rejects.toThrow('enrollment-signature-invalid');
      await expect(verifyEnrollment(f.approval,{...f.acceptance,receiptId:'other'},f.trust)).rejects.toThrow('enrollment-policy-invalid');
      await expect(verifyEnrollment(f.approval,f.acceptance,{...f.trust,policy:{...f.trust.policy,publicKey:f.approvalKey.publicKey}})).rejects.toThrow('enrollment-policy-invalid');
      await expect(verifyEnrollment(f.approval,f.acceptance,{...f.trust,policy:{...f.trust.policy,minEpoch:2}})).rejects.toThrow('enrollment-policy-invalid');
    }finally{f.db.close();}
  });
  it('detaches claims before asynchronous signature checks',async()=>{
    const f=await enrollmentFixture();try{
      const promise=verifyEnrollment(f.approval,f.acceptance,f.trust);
      f.approval.claims.folder.collectionId='col:attacker'; f.acceptance.receiptId='attacker';
      const grant=await promise;
      expect(grant.claims.folder.collectionId).toBe('col:fixture');
      expect(grant.acceptance.receiptId).toBe('policy-fixture');
      expect(Object.isFrozen(grant.claims.folder)).toBe(true);
    }finally{f.db.close();}
  });
  it('rejects incomplete, duplicate or oversized grant sets and unknown fields',async()=>{
    const f=await enrollmentFixture();try{
      await expect(f.resign({...f.claims,tokens:f.claims.tokens.slice(0,2)})).rejects.toThrow('enrollment-tokens-invalid');
      await expect(f.resign({...f.claims,tokens:[f.claims.tokens[0]!,f.claims.tokens[0]!,f.claims.tokens[2]!]})).rejects.toThrow('enrollment-tokens-invalid');
      await expect(signEnrollment({...f.claims,extra:'untrusted'} as typeof f.claims,f.approvalKey.keyId,f.approvalKey.privateKey)).rejects.toThrow('enrollment-invalid');
    }finally{f.db.close();}
  });
  it.each([1,2,3])('rolls back every trust row on token insert %i failure',async nth=>{
    const f=await enrollmentFixture(), run=f.db.run;let inserts=0;
    try{
      f.db.run=(sql,args)=>{if(sql.startsWith('INSERT INTO tokens')&&++inserts===nth)throw Error('synthetic-insert-failure');return run(sql,args);};
      expect(()=>f.catalog.enroll(f.grant)).toThrow('synthetic-insert-failure');
      for(const table of ['principals','tokens','collections','folders','approvals','policy_acceptances','authz_events','events','outbox'])
        expect(f.db.get<{n:number}>(`SELECT count(*) AS n FROM ${table}`)?.n).toBe(0);
      expect(f.db.get("SELECT value FROM meta WHERE key='enrollment_hash'")).toBeUndefined();
      f.db.run=run;expect(f.catalog.enroll(f.grant).result.state).toBe('pending');
    }finally{f.db.close();}
  });
  it('stays denied when immutable checkpoint conflicts or readback fails, then resumes without reissuing',async()=>{
    const f=await enrollmentFixture();try{
      const seq=f.catalog.enroll(f.grant).result.authzSeq as number,key=`authz/${String(seq).padStart(12,'0')}.json`;
      await f.mirror.put(key,new TextEncoder().encode('synthetic-conflict'));
      await expect(f.catalog.acknowledgeEnrollment(seq)).rejects.toThrow('enrollment-checkpoint-pending');
      expect(authenticate(f.db,f.tokens[0]!.token,f.trust.now()).ok).toBe(false);
      await f.mirror.delete(key);f.mirror.failWhenGet=k=>k===key;
      await expect(f.catalog.acknowledgeEnrollment(seq)).rejects.toThrow('enrollment-checkpoint-pending');
      const recreated=new Catalog({db:f.db,blobStore:f.blobStore,mirror:f.mirror,denyRules:f.denyRules,clock:{now:f.trust.now}});
      f.mirror.failWhenGet=null;await recreated.acknowledgeEnrollment(seq);
      expect(recreated.enroll(f.grant).result.replay).toBe(true);
      expect(authenticate(f.db,f.tokens[0]!.token,f.trust.now()).ok).toBe(true);
    }finally{f.db.close();}
  });
  it('refuses missing checkpoint row rather than acknowledging it',async()=>{
    const f=await enrollmentFixture();try{
      await expect(f.catalog.acknowledgeEnrollment(99)).rejects.toThrow('enrollment-checkpoint-missing');
      const seq=f.catalog.enroll(f.grant).result.authzSeq as number;
      f.db.run("DELETE FROM outbox WHERE step='enrollment.checkpoint'");
      await expect(f.catalog.acknowledgeEnrollment(seq)).rejects.toThrow('enrollment-checkpoint-missing');
      expect(()=>f.catalog.enroll(f.grant)).toThrow('enrollment-checkpoint-missing');
    }finally{f.db.close();}
  });
  it('refuses a different signed receipt/nonce after restart even with the same owner',async()=>{
    const f=await enrollmentFixture();try{
      f.catalog.enroll(f.grant);
      const other=await f.resign({...f.claims,nonce:sha256Hex('other-nonce'),receiptId:'other-receipt'});
      const grant=await verifyEnrollment(other,f.acceptance,f.trust);
      const catalog=new Catalog({db:f.db,blobStore:f.blobStore,mirror:f.mirror,denyRules:f.denyRules,clock:{now:f.trust.now}});
      expect(()=>catalog.enroll(grant)).toThrow('enrollment-already-consumed');
    }finally{f.db.close();}
  });
  it('refuses a policy that is signed but is not the actual loaded admission policy',async()=>{
    const f=await enrollmentFixture();try{
      const catalog=new Catalog({db:f.db,blobStore:f.blobStore,mirror:f.mirror,denyRules:{...f.denyRules},clock:{now:f.trust.now}});
      expect(()=>catalog.enroll(f.grant)).toThrow('enrollment-policy-unavailable');
      expect(()=>catalog.apply({principal:f.claims.principal,clientClass:'kl-device'},{kind:'enrollment'},{kind:'enrollment.initialize',grant:f.grant})).toThrow('enrollment-policy-unavailable');
    }finally{f.db.close();}
  });
  it('opt-in route accepts only signed complete requests, returns no tokens, and preserves revocation',async()=>{
    const f=await enrollmentFixture();try{
      const request=()=>new Request('https://enrollment.invalid/v1/enroll',{method:'POST',body:JSON.stringify({approval:f.approval,acceptance:f.acceptance})});
      expect((await createApiHandler({catalog:f.catalog})(request())).status).toBe(404);
      const api=createApiHandler({catalog:f.catalog,enrollmentTrust:f.trust});
      const response=await api(request());expect(response.status).toBe(200);
      const text=await response.text();for(const t of f.tokens)expect(text).not.toContain(t.token);
      expect(JSON.parse(text)).toMatchObject({state:'active',receiptId:f.claims.receiptId});
      f.catalog.apply({principal:'system',clientClass:'kl-device'},{kind:'system'},{kind:'token.revoke',tokenHash:f.tokens[1]!.hash,reason:'owner'});
      expect((await api(request())).status).toBe(200); // metadata retry never resurrects grants
      expect(authenticate(f.db,f.tokens[1]!.token,f.trust.now())).toMatchObject({ok:false,reason:'revoked'});
      expect((await api(new Request('https://enrollment.invalid/v1/enroll',{method:'POST',body:'{'}))).status).toBe(400);
    }finally{f.db.close();}
  });
  it('accepts a bounded long receipt identifier without putting it in cleartext in the event payload',async()=>{
    const f=await enrollmentFixture();try{
      const receiptId='receipt-'+ 'a'.repeat(64),approval=await f.resign({...f.claims,receiptId});
      const grant=await verifyEnrollment(approval,f.acceptance,f.trust);
      f.catalog.enroll(grant);
      const ev=f.db.get<{payload:string}>("SELECT payload FROM events WHERE kind='enrollment.initialize'");
      expect(ev?.payload).toContain(sha256Hex(receiptId));expect(ev?.payload).not.toContain(receiptId);
    }finally{f.db.close();}
  });
});
