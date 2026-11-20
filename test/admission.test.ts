import { describe, it, expect } from "vitest";
import { admit, ADMISSION_RULE_CODES, sha256Hex, matchesClientName } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";

const fx = generateFixtures();
const rules = fx.denyRules;

describe("admission guard (A8)", () => {
  it("gives every fixture note its expected outcome, and its expected rule codes", () => {
    for (const n of fx.notes) {
      const r = admit(rules, { requestId: "r", content: n.body, path: `${n.folder}/${n.relPath}`, requestedCollection: n.collection });
      expect(r.outcome, `${n.folder}/${n.relPath}`).toBe(n.expected.admission);
      for (const code of n.expected.ruleCodes) expect(r.ruleCodes, `${n.relPath} should carry ${code}`).toContain(code);
    }
  });
  it("has a passing reject test for every rejecting rule code", () => {
    const seen = new Set<string>();
    for (const n of fx.notes) { const r = admit(rules, { requestId: "r", content: n.body, path: `${n.folder}/${n.relPath}` }); if (r.outcome === "rejected") r.ruleCodes.forEach((c) => seen.add(c)); }
    for (const code of ["secret.file.badname", "secret.credential", "student.content", "student.path", "deny.segment", "deny.client-ledger", "client.match.no-store-ok"]) expect(seen.has(code), code).toBe(true);
    for (const { code } of rules.contentPatterns) if (code !== "secret.credential.square-like") expect(seen.has(code), code).toBe(true);
    // the square-like pattern has no fixture note; prove it directly
    expect(admit(rules, { requestId: "r", content: `K012${"A".repeat(27)}` }).ruleCodes).toContain("secret.credential.square-like");
    expect([...seen].every((c) => (ADMISSION_RULE_CODES as readonly string[]).includes(c) || c.startsWith("secret.credential."))).toBe(true);
  });
  it("never returns matched text, and revokes a found klb_ token by hash only", () => {
    const token = `klb_${"b".repeat(43)}`;
    const r = admit(rules, { requestId: "req-1", content: `my token is ${token} keep it safe` });
    expect(r.outcome).toBe("rejected");
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.revokeTokenHashes).toEqual([sha256Hex(token)]);
    expect(r.requestId).toBe("req-1");
  });
  it("stores client material only with a store_ok decision, quarantining a mismatched destination", () => {
    const content = "Notes for Examplecorp Robotics about the retainer.";
    const none = admit(rules, { requestId: "r", content });
    expect(none.outcome).toBe("rejected"); expect(none.ruleCodes).toEqual(["client.match.no-store-ok"]);
    const ok = admit(rules, { requestId: "r", content, requestedCollection: "col:client-examplecorp", decisions: [{ client: "examplecorp robotics", store_ok: true, clients_ok: [], collection: "col:client-examplecorp" }] });
    expect(ok.outcome).toBe("admitted"); expect(ok.destination).toEqual({ collection: "col:client-examplecorp", quarantine: false });
    const q = admit(rules, { requestId: "r", content, requestedCollection: "col:synth-desk", decisions: [{ client: "Examplecorp Robotics", store_ok: true, clients_ok: [], collection: "col:client-examplecorp" }] });
    expect(q.outcome).toBe("admitted"); expect(q.destination?.quarantine).toBe(true); expect(q.ruleCodes).toContain("client.match.quarantine");
  });
  it("matches client names literally over the stated normalization, with word boundaries", () => {
    expect(matchesClientName("Met with EXAMPLECORP   robotics, again", "Examplecorp Robotics")).toBe(true);
    expect(matchesClientName("examplecorporate robotics", "Examplecorp Robotics")).toBe(false);
    expect(matchesClientName("Placeholder & Sample Bakery", "Placeholder and Sample Bakery")).toBe(false); // '&' is not 'and': literal, not fuzzy
  });
  it("applies the server's lineage decision: held at the stated ceiling in the saver's inbox", () => {
    const r = admit(rules, { requestId: "r", content: "team summary of something private", requestedCollection: "col:synth-desk", saverInbox: "inbox:frank", lineage: { hold: true, code: "lineage-uncertain", ceiling: "frank-private" } });
    expect(r.outcome).toBe("held"); expect(r.ruleCodes).toEqual(["lineage-uncertain"]); expect(r.destination).toEqual({ collection: "inbox:frank", quarantine: true, privacyClassCeiling: "frank-private" });
    expect(admit(rules, { requestId: "r", content: "team summary", requestedCollection: "col:synth-desk", lineage: { hold: false } }).outcome).toBe("admitted");
  });
  it("scans every stored string: title, tags, kind, topic and detail, and credentials in the path", () => {
    const token = `klb_${"c".repeat(49)}`;
    for (const fields of [{ title: `my ${token}` }, { tags: ["ok", `sk_live_${"A".repeat(20)}`] }, { kind: "Examplecorp Robotics" }, { topic: `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}` }, { detail: "Placeholder and Sample Bakery meeting" }]) {
      const r = admit(rules, { requestId: "r", content: "clean body", fields });
      expect(r.outcome, JSON.stringify(fields)).toBe("rejected");
    }
    expect(admit(rules, { requestId: "r", content: "clean", fields: { title: `t ${token}` } }).revokeTokenHashes).toEqual([sha256Hex(token)]);
    expect(admit(rules, { requestId: "r", content: "clean", path: `notes/sk-ant-${"x".repeat(24)}.md` }).ruleCodes).toContain("secret.credential.anthropic-like");
  });
  it("student records need 2+ content signatures or a path signature", () => {
    expect(admit(rules, { requestId: "r", content: "Report card season again" }).outcome).toBe("admitted");
    expect(admit(rules, { requestId: "r", content: "Report card attached; Student ID: 1" }).ruleCodes).toContain("student.content");
    expect(admit(rules, { requestId: "r", content: "nothing", path: "x/gradebook/y.md" }).ruleCodes).toContain("student.path");
  });
});
