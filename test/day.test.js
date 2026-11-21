import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../lib/index.js';

const { validDay } = __test;

test('validDay：正常的日期原样返回', () => {
  assert.equal(validDay('2026-11-21'), '2026-11-21');
  assert.equal(validDay(' 2026-01-01 '), '2026-01-01');
  assert.equal(validDay('2024-02-29'), '2024-02-29'); // 闰年
});

test('validDay：不存在的日子要被挡住', () => {
  // Date 会把 2-31 悄悄算成 3-3，如果只做正则就会把假日期写进日记标题
  assert.equal(validDay('2026-02-31'), '');
  assert.equal(validDay('2025-02-29'), '');
  assert.equal(validDay('2026-13-01'), '');
  assert.equal(validDay('2026-00-10'), '');
});

test('validDay：格式不对的一律不要', () => {
  assert.equal(validDay(''), '');
  assert.equal(validDay('2026-1-1'), '');
  assert.equal(validDay('20261121'), '');
  assert.equal(validDay('2026/11/21'), '');
  assert.equal(validDay('today'), '');
  assert.equal(validDay(null), '');
});
