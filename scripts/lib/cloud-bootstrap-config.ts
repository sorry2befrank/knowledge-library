/** Initial owner provisioning only. This does not deploy or enroll an archive. */
export type BootstrapConfigInput = {
  environment: 'staging';
  accountIsolation: 'shared-account' | 'separate-accounts';
  stagingAccountId: string;
  productionAccountId: string;
};

function dataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Inspect only own JSON data fields; do not invoke accessors or ignore hidden keys. */
function exactFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!dataObject(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => {
    if (typeof key !== 'string' || !keys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function checkedInput(input: BootstrapConfigInput): BootstrapConfigInput {
  if (!exactFields(input, ['environment', 'accountIsolation', 'stagingAccountId', 'productionAccountId'])) {
    throw new Error('bootstrap input must contain exactly the environment, account layout, and both account IDs');
  }
  const accountId = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && value !== '0'.repeat(32);
  const sameAccount = input.stagingAccountId === input.productionAccountId;
  const validLayout = (input.accountIsolation === 'shared-account' && sameAccount)
    || (input.accountIsolation === 'separate-accounts' && !sameAccount);
  if (input.environment !== 'staging' || !accountId(input.stagingAccountId) || !accountId(input.productionAccountId)
      || !validLayout) {
    throw new Error('bootstrap requires staging, valid lowercase account IDs, and an explicit matching account layout');
  }
  return input;
}

export function makeBootstrapConfig(input: BootstrapConfigInput) {
  const checked = checkedInput(input);
  return {
    name: 'kl-api-staging',
    main: './worker.mjs',
    find_additional_modules: false,
    account_id: checked.stagingAccountId,
    compatibility_date: '2026-07-30',
    workers_dev: true,
    preview_urls: false,
    send_metrics: false,
    upload_source_maps: false,
    observability: { enabled: false, logs: { enabled: false }, traces: { enabled: false } },
  } as const;
}

function matchesJson(actual: unknown, expected: unknown): boolean {
  if (!dataObject(expected)) return Object.is(actual, expected);
  const keys = Object.keys(expected);
  return exactFields(actual, keys) && keys.every((key) => matchesJson(actual[key], expected[key]));
}

/** Refuse all drift, including settings Wrangler would accept but this phase does not. */
export function validateBootstrapConfig(config: unknown, expectedInput: BootstrapConfigInput): void {
  if (!matchesJson(config, makeBootstrapConfig(expectedInput))) {
    throw new Error('bootstrap config differs from the reviewed staging-only settings');
  }
}
