# Manifest envelope and Library adaptation

Reference only. The source identifier is `owner-manifest-envelope`; provenance records its exact source hash and selected spans. This document exposes field names and observed JSON types, never the source's values, prompt, tenant identity, home, project names or policy. An observed example is not a formal validator or a promise that all manifests share every optional key.

## Observed source shape

The Library manifest is `library-manifest/v1` in DESIGN.md §7.2, "Manifest and home", which governs. Target keys: `id`, `version`, `tenant_id`, `role`, `risk_tier` unchanged; `display_name` not carried; `persona` becomes northstar/directive/corrections references only (`system_prompt_stable` and `voice` are not carried; persona guidance exists only in the owner's NORTHSTAR.md and DIRECTIVE.md); `knowledge.namespaces` becomes `knowledge.collections`; `pinned_to_stable_prefix` and `knowledge.writes` are not carried; `tools.allow` becomes `tools.capabilities`; `tools.deny_note` becomes the `tools.never` list; `crew` becomes `{}`; `reports.contract` (object) becomes `"MOVED|BLOCKED|HIRING|NEXT"` with extension `"LEARNED"` and cadence `"weekly"`; `publish_to` and `cache_layout` are not carried in v1.

| Source path | Observed type | Source-compatibility note |
|---|---|---|
| `id`, `version`, `tenant_id`, `display_name`, `role`, `risk_tier` | string | Source identity/description fields; source values are omitted. Tenant identity is distinct from caller authorization. |
| `_schema_note` | string | Documentation only; source prose is omitted. |
| `persona` | object | Source persona envelope has different keys from the Library's reference-only persona object. |
| `persona.system_prompt_stable` | string array | Source stable-guidance list; no prompt is exported and this field is not carried into v1. |
| `persona.voice` | string | Source descriptive field; not carried into v1. |
| `knowledge` | object | Source knowledge declarations are separate from tool declarations. |
| `knowledge.namespaces` | string array | Source namespace list; its observed array type differs from the v1 example's collections selector. A namespace alone grants no access. |
| `knowledge.pinned_to_stable_prefix` | string array | Source pin declarations; not carried into the v1 manifest. |
| `knowledge.writes` | string array | Source write declarations; not carried into v1 and not authority for external-home writes. |
| `knowledge._note` | string | Documentation only; omitted from exported example. |
| `tools` | object | Source tool envelope has different keys from the v1 capabilities/never envelope. |
| `tools.allow` | string array | Source allowed-tool declaration; target key is capabilities, as defined above. |
| `tools.deny_note` | string | Source human-readable explanation; the target never list is an explicit adaptation, not text copied from this note. |
| `crew` | object | Source object shape; v1 uses an empty object, not an array. |
| `crew.hiring_protocol`, `crew.manifest_id_pattern`, `crew.inheritance` | string | Source crew identity/hiring/inheritance declarations. Crew IDs are `<parent manifest id>.crew.<role>`; Orrery hiring (`crewLeaf`) and agent-ladder `sync-crew` key on the `.crew.` segment, and `sync-crew` ignores IDs without it and records under `crew.<leaf>`. Hiring's helper also has a last-segment fallback; `sync-crew` does not. |
| `crew.anticipated_roles` | array of objects | Each observed item has string `role` and `charge`; examples below are fictional. |
| `reports` | object | Source destination, cadence and contract are separate fields. |
| `reports.publish_to`, `reports.cadence` | string | Source strings; publish_to is omitted from v1, whose cadence is weekly. A cadence declaration installs no schedule. |
| `reports.contract` | object | Source descriptions have string keys moved/blocked/hiring/next; v1 intentionally uses a contract string and separate LEARNED extension. |
| `reports._note` | string | Documentation only; omitted from exported example. |
| `cache_layout` | object | Source descriptive envelope; no cache_layout fields are carried into v1. |
| `cache_layout.stable_prefix`, `cache_layout.volatile` | string arrays | Synthetic symbolic names; no file paths or private content. |
| `cache_layout.breakpoint` | boolean | Source example uses a Boolean field. |
| `cache_layout.ci_assertion` | string | Source descriptive assertion; source prose omitted. |

## Synthetic source-shaped example (not a Library manifest)

This example demonstrates legacy field names and types only. It is not a target template; implement the Library manifest from DESIGN.md's "Manifest and home" section. Stable-guidance placeholders contain no persona instructions.

```json
{
  "id": "understudy.librarian.synthetic-owner",
  "version": "synthetic-1",
  "tenant_id": "synthetic-owner",
  "display_name": "Example librarian",
  "role": "librarian",
  "risk_tier": "reviewed",
  "persona": {
    "system_prompt_stable": ["synthetic-string"],
    "voice": "synthetic-string"
  },
  "knowledge": {
    "namespaces": ["example-collection"],
    "pinned_to_stable_prefix": ["owner-policy"],
    "writes": ["library-owned-case-ledger"]
  },
  "tools": {"allow": ["example-search"], "deny_note": "No policy widening."},
  "crew": {
    "hiring_protocol": "owner-reviewed",
    "manifest_id_pattern": "understudy.librarian.synthetic-owner.crew.{role}",
    "anticipated_roles": [{"role": "reviewer", "charge": "Review proposed lessons."}],
    "inheritance": "Permissions remain explicit."
  },
  "reports": {
    "publish_to": "example-commons",
    "cadence": "on-completed-run",
    "contract": {
      "moved": "Observed progress with evidence.",
      "blocked": "Unresolved constraints.",
      "hiring": "Owner decisions needed.",
      "next": "Concrete next action."
    }
  },
  "cache_layout": {
    "stable_prefix": ["owner-policy"],
    "breakpoint": true,
    "volatile": ["run-evidence"],
    "ci_assertion": "Stable guidance remains separate from run evidence."
  }
}
```

## Library additions and boundaries

The Library introduces ledger-backed corrections/cases, reviewed promotions, scope/privacy filtering and a read-only Orrery evidence projection. Orrery's external-persona ownership fields belong to its registry contract and ownership guards; they are not present in this source manifest. Registering a manifest must not silently schedule execution or permit home writes.

The cloud lane owns the canonical `library-evidence/v1` JSON schema. This reference does not define or revise it. DESIGN.md §7.2, "Manifest and home", defines the Library manifest; the cloud lane implements it. The mapping above distinguishes source declarations from that target; it does not require the adapted manifest to retain omitted source keys. The target additionally declares schema, adaptedFrom, registryKey and knowledge.privacy_ceiling as specified by DESIGN.md.

Source attribution is retained through logical identifier, source hash, symbols and transformation notes in pack provenance. The owner, who wrote the source material, approved publishing this exact inventory in this public repository under the repository's MIT license.
