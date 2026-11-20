// Frozen baseline v0: the first opponent for every candidate (DESIGN §7.8 "Day 0"). Data only.
import { sha256Hex } from "../primitives/sha256.ts";
import { canonicalJson } from "../primitives/canonical.ts";

export interface RetrievalPlaybook {
  capability: "retrieval";
  version: string;
  synonyms: Record<string, string[]>;      // query term -> alternatives (phrases allowed)
  bm25Weights: { title: number; headings: number; tags: number; body: number; path: number };
  rerank: { bm25: number; title: number; tag: number; recency: number; superseded: number; kindPrior: Record<string, number> };
  retrievalMode: "keyword";
  consumes: Record<string, string>;
}

function deepFreeze<T>(o: T): T { if (o && typeof o === "object") { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); } return o; }

export const BASELINE_V0: RetrievalPlaybook = deepFreeze({
  capability: "retrieval",
  version: "v0",
  synonyms: {},
  bm25Weights: { title: 4, headings: 2, tags: 2, body: 1, path: 1 },
  rerank: { bm25: 1.0, title: 2.0, tag: 0.5, recency: 0.3, superseded: 1.5, kindPrior: { decision: 0.4, implementation: 0.2, handoff: 0.1, status: 0.1, note: 0.0, log: -0.2, turnover: -0.1, binary: -0.5 } },
  retrievalMode: "keyword",
  consumes: {},
}) as RetrievalPlaybook;

export const RETRIEVAL_ALLOWLIST = ["synonyms", "bm25Weights", "rerank", "retrievalMode"] as const;

export function playbookHash(p: object): string { return sha256Hex(canonicalJson(p)); }
export const BASELINE_V0_HASH = playbookHash(BASELINE_V0);
