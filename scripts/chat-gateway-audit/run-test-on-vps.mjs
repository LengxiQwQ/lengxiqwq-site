import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tmp = await mkdtemp(join(tmpdir(), 'priority-test-'));
console.log('Created tmp candidate dir:', tmp);
await cp('/opt/chat-server', tmp, { recursive: true });

let serverCode = await readFile(join(tmp, 'server.mjs'), 'utf8');
serverCode = serverCode.replace(/const MATRIX_ADMIN_TOKEN = '[^']+';/, "const MATRIX_ADMIN_TOKEN = 'audit-fixture';");
serverCode = serverCode.replace(/const MATRIX_REGISTRATION_SHARED_SECRET = '[^']+';/, "const MATRIX_REGISTRATION_SHARED_SECRET = 'audit-fixture';");
serverCode = serverCode.replace(/const GUEST_SIGN_SECRET = '[^']+';/, "const GUEST_SIGN_SECRET = 'audit-fixture';");
serverCode = serverCode.replace(/const AUDIO_SIGN_SECRET = '[^']+';/, "const AUDIO_SIGN_SECRET = 'audit-fixture';");
await writeFile(join(tmp, 'server.mjs'), serverCode);

try {
  const out = execSync(`node /opt/chat-server/priority-regression.mjs "${tmp}" /opt/chat-server/node_modules/ws`, { encoding: 'utf8' });
  console.log(out);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
