import { expect, it } from 'vitest';
import { testLocalScorer } from './helpers/s2f-test-scorer.ts';
import { closeKernelProposal } from '../packages/core/src/focus/eligibility.ts';
import { collectKernelInputs } from '../packages/core/src/focus/collect-kernel-inputs.ts';
import { eligible } from '../packages/core/src/focus/kernel-adapter.ts';
import { fixture } from './helpers/s2f-adapter-fixture.ts';

it('expansion and correction controls change real closed proposals while factual E is identical', async () => {
  const { c, ports } = await fixture(), inputs = await collectKernelInputs(c, ports), output = eligible(...inputs);
  const ids = output.kernel.eligible, cards = ids.map((id, i) => ({ id, terms: [`topic-${i}`] }));
  const playbook = { scores: ids.map(id => ({ id, value: -1 })), threshold: 0, expansionBoost: 2 };
  const baseline = testLocalScorer(cards, playbook, [], []);
  const expanded = testLocalScorer(cards, playbook, [], [{ term: 'topic-0', weight: 1 }]);
  const corrected = testLocalScorer(cards, playbook, [{ id: ids[1]!, keep: true }], []);
  expect(closeKernelProposal(output.input, baseline).eligible).toEqual(ids);
  expect(closeKernelProposal(output.input, expanded).eligible).toEqual([ids[1]!]);
  expect(closeKernelProposal(output.input, corrected).eligible).toEqual([ids[0]!]);
  expect(eligible(...inputs)).toEqual(output);
});

it('an ineligible low-score card can enter the learned proposal but cannot enter the closed proposal', async () => {
  const { c, ports } = await fixture(), inputs = await collectKernelInputs(c, ports), id = inputs[0].files[0]!.id;
  inputs[3].files.find(row => row.id === id)!.value!.kinds = ['goal'];
  const output = eligible(...inputs), proposed = testLocalScorer([{ id, terms: ['topic'] }],
    { scores: [{ id, value: -100 }], threshold: 0, expansionBoost: 2 }, [], [{ term: 'topic', weight: 1 }]);
  expect(proposed).toEqual([id]); expect(closeKernelProposal(output.input, proposed).eligible).toEqual([]);
  expect(eligible(...inputs)).toEqual(output);
});
