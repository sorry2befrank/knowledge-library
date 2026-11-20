import { beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { admit, bundleHash, generateServiceKey, loadReferenceAdmissionRules, signAcceptance, type DenyRules } from "@kl/core";

let rules: DenyRules;
beforeAll(async () => {
  const key = await generateServiceKey();
  const bundle = { files: {
    "deny.reference.json": JSON.parse(readFileSync(new URL("../policy/deny.template.json", import.meta.url), "utf8")),
    "deny.private.json": { ownerApprovedRevision: "fixture-ledger-revision", projectAndClientDeniedDirectorySegments: [], projectAuditDirectoryPatterns: [], privateOperationalPathSignatures: [], clientClassificationRules: [], privateLedgerPathRules: ["PRIVATE-LEDGER.md", "department/MEMORY.md"] },
  } };
  const trust = { publicKey: key.publicKey, keyId: key.keyId, minEpoch: 1 };
  const record = await signAcceptance(key.privateKey, { policyHash: bundleHash(bundle), epoch: 1, receiptId: "fixture-ledger-receipt", keyId: key.keyId });
  rules = await loadReferenceAdmissionRules(bundle, record, trust);
});

it.each(["project/PRIVATE-LEDGER.md", "department/MEMORY.md", "project/private-ledger.md", "DEPARTMENT\\memory.md"])("rejects accepted private ledger path %s", path => {
  const result = admit(rules, { requestId: "fixture-ledger", path, content: "neutral fixture content" });
  expect(result.outcome).toBe("rejected"); expect(result.admitted).toBeUndefined();
  expect(result.ruleCodes).toContain("deny.client-ledger");
});
it.each(["project/not-private-ledger.md", "other-department/memory.md"])("does not widen literal ledger rule to near-miss %s", path => {
  const result = admit(rules, { requestId: "fixture-ledger", path, content: "neutral fixture content" });
  expect(result.outcome).toBe("admitted"); expect(result.ruleCodes).not.toContain("deny.client-ledger");
});
