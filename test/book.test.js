import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionsOf } from '../lib/index.js';

test('sectionsOf：按 ## 日期切段，跳过前言', () => {
  const text = '# 日记合集\n\n## 2026-11-21 日记\n今天很好\n\n## 2026-11-22 日记\n第二段\n';
  const s = sectionsOf(text);
  assert.equal(s.length, 2);
  assert.equal(s[0].day, '2026-11-21');
  assert.equal(s[0].body, '今天很好');
  assert.equal(s[1].day, '2026-11-22');
  assert.equal(s[1].body, '第二段');
});

test('sectionsOf：正文里的 ## 小标题不切段', () => {
  const text = '## 前言\n废话\n\n## 2026-11-21 日记\n第一行\n## 正文里的小标题\n第二行\n';
  const s = sectionsOf(text);
  assert.equal(s.length, 1);
  assert.match(s[0].body, /## 正文里的小标题/);
  assert.match(s[0].body, /第二行/);
});

test('sectionsOf：空文件、只有前言、空正文都不炸', () => {
  assert.deepEqual(sectionsOf(''), []);
  assert.deepEqual(sectionsOf(null), []);
  assert.deepEqual(sectionsOf('# 只有前言\n'), []);
  const s = sectionsOf('## 2026-11-21 日记\n## 2026-11-22 日记\n有字\n');
  assert.equal(s[0].body, '');
  assert.equal(s[1].body, '有字');
});
