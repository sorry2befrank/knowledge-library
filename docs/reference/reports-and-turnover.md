# Four-field reports and synthetic turnover

Reference derived from `orrery-personas`, `parseFourFields` (lines 125–162). No report, passdown or turnover from the workstation is copied.

## Parser compatibility

The source returns exactly four strings: `moved`, `blocked`, `hiring`, `next`. It accepts case-insensitive field labels with optional leading whitespace, optional `-`/`*` bullet and optional bold markers surrounding the label/colon. Text after the colon starts the capture; trailing asterisks are removed. Later nonblank lines append with a separating space until a heading, a line beginning with `---`, a blank line, or another recognized field stops/changes capture.

The source comment says "FIRST wins," but the code tests whether the accumulated field value is nonempty. Therefore the first **nonempty capture** wins. An empty first label can be filled by continuation or replaced by a later occurrence. A duplicate of a populated field sets the current capture to null, so its subsequent continuation is discarded until another field begins. Missing fields return empty strings; parse success is not a proof that the report is complete or its claims are true.

`LEARNED:` is not a recognized field. If it immediately follows `NEXT:` without a blank line or heading, it is appended to `next`. The Library must render `LEARNED` in its own heading-delimited section or use a separately versioned structured report. Extending the legacy parser must not silently alter the four-field projection consumed by Orrery.

## Synthetic source-compatible report

```markdown
## Report
MOVED: Prepared a synthetic reference candidate; no archive operation ran.
BLOCKED: Awaiting review of the candidate inventory.
HIRING: No new persona is hired by this report.
NEXT: Review the inventory and the canonical cloud schema.

## LEARNED
Saved: one synthetic case.
Tested: baseline replay only; accuracy is unknown without an independent label.
Deployed: none.
Demonstrated: none.
```

For the four-field parser, the `LEARNED` heading ends `NEXT` capture. The lesson section is additional Library presentation, not source parser output or generic rung authority.

## Synthetic turnover template

```markdown
# Turnover — synthetic run

Run identity: synthetic-run-001
Owner scope: synthetic-owner / synthetic-collection
Goal revision: synthetic-goal-001
Policy revision: synthetic-policy-001
Baseline/champion: synthetic-baseline-0 / synthetic-baseline-0

## Report
MOVED: Describe completed work and its verified evidence.
BLOCKED: Describe missing evidence or unresolved constraints.
HIRING: Describe owner decisions; never imply auto-hiring.
NEXT: State one concrete next action.

## LEARNED
Record saved/tested/deployed/demonstrated separately. Treat agent activity as
unconfirmed observations. Record unknown outcomes as unknown.

## Verification and recovery
State source coverage, stale/partial evidence and failure state.
State undo/recovery references and the exact scope of verification.
Do not embed private note content or credentials in the commons projection.

## Session funding
funding_source: codex
spend_usd: unknown
Allocation remaining: unknown
Receipt reference: synthetic-billing-receipt
```

Build-session turnovers use `persona/build-turnovers/YYYY-MM-DD-<slug>.md` and the fields in DESIGN.md §7.2 (Manifest and home): `funding_source:` is one of `credit|purchased|plan|codex`; `spend_usd:` records actual spend from the balance or billing page; allocation remaining is also recorded. The synthetic example uses `unknown` rather than inventing spend or a balance (S1b exit evidence permits unknown spend).

The other template labels are illustrative documentation, not a frozen turnover JSON schema. The cloud lane defines actual storage/rendering and its version. Scope/privacy restrictions apply to every rendered line, including passdowns and lessons. An observed report is not permission to change files, schedule work, promote a lesson or authorize removal.

The shared learning fixtures include positive syntax, missing fields, duplicates, empty first labels, continuation/heading boundaries and an unsafe unheaded `LEARNED` example. Attribution and source hash are retained in pack provenance; copying private prose is excluded.
