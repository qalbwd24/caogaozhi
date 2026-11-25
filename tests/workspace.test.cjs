'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, DEFAULT_KEY, LEGACY_KEY } = require('../dist/workspace.js');

function memory(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data, writes: [], failRead: false, failWrite: false,
    getItem(key) { if (this.failRead) throw Error('read unavailable'); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) {
      if (this.failWrite) throw Error('quota exceeded');
      this.writes.push({ key, value }); data.set(key, value);
    }
  };
}
function model(text = '正文', extra = {}) {
  return { nodes: [{ id: 'n1', x: 10, y: 20, text, color: 'black', ...extra }], edges: [] };
}
function normalize(value) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw Error('invalid model');
  return value;
}
function setup(t, storage = memory(), extra = {}) {
  let counter = 0;
  const workspace = create({ storage, normalize, makeId: () => 'doc-' + ++counter, ...extra });
  t.after(() => workspace.dispose());
  return { workspace, storage };
}

test('migrates v1 without changing its original contents; preserves new model fields', t => {
  const legacy = JSON.stringify(model('旧草稿', { parentId: 'parent', runs: [{ text: '旧草稿', color: 'blue' }] }));
  const storage = memory({ [LEGACY_KEY]: legacy });
  const { workspace } = setup(t, storage);
  assert.deepEqual(workspace.active().model, JSON.parse(legacy));
  assert.equal(workspace.active().title, '未命名');
  assert.equal(workspace.hasPendingSave, true);
  assert.equal(workspace.save(), true);
  assert.equal(storage.data.get(LEGACY_KEY), legacy);
  assert.equal(JSON.parse(storage.data.get(DEFAULT_KEY)).version, 2);
  assert.ok(storage.writes.every(write => write.key === DEFAULT_KEY));
});

test('fast tab changes capture each model immediately and cannot save into the wrong document', t => {
  const { workspace, storage } = setup(t);
  const first = workspace.active().id;
  const shared = model('第一页');
  workspace.updateActive({ model: shared, title: '我命名的第一页', cam: { x: 45, y: -30, z: 1.2 }, ink: 'blue' });
  const second = workspace.createDocument('第二页', shared).id;
  shared.nodes[0].text = '调用方后来改了自己的对象';
  workspace.updateActive({ model: model('第二页修改'), ink: 'red' });
  workspace.activate(first);
  assert.equal(workspace.active().model.nodes[0].text, '第一页');
  assert.equal(workspace.active().ink, 'blue');
  workspace.updateActive({ model: model('第一页再修改') });
  workspace.activate(second);
  workspace.save();
  const saved = JSON.parse(storage.data.get(DEFAULT_KEY));
  assert.equal(saved.documents.find(doc => doc.id === first).model.nodes[0].text, '第一页再修改');
  assert.equal(saved.documents.find(doc => doc.id === second).model.nodes[0].text, '第二页修改');
  assert.deepEqual(saved.documents.find(doc => doc.id === first).cam, { x: 45, y: -30, z: 1.2 });
  assert.equal(saved.documents.find(doc => doc.id === first).title, '我命名的第一页');
});

test('snapshots cannot mutate internal state or other documents', t => {
  const { workspace } = setup(t);
  workspace.updateActive({ model: model('保留内容') });
  const first = workspace.active();
  workspace.createDocument('复制页', first.model);
  first.model.nodes[0].text = '外部变更';
  const snapshot = workspace.state;
  snapshot.documents[1].model.nodes[0].text = '再次外部变更';
  assert.equal(workspace.active().model.nodes[0].text, '保留内容');
  workspace.activate(first.id);
  assert.equal(workspace.active().model.nodes[0].text, '保留内容');
});

test('closing and reopening tabs keeps every document and leaves an editable tab', t => {
  const { workspace } = setup(t);
  const first = workspace.active().id;
  workspace.updateActive({ model: model('不应删除') });
  assert.equal(workspace.close(first), true);
  assert.equal(workspace.state.openIds.length, 1);
  assert.notEqual(workspace.state.activeId, first);
  assert.equal(workspace.state.documents.length, 2);
  assert.deepEqual(workspace.state.closedIds, [first]);
  assert.equal(workspace.reopen().id, first);
  assert.equal(workspace.active().model.nodes[0].text, '不应删除');
  assert.deepEqual(workspace.state.closedIds, []);
  assert.equal(workspace.reopen(), false);
});

test('refresh restores active tab, closed tabs, names, camera, colors, and contents', t => {
  const { workspace, storage } = setup(t);
  const first = workspace.active().id;
  workspace.updateActive({ model: model('第一份'), title: '自己的标题' });
  const second = workspace.createDocument('第二份', model('第二份内容')).id;
  workspace.updateActive({ cam: { x: -100, y: 200, z: .75 }, ink: 'gray' });
  workspace.close(first);
  workspace.flush();
  const { workspace: restored } = setup(t, storage);
  assert.equal(restored.active().id, second);
  assert.equal(restored.active().ink, 'gray');
  assert.deepEqual(restored.active().cam, { x: -100, y: 200, z: .75 });
  assert.equal(restored.active().model.nodes[0].text, '第二份内容');
  assert.deepEqual(restored.state.closedIds, [first]);
  assert.equal(restored.reopen().title, '自己的标题');
});

