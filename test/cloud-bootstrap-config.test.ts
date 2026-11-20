import { describe, expect, test } from 'vitest';
import { makeBootstrapConfig, validateBootstrapConfig, type BootstrapConfigInput } from '../scripts/lib/cloud-bootstrap-config.ts';

// Public synthetic account IDs; never point tests at a real account.
const input: BootstrapConfigInput = {
  environment: 'staging', accountIsolation: 'separate-accounts',
  stagingAccountId: '1'.repeat(32), productionAccountId: '2'.repeat(32),
};

describe('owner bootstrap config', () => {
  test('emits only the initial staging Worker and explicitly disables telemetry', () => {
    const config = makeBootstrapConfig(input);
    expect(config).toEqual({
      name: 'kl-api-staging', main: './worker.mjs', account_id: input.stagingAccountId,
      compatibility_date: '2026-07-30', workers_dev: true, preview_urls: false,
      send_metrics: false, upload_source_maps: false, find_additional_modules: false,
      observability: { enabled: false, logs: { enabled: false }, traces: { enabled: false } },
    });
    expect(() => validateBootstrapConfig(JSON.parse(JSON.stringify(config)), input)).not.toThrow();
  });

  test('explicit shared-account layout targets only the staging Worker in the approved account', () => {
    const shared: BootstrapConfigInput = { ...input, accountIsolation: 'shared-account', productionAccountId: input.stagingAccountId };
    const config = makeBootstrapConfig(shared);
    expect(config.name).toBe('kl-api-staging'); expect(config.account_id).toBe(shared.stagingAccountId);
    expect(() => validateBootstrapConfig(config, shared)).not.toThrow();
    expect(() => validateBootstrapConfig(config, { ...shared, accountIsolation: 'separate-accounts' })).toThrow();
  });

  test.each([
    ['production mode', { ...input, environment: 'production' }],
    ['same account', { ...input, stagingAccountId: input.productionAccountId }],
    ['shared layout with different accounts', { ...input, accountIsolation: 'shared-account' }],
    ['unknown layout', { ...input, accountIsolation: 'automatic' }],
    ['missing layout with separate accounts', { environment: 'staging', stagingAccountId: input.stagingAccountId, productionAccountId: input.productionAccountId }],
    ['missing layout with shared account', { environment: 'staging', stagingAccountId: input.stagingAccountId, productionAccountId: input.stagingAccountId }],
    ['missing staging account', { environment: 'staging', productionAccountId: input.productionAccountId }],
    ['extra authority input', { ...input, apiToken: 'synthetic-not-a-token' }],
    ['null input', null], ['array input', []],
    ...['stagingAccountId', 'productionAccountId'].flatMap((field) =>
      ['', '0'.repeat(32), 'A'.repeat(32), 'g'.repeat(32), '1'.repeat(31), '1'.repeat(33), 123, ' ' + '1'.repeat(32)].map(
        (value): [string, unknown] => [`invalid ${field} ${typeof value}:${String(value).length}`, { ...input, [field]: value }],
      )),
  ])('refuses %s', (_label, invalid) => {
    expect(() => makeBootstrapConfig(invalid as BootstrapConfigInput)).toThrow(/bootstrap/i);
  });

  test.each([
    ['account_id', input.productionAccountId], ['name', 'kl-api-prod'], ['main', './alternate.mjs'],
    ['compatibility_date', '2026-10-13'], ['workers_dev', false], ['preview_urls', true],
    ['send_metrics', true], ['upload_source_maps', true], ['find_additional_modules', true], ['env', { production: {} }],
    ['routes', []], ['route', 'example.invalid/*'], ['triggers', { crons: [] }],
    ['durable_objects', { bindings: [] }], ['r2_buckets', []], ['kv_namespaces', []],
    ['d1_databases', []], ['services', []], ['queues', {}], ['workflows', []],
    ['migrations', []], ['secrets', {}], ['vars', {}], ['build', { command: 'unexpected-build' }],
    ['compatibility_flags', ['nodejs_compat']], ['unsafe', { bindings: [] }],
    ['observability', { enabled: true, logs: { enabled: false }, traces: { enabled: false } }],
    ['observability', { enabled: false, logs: { enabled: true }, traces: { enabled: false } }],
    ['observability', { enabled: false, logs: { enabled: false }, traces: { enabled: true } }],
    ['observability', { enabled: false, logs: { enabled: false, destinations: [] }, traces: { enabled: false } }],
  ])('rejects altered or added field %s', (field, value) => {
    expect(() => validateBootstrapConfig({ ...makeBootstrapConfig(input), [field]: value }, input)).toThrow(/bootstrap/i);
  });

  test('refuses omitted controls, undefined extras, and mismatched expected accounts', () => {
    const config = makeBootstrapConfig(input);
    for (const field of Object.keys(config)) {
      const omitted: Record<string, unknown> = { ...config }; delete omitted[field];
      expect(() => validateBootstrapConfig(omitted, input), field).toThrow();
    }
    expect(() => validateBootstrapConfig({ ...config, routes: undefined }, input)).toThrow();
    expect(() => validateBootstrapConfig(config, { ...input, stagingAccountId: '3'.repeat(32) })).toThrow();
    expect(() => validateBootstrapConfig(config, { ...input, productionAccountId: input.stagingAccountId })).toThrow();
  });

  test('does not invoke getters or accept inherited, symbol, or non-enumerable controls', () => {
    let getterCalls = 0;
    const getter = { ...input };
    Object.defineProperty(getter, 'stagingAccountId', { get: () => { getterCalls++; return input.stagingAccountId; } });
    expect(() => makeBootstrapConfig(getter)).toThrow();
    const config = makeBootstrapConfig(input);
    Object.defineProperty(config, 'name', { get: () => { getterCalls++; return 'kl-api-staging'; } });
    expect(() => validateBootstrapConfig(config, input)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() => validateBootstrapConfig(Object.create(makeBootstrapConfig(input)), input)).toThrow();
    expect(() => validateBootstrapConfig({ ...makeBootstrapConfig(input), [Symbol('extra')]: true }, input)).toThrow();
    const hidden = makeBootstrapConfig(input);
    Object.defineProperty(hidden, 'unexpected', { value: true, enumerable: false });
    expect(() => validateBootstrapConfig(hidden, input)).toThrow();
  });

  test('accepts reordered JSON properties but never coerces invalid values or reveals them in errors', () => {
    const config = makeBootstrapConfig(input);
    expect(() => validateBootstrapConfig(Object.fromEntries(Object.entries(config).reverse()), input)).not.toThrow();
    const sensitiveMarker = 'private-value-do-not-echo';
    let error: unknown;
    try { makeBootstrapConfig({ ...input, stagingAccountId: sensitiveMarker }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(sensitiveMarker);
    expect(() => validateBootstrapConfig({ ...config, workers_dev: 'true' }, input)).toThrow();
  });
});
