# Headless launch reference

This document describes inspected launch sites, not a secure human-presence detector. No script or model was run. Example values and identities are synthetic. Logical source hashes are recorded in the reference pack's provenance receipt.

| Launch site | Observed source behavior | Limit |
|---|---|---|
| Daily chain | `orrery/scripts/armillary-daily.mjs`, `run`: invokes stage scripts through the watched-process adapter; extends the inherited environment with `ARMILLARY_DAILY_CHAIN="1"`, `ARMILLARY_TRACE_ID` and `ARMILLARY_DAILY_ID`. | These identify that launch context when inherited. An arbitrary process can set the same variables. Their absence does not establish an interactive session. |
| Shared Claude CLI adapter | `orrery/scripts/claude-cli.mjs`, `buildClaudeEnv`, `spawnClaude`: copies the chosen environment and removes `ARMILLARY_MODEL_STAGE`; resolves the CLI and wraps a Windows command shim through `cmd.exe`; hidden window defaults are set, while caller options can override. | It does not invent a universal headless marker. The model-tier override is consumed rather than inherited by descendants. It cannot authenticate an owner. |
| Sweep | `understudy/understudy-sweep.ps1`, `Invoke-Sweep`: launches the Claude command shim with `--print`, `--allowedTools "Read,Glob,Grep"` and allowed-directory arguments, with the prompt on standard input. | This invocation has no dedicated environment marker assignment. It inherits its process environment. Tool restrictions do not establish that every future invocation or wrapper is detectable. |
| Independent report adjudicator | `understudy/adjudicate-report.ps1`, print-mode invocation: also uses `--print`, `Read,Glob,Grep` and an allowed-directory argument. | No dedicated headless marker is assigned here either. Its independently generated verdict is an operational observation, not a passkey-confirmed human label. |

Never serialize inherited environment values, actual command-directory arguments or runtime prompts into the reference pack. The table exports marker names and launch shapes only.

## Adopted Library adaptation

The Library's session hooks must remain silent in these known automated launch contexts. DESIGN.md §6.14 (Hooks) defines the guard: exit silently when any ARMILLARY daily marker is set, the parent command line contains `--print` or `-p`, or the working directory is under the Orrery root. Absence of these markers is the normal interactive case, not a reason to no-op. If the hook cannot read one of these signals, it exits silently. A dedicated marker is optional. Integration tests need synthetic wrappers for all four inspected paths, including a sweep launched without a daily-chain environment.

No claim is made that `CLAUDE_CODE_ENTRYPOINT`, parent-process names, a terminal/TTY, environment values, or absence of those values reliably distinguish every interactive and automated run. Same-user processes can forge these signals. Do not count them as owner approval, a confirmed learning label, rung ratification, policy widening or removal authorization.

Under reconciliation decision D2, the approval authority is a transaction-bound owner passkey approval bound to the exact action/evidence revision. Routine weekly execution uses previously approved standing policy. Operational restores, ghost observations, trails, MCP feedback and agreement between two principals remain unconfirmed observations unless an admissible owner-confirmation receipt exists. This is an adopted Library contract; it is not implemented by the current launch scripts.

The static fixture `runtime.cases.json` records marker-preservation/removal expectations and the absence of secure approval authority. It is not a universal detector implementation and was not run against production.
