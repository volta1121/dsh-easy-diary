import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../lib/index.js';

const { normalizeBridgeMap, guessKeyFromLabel } = __test;
const A = 'session-aaaaaaaa-1111-2222-3333-444444444444';
const B = 'session-bbbbbbbb-1111-2222-3333-444444444444';

test('normalizeBridgeMap：QQ 桥的 sessions.json 形状（带 sessionPolicies 也不干扰）', () => {
  const out = normalizeBridgeMap({
    sessions: { 'group:1034279878': A, 'private:1879047761': B },
    sessionPolicies: { 'group:1034279878': ['reserved2', 'qq-chat-v2', null] },
  });
  assert.deepEqual(out, { 'group:1034279878': A, 'private:1879047761': B });
});

test('normalizeBridgeMap：GET /api/sessions 的数组形状', () => {
  const out = normalizeBridgeMap({
    sessions: [
      { key: 'group:1034279878', sessionId: A, owner: false },
      { key: 'private:1879047761', sessionId: B, owner: true },
    ],
  });
  assert.deepEqual(out, { 'group:1034279878': A, 'private:1879047761': B });
});

test('normalizeBridgeMap：扁平形状', () => {
  assert.deepEqual(normalizeBridgeMap({ 'group:1': A }), { 'group:1': A });
});

test('normalizeBridgeMap：非法值（不是 session- 开头 / 缺 key）被丢掉，不抛错', () => {
  assert.deepEqual(normalizeBridgeMap({ 'group:1': 'not-a-session', '': A, 'group:2': null }), {});
  assert.deepEqual(normalizeBridgeMap(null), {});
  assert.deepEqual(normalizeBridgeMap('乱码'), {});
});

test('guessKeyFromLabel：从会话标签猜聊天 key', () => {
  assert.equal(guessKeyFromLabel('1034279878 群'), 'group:1034279878');
  assert.equal(guessKeyFromLabel('1879047761 私聊'), 'private:1879047761');
  assert.equal(guessKeyFromLabel('qq 群聊'), '');
  assert.equal(guessKeyFromLabel('好友 私聊'), '');
  assert.equal(guessKeyFromLabel(''), '');
});
