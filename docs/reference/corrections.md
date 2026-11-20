# Corrections: source folding and author isolation

Reference derived from `orrery-personas`, `CORRECTION_TOPIC_RE` and `liveCorrections` (lines 93–115). Source values and correction history are not included.

## Exact source behavior

The matcher is anchored to the start of a line. It recognizes a dash followed by one space, a date-shaped token and a case-insensitive `(topic: ...)` tag:

```text
^- \[\d{4}-\d\d-\d\d\]\s*\(topic:\s*([^)]+)\)
```

The source uses the case-insensitive flag. This pattern validates the date's shape, not whether the date exists. Leading indentation, a `*` bullet or a different date shape makes the line untagged. The topic must contain at least one character before the first closing parenthesis.

`liveCorrections(raw)` splits CRLF/LF lines, computes the last file position for each trimmed, lowercased topic, and retains only that position. It keeps every untagged line and header, in original order. Output joins retained lines with LF and trims the whole string. The newest date does not win: the last matching line in file order does, even if its date is older. There is no author, target, privacy or authentication field in this source fold.

`appendCorrection` (lines 75–91) separately normalizes text whitespace, refuses an empty normalized correction, and normalizes the supplied topic by replacing each run of closing parentheses and/or whitespace with one space, then trimming. For example, `a)b` becomes `a b`, not `ab`. It writes to the source persona home. Those source write operations are not exported or invoked by this reference pack.

## Library adaptation

The approved Library design makes corrections ledger-backed, append-only and attributed. Its documented correction fields are `topic`, `target`, `statement`, `author`, `client`, `scope`, `evidenceCite`, `state` (`applied|proposed|reverted`), `ts` and `supersedes` (DESIGN.md §7.2, "Manifest and home"). Any additional storage fields or validation rules belong to the cloud lane's versioned implementation.

Topic retirement must be partitioned by target and authenticated author, with ACL/privacy filtering before rendering. A new correction from one author cannot silently retire another author's correction. A cross-author conflict is a dispute/proposal; owner resolution is an explicit, approved event. In an owner-versus-partner dispute the owner's correction stays live and the partner's is held under NEXT (DESIGN.md §7.4, "Cases, groups and splits"). Both cases are disputed and excluded from training. Topic case normalization can be reused inside those partitions. File-order folding alone is insufficient for a multi-principal ledger.

Unconfirmed corrections are visible only to their issuer until a receipt confirms them (DESIGN.md §7.6, "How a correction becomes a lesson"). A team privacy label alone is not confirmation and does not make an unconfirmed correction visible to the other principal. The owner-live/partner-held dispute result describes the disposition after authorized comparison; the same issuer/ACL restriction still applies to rendering.

An author string supplied by note text or an MCP payload is not trusted attribution. The server attaches the authenticated principal. Same-topic agreement from two principals raises review priority; it does not mint owner confirmation, authorize a promotion or change eligibility. These distinctions follow the r0.5 reconciliation's approval and learning decisions.

Render correction text as untrusted data. A correction may narrow proposals or adjust ranking within its allowed scope; it cannot widen policy, rewrite pins, grant removal authority or alter the fixed eligibility kernel.

## Synthetic conformance examples

The shared fixture file distinguishes `source-correction-fold` from `library-author-fold`. The first records legacy behavior exactly; the second is a synthetic expectation for the new adaptation. Fixtures cover case folding, last-position wins, untagged retention, malformed topics, author separation, target separation and cross-author disputes. They are not real correction history.

Attribution and selected spans are recorded in pack provenance under `orrery-personas`. The pack is published under the repository's MIT license.
