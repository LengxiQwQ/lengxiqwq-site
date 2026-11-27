// PM2 drains stdout through a pipe. Never wait for that pipe on the playback path.
export function createTraceWriter(output, now = Date.now) {
  let windowStart = now(), written = 0, bytes = 0, dropped = 0;
  return (label, entry) => {
    const time = now();
    if (time - windowStart >= 1000 || time < windowStart) {
      windowStart = time;
      written = 0;
      bytes = 0;
    }
    const important = entry.ok === false || entry.failures?.length || entry.stage === 'transition_failed';
    // Leave capacity for failures even when a burst of ordinary events fills its quota.
    const maxRecords = important ? 240 : 200;
    const maxBytes = important ? 128 * 1024 : 96 * 1024;
    if (written >= maxRecords || bytes >= maxBytes || output.writableNeedDrain || output.destroyed || !output.writable) {
      dropped++;
      return;
    }
    written++;
    if (dropped) entry = { ...entry, droppedBefore: dropped };
    try {
      const line = label + ' ' + JSON.stringify(entry) + '\n';
      const size = Buffer.byteLength(line);
      if (size > 8192 || bytes + size > maxBytes) {
        dropped++;
        return;
      }
      bytes += size;
      output.write(line);
      dropped = 0;
    } catch {
      dropped++;
    }
  };
}

export const writeMusicTrace = createTraceWriter(process.stdout);