test('read errors and malformed v2 data never replace the saved value with a blank sheet', t => {
  for (const raw of ['{broken', '', JSON.stringify({ version: 3, documents: [] }), JSON.stringify({ version: 2, openIds: [], documents: [{ id: 'doc', model: null }] })]) {
    const errors = [];
    const storage = memory({ [DEFAULT_KEY]: raw, [LEGACY_KEY]: JSON.stringify(model('仍需保留的旧版')) });
    const { workspace } = setup(t, storage, { onError: (error, context) => errors.push({ error, context }) });
    assert.equal(workspace.blocked, true);
    workspace.updateActive({ model: model('仍可在内存里编辑') });
    assert.equal(workspace.save(), false);
    assert.equal(storage.data.get(DEFAULT_KEY), raw);
    assert.equal(storage.writes.length, 0);
    assert.equal(errors[0].context.operation, 'read');
    assert.equal(errors[0].context.blocked, true);
  }
  const storage = memory({ [DEFAULT_KEY]: 'keep original bytes' });
  storage.failRead = true;
  const { workspace } = setup(t, storage);
  storage.failRead = false;
  assert.equal(workspace.save(), false);
  assert.equal(storage.data.get(DEFAULT_KEY), 'keep original bytes');
});

test('invalid legacy data is also protected and never silently migrated to empty', t => {
  const storage = memory({ [LEGACY_KEY]: '{cannot parse' });
  const { workspace } = setup(t, storage);
  workspace.createDocument('临时页', model('新内容'));
  assert.equal(workspace.blocked, true);
  assert.equal(workspace.save(), false);
  assert.equal(storage.data.get(LEGACY_KEY), '{cannot parse');
  assert.equal(storage.data.has(DEFAULT_KEY), false);
});

test('write failure preserves pending edits, keeps previous storage, and permits retry', t => {
  const errors = [];
  const { workspace, storage } = setup(t, memory(), { onError: (error, context) => errors.push({ error, context }) });
  workspace.updateActive({ model: model('已保存') });
  workspace.save();
  const original = storage.data.get(DEFAULT_KEY);
  storage.failWrite = true;
  workspace.updateActive({ model: model('尚未写入') });
  assert.equal(workspace.flush(), false);
  assert.equal(workspace.hasPendingSave, true);
  assert.equal(workspace.active().model.nodes[0].text, '尚未写入');
  assert.equal(storage.data.get(DEFAULT_KEY), original);
  assert.equal(errors[0].context.operation, 'write');
  assert.equal(workspace.blocked, false);
  storage.failWrite = false;
  assert.equal(workspace.save(), true);
  assert.equal(workspace.hasPendingSave, false);
  assert.equal(workspace.lastError, null);
  assert.equal(JSON.parse(storage.data.get(DEFAULT_KEY)).documents[0].model.nodes[0].text, '尚未写入');
});

test('validation failure leaves the active model and its name intact', t => {
  const { workspace } = setup(t);
  workspace.updateActive({ model: model('有效内容'), title: '原标题' });
  assert.throws(() => workspace.updateActive({ model: { invalid: true }, title: '不应改名' }), /invalid model/);
  assert.equal(workspace.active().title, '原标题');
  assert.equal(workspace.active().model.nodes[0].text, '有效内容');
});

test('automatic saves run within 200 ms of the first change, even during continuous input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { workspace, storage } = setup(t);
  workspace.updateActive({ model: model('A') });
  t.mock.timers.tick(90);
  workspace.updateActive({ model: model('AB') });
  t.mock.timers.tick(59);
  assert.equal(storage.writes.length, 0);
  t.mock.timers.tick(1);
  assert.equal(storage.writes.length, 1);
  assert.equal(JSON.parse(storage.data.get(DEFAULT_KEY)).documents[0].model.nodes[0].text, 'AB');
  workspace.updateActive({ model: model('ABC') });
  workspace.updateActive({ model: model('AB') }); // Undo before the queued save.
  t.mock.timers.tick(150);
  assert.equal(JSON.parse(storage.data.get(DEFAULT_KEY)).documents[0].model.nodes[0].text, 'AB');
});

test('the v2 workspace takes precedence over the retained original v1 data', t => {
  const { workspace, storage } = setup(t, memory({ [LEGACY_KEY]: JSON.stringify(model('历史原稿')) }));
  workspace.updateActive({ model: model('当前版本') });
  workspace.save();
  const { workspace: restored } = setup(t, storage);
  assert.equal(restored.active().model.nodes[0].text, '当前版本');
  assert.equal(JSON.parse(storage.data.get(LEGACY_KEY)).nodes[0].text, '历史原稿');
});
