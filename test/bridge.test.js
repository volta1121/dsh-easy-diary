import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../lib/index.js';

const { remapStructure } = __test;
const OLD = 'session-old-1111';
const NEW = 'session-new-2222';

test('桥映射：{sessions: {key: id}} 只改命中的那一项', () => {
  const map = { sessions: { 'group:1': OLD, 'group:2': 'session-keep' }, sessionPolicies: { 'group:1': ['reserved2'] } };
  assert.equal(remapStructure(map, OLD, NEW, 'group:1'), true);
  assert.deepEqual(map.sessions, { 'group:1': NEW, 'group:2': 'session-keep' });
  assert.deepEqual(map.sessionPolicies, { 'group:1': ['reserved2'] });
});

test('桥映射：{sessions: {key: {sessionId}}} 认 sessionId / session_id / id 三种字段', () => {
  const map = {
    sessions: {
      a: { sessionId: OLD },
      b: { session_id: OLD },
      c: { id: OLD },
      d: { sessionId: 'session-keep' },
    },
  };
  assert.equal(remapStructure(map, OLD, NEW, ''), true);
  assert.deepEqual(map.sessions, {
    a: { sessionId: NEW },
    b: { session_id: NEW },
    c: { id: NEW },
    d: { sessionId: 'session-keep' },
  });
});

test('桥映射：{sessions: [{key, sessionId}]} 数组形状', () => {
  const map = { sessions: [{ key: 'group:1', sessionId: OLD }, { key: 'group:2', sessionId: 'session-keep' }] };
  assert.equal(remapStructure(map, OLD, NEW, ''), true);
  assert.equal(map.sessions[0].sessionId, NEW);
  assert.equal(map.sessions[1].sessionId, 'session-keep');
});

test('桥映射：扁平形状按这本日记自己的 key 兜底', () => {
  const map = { 'group:1': OLD, 'group:2': 'session-keep' };
  assert.equal(remapStructure(map, OLD, NEW, 'group:1'), true);
  assert.equal(map['group:1'], NEW);
  assert.equal(map['group:2'], 'session-keep');
});

test('桥映射：没命中就不算改过，也不碰别处出现的同一个 id', () => {
  const map = { sessions: { 'group:1': 'session-keep' }, history: [OLD], note: { old: OLD } };
  assert.equal(remapStructure(map, OLD, NEW, 'group:9'), false);
  assert.equal(map.sessions['group:1'], 'session-keep');
  assert.deepEqual(map.history, [OLD]);
  assert.deepEqual(map.note, { old: OLD });
});
