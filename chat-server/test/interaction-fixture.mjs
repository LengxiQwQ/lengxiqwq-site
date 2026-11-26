import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const audio = fs.readFileSync('fixture.mp3'),
  downloads = {},
  ranges = {};
let activeAudio = 0;
process.on('message', (p) => {
  if (p === 'stats')
    process.send({
      rss: Math.round(process.memoryUsage().rss / 1048576),
      cpu: process.cpuUsage().user + process.cpuUsage().system,
      peak: Math.round(process.resourceUsage().maxRSS / 1024),
      downloads,
      ranges,
      activeAudio,
    });
});
globalThis.fetch = async (input, opts = {}) => {
  const u = new URL(input),
    id = u.searchParams.get('mid');
  if (u.hostname === 'api.vkeys.cn' || u.hostname === 'cyapi.top') {
    if (!id) return Response.json({}, { status: 404 });
    await sleep(id.startsWith('slow') ? 900 : 45, undefined, { signal: opts.signal });
    if (id === 'offline') return Response.json({}, { status: 503 });
    const src = { url: 'https://test.stream.qqmusic.qq.com/' + id, duration: 180 };
    return Response.json(u.hostname === 'api.vkeys.cn' ? { data: src } : src);
  }
  if (u.hostname === 'test.stream.qqmusic.qq.com') {
    const id = u.pathname.slice(1),
      range = new Headers(opts.headers).get('range');
    if (range) {
      ranges[id] = (ranges[id] || 0) + 1;
      const [a, b] = range.slice(6).split('-').map(Number);
      const end = Math.min(b || audio.length - 1, audio.length - 1);
      let offset = a,
        canceled = false;
      const body = new ReadableStream({
        async pull(c) {
          await sleep(4);
          if (canceled) return;
          if (offset > end) {
            c.close();
            return;
          }
          c.enqueue(audio.subarray(offset, Math.min(end + 1, offset + 65536)));
          offset += 65536;
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': 'bytes ' + a + '-' + end + '/' + audio.length,
          'Content-Type': 'audio/mpeg',
        },
      });
    }
    downloads[id] = (downloads[id] || 0) + 1;
    let off = 0;
    activeAudio++;
    return new Response(
      new ReadableStream({
        async pull(c) {
          if (off >= audio.length) {
            activeAudio--;
            c.close();
            return;
          }
          await sleep(Number(process.env.FIXTURE_CHUNK_MS || 3));
          c.enqueue(audio.subarray(off, off + 65536));
          off += 65536;
        },
      }),
      { headers: { 'Content-Length': String(audio.length), 'Content-Type': 'audio/mpeg' } },
    );
  }
  if (u.hostname === 'c.y.qq.com')
    return Response.json({ code: 0, data: { song: { list: [], totalnum: 0 } } });
  if (u.hostname === 'music.163.com')
    return Response.json({ code: 200, result: { songs: [], songCount: 0 } });
  if (u.hostname === 'songsearch.kugou.com') return Response.json({ status: 1, data: { lists: [] } });
  if (u.hostname === 'music.youtube.com') return Response.json({ contents: {} });
  return Response.json({}, { status: 404 });
};
