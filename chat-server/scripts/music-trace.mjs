import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { once } from 'node:events';

// Scan without loading the PM2 log into memory. Output only the selected command's structured events.
const [query, path = join(homedir(), '.pm2/logs/chat-server-out.log')] = process.argv.slice(2);
if (!query?.trim()) {
  console.error('用法：node music-trace.mjs <请求编号或歌名> [PM2 日志文件]');
  process.exit(2);
}
async function* entries() {
  const file = createReadStream(path);
  const input = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  if (input !== file) file.on('error', error => input.destroy(error));
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const data = line.match(/\[Music(?:Command|Resolution)\] (\{.*\})$/)?.[1];
    if (!data) continue;
    try { yield JSON.parse(data); } catch { /* A log being written may end mid-line. */ }
  }
}
const text = query.trim().toLowerCase();
const matches = entry => entry.requestId === query || entry.title?.toLowerCase().includes(text);
const requests = new Set();
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(query)) {
  for await (const entry of entries()) {
    if (!entry.requestId || !matches(entry)) continue;
    requests.add(entry.requestId);
    if (requests.size > 1000) {
      console.error('匹配超过 1000 个请求，请指定请求编号或选择较小的归档。');
      process.exit(2);
    }
  }
}
let count = 0;
for await (const entry of entries()) {
  if (!requests.has(entry.requestId) && !matches(entry)) continue;
  if (!process.stdout.write(JSON.stringify(entry) + '\n')) await once(process.stdout, 'drain');
  count++;
}
if (!count) console.error('此日志中没有匹配的音乐操作。');
