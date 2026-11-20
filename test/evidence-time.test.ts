import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validate, validateEvidence } from "@kl/contracts";

const now = "2026-10-04T18:00:00.000Z";
const load = (name = "positive") => JSON.parse(readFileSync(`schemas/fixtures/library-evidence/v1/${name}.json`, "utf8"));

describe("evidence time semantics", () => {
  it.each([false, true])("orders pre-epoch retries without an epoch-zero clamp (reversed=%s)", reverse => {
    const doc = load("failure-then-retry");
    for (const op of doc.operations) op.timestamps = { RECEIVED: op.result === "failed" ? "1960-01-01T00:00:00Z" : "1961-01-01T00:00:00Z" };
    if (reverse) doc.operations.reverse();
    expect(validate("library-evidence/v1", doc).valid).toBe(true);
    const result = validateEvidence(doc, { now });
    expect(result.valid).toBe(true);
    expect(result.verdicts["ingest-custody"]).toBe("verified");
  });

  it.each([{}, { COMMITTED: "2016-12-31T23:59:60Z" }])("rejects operations with unusable ordering times: %j", timestamps => {
    const doc = load();
    doc.operations[0].timestamps = timestamps;
    expect(validate("library-evidence/v1", doc).valid).toBe(true);
    const result = validateEvidence(doc, { now });
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toMatch(/operations\/0\/timestamps/);
    expect(result.verdicts).toEqual({});
    expect(result.freshness).toBe("unknown");
    expect(result.stale).toBe(true);
  });

  it.each(["not-a-date", "", "2016-12-31T23:59:60Z"])("marks an unusable consumer clock unknown: %j", clock => {
    const doc = load();
    const result = validateEvidence(doc, { now: clock });
    expect(result.valid).toBe(true);
    expect(result.freshness).toBe("unknown");
    expect(result.stale).toBe(true);
    expect(result.verdicts).toEqual(validateEvidence(doc, { now }).verdicts);
  });

  it.each(["not-a-date", "", "2027-01-01T00:00:00Z"])("marks an unusable or future acceptance unknown when sync is absent: %j", acceptedAt => {
    const doc = load();
    doc.freshness.lastSuccessfulSync = null;
    const result = validateEvidence(doc, { now, acceptedAt });
    expect(result.valid).toBe(true);
    expect(result.freshness).toBe("unknown");
    expect(result.stale).toBe(true);
    expect(result.verdicts).toEqual(validateEvidence(load(), { now }).verdicts);
  });

  it.each(["sync", "observation"])("marks a schema-valid but unparseable %s unknown", field => {
    const doc = load();
    if (field === "sync") doc.freshness.lastSuccessfulSync = "2016-12-31T23:59:60Z";
    else doc.observedAt = "2016-12-31T23:59:60Z";
    expect(validate("library-evidence/v1", doc).valid).toBe(true);
    const result = validateEvidence(doc, { now, acceptedAt: now });
    expect(result.valid).toBe(true);
    expect(result.freshness).toBe("unknown");
    expect(result.stale).toBe(true);
  });

  it("retains sync precedence over invalid unused acceptance and the observed-at cap", () => {
    const doc = load();
    expect(validateEvidence(doc, { now, acceptedAt: "invalid unused fallback" }).freshness).toBe("fresh");
    doc.observedAt = "2026-10-04T17:00:00Z";
    expect(validateEvidence(doc, { now, acceptedAt: now }).freshness).toBe("stale");
  });

  it("accepts the skew boundary and marks a later acceptance unknown", () => {
    const doc = load();
    doc.freshness.lastSuccessfulSync = null;
    expect(validateEvidence(doc, { now, acceptedAt: "2026-10-04T18:02:00Z" }).freshness).toBe("fresh");
    expect(validateEvidence(doc, { now, acceptedAt: "2026-10-04T18:02:00.001Z" }).freshness).toBe("unknown");
  });
});
