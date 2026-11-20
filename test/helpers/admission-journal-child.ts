// Fixed synthetic test worker. No provider, helper process, cleanup, network or real state bootstrap.
import { openAdmissionJournal, openFullAdmissionSqlite } from '../../packages/core/src/focus/node-admission-journal.ts';
import { binding, NOW } from './admission-journal-fixture.ts';
const input = JSON.parse(process.argv[2]!) as { path: string; mode: string; runId: string; journalId: string; stateHash: string };
if (input.mode === 'crash-transaction') {
  const db = openFullAdmissionSqlite(input.path);
  db.transaction(() => { db.run('UPDATE admission_state SET state_json = ? WHERE singleton = 1', ['broken-uncommitted']); process.exit(23); });
  throw Error('unreachable');
}
const result = openAdmissionJournal(input.path, NOW + 10);
if (result.status !== 'opened') throw Error('child-open-held');
function commit(): void {
  const value = result.status === 'opened' ? result.journal.transition({ nowMs: NOW + 10, expectedJournalId: input.journalId,
    expectedRevision: 0, expectedStateHash: input.stateHash, command: { type: 'admit', binding: binding(input.runId) } }) : null;
  if (input.mode === 'crash-after-commit') process.exit(value?.status === 'committed' ? 24 : 25);
  process.stdout.write(JSON.stringify(value) + '\n'); result.status === 'opened' && result.journal.close();
}
if (input.mode === 'concurrent') {
  process.stdout.write('ready\n'); process.stdin.setEncoding('utf8');
  process.stdin.once('data', data => { if (String(data) !== 'go\n') throw Error('child-invalid-barrier'); commit(); process.stdin.pause(); });
} else if (input.mode === 'crash-after-commit') commit();
else throw Error('child-invalid-mode');
