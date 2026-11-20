// Local verification only. Approval pins must come from the separate review receipt.
import { readPreflightArguments, assertOwnerEnvironment } from './cloud-bootstrap-preflight.ts';
import { verifyPackage } from './cloud-bootstrap.ts';
import { verifyBootstrapToolchain } from './lib/cloud-bootstrap-toolchain.ts';

try {
  assertOwnerEnvironment(process.env);
  const args = readPreflightArguments(process.argv.slice(2));
  const verified = verifyPackage(args.source, args.input, args.pins);
  verifyBootstrapToolchain(args.source, args.pins);
  console.log(JSON.stringify({ ...verified, deployed: false }));
} catch {
  console.error('Bootstrap verification refused. Check approved pins, exact package contents and owner environment.');
  process.exitCode = 1;
}
