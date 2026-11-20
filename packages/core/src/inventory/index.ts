// The reference inventory (DESIGN §6.3): a read-only source port, its memory model, the generation record and
// extraction, the read-only git port and the local refs.sqlite store. No eligibility decision lives here (S2f).
export * from "./source.ts";
export * from "./memory-source.ts";
export * from "./inventory.ts";
export * from "./git-port.ts";
export * from "./store.ts";
