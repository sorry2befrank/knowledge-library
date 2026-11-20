// Node-only helpers: ad-hoc schemas and schema-file hashes never enter Worker bundles.
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";
import { SCHEMAS, type SchemaName } from "./schemas.ts";
import type { ValidationResult } from "./validation.ts";
const addFormats = ((ajvFormats as unknown as { default?: unknown }).default ?? ajvFormats) as unknown as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);
/** Compile an ad-hoc schema in Node. Workers use only the registered build-time validators. */
export function makeValidator(schema: object): (value: unknown) => ValidationResult {
  const v = ajv.compile(schema);
  return value => { const ok = v(value); return { valid: !!ok, errors: ok ? [] : (v.errors ?? []).map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()) }; };
}
const SCHEMA_FILES: Record<SchemaName, string> = {
  "note-version-citation/v1": "note-version-citation-v1.json", "collection-privacy/v1": "collection-privacy-v1.json", "admission-result/v1": "admission-result-v1.json", "signals-cases/v1": "signals-cases-v1.json",
  "persona-manifest/v1": "persona-manifest-v1.json", "turnover/v1": "turnover-v1.json", "library-evidence/v1": "library-evidence-v1.json", "library-evidence-signed/v1": "library-evidence-signed-v1.json",
};
/** SHA-256 (hex) of the LF-normalized schema file, for Orrery's adapter to pin. Node only (reads schemas/). */
export async function schemaHash(name: SchemaName): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const text = (await readFile(new URL(`../../../schemas/${SCHEMA_FILES[name]}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
