import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, looksLikeDiary } from '../lib/index.js';

test('cleanText：取出 <diary> 标签里的正文', () => {
  const raw =
    '好的，我这就写：\n<diary>今天下了雨，我把伞忘在学校，回去的路上一直淋着，到家才发现鞋也湿透了。</diary>\n希望你喜欢。';
  assert.equal(
    cleanText(raw),
    '今天下了雨，我把伞忘在学校，回去的路上一直淋着，到家才发现鞋也湿透了。',
  );
});

test('cleanText：剥掉开头的说明行', () => {
  const raw = '好的\n这是日记正文：\n今天很累但很开心，晚上给自己煮了一碗热干面，吃完就躺下了。';
  const out = cleanText(raw);
  assert.ok(out.startsWith('今天很累'), `实际输出：${out}`);
  assert.ok(!out.includes('这是日记正文'), `实际输出：${out}`);
});

test('cleanText：清掉乱码替换符', () => {
  assert.equal(cleanText('今天天气不错\uFFFD，出去走了一圈。'), '今天天气不错，出去走了一圈。');
});

test('looksLikeDiary：中文太少直接拒', () => {
  const r = looksLikeDiary('嗯，好的。');
  assert.equal(r.ok, false);
  assert.match(r.reason, /中文太少/);
});

test('looksLikeDiary：压缩摘要拒', () => {
  const text =
    '这段时间我一直在整理这几天攒下来的压缩记录，其中 m00674 – m00700 那一大段里全是会话摘要，翻起来确实挺费劲的，得从头再过一遍才理得清。';
  const r = looksLikeDiary(text);
  assert.equal(r.ok, false, '这条不该通过');
  assert.match(r.reason, /压缩摘要/);
});

test('looksLikeDiary：条目列表拒', () => {
  const text = [
    '- 早上七点起床，给自己煮了一碗面，吃完出门赶公交车',
    '- 中午和同事去楼下吃了盖饭，聊了一会儿最近的项目',
    '- 晚上回家路上买了点水果，洗完澡就早早躺下了',
  ].join('\n');
  const r = looksLikeDiary(text);
  assert.equal(r.ok, false);
  assert.match(r.reason, /条目列表/);
});

test('looksLikeDiary：正常的中文日记通过', () => {
  const text =
    '今天早上去菜市场买了半斤排骨，回来炖了一锅汤，中午一个人吃完了，下午睡了一觉，晚上把阳台的花浇了，觉得这样平平淡淡也挺好。';
  const r = looksLikeDiary(text);
  assert.equal(r.ok, true, r.reason);
});
