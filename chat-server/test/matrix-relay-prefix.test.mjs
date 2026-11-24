import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMatrixRelayPrefix } from '../src/matrix-relay-prefix.mjs';

test('reads a Markdown relay avatar without dropping the query or consuming the message', () => {
  const avatar = 'https://avatars.example.net/avatar/user?s=128&d=https%3A%2F%2Fsite.example%2Fprofile.webp';
  const header = "[ID:Tea Friend · Snow's Chat];[URL:[avatar](" + avatar.replace('&', '\\&') + ')]';
  assert.deepEqual(parseMatrixRelayPrefix(header + ' 不错，有了'), {
    name: "Tea Friend · Snow's Chat",
    avatar,
    content: ' 不错，有了',
    userKey: undefined,
    site: undefined,
    header
  });
});

test('keeps plain URLs, Matrix media and the optional relay identity fields', () => {
  const body = '[ID:Tea Friend];[URL:mxc://matrix.example.net/abcdef];[KEY:sender];[SITE:Tea room]\r\nhello\nworld';
  const result = parseMatrixRelayPrefix(body);
  assert.equal(result.avatar, 'mxc://matrix.example.net/abcdef');
  assert.equal(result.userKey, 'sender');
  assert.equal(result.site, 'Tea room');
  assert.equal(result.content, 'hello\nworld');
  assert.equal(parseMatrixRelayPrefix('[ID:Tea Friend];[URL:]\nhello').avatar, '');
});

test('handles a labeled destination with parentheses and rejects non-image URL schemes', () => {
  assert.equal(
    parseMatrixRelayPrefix('[ID:name];[URL:[shown](<https://site.example/a(1).png?x=2&amp;y=3>)] hello').avatar,
    'https://site.example/a(1).png?x=2&y=3'
  );
  assert.equal(parseMatrixRelayPrefix('[ID:name];[URL:[shown](javascript:alert(1))] hello').avatar, '');
  assert.equal(parseMatrixRelayPrefix('[ID:name];[URL:[unclosed] text'), null);
  assert.equal(parseMatrixRelayPrefix('Ordinary [URL:https://site.example] message'), null);
});
