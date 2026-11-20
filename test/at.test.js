import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../lib/index.js';

const { normalizeAt } = __test;

test('normalizeAt：合法时间统一成两位', () => {
  assert.deepEqual(normalizeAt('22:00'), { h: 22, m: 0, text: '22:00' });
  assert.deepEqual(normalizeAt(' 7:05 '), { h: 7, m: 5, text: '07:05' });
  assert.deepEqual(normalizeAt('0:00'), { h: 0, m: 0, text: '00:00' });
  assert.deepEqual(normalizeAt('23:59'), { h: 23, m: 59, text: '23:59' });
});

test('normalizeAt：越界或格式不对一律 null', () => {
  for (const bad of ['25:00', '22:70', '24:00', '-1:00', '22:0', 'abc', '', null, undefined, 2200]) {
    assert.equal(normalizeAt(bad), null, `应该拒绝 ${String(bad)}`);
  }
});
