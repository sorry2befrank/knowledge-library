# Generic Understudy ladder: compatibility and limits

Reference derived from `understudy-agent-ladder`. The source script was read for declarations only. Its runtime state file was neither read nor exported. The script was not invoked or copied into this reference pack.

## Actual interface

Source usage is documented at lines 17–23; dispatch is at lines 339–360. Recognized commands are `status`, `record`, `promote`, `sync-crew`, `report`, `json`, `selftest`. `--help` is not recognized. No arguments prints the docstring and exits 2; an unknown command also exits 2. These are compatibility facts, not instructions to execute the source.

`record <agentId> <eventId> <clean|false|neutral> [note]` accepts an arbitrary agent ID. At least three arguments are required. It rejects an invalid verdict with exit 2, defaults an omitted note to an empty string, and treats an existing event ID under the same agent as a no-op with exit 0. It does not replace an existing event's verdict or note. A new record persists the following source shape:

```json
{
  "agents": {
    "synthetic.librarian": {
      "rung": 0,
      "records": {
        "synthetic-event-001": {
          "verdict": "clean",
          "note": "Synthetic independently adjudicated outcome.",
          "by": "external",
          "ts": "2030-01-02T12:00:00+00:00"
        }
      },
      "promotions": []
    }
  }
}
```

The state also has `threshold` and `updatedAt`; `save` writes a live state file. An arbitrary ID is accepted, but it is not thereby registered as an Orrery persona. In the `json` projection, an unknown ID defaults to `kind="crew"` and `persona=""`.

## Actual earn filters

| Rung | Next-step threshold | Required record filter | Source meaning |
|---|---|---|---|
| 0 | baseline | none | Read-only proposals. |
| 1 | 10 | none | Write to the agent's own Understudy workspace. |
| 2 | 10 | `wrote` | Clean accepted certifications that changed files. |
| 3 | 10 | `merged` | Clean accepted certifications that the owner merged. |

`rung_streak` sorts records by their `ts` string and counts backward. A `false` verdict stops the streak. Neutral records and clean records that do not match the required filter are skipped. Eligibility does not promote automatically. `promote` requires a nonempty ratification-note argument and eligibility, then increments exactly one rung and stores `{to, at, progress, note}`. A note string is not authenticated owner approval; the legacy script does not verify a passkey or prove who supplied it.

The generic `record` command has no `wrote` or `merged` arguments and stores neither field. Its clean records can contribute toward rung 1 but cannot earn rung 2 or 3 through those filters. `sync-crew` creates the fields from source certification data (lines 199–235): accepted/rejected decisions become clean/false, `appliedFiles` determines `wrote`, and the certification's `merged` flag determines `merged`. This reference pack includes no certification rows.

The general `streak` helper (lines 108–119) differs slightly: it skips neutral, counts clean and stops on any other verdict. The rung helper stops specifically on `false`. Invalid source-state verdicts should not be introduced; adaptation fixtures record this difference without granting them authority.

The source stores per-rung thresholds in `RUNGS`. The state-level `threshold` is also used in presentation; changing that value alone does not change the `next_rung` thresholds. Timestamp ordering is lexicographic, so any Library adaptation should store canonical timestamps and not infer event sequence from heterogeneous formats.

## Library adaptation

The Library's focus F-levels, lesson L-levels and per-scope capabilities remain authoritative in its own versioned trust state, approved via the owner's transaction-bound mechanism. A generic rung is a display of legacy work certification, not permission to archive notes, widen policy, confirm labels or promote a Library champion.

If a later owner-approved adapter records generic outcomes, it must use stable event IDs, independently adjudicated evidence, privacy-safe notes and the full manifest ID. Repeated evidence syncs must not mint new streak increments. A restore is not a merge; a successful sync is not a human-confirmed lesson. This reference pack authorizes no such state writes.

The shared learning fixtures cover arbitrary IDs, duplicate event IDs, invalid verdicts, streak reset/skip behavior and higher-rung filter limitations. Attribution/source spans remain in pack provenance. Permission to redistribute the script has not been inferred.
