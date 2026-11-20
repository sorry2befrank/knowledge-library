# Ripple runtime reference

This is a sanitized source-inspection reference. Logical source IDs below refer to the local provenance receipt; every example path is fictional. No imported module, watcher, model, production command or filesystem probe was executed. The synthetic scenarios in `fixtures/reference/runtime.cases.json` are expectations to bind to an offline harness later, not execution receipts.

## Three different mechanisms

| Layer | Logical source / symbols | Established behavior |
|---|---|---|
| Watcher gate | `orrery/lib/armillary/ripple-watch.ts`: `RIPPLE_WATCH_DEBOUNCE_MS`, `suppressionFor`, `createRippleWatchGate`, `routeRippleWatchEvent` | Only `rename` events are accepted. A normal `change` event is ignored without a suppression reason. Paths are resolved, slash-normalized and lowercased. The same normalized path within 2,000 ms is suppressed as `duplicate`. |
| Supervisor | `orrery/scripts/armillary-loop.mjs`: `MIN_TOKEN`, `tokenFor`, `scanRipple`, `runSupervisor` pending/flush | Accepted paths enter a normalized-path map. Its flush handles each distinct path separately; a batch is not one fleet scan. The token is the last two path segments when at least five characters long (supervisor MIN_TOKEN = 5; the detector separately refuses tokens under four), otherwise the basename. |
| Detector | `orrery/lib/armillary/ripple.ts`: `IGNORE_DIRS`, `TEXT_EXT`, `walk`, `detectRipple` | For a token of at least four characters, synchronously walks eligible fleet files and reads their bytes before deciding whether there are hits. Matches are case-insensitive substring matches. No hits returns null and no proposal. The loop calls `startRun` only after a non-null task. |
| Rot interpreter | `orrery/lib/armillary/ripple-rot.ts`: `NOISE`, `HISTORICAL`, `splitHit`, `buildHomeIndex`, `rotFindings`, `correctionFor` | Interprets already discovered references. It is neither a watcher nor proof that a path deletion is safe. |

The default detector limits are 512 KiB per file and 200 hits. It skips dot-prefixed directories and the declared dependency/build/data/backup/archive directories. `TEXT_EXT` includes code, configuration and prose extensions. Unreadable directories/files are skipped. The changed source file is excluded unless `ignoreSourceFile:false`. Any matched path classified `GATED` makes the proposal `GATED`; discovery itself does not authorize a fix.

Watcher suppression reasons are `autonomousSave`, `remember`, `appendArtifact`, `logFile`, `runtimeBackup`, `docBackup`, `dependencyTree`, `transient`, `internalStore`, and `duplicate`. These are watcher-specific patterns. For example, a fictional `.remember/cache.json` rename is suppressed; a fictional `_UNDERSTUDY/turnover/example.md` rename is not suppressed merely because it is historical. An event under the gate repoRoot's `data/` or `work-orders/` subtree (not `ARMILLARY_DATA_DIR`) is suppressed as an internal store. Suppression accounting is not a count of all detector scans.

## Rot's historical and path rules

`HISTORICAL` matches `_UNDERSTUDY` path segments, `turnover` path segments, `.remember` path segments, `rejected` or `accepted` path segments, or a path ending in `UNDERSTUDY.md` / `sweep-log.md` / `PASSDOWN.md` (suffix match, not basename equality), case-insensitively with both slash styles. Thus a fictional `notes-passdown.md` also matches. The test is applied to the parsed citing filename, not the raw `file:line` hit. `splitHit` splits from the right so a synthetic Windows drive colon is retained.

`rotFindings` first requires a missing `sourcePath`. It excludes noise, missing/unparseable citing files, historical citing files and unsupported citing-file extensions. Only tokens containing `/` or `\` proceed. A live target resolved relative to the citing document or to any supplied root suppresses the finding. If the token is dead and exactly one live same-basename home exists, the result is `repoint`; zero or multiple homes produce `review`. The home index is built once per invocation, with default maximum depth six.

These rules do not prove a bare mention is irrelevant to focus eligibility. They only explain why a bare symbol such as `sample-guide` does not become a rot finding. A generated archive view with no slash-bearing references can still cause a watcher event and detector work.

## Library adaptation and measurement requirements

The adopted Library design must measure accepted events, distinct scan attempts including zero-hit scans, duration and proposal/run counts separately. Ten distinct accepted note-removal events can cause ten fleet scans and zero run receipts. A generated-file replacement may add another event. Filesystem notifications may coalesce or duplicate, so that example is a possible workload, not a guaranteed event count.

Before real focus activation, use one explicitly approved canary, a conservative cumulative event/batch budget and stop conditions. Do not pause the watcher or suppress genuine missing dependencies to improve a metric. Runtime integration and protected-reference checks must remain independent of the historical rot filter. The reference pack does not add telemetry or alter any of these source mechanisms.

## Canary measurement source

No canary measurement record of accepted ripple events together with zero-hit scan timings exists in this reference pack. The pinned watcher, supervisor and detector sources do not produce that required record: suppression receipts and non-null proposal/run receipts do not measure every accepted event or zero-hit scan. No runtime measurement store was read, and no measurement SHA-256 is claimed. Logical sources are `orrery/lib/armillary/ripple-watch.ts`, `orrery/scripts/armillary-loop.mjs` and `orrery/lib/armillary/ripple.ts`, pinned in provenance; `FLEET_ROOTS:41` is a declaration reference only and exports no root values.

Orrery's default-off ripple-load counter is therefore required before a canary can supply verified measurement. It must count accepted events, every scan attempt including zero-hit scans, scan duration, queue impact and proposals, including the fixed `ARCHIVED.md` replacement and `.ignore` write. Until an explicitly approved canary yields the required, content-hash-pinned record, the ripple term of `effectiveCap` stays at **1** (DESIGN.md §6.13, "Orrery load and non-interruption"). This is a conservative single-item ceiling, not authority to run a canary or remove any item: other eligibility, approval and batch caps still apply. An unknown or zero measured denominator never grants unlimited capacity. This pack installs no counter and activates no runtime measurement.
