import assert from 'node:assert/strict';
import { MusicRegistry } from '/opt/chat-server/src/music/registry.mjs';
import { QQMusicProvider } from '/opt/chat-server/src/music/qq-music.mjs';

const qqProvider = new QQMusicProvider();
const registry = new MusicRegistry([qqProvider]);

console.log('Testing resolvePlaylistTrack...');

// 1. Matched track passthrough
const prematched = {
  position: 1,
  title: '测试',
  artist: '测试',
  matchedTrack: { id: 'qq:123', provider: 'qq', title: '测试', artist: '测试' }
};
const res1 = await registry.resolvePlaylistTrack(prematched);
assert.equal(res1.id, 'qq:123');
console.log('  [+] Case 1: prematched track passed');

// 2. Real search match for Jay Chou - 晴天 (external netease item)
const neteaseItem = {
  position: 2,
  sourcePlatform: 'netease',
  sourceTrackId: '186016',
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  durationSec: 269
};
const res2 = await registry.resolvePlaylistTrack(neteaseItem);
assert.ok(res2, 'Should match Jay Chou - 晴天');
assert.equal(res2.provider, 'qq');
assert.ok(res2.sourceId, 'Should have sourceId');
console.log('  [+] Case 2: external track resolved to QQ music:', res2.title, res2.artist, res2.sourceId);

// 3. Fallback for completely nonsense song
const nonsenseItem = {
  position: 3,
  title: 'a9f83nd92jf832nd92jf983j',
  artist: 'z9f83nd92jf832nd92jf983j'
};
const res3 = await registry.resolvePlaylistTrack(nonsenseItem);
assert.equal(res3, null);
console.log('  [+] Case 3: unmatched nonsense track correctly returned null');

console.log('ALL MUSIC RESOLVE TESTS PASSED!');
