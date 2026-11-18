import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicManager } from './music-manager.mjs';

function manager() {
  const m = Object.create(MusicManager.prototype);
  Object.assign(m, {
    current: { uid: 'current', requesterKey: 'owner', isFallback: false, skipVotes: [] },
    queue: [{ uid: 'a', track: { id: 'a' }, requesterKey: 'a-owner' }, { uid: 'b', track: { id: 'b' }, requesterKey: 'b-owner' }],
    queueVotes: new Map(), queueVotePlayUid: null, generation: 1,
    preparedQueue: null, historyMap: new Map(), historyLogs: [], changes: 0,
    onStateChanged() { this.changes++; }, usePrepared: async () => null,
    resolve: async track => track, savePlayback() {}, markOutcome() {}, prepareNext() {},
    playTrack(track) { this.current = { uid: 'new', track }; this.generation++; },
    advanceNext() { this.advanced = true; }
  });
  return m;
}
const actor = key => ({ userKey: key, name: key });
test('three listeners require two votes for the same queue item; vote can move or cancel', async () => {
  const m = manager();
  await m.playQueued('a', actor('one'), 3, 'current');
  assert.equal(m.getSnapshot().queue[0].playVotes[0], 'one');
  await m.playQueued('b', actor('one'), 3, 'current');
  assert.equal(m.getSnapshot().queue[0].playVotes.length, 0);
  assert.equal(m.getSnapshot().queue[1].playVotes.length, 1);
  await m.playQueued('b', actor('one'), 3, 'current');
  assert.equal(m.getSnapshot().queue[1].playVotes.length, 0);
  await m.playQueued('a', actor('one'), 3, 'current');
  await m.playQueued('a', actor('two'), 3, 'current');
  assert.equal(m.current.track.id, 'a');
  assert.equal(m.queue.length, 1);
});
test('two listeners, current requester and admin can play directly', async () => {
  for (const [who, count] of [[actor('one'), 2], [actor('owner'), 3], [{ ...actor('admin'), isAdmin: true }, 3]]) {
    const m = manager(); await m.playQueued('a', who, count, 'current');
    assert.equal(m.current.track.id, 'a');
  }
});
test('stale songs and removed queue entries cannot trigger a vote', async () => {
  const m = manager();
  assert.equal((await m.playQueued('a', actor('one'), 3, 'old')).ok, false);
  assert.equal((await m.playQueued('missing', actor('one'), 3, 'current')).ok, false);
  assert.equal(m.queueVotes.size, 0);
});
test('a delayed resolve cannot replace a newer track', async () => {
  const m = manager(); let finish;
  m.resolve = () => new Promise(resolve => { finish = resolve; });
  const pending = m.playQueued('a', actor('one'), 2, 'current');
  await new Promise(resolve => setImmediate(resolve));
  m.current = { uid: 'newer' }; m.generation++;
  finish({ id: 'a' });
  assert.equal((await pending).ok, false);
  assert.equal(m.current.uid, 'newer');
});
test('regular skip follows the number of listeners, not connected clients', () => {
  const m = manager();
  m.skip(actor('one'), 2, 3);
  assert.equal(m.advanced, undefined);
  assert.equal(m.current.skipVotes.length, 1);
  m.voteSkip(actor('two'), 10, 2);
  assert.equal(m.advanced, true);
});
