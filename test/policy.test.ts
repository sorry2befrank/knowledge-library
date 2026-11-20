import { describe, it, expect, beforeAll } from "vitest";
import { generateServiceKey, importPublicKey, signAcceptance, verifyAcceptance, loadPolicy, bundleHash, type Trust, type PolicyBundle } from "@kl/core";

const bundle: PolicyBundle = { files: { "focus.json": { enabled: true, max_removals_per_run: 30 }, "privacy.json": { classes: ["team"] } } };
let trust: Trust, priv: CryptoKey, otherPriv: CryptoKey;

beforeAll(async () => {
  const k = await generateServiceKey();
  priv = k.privateKey;
  trust = { publicKey: await importPublicKey(k.publicKeyB64), keyId: k.keyId, minEpoch: 3 };
  otherPriv = (await generateServiceKey()).privateKey;
});

describe("signed policy loader with anti-rollback epochs (A21 subset, DESIGN §2.7)", () => {
  it("accepts a correctly signed acceptance at a newer epoch", async () => {
    const acc = await signAcceptance(priv, { policyHash: bundleHash(bundle), epoch: 4, receiptId: "rcpt-synthetic", keyId: trust.keyId });
    expect(await verifyAcceptance(acc, bundleHash(bundle), trust)).toEqual({ ok: true, epoch: 4 });
    const p = await loadPolicy(bundle, acc, trust);
    expect(p.mode).toBe("accepted"); expect(p.removals).toBe(true);
  });
  it("fails closed when unsigned, wrongly signed, hash-mismatched or at an older epoch", async () => {
    const h = bundleHash(bundle);
    const unsigned = { policyHash: h, epoch: 4, receiptId: "r", keyId: trust.keyId };
    expect(await verifyAcceptance(unsigned, h, trust)).toEqual({ ok: false, reason: "unsigned" });
    const wrong = await signAcceptance(otherPriv, { policyHash: h, epoch: 4, receiptId: "r", keyId: trust.keyId });
    expect(await verifyAcceptance(wrong, h, trust)).toEqual({ ok: false, reason: "bad-signature" });
    const tampered = { ...(await signAcceptance(priv, { policyHash: h, epoch: 4, receiptId: "r", keyId: trust.keyId })), epoch: 9 };
    expect(await verifyAcceptance(tampered, h, trust)).toEqual({ ok: false, reason: "bad-signature" });
    const mismatch = await signAcceptance(priv, { policyHash: "0".repeat(64), epoch: 4, receiptId: "r", keyId: trust.keyId });
    expect(await verifyAcceptance(mismatch, h, trust)).toEqual({ ok: false, reason: "hash-mismatch" });
    const current = await signAcceptance(priv, { policyHash: h, epoch: 3, receiptId: "r", keyId: trust.keyId }); // epoch == min: the current policy loads
    expect(await verifyAcceptance(current, h, trust)).toEqual({ ok: true, epoch: 3 });
    const older = await signAcceptance(priv, { policyHash: h, epoch: 2, receiptId: "r", keyId: trust.keyId }); // valid signature, epoch below the floor
    expect(await verifyAcceptance(older, h, trust)).toEqual({ ok: false, reason: "epoch-rollback" });
    const otherKey = await signAcceptance(priv, { policyHash: h, epoch: 4, receiptId: "r", keyId: "someone-else" });
    expect(await verifyAcceptance(otherKey, h, trust)).toEqual({ ok: false, reason: "unknown-key" });
    for (const bad of [unsigned, wrong, mismatch, older, undefined, null, "garbage"]) {
      const p = await loadPolicy(bundle, bad, trust);
      expect(p.mode).toBe("fail-closed"); expect(p.removals).toBe(false); expect(p.proposalsOnly).toBe(true); expect(p.acceptNewTeamClass).toBe(false); expect(p.files).toEqual({});
    }
    expect((await loadPolicy(undefined, unsigned, trust)).mode).toBe("fail-closed");
  });
  it("the catalog's policy.accept op is receipt-gated and refuses epoch rollback even past the gate", async () => {
    const { newCatalog } = await import("./helpers/load.ts");
    const { generateFixtures } = await import("../fixtures/gen.ts");
    const { catalog } = newCatalog(generateFixtures());
    expect(() => catalog.apply({ principal: "frank", clientClass: "kl-device" }, { kind: "principal" }, { kind: "policy.accept", epoch: 1, policyHash: "0".repeat(64), receiptId: "r", sig: "s" })).toThrow(/receipt-required/);
    expect(() => catalog.apply({ principal: "frank", clientClass: "kl-device" }, { kind: "receipt", receipt: undefined }, { kind: "policy.accept", epoch: 1, policyHash: "0".repeat(64), receiptId: "r", sig: "s" })).toThrow(/no-approval-channel/);
  });
});
