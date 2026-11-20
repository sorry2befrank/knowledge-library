# Evolution event: observed schema and Library additions

Reference derived from `orrery-evolution`. This is a description of its version-1 event shape; no live evolution ledger, event or runtime receipt is exported.

## Observed source declarations

`EVOLUTION_CONTRACT_VERSION` is 1 (line 7). `EvolutionState` (line 11) has three values: `candidate`, `accepted`, `returned`. The source calls this field `state`; it declares no separate `kind` enum. `EvolutionScope` (lines 13–16) has string `capabilityKey` and string-array `folderScopeIds`.

| EvolutionEvent field | Declared type |
|---|---|
| `id`, `ts`, `persona` | string |
| `traceId` | optional string |
| `version` | number |
| `state` | `candidate` / `accepted` / `returned` |
| `taskDigest`, `crewDigest`, `capabilityKey` | string |
| `folderScopeIds` | string array |
| `evidenceCount`, `checkCount`, `errorCount` | number |
| `resultDigest`, `lessonDigest`, `regressionDigest` | string |

Source declaration lines 18–35 are a TypeScript interface, not a complete runtime JSON validator. `evolutionEvents` (lines 143–149) filters only truthiness, exact contract version, the three states and a string `taskDigest`. A malformed row may pass that reader even when it lacks other declared fields. A new Library validator must not repeat that weak check as schema validation.

## Synthetic source-shaped event

```json
{
  "id": "synthetic-evolution-001",
  "traceId": "synthetic-trace-001",
  "ts": "2030-01-02T12:00:00.000Z",
  "version": 1,
  "state": "candidate",
  "persona": "synthetic-persona",
  "taskDigest": "synthetic-task-digest",
  "crewDigest": "synthetic-crew-digest",
  "capabilityKey": "synthetic-capability",
  "folderScopeIds": ["synthetic-folder-scope"],
  "evidenceCount": 2,
  "checkCount": 1,
  "errorCount": 0,
  "resultDigest": "synthetic-result-digest",
  "lessonDigest": "synthetic-lesson-digest",
  "regressionDigest": "synthetic-regression-digest"
}
```

The digest placeholders deliberately are not real identifiers or outputs from private inputs. This example tests declared shape only. Production hash derivation has separate requirements.

## Source derivation and safety boundaries

The source hashes text with SHA-256 and truncates its opaque prefixed IDs to 20 hex characters (lines 44–49). Capability derivation uses persona and task type; folder scope derivation uses normalized folder paths plus a resolved home (lines 86–110). `cleanRelative` rejects absolute paths and selected parent traversal forms (lines 52–65). These functions create source-specific identities; they are not a general path-safety validator or an anonymization proof.

`appendEvolutionEvent` (lines 113–141) writes a candidate/accepted/returned row with counts and digests. It clamps finite negative error counts toward zero through `Math.max(0, Math.floor(...))`; there is no explicit finite-number check, so callers must not assume NaN/infinite values are validated. It creates IDs, timestamps and trace references at runtime. It does not itself establish owner approval, validate a lesson, authenticate labels or promote a champion.

`hasEvolutionCandidate` (lines 152–160) requires a candidate with matching task/result digests and `errorCount === 0`. `evolutionSummary` counts rows by state. Neither turns accepted rows into Library capability authority.

## Library additions

The Library separately needs principal attribution, privacy/collection scope, independent label provenance, baseline/champion identity, review/approval evidence and explicit unknown outcomes. Those are design requirements, not fields already supplied by `EvolutionEvent`. The cloud lane owns the adaptation's JSON schema and version. Keep its learning events distinct from the canonical `library-evidence/v1` status envelope.

Reviewed promotions ship first. A rank change with unknown expected outcomes is a rank change, not an accuracy gain. Agent-generated actions, restores, ghosts, trails and multi-principal agreement remain unconfirmed observations until the owner mechanism supplies the required confirmation.

The shared fixture file distinguishes the source reader's weak acceptance from proposed Library validation requirements. It includes all three states, wrong versions/states, missing declared fields and invalid counts. Attribution/source hash and transforms are retained in pack provenance; the pack is published under the repository's MIT license.
