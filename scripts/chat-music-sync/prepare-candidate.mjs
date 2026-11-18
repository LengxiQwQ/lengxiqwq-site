// Prepare an overlay against an explicitly supplied local snapshot. Never deploys.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrateMusicSync } from './server-integration.mjs';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('Usage: node prepare-candidate.mjs <local-runtime-snapshot> <new-output-directory>');
const sourceDir = path.resolve(sourceArg), outputDir = path.resolve(outputArg);
if (outputDir === sourceDir || outputDir.startsWith(sourceDir + path.sep) || sourceDir.startsWith(outputDir + path.sep)) {
  throw new Error('Source and candidate directories must be separate');
}
const root = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(await readFile(path.join(root, 'baseline-sha256.json'), 'utf8'));
for (const [name, expected] of Object.entries(baseline)) {
  const bytes = await readFile(path.join(sourceDir, name));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Runtime source changed: ' + name + '; refresh and review before preparing');
  }
}
const patched = integrateMusicSync(await readFile(path.join(sourceDir, 'server.mjs'), 'utf8'));
// Refuse to overwrite an existing candidate or deployment directory.
await mkdir(outputDir);
for (const name of await readdir(path.join(root, 'candidate'))) {
  await cp(path.join(root, 'candidate', name), path.join(outputDir, name), { recursive: true, force: false, errorOnExist: true });
}
await writeFile(path.join(outputDir, 'server.mjs'), patched, { flag: 'wx', mode: 0o600 });
console.log('Prepared local overlay. No service files, state, credentials or running processes were changed.');
console.log('The generated server.mjs inherits the snapshot configuration; keep the output private and untracked.');
