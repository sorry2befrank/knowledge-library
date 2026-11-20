import { expect, it } from 'vitest';
import { recheck } from '../packages/core/src/focus/recheck.ts';
import { collectKernelInputs } from '../packages/core/src/focus/collect-kernel-inputs.ts';
import { eligible } from '../packages/core/src/focus/kernel-adapter.ts';
import { fixture, NOW } from './helpers/s2f-adapter-fixture.ts';

it('recheck drops a fresh pin with the actual rule label and retains its eligible peer', async () => {
  const { c, ports } = await fixture(), original = await collectKernelInputs(c, ports), initial = eligible(...original);
  const fresh = structuredClone(original), blocked = initial.kernel.eligible[0]!, kept = initial.kernel.eligible[1]!;
  fresh[3].files.find(row => row.id === blocked)!.value!.kinds = ['feedback'];
  const result = recheck(initial.kernel.eligible, fresh);
  expect(result.retained).toEqual([kept]); expect(result.dropped).toEqual([{ id: blocked, reasons: ['ineligible-now:2'], globalHolds: [] }]);
  expect(result.effect).toBe('none');
});
it('proposal closure keeps a target when its linked eligible source is omitted from R', async () => {
  const { c, ports } = await fixture(), inputs = await collectKernelInputs(c, ports), ids = eligible(...inputs).kernel.eligible;
  inputs[7].edges = [{ id: 'group-link', source: ids[0]!, target: ids[1]!, kind: 'path' }];
  expect(eligible(...inputs).kernel.eligible).toEqual(ids);
  const result = recheck([ids[1]!], inputs);
  expect(result.retained).toEqual([]); expect(result.dropped[0]!.reasons).toEqual(['ineligible-now:7']);
});
it('whole-input goal refusal is named explicitly rather than inventing a numbered rule', async () => {
  const { c, ports } = await fixture(), inputs = await collectKernelInputs(c, ports), ids = eligible(...inputs).kernel.eligible;
  inputs[1].expiresAtMs = NOW;
  const result = recheck(ids, inputs); expect(result.retained).toEqual([]);
  for (const drop of result.dropped) { expect(drop.reasons).toEqual(['ineligible-now:global']); expect(drop.globalHolds).toContain('goal-expired-or-invalid'); }
});
