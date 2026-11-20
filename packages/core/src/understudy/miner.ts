// Deterministic, $0 generator (DESIGN §7.7 step 1): synonym mining from (query, needed note) pairs,
// TRAIN SPLIT ONLY. Held-out and audit cases are never visible to this function: it queries split='train'.
import type { Catalog } from "../catalog/catalog.ts";
import { tokenize } from "../catalog/search.ts";
import type { RetrievalPlaybook } from "./baseline.ts";
import { labelledPairs, type GoldenQuery } from "./replay.ts";

const STOP = new Set(["the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "is", "are", "current", "our", "my", "this", "that", "with", "about"]);

export interface MinedCandidate { playbook: RetrievalPlaybook; targetGroups: string[]; delta: { synonyms: Record<string, string[]> }; trainCases: number }

/**
 * For each LABELLED train pair (receipt-confirmed case or golden query) whose query terms are absent from the needed
 * note's title, map those terms to the title phrase. Unconfirmed observations are never mined (DESIGN §7.8 labels).
 */
export function mineSynonyms(catalog: Catalog, champion: RetrievalPlaybook, key: { scopeId: string; privacy: string }, goldens: GoldenQuery[] = []): MinedCandidate {
  const train = labelledPairs(catalog, key.privacy, goldens, key.scopeId, "train");
  const synonyms: Record<string, Set<string>> = {};
  const groups = new Set<string>();
  for (const c of train) {
    const q = c.q;
    const title = c.title; // already checked under the lesson scope and the source's current version/client ACL
    if (!title) continue;
    const titleTokens = tokenize(title.replace(/[-_]+/g, " ")).filter((t) => !/^\d+$/.test(t));
    const phrase = titleTokens.join(" ");
    if (!phrase) continue;
    const terms = tokenize(q).filter((t) => !STOP.has(t));
    const absent = terms.filter((t) => !titleTokens.some((tt) => tt === t || (t.length >= 4 && tt.startsWith(t.slice(0, -1)))));
    if (absent.length === 0) continue;
    // one rule per query (multiword key when every term is absent), else per absent term
    const key2 = absent.length === terms.length && terms.length > 1 ? terms.join(" ") : null;
    for (const k of key2 ? [key2] : absent) { (synonyms[k] ??= new Set()).add(phrase); }
    groups.add(c.groupKey);
  }
  const merged: Record<string, string[]> = { ...champion.synonyms };
  for (const [k, v] of Object.entries(synonyms)) merged[k] = [...new Set([...(merged[k] ?? []), ...v])].sort();
  const playbook: RetrievalPlaybook = { ...champion, version: `${champion.version}+syn${Object.keys(synonyms).length}`, synonyms: merged };
  return { playbook, targetGroups: [...groups].sort(), delta: { synonyms: Object.fromEntries(Object.entries(synonyms).map(([k, v]) => [k, [...v].sort()])) }, trainCases: train.length };
}
