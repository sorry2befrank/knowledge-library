// Fresh evidence only; the existing kernel owns intersection and repeated proposal closure.
import { closeKernelProposal, type Rule } from './eligibility.ts';
import { eligible, type KernelInputs } from './kernel-adapter.ts';

export type DropReason = `ineligible-now:${Rule}` | 'ineligible-now:global' | 'ineligible-now:not-in-snapshot';
export function recheck(proposed: readonly string[], fresh: KernelInputs) {
  const evidence = eligible(...fresh);
  const result = closeKernelProposal(evidence.input, proposed);
  const retained = result.eligible;
  const dropped = [...new Set(proposed)].filter(id => !retained.includes(id)).sort().map(id => {
    const proof = result.items[id];
    const reasons: DropReason[] = proof ? (Object.keys(proof).map(Number) as Rule[])
      .filter(rule => proof[rule].state !== 'pass').map(rule => `ineligible-now:${rule}` as DropReason) : [];
    // Goal/policy/shape refusals are whole-input holds, not invented numbered rules.
    if (!reasons.length) reasons.push(result.globalHolds.length ? 'ineligible-now:global' : 'ineligible-now:not-in-snapshot');
    return { id, reasons, globalHolds: [...result.globalHolds] };
  });
  return { retained, dropped, proof: result.items, globalHolds: result.globalHolds, effect: 'none' as const };
}
