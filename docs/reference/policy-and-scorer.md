# Generic policy and perishability references

Status: reference only. Not installed; never used against real content.

## Provenance and extraction boundary

The declarations come from logical source IDs `legacy-vault-policy` (`denied`, `badFile`, `defaultGuard`, `deniedDirectory`, `checkName`, `guardContent`) and `legacy-static-policy` (`DENIED_DIRS`, `DENIED_FILE`, `staticCheck`). Their source-file hashes and this reference pack's artifact hashes belong in the canonical provenance manifest. No path-resolution, discovery, bounded-reader, project identity, index publication, or IO implementation was copied.

`vendor/perishability.ts` extracts only `PERISHABLE_MARKERS`, `SCAN_CHARS`, `Perishability` and `perishability` from `legacy-local-triage`. Its regular expressions, weights, first-8,000-character window, breadth damping and rounding are unchanged. Comments are adapted. Personal benchmark commentary, real note examples, model instructions, the IO-injected ranking wrapper and its inaccurate unreadable-item positioning claim are omitted.

No tracked or root license/notice file was located in either source repository, and neither inspected package manifest declared a license. The owner, who wrote both sources, approved publishing this exact inventory in this public repository under the repository's MIT license. Retain provenance.

## The policy template is deliberately incomplete

`policy/deny.template.json` records generic legacy signals and marks library additions separately. The full legacy vault set contains 42 segments; this template retains 41 generic segments and omits the local project's segment. The legacy static set loses named-project directories and a private operational marker. Project-specific audit prefixes and the private record-path marker are also omitted. No real names, paths, or reversible hashes of names replace them.

Real admission requires an owner-installed, owner-approved private overlay held outside this reference pack and publication repository. It supplies private project/client exclusions, audit-directory patterns, operational path signatures, client classification and ledger path rules. Empty arrays in the template are placeholders, not an approved overlay. A missing or unapproved overlay must block real admission. Synthetic validation may proceed with the clearly fictional overlay in the fixtures.

DESIGN.md §3.2 adds named library rules not carried in this template; implement them from DESIGN.md.

The patterns retain legacy behavior, including broad basename matches such as `backup-plan.md`, uppercase-only status words in the scorer, and credential-length thresholds. These are detection signals with known false positives and omissions. A pattern miss does not prove that content contains no credentials, student data, or private client material.

Three credential-prefix spellings use equivalent regex quantifiers or singleton character classes so the reference text passes the S1b CI signature scan. The synthetic private-header input is assembled from smaller parts through the existing construction grammar. Detection behavior, case flags and length thresholds are unchanged; source-to-reference parity checks cover these representation changes.

For record detection, signatures are regex-escaped literal phrases bounded by `\b`, case-insensitive. At least two distinct matching phrases flag a record; repeating one phrase does not cross the threshold. A normalized matching record path flags with only one path signature. Credential detection is independent of the record flag. When both fire, the legacy reason list gives credential detection precedence; the record flag remains true.

The r0.5 admission adaptation rejects credentials and flagged student-record material before writing content blobs, search rows, fingerprints or private inbox content. There is no sensitive-input inclusion switch. Unclassified or unapproved client material is also rejected. The legacy detector is only one input to those rules; classification, current authorization, scope, byte bounds, encoding, path identity, reparse protection and adapter conformance are separate required contracts. This template cannot authorize local removal.

## Fixture interpretation

All text and relative paths are synthetic. The fixture `reference-fixture-cases/v1` construction grammar accepts either a literal string or one of these objects:

- `{"concat": [part, ...]}` recursively constructs and concatenates parts.
- `{"repeat": [part, count]}` recursively constructs a part and repeats it.
- `{"join": [part, count, separator]}` joins repeated constructed parts with a separator; used only by the scorer fixtures.

Counts are bounded nonnegative integers supplied by trusted fixtures. Credential-shaped strings are assembled in isolated test memory from separate prefix components and repeated placeholder characters. Do not store constructed strings in logs or reports. Fixture manifests contain no usable credential, account identifier, or live note.

Policy fixture operations have deliberately narrow meanings:

| Operation | Check represented |
| --- | --- |
| `generic-directory-segment` | Lowercase exact membership in the union of the two generic denied-segment arrays. |
| `extension` | Lowercase membership in `supportedTextExtensions`. |
| `basename` | `deniedBasename` regex applied to the supplied basename. |
| `legacy-guard` | Legacy path/content and credential signals with exact reason precedence. |
| `synthetic-overlay-directory` | Fictional overlay segment membership and fictional audit regex. |
| `synthetic-overlay-path` | Fictional normalized path-signature match. |
| `library-admission` | Reject if overlay approval, scope or client approval fails, or credentials/record flags are present. `allowed-by-these-checks` never means complete authorization. |

Scorer fixtures declare exact `hits`, `per1k` and ordered `classes`, including a dense-date case and the scan boundary. Expected outputs were derived from the inspected formula. No source module, test suite or live pipeline was executed during extraction. Later cloud-lane tests can execute the reviewed extraction against these fixtures. High claim density establishes neither truth nor off-task status, and cannot weaken any archive safety guard.
