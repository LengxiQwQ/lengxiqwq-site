
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'chat-music-gateway-test-'));
const testModules = process.env.CHAT_GATEWAY_MODULES;
const docs = process.argv[2];
const release = resolve(process.argv[3]);
assert.ok(testModules && docs);
const data = join(dir, 'data');
let server;
const sockets = [];
try {
  const portProbe = createServer();
  await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port;
  await new Promise(r => portProbe.close(r));
  const origin = 'http://127.0.0.1:' + port;
  await mkdir(data);
  await cp(join(release, 'src'), join(dir, 'src'), { recursive: true });
  if (process.env.CHAT_GATEWAY_MATRIX_SOURCE) {
    await cp(process.env.CHAT_GATEWAY_MATRIX_SOURCE, join(dir, 'src', 'matrix'), { recursive: true });
  }
  await symlink(testModules, join(dir, 'node_modules'), 'junction');
  let source = (await readFile(docs, 'utf8'))
    .replace(/^loadEnvFile\([^\n]+\);$/m, '')
    .replace(/^(const (?:[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)) = .*$/gm, "$1 = 'fixture';")
    .replace(/const PORT = 3001;/, 'const PORT = ' + port + ';')
    .replace(/const DATA_DIR = .*;/, 'const DATA_DIR = ' + JSON.stringify(data) + ';')
    .replace(/const SERVER_ORIGIN = .*;/, 'const SERVER_ORIGIN = ' + JSON.stringify(origin) + ';')
    .replace(/  await primeMatrixRoomMembers\(\);\n  await ensureMatrixAdminProfile\(\);\n  syncMatrix\(\);/g, '');
  await writeFile(join(dir, 'server.mjs'), source);
  await writeFile(join(dir, 'mock.mjs'), [
    "globalThis.fetch = async (target, opts) => {",
    " const u = new URL(target);",
    " if (u.pathname === '/api/token') {",
    "  const role = new Headers(opts.headers).get('authorization').slice(7);",
    "  if(role!=='admin' && role!=='user')return Response.json({errno:1},{status:401});",
    "  return Response.json({errno:0,data:{objectId:role,display_name:role,type:role==='admin'?'administrator':'user'}});",
    " }",
    " if (u.hostname==='cyapi.top') {",
    "  if(u.searchParams.get('mid')==='slow'){await new Promise(r=>setTimeout(r,350));}",
    "  return Response.json({url:'https://isure6.stream.qqmusic.qq.com/audio/'+u.searchParams.get('mid')});",
    " }",
    " if (u.hostname==='isure6.stream.qqmusic.qq.com') {",
    "  const bytes = Buffer.alloc(6000, 1); bytes.write('ID3');",
    "  if(new Headers(opts.headers).get('range'))return new Response(bytes.subarray(0,4096),{status:206,headers:{'Content-Range':'bytes 0-4095/6000','Content-Type':'audio/mpeg'}});",
    "  return new Response(bytes,{headers:{'Content-Type':'audio/mpeg','Content-Length':'6000'}});",
    " }",
    " if(u.hostname==='c.y.qq.com')return Response.json({data:{song:{totalnum:65,list:[{songmid:'one',songname:'One'},{songmid:'one',songname:'One'}]}}});",
    " return Response.json({}, {status:404});",
    "};"
  ].join('\n'));
  server = spawn(process.execPath, ['--import', './mock.mjs', 'server.mjs'], {
    cwd: dir, env: { ...process.env, CHAT_MUSIC_CACHE_DIR: join(data, 'music_cache') }, stdio: ['ignore','pipe','pipe']
  });
  server.stderr.on('data', b => process.stderr.write(b));
  server.stdout.on('data', b => process.stderr.write(b));
  for (let i = 0; i < 50; i++) {
    if (await fetch(origin + '/api/health').then(r=>r.ok,()=>false)) break;
    if (i === 49) throw new Error('fixture gateway did not start');
    await new Promise(r=>setTimeout(r,60));
  }
  const open = (room, user) => {
    const socket = new WebSocket(origin.replace(/^http/,'ws') + '/ws?room=' + room +
      (user ? '&authKind=waline&token=' + user : ''));
    sockets.push(socket);
    const packets = [];
    socket.addEventListener('message', event => packets.push(JSON.parse(event.data)));
    const take = async predicate => {
      for (let i=0;i<90;i++) {
        const ix=packets.findIndex(predicate);
        if (ix>=0) return packets.splice(ix,1)[0];
        await new Promise(r=>setTimeout(r,25));
      }
      throw new Error('fixture timeout waiting for ' + predicate);
    };
    return { socket, take, send: packet => socket.send(JSON.stringify(packet)) };
  };
  const request = async (api, body, token, authKind) => {
    const response = await fetch(origin + api, {
      method: body ? 'POST' : 'GET',
      headers: token ? { Authorization: 'Bearer ' + token, ...(authKind && { 'X-Auth-Kind': authKind }) } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    return { code: response.status, body: await response.json() };
  };
  if (process.argv.includes('--guest-playlists')) {
    const guest = name => {
      const user = { userKey: 'guest:' + name, authType: 'guest', name, isAdmin: false };
      const payload = Buffer.from(JSON.stringify({ user, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
      return payload + '.' + createHmac('sha256', 'fixture').update(payload).digest('base64url');
    };
    const owner = guest('owner');
    const other = guest('other');
    const playlist = { title: 'Guest playlist', platform: 'qqmusic', sourceUrl: 'https://y.qq.com/guest-fixture',
      tracks: [{ title: 'Song', sourceTrackId: 'one', sourcePlatform: 'qqmusic', durationSec: 180 }] };
    const call = (path, body, token) => request('/api/playlists' + path, body, token, token && 'guest');
    assert.equal((await call('/import', playlist)).code, 401);
    assert.equal((await call('/import', playlist, 'invalid.guest')).code, 401);
    const created = await call('/import', playlist, owner);
    assert.equal(created.code, 200);
    const playlistId = created.body.playlist.id;
    assert.equal(created.body.playlist.ownerKey, 'guest:owner');
    assert.equal((await call('?room=chat', null, owner)).body.mine[0].id, playlistId);
    assert.equal((await call('?room=interconnect', null, other)).body.mine.length, 0);
    for (const settings of [{ isFallback: true }, { isFeatured: true }]) {
      assert.equal((await call('/flags', { playlistId, ...settings }, owner)).code, 403);
    }
    assert.equal((await call('/rotation?room=chat', { mode: 'all' }, owner)).code, 401);
    assert.equal((await call('/flags', { playlistId, isPublic: false }, owner)).code, 200);
    assert.equal((await call('/detail?id=' + playlistId, null, owner)).code, 200);
    assert.equal((await call('/detail?id=' + playlistId, null, other)).code, 404);
    assert.equal((await call('/detail?id=' + playlistId)).code, 404);
    assert.equal((await call('/flags', { playlistId }, other)).code, 403);
    const refresh = { playlistId, playlist: { ...playlist, title: 'Updated by guest' } };
    assert.equal((await call('/refresh', refresh, other)).code, 403);
    assert.equal((await call('/refresh', refresh, owner)).body.playlist.title, refresh.playlist.title);
    assert.equal((await call('/delete', { playlistId }, other)).code, 403);
    assert.equal((await call('/delete', { playlistId }, owner)).code, 200);
    assert.equal((await call('/detail?id=' + playlistId, null, owner)).code, 404);
    assert.equal((await request('/api/playlists/import', playlist, 'user')).code, 200);
    console.log('PASS guest playlists: import, read, private access, refresh, share, delete, spectator and room permissions');
  } else {
  const anonA = open('chat');
  await anonA.take(packet => packet.type === 'room:init');
  const anonB = open('chat');
  const visitorState = await anonB.take(packet => packet.type === 'room:init');
  assert.equal(visitorState.observers.length, 2);
  assert.equal(new Set(visitorState.observers.map(observer => observer.userKey)).size, 2);
  anonA.socket.close();
  anonB.socket.close();

  const tea = open('interconnect', 'user');
  const chat = open('chat', 'admin');
  await Promise.all([tea.take(p=>p.type==='room:init'),chat.take(p=>p.type==='room:init')]);
  const playlist = { title:'Shared', platform:'qqmusic', sourceUrl:'https://y.qq.com/sample',
    tracks:[{ title:'Song', sourceTrackId:'one', sourcePlatform:'qqmusic', durationSec:180 }] };
  const added = await request('/api/playlists/import?room=chat', playlist, 'admin');
  assert.equal(added.code, 200);
  const playlistId = added.body.playlist.id;
  assert.equal((await tea.take(p=>p.type==='playlists:updated')).roomId,'interconnect');
  assert.equal((await chat.take(p=>p.type==='playlists:updated')).roomId,'chat');
  assert.equal((await request('/api/playlists/flags?room=chat', { playlistId, isFeatured:true }, 'admin')).code,200);
  assert.equal((await request('/api/playlists?room=chat')).body.featured[0].id,playlistId);
  assert.equal((await request('/api/playlists?room=interconnect')).body.featured.length,0);
  assert.equal((await request('/api/playlists?room=interconnect',null,'admin')).body.mine[0].id,playlistId);
  assert.equal((await request('/api/playlists/import?room=interconnect', playlist, 'admin')).body.updatedExisting,true);

  const featuredOnly = open('chat');
  assert.equal((await featuredOnly.take(p=>p.type==='room:init')).music.current, null);
  const sharedOnly = open('interconnect');
  assert.equal((await sharedOnly.take(p=>p.type==='room:init')).music.current, null);
  const selected = { mode: 'playlist', playlistId };
  assert.equal((await request('/api/playlists/rotation?room=chat', selected, 'user')).code, 403);
  assert.equal((await request('/api/playlists/rotation?room=chat', { mode: 'playlist', playlistId: 'missing' }, 'admin')).code, 400);
  assert.deepEqual((await request('/api/playlists/rotation?room=chat', selected, 'admin')).body.rotation, selected);
  const radio = await chat.take(p=>p.type==='music:state' && p.current?.isFallback);
  assert.equal(radio.current.requesterName, 'Shared (轮播)');
  assert.equal((await request('/api/playlists/flags?room=chat', { playlistId, isFeatured:false }, 'admin')).body.playlist.isFallback,true);
  assert.deepEqual((await request('/api/playlists/rotation?room=chat', { mode: 'off' }, 'admin')).body.rotation, { mode: 'off' });
  await chat.take(p=>p.type==='music:state' && p.current===null);

  assert.equal((await request('/api/playlists/flags?room=chat',{playlistId,isPublic:false},'admin')).code,200);
  assert.equal((await request('/api/playlists/detail?room=chat&id='+playlistId)).code,404);
  assert.equal((await request('/api/playlists/detail?room=interconnect&id='+playlistId,null,'admin')).code,200);
  assert.equal((await request('/api/playlists?room=chat&includeTracks=1')).body.details[playlistId],undefined);
  assert.equal((await request('/api/playlists/rotation?room=chat', selected, 'admin')).code, 400);
  const otherPlaylist = {
    ...playlist, title: 'Public songs', sourceUrl: 'https://y.qq.com/public-songs',
    tracks: [{ ...playlist.tracks[0], sourceTrackId: 'publicSong' }]
  };
  const publicList = await request('/api/playlists/import?room=interconnect', otherPlaylist, 'admin');
  assert.equal(publicList.code, 200);
  assert.deepEqual((await request('/api/playlists/rotation?room=chat', { mode: 'all' }, 'admin')).body.rotation, { mode: 'all' });
  const allRadio = await chat.take(packet => packet.type === 'music:state' && packet.current?.requesterName === '全部公开歌单 (轮播)');
  assert.equal(allRadio.current.track.sourceId, 'publicSong');
  assert.deepEqual((await request('/api/playlists?room=interconnect')).body.rotation, { mode: 'off' });
  const roomSettings = JSON.parse(await readFile(join(data, 'room_settings.json'), 'utf8'));
  assert.equal(roomSettings.chat.fallbackAll, true);
  assert.notEqual(roomSettings.interconnect.fallbackAll, true);
  const hidden = await request('/api/playlists/flags?room=interconnect', { playlistId: publicList.body.playlist.id, isPublic: false }, 'admin');
  assert.equal(hidden.code, 200);
  const afterUnshare = open('chat');
  assert.equal((await afterUnshare.take(packet => packet.type === 'room:init')).music.current, null);
  assert.deepEqual((await request('/api/playlists?room=chat')).body.rotation, { mode: 'all' });
  await request('/api/playlists/rotation?room=chat', { mode: 'off' }, 'admin');

  tea.send({type:'music:enqueue',requestId:'slow-case',track:{provider:'qq',sourceId:'slow',title:'Slow',durationSec:180}});
  tea.send({type:'room:switch',roomId:'chat'});
  await tea.take(p=>p.type==='room:init'&&p.roomId==='chat');
  const accepted=await tea.take(p=>p.type==='music:request_result');
  assert.equal(accepted.roomId,'interconnect');
  assert.equal(accepted.ok,true);
  tea.send({type:'room:switch',roomId:'interconnect'});
  const back=await tea.take(p=>p.type==='room:init'&&p.roomId==='interconnect');
  assert.equal(back.music.current.track.sourceId,'slow');
  assert.equal(back.music.historyLogs[0].track.sourceId,'slow');
  const openChat = open('chat');
  const chatState = await openChat.take(p=>p.type==='room:init');
  assert.equal(chatState.music.historyLogs.length,0);
  assert.notEqual(chatState.music.current?.track.sourceId,'slow');

  const audio = await fetch(back.music.current.track.streamUrl,{headers:{Range:'bytes=0-4095'}});
  assert.equal(audio.status,206);
  assert.equal(audio.headers.get('content-type'),'audio/mpeg');
  assert.equal(Buffer.from(await audio.arrayBuffer()).subarray(0,3).toString(),'ID3');
  const listener = open('interconnect');
  await listener.take(packet => packet.type === 'room:init');
  tea.send({
    type: 'music:enqueue', requestId: 'next-song',
    track: { provider: 'qq', sourceId: 'next', title: 'Next', durationSec: 180 }
  });
  const queued = await tea.take(packet => packet.type === 'music:request_result' && packet.requestId === 'next-song');
  assert.equal(queued.position, 1);
  tea.send({ type: 'music:skip', playUid: back.music.current.uid });
  const isNext = packet => packet.type === 'music:state' && packet.current?.track.sourceId === 'next';
  const [requesterState, listenerState] = await Promise.all([tea.take(isNext), listener.take(isNext)]);
  assert.equal(requesterState.current.uid, listenerState.current.uid);
  assert.equal(requesterState.current.startedAt, listenerState.current.startedAt);
  assert.equal(requesterState.current.track.streamUrl, listenerState.current.track.streamUrl);
  const otherRoom = open('chat');
  const otherState = await otherRoom.take(packet => packet.type === 'room:init');
  assert.notEqual(otherState.music.current?.uid, requesterState.current.uid);
  tea.send({ type: 'music:skip', playUid: requesterState.current.uid });
  await listener.take(packet => packet.type === 'music:state' && packet.current === null);
  const page=await request('/api/music/search?q=one&limit=30&page=2');
  assert.equal(page.body.tracks.length,1);
  assert.equal(page.body.hasMore,true);
  console.log('PASS gateway HTTP/WS: unique visitors, shared/private playlists, isolated rooms, synchronized skip, stream and search');
  }
} finally {
  for (const socket of sockets) socket.close();
  if (server) {
    server.kill();
    if (server.exitCode === null && server.signalCode === null) await new Promise(resolve => server.once('exit',resolve));
  }
  await rm(dir,{recursive:true,force:true});
}
