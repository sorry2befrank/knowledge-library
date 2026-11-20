# policy/

Policy files in this directory are **proposals** (DESIGN §2.7). A policy takes effect only when Frank
approves its bundle hash with a passkey and the service signs an acceptance record
`{policyHash, epoch, receiptId, keyId, sig}`. The loader in `packages/core/src/policy/acceptance.ts`
verifies that record with the pinned service public key and refuses any epoch below the last accepted or
seen one (the current epoch loads; accepting a new policy needs a strictly newer epoch). A missing, unsigned, wrongly signed, hash-mismatched or older-epoch policy fails closed:
everything becomes a proposal, nothing is removed, and no new team class is accepted.

- `deny.template.json` is published by Codex from the reviewed reference pack (its lane). Until then the
  tests use the synthetic deny rules inside `fixtures/gen.ts`, which carry only the DESIGN §3.2 library
  extensions and clearly synthetic client names.
- `focus.json`, `privacy.json` and `ladder.json` (DESIGN §6.2, §9.4, §7.10) are S2 proposals.
- The real client-name overlay never enters this repository (DESIGN §3.2).
