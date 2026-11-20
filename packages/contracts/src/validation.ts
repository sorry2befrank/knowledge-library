import { SCHEMAS, type SchemaName } from './schemas.ts';
import { schemaValidators, inputValidators } from './validators.generated.ts';

export interface ValidationResult { valid: boolean; errors: string[] }
type Validator = ((value: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };

function result(validator: Validator, value: unknown): ValidationResult {
  const ok = validator(value);
  return { valid: ok, errors: ok ? [] : (validator.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()) };
}

export function validate(name: SchemaName, value: unknown): ValidationResult {
  const validator = (schemaValidators as Record<string, Validator>)[(SCHEMAS[name] as { $id: string }).$id];
  if (!validator) throw new Error('Missing compiled schema; run build:contracts');
  return result(validator, value);
}

/** Workers cannot compile schemas with eval. Unknown or changed schemas fail closed until rebuilt. */
export function makeValidator(schema: object): (value: unknown) => ValidationResult {
  const validator = (inputValidators as Record<string, Validator>)[JSON.stringify(schema)];
  if (!validator) throw new Error('Missing compiled input schema; run build:contracts');
  return value => result(validator, value);
}
