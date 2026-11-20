import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate, validateEvidence, verifySignedEvidence, SCHEMAS, schemaHash, type SchemaName } from "@kl/contracts";
import { importPublicKey } from "@kl/core";
import { admit, ADMISSION_RULE_CODES } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";

const FIX = "schemas/fixtures";
// S1c pins (SHA-256 of the LF-normalized schema files). Recorded in DESIGN after the merge; any later change is v2.
export const PIN_EVIDENCE = "36da96ee56d763a152c90bdf7310f15cd23cf9ce9898f8d0a446a8a72dbc7239";
export const PIN_SIGNED = "2d3f28ddceeccbc54d4b8520543ed4e35ab22b17f6f38a50037a179b52a8386b";
const load = (dir: string, name: string) => JSON.parse(readFileSync(join(FIX, dir, name), "utf8"));

describe("contracts: every schema compiles and its fixtures sort correctly", () => {
  for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
    const dir = name.replace("/", "/"); // e.g. admission-result/v1
    const files = readdirSync(join(FIX, dir)).filter((f) => f.endsWith(".json") && f !== "expected.json" && f !== "trust.json");
    it(`${name}: ${files.length} fixtures`, async () => {
      expect(await schemaHash(name)).toMatch(/^[0-9a-f]{64}$/);
      for (const f of files) {
        const r = validate(name, load(dir, f));
        if (!f.startsWith("invalid")) expect(r.valid, `${f}: ${r.errors.join("; ")}`).toBe(true);
        else expect(r.valid, `${f} should be invalid`).toBe(false);
      }
    });
  }
});

describe("library-evidence/v1 (A29 schema and fixtures)", () => {
  const dir = "library-evidence/v1";
  const expected = load(dir, "expected.json");
  for (const name of Object.keys(expected).filter((k) => k !== "now")) {
    it(`${name} fixture gives the expected validity, verdicts, freshness and duplicate flag`, () => {
      const want = expected[name];
      const r = validateEvidence(load(dir, `${name}.json`), { now: expected.now, previousSequence: 11, ...(want.options ?? {}) });
      expect(r.valid, r.errors.join("; ")).toBe(want.valid);
      if (want.verdicts) expect(r.verdicts).toEqual(want.verdicts);
      if (want.freshness) expect(r.freshness).toBe(want.freshness);
      if (want.operationErrors !== undefined) expect(r.operationErrors.length).toBe(want.operationErrors);
      expect(r.duplicate).toBe(want.duplicate === true);
    });
  }
  it("every ruling fixture is present, and the invalid ones name a semantic reason, not only a schema one", () => {
    for (const f of ["one-run-two-versions-pending", "one-run-two-versions-failed", "failure-then-retry", "received-no-receipt", "planned-under-retrieval", "guard-refused", "restore-requested", "tied-timestamps", "stale-sync-fresh-acceptance", "null-sync-accepted", "future-sync", "truncated-ordered", "truncated-misordered", "duplicate", "veil-written"]) expect(expected[f], f).toBeTruthy();
    expect(validateEvidence(load(dir, "inconsistent-counts.json"), { now: expected.now }).errors.join()).toMatch(/indexing.indexed/);
    expect(validate("library-evidence/v1", load(dir, "inconsistent-counts.json")).valid).toBe(true); // schema-valid; the semantic check rejects it
    expect(JSON.stringify(load(dir, "failure-then-retry.json").operations.map((o: { runId: string | null }) => o.runId))).toContain("run-8"); // fixtures with non-null runId exist
  });
  it("the latest attempt is keyed by sourceVersion, not runId; ties go to the worse outcome; a failed later attempt in another run blocks", () => {
    const doc = load(dir, "failure-then-retry.json");
    const swapped = { ...doc, operations: doc.operations.map((o: { runId: string; timestamps: Record<string, string> }) => (o.runId === "run-7" ? { ...o, timestamps: { RECEIVED: "2026-10-04T19:00:00.000Z" } } : o)) };
    expect(validateEvidence(swapped, { now: "2026-10-04T19:30:00.000Z" }).verdicts["ingest-custody"]).toBe("blocked"); // the failure is now the newest attempt
  });
  it("the truncation order rule makes every enabled milestone unproven when a verified attempt precedes a pending one", () => {
    const ok = validateEvidence(load(dir, "truncated-ordered.json"), { now: expected.now }), bad = validateEvidence(load(dir, "truncated-misordered.json"), { now: expected.now });
    expect(ok.valid && bad.valid).toBe(true);
    expect(ok.verdicts["retrieval-index"]).toBe("verified"); expect(bad.verdicts).toEqual({ "ingest-custody": "unproven", "retrieval-index": "unproven" });
  });
  it("the schema description declares the v1 omission (run and policy binding is a consumer check)", () => {
    const desc = (SCHEMAS["library-evidence/v1"] as { description: string }).description;
    expect(desc).toMatch(/declared v1 omission/); expect(desc).toMatch(/goalHash and policyHash/); expect(desc).not.toMatch(/none known/);
  });
  it("staleness is an overlay, not a verdict (S1b D3, decided 2026-10-04 22:45): stale or unknown freshness keeps every milestone verdict", () => {
    const fresh = validateEvidence(load(dir, "positive.json"), { now: expected.now });
    for (const name of ["stale", "fresh-producer-old-sync", "no-sync"]) {
      const r = validateEvidence(load(dir, `${name}.json`), { now: expected.now });
      expect(r.freshness, name).not.toBe("fresh");
      expect(r.verdicts, name).toEqual(fresh.verdicts); // the flag is added; the verdicts are untouched
      expect(r.valid).toBe(true);
    }
  });
  it("the two pins Orrery's adapter records are SHA-256 of the LF-normalized schema files (exact values; any change is v2)", async () => {
    expect(await schemaHash("library-evidence/v1")).toBe(PIN_EVIDENCE);
    expect(await schemaHash("library-evidence-signed/v1")).toBe(PIN_SIGNED);
  });
  it("rejects a sequence rollback and a snapshot over 1 MiB", () => {
    const doc = load(dir, "positive.json");
    expect(validateEvidence(doc, { previousSequence: 12 }).errors.join()).toMatch(/not monotonic/);
    const big = { ...doc, policyRevision: "x".repeat(1 << 20) };
    expect(validateEvidence(big).errors.join()).toMatch(/exceeds/);
  });
  it("a completed flag without proof fields is invalid at the schema level", () => {
    const doc = load(dir, "positive.json");
    doc.operations[0].proof = {};
    expect(validate("library-evidence/v1", doc).valid).toBe(false);
  });
});

