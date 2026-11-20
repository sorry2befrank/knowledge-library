// Portable validation: no runtime schema compilation, filesystem APIs or eval.
export { SCHEMAS, type SchemaName } from "./schemas.ts";
export { validate, makeValidator, type ValidationResult } from "./validation.ts";
export * from "./semantics.ts";
