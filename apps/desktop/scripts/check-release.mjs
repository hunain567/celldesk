// Stops an installer from being built without the licence verification key.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../src/main/licensing/vendor-key.ts', import.meta.url));
const source = readFileSync(file, 'utf8');
if (/VENDOR_PUBLIC_KEY_PEM: string \| null = null/.test(source) || !source.includes('BEGIN PUBLIC KEY')) {
  console.error(
    '\nRelease blocked: src/main/licensing/vendor-key.ts has no licence verification key.\n' +
      'Open NexoDesk License Manager > Settings, copy the public key and paste it into that file.\n',
  );
  process.exit(1);
}
console.log('Release check passed: licence verification key is present.');
