// Test-local learned ranking only. It receives note cards, never factual kernel evidence or authority.
export interface ScorerCard { id: string; terms: readonly string[] }
export interface GeneratedPlaybook { scores: readonly { id: string; value: number }[]; threshold: number; expansionBoost: number }
export interface GeneratedCorrection { id: string; keep: boolean }
export interface GeneratedExpansion { term: string; weight: number }
export function testLocalScorer(cards: readonly ScorerCard[], playbook: GeneratedPlaybook,
  corrections: readonly GeneratedCorrection[], expansions: readonly GeneratedExpansion[]): string[] {
  const scores = new Map(playbook.scores.map(row => [row.id, row.value]));
  const keep = new Set(corrections.filter(row => row.keep).map(row => row.id));
  return cards.map(card => ({ id: card.id, score: (scores.get(card.id) ?? Infinity)
    + playbook.expansionBoost * expansions.filter(expansion => card.terms.includes(expansion.term)).reduce((total, expansion) => total + expansion.weight, 0) }))
    .filter(row => row.score <= playbook.threshold && !keep.has(row.id))
    .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(row => row.id);
}
