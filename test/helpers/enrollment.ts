import { readFile } from 'node:fs/promises';
import { Catalog, MemoryObjectStore, openNodeSqlite, generateServiceKey, signAcceptance, bundleHash,
  loadReferenceAdmissionRules, mintToken, sha256Hex, signEnrollment, verifyEnrollment,
  type EnrollmentClaims, type EnrollmentTrust } from '@kl/core';

export async function enrollmentFixture(initialTime = '2026-10-18T12:00:00.000Z') {
  let at = initialTime;
  const approvalKey = await generateServiceKey(), policyKey = await generateServiceKey();
  const bundle = {files:{'deny.reference.json':JSON.parse(await readFile('policy/deny.template.json','utf8')),
    'deny.private.json':{ownerApprovedRevision:'synthetic-enrollment',projectAndClientDeniedDirectorySegments:['fixture-private'],
      projectAuditDirectoryPatterns:[{source:'^fixture-audit-',flags:'i'}],privateOperationalPathSignatures:['/fixture-records/'],
      clientClassificationRules:['Example Orchard'],privateLedgerPathRules:['FIXTURE-LEDGER.md']}}};
  const acceptance = await signAcceptance(policyKey.privateKey,{policyHash:bundleHash(bundle),epoch:1,receiptId:'policy-fixture',keyId:policyKey.keyId});
  const denyRules = await loadReferenceAdmissionRules(bundle,acceptance,{publicKey:policyKey.publicKey,keyId:policyKey.keyId,minEpoch:1});
  const tokens = ['kl-device','cc-bearer','cx-bearer'].map(kind => ({kind:kind as 'kl-device'|'cc-bearer'|'cx-bearer',
    ...mintToken(n=>crypto.getRandomValues(new Uint8Array(n)))}));
  const claims: EnrollmentClaims = {schema:'kl-enrollment/v1',receiptId:'enrollment-fixture',nonce:sha256Hex('synthetic-nonce'),principal:'fixture-owner',
    audience:{origin:'https://enrollment.invalid',environment:'staging',libraryId:'library-fixture'},
    folder:{folderId:'folder:fixture',device:'fixture-device',volumeSerial:'node-dev:1',rootFileId:'node-ino:2',
      displayPathHash:sha256Hex('synthetic-path'),collectionId:'col:fixture',privacyClass:'team'},
    registrationHash:sha256Hex('synthetic-registration'),privacyCensusHash:sha256Hex('synthetic-census'),
    policy:{policyHash:acceptance.policyHash,epoch:1,receiptId:acceptance.receiptId},
    tokens:tokens.map(t=>({kind:t.kind,hash:t.hash,expiresAt:new Date(Date.parse(at)+86_400_000).toISOString()})),
    issuedAt:at,expiresAt:new Date(Date.parse(at)+900_000).toISOString()};
  const trust: EnrollmentTrust = {approval:{keyId:approvalKey.keyId,publicKeyB64:approvalKey.publicKeyB64},
    policy:{publicKey:policyKey.publicKey,keyId:policyKey.keyId,minEpoch:1,policyHash:acceptance.policyHash},
    audience:claims.audience,now:()=>at};
  const approval = await signEnrollment(claims,approvalKey.keyId,approvalKey.privateKey);
  const blobStore = new MemoryObjectStore(), mirror = new MemoryObjectStore(), db = openNodeSqlite();
  const catalog = new Catalog({db,blobStore,mirror,clock:{now:()=>at},denyRules});
  const grant = await verifyEnrollment(approval,acceptance,trust);
  return {approvalKey,policyKey,bundle,acceptance,claims,trust,approval,tokens,blobStore,mirror,db,catalog,grant,denyRules,
    setTime(value:string){at=value;}, async resign(next:EnrollmentClaims){return signEnrollment(next,approvalKey.keyId,approvalKey.privateKey);}};
}
