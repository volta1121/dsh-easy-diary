// 客户端半边的冒烟测试：不渲染 React，只验证「能加载 + 注册了什么」。
// 拦下 __ModuleLoader__，喂一个最小 React 桩，然后调用 apply()。
import test from 'node:test';
import assert from 'node:assert/strict';

const registrations = [];
let entry = null;

globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      entry = def;
    },
  },
};

const ReactStub = {
  createElement() {
    return null;
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
};

const requireStub = (name) => {
  if (name === 'react') return ReactStub;
  throw new Error('unexpected require: ' + name);
};

await import('../client.js');

test('client.js 通过 __ModuleLoader__ 自注册且 id 正确', () => {
  assert.ok(entry, '没有调用 __ModuleLoader__.load');
  assert.equal(entry.id, 'dsh-diary');
  assert.equal(typeof entry.factory, 'function');
});

test('apply() 注册 settings.section 与同 id 的图标', () => {
  const mod = entry.factory(requireStub);
  assert.deepEqual(mod.inject, ['slots']);

  const ctx = {
    slots: {
      inject(owner, fn) {
        assert.equal(typeof fn, 'function');
        registrations.push({ owner, fn });
      },
      register(meta, component) {
        assert.equal(typeof component, 'function');
        return { meta, component };
      },
    },
  };

  mod.apply(ctx);

  const owners = registrations.map((r) => r.owner);
  assert.deepEqual(owners.sort(), ['settings.section', 'settings.section.icon']);

  const made = registrations.map((r) => r.fn());
  const section = made.find((x) => x.meta.name === 'settings.section');
  const icon = made.find((x) => x.meta.name === 'settings.section.icon');

  assert.equal(section.meta.id, 'diary');
  assert.equal(section.meta.order, 25);
  // 标题是 thunk：切语言时外壳重新取，这里默认应为中文
  assert.equal(typeof section.meta.label, 'function');
  assert.equal(section.meta.label(), '日记');
  assert.equal(icon.meta.id, 'diary');
});