describe("library-evidence-signed/v1 fixtures that really verify (S1c D8)", () => {
  const dir = "library-evidence-signed/v1";
  it("the valid wrapper verifies with the fixture trust key; the tampered one fails the signature; a wrong inner key is key-mismatch; a duplicate checkpoint is a no-op", async () => {
    const trust = load(dir, "trust.json") as { keyId: string; publicKeyB64: string };
    const t = { keyId: trust.keyId, publicKey: await importPublicKey(trust.publicKeyB64) };
    const good = await verifySignedEvidence(load(dir, "valid-signed.json"), t, { now: "2026-10-04T18:00:00.000Z", previousSequence: 11 });
    expect(good.signature).toBe("ok"); expect(good.valid, good.errors.join("; ")).toBe(true); expect(good.verdicts).toEqual({ "ingest-custody": "verified", "retrieval-index": "verified" }); expect(good.duplicate).toBe(false);
    expect((await verifySignedEvidence(load(dir, "tampered-signed.json"), t)).signature).toBe("bad-signature");
    expect((await verifySignedEvidence(load(dir, "key-mismatch-signed.json"), t)).signature).toBe("key-mismatch");
    expect((await verifySignedEvidence(load(dir, "valid-signed.json"), { ...t, keyId: "k-other" })).signature).toBe("unknown-key");
    const dup = await verifySignedEvidence(load(dir, "valid-signed.json"), t, { now: "2026-10-04T18:00:00.000Z", previousSequence: 12, accepted: { digest: (load(dir, "valid-signed.json") as { digest: string }).digest } });
    expect(dup.duplicate).toBe(true); expect(dup.valid).toBe(true); expect(dup.errors).toEqual([]); // before the sequence check: never a rollback
    const rollback = await verifySignedEvidence(load(dir, "valid-signed.json"), t, { now: "2026-10-04T18:00:00.000Z", previousSequence: 12 });
    expect(rollback.duplicate).toBe(false); expect(rollback.errors.join()).toMatch(/not monotonic/);
  });
});

describe("the admission guard's output conforms to admission-result/v1", () => {
  it("every declared guard rule code is representable in a rejected wire response", () => {
    for (const code of ADMISSION_RULE_CODES) {
      const result = validate("admission-result/v1", { requestId: "0".repeat(32), outcome: "rejected", ruleCodes: [code] });
      expect(result.valid, `${code}: ${result.errors.join("; ")}`).toBe(true);
    }
  });
  it("unavailable-policy refusal accepts only its exact code and never matched text or a destination", () => {
    const wire = { requestId: "0".repeat(32), outcome: "rejected", ruleCodes: ["policy.unavailable"] };
    expect(validate("admission-result/v1", wire).valid).toBe(true);
    for (const code of ["policyXunavailable", "policy.unavailable-extra", "policy.unknown"]) {
      expect(validate("admission-result/v1", { ...wire, ruleCodes: [code] }).valid, code).toBe(false);
    }
    expect(validate("admission-result/v1", { ...wire, matchedText: "fixture private reason" }).valid).toBe(false);
    expect(validate("admission-result/v1", { ...wire, destination: { collection: "col:fixture", quarantine: false } }).valid).toBe(false);
  });
  it("for every fixture note", () => {
    const fx = generateFixtures();
    for (const n of fx.notes) {
      const r = admit(fx.denyRules, { requestId: "0".repeat(32), content: n.body, path: `${n.folder}/${n.relPath}`, requestedCollection: n.collection });
      const wire = { requestId: r.requestId, outcome: r.outcome, ruleCodes: r.ruleCodes, ...(r.destination ? { destination: r.destination } : {}), revokedTokens: r.revokeTokenHashes.length };
      const v = validate("admission-result/v1", wire);
      expect(v.valid, `${n.relPath}: ${v.errors.join("; ")}`).toBe(true);
    }
  });
});

describe("persona manifest", () => {
  it("persona/understudy.librarian.frank-epps.manifest.json validates and names every forbidden tool", () => {
    const m = JSON.parse(readFileSync("persona/understudy.librarian.frank-epps.manifest.json", "utf8"));
    expect(validate("persona-manifest/v1", m).valid).toBe(true);
    expect(m.id).toBe("understudy.librarian.frank-epps"); expect(m.registryKey).toBe("librarian");
    expect(m.tools.never).toEqual(expect.arrayContaining(["policy.*", "acl.*", "retention.*", "roots.*", "eligibility.*", "pins.*", "ladder.*", "overrides.confirm", "delete", "purge"]));
  });
});
