'use strict';

// Run: BROWSER_EXECUTABLE=/path/to/chromium node --test tests/editor-flows.cjs
// Playwright is a development/test dependency, never a runtime dependency.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '', 'playwright')); }

const dist = path.resolve(__dirname, '../dist');
let server, browser, baseURL;
before(async () => {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(filename, (error, contents) => {
      if (error) { response.writeHead(404).end(); return; }
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(filename)];
      response.writeHead(200, { 'Content-Type': mime || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(contents);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.BROWSER_EXECUTABLE || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined);
  browser = await playwright.chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function pageFor(t, seed) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (seed) await page.addInitScript(value => {
    if (!sessionStorage.getItem('test-seeded')) {
      for (const [key, data] of Object.entries(value)) localStorage.setItem(key, data);
      sessionStorage.setItem('test-seeded', 'true');
    }
  }, seed);
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'page should not throw uncaught errors'); });
  await page.goto(baseURL);
  await page.locator('#tabs [role="tab"]').first().waitFor();
  return page;
}
async function writeFirst(page, text) {
  await page.locator('#paper').click({ position: { x: 180, y: 130 } });
  await page.locator('.editor[contenteditable]').waitFor();
  await page.keyboard.insertText(text);
}
async function app(page) {
  return page.evaluate(() => ({
    model: JSON.parse(JSON.stringify(model)), cam: { ...cam }, ink, selected,
    editingId: editing?.id || null,
    focusedEditor: !!document.activeElement?.matches('.editor[contenteditable]'),
    workspace: workspace.state
  }));
}
function edgeBetween(model, fromText, toText) {
  const from = model.nodes.find(n => n.text === fromText);
  const to = model.nodes.find(n => n.text === toText);
  return model.edges.find(e => e.a === from?.id && e.b === to?.id);
}
async function selectText(page, start, end = start) {
  await page.evaluate(({ start, end }) => editing.controller.setSelection(start, end), { start, end });
}
async function functionKey(page, key) {
  // Playwright's keyboard table stops before F17; CDP can send the real virtual key.
  const session = await page.context().newCDPSession(page);
  const keyCode = 111 + Number(key.slice(1));
  try {
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  } finally { await session.detach(); }
}

test('Tab grows through three levels; Enter creates a sibling with the same parent', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '主问题');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('子问题');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('进一步追问');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('另一个追问');
  const state = await app(page);
  assert.equal(state.model.nodes.length, 4);
  assert.equal(state.model.edges.length, 3);
  assert.equal(edgeBetween(state.model, '主问题', '子问题')?.arrow, 'single');
  assert.equal(edgeBetween(state.model, '子问题', '进一步追问')?.arrow, 'single');
  assert.equal(edgeBetween(state.model, '子问题', '另一个追问')?.arrow, 'single');
  assert.equal(state.model.nodes.find(n => n.id === state.editingId)?.text, '另一个追问');
  assert.equal(state.focusedEditor, true);
});

test('returning to an existing block can immediately grow another child', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '已有想法');
  await page.keyboard.press('Escape');
  await page.locator('.note').filter({ hasText: '已有想法' }).click();
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('补充的新分支');
  const { model, focusedEditor } = await app(page);
  assert.equal(model.nodes.length, 2);
  assert.equal(edgeBetween(model, '已有想法', '补充的新分支')?.arrow, 'single');
  assert.equal(focusedEditor, true);
});

test('F18 cycles only the selected text and retain the selection and editor focus', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '正文提醒');
  await selectText(page, 2, 4);
  await functionKey(page, 'F18');
  let state = await app(page);
  assert.deepEqual(state.model.nodes[0].runs, [{ text: '正文', color: 'black' }, { text: '提醒', color: 'red' }]);
  let selection = await page.evaluate(() => editing.controller.getSelection());
  assert.deepEqual([selection.start, selection.end], [2, 4]);
  assert.equal(state.focusedEditor, true);
  await functionKey(page, 'F18');
  state = await app(page);
  assert.deepEqual(state.model.nodes[0].runs, [{ text: '正文', color: 'black' }, { text: '提醒', color: 'blue' }]);
  assert.equal(state.model.nodes[0].text, '正文提醒');
  selection = await page.evaluate(() => editing.controller.getSelection());
  assert.deepEqual([selection.start, selection.end], [2, 4]);
});

test('switching the next pen color preserves existing text; F19/F20 are not consumed as color keys', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '正文');
  await functionKey(page, 'F18');
  await page.keyboard.insertText('提醒');
  let state = await app(page);
  assert.deepEqual(state.model.nodes[0].runs, [{ text: '正文', color: 'black' }, { text: '提醒', color: 'red' }]);
  await functionKey(page, 'F19');
  assert.equal(await page.locator('#panel .menu-item').first().textContent(), '笔颜色→');
  await page.keyboard.press('Escape');
  await functionKey(page, 'F20');
  assert.equal((await app(page)).ink, state.ink);
  await functionKey(page, 'F18');
  await page.keyboard.insertText('启发');
  state = await app(page);
  assert.deepEqual(state.model.nodes[0].runs, [
    { text: '正文', color: 'black' }, { text: '提醒', color: 'red' }, { text: '启发', color: 'blue' }
  ]);
  assert.equal(state.focusedEditor, true);
});

test('application undo/redo restores a color edit while typing', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '保留我的文字');
  await selectText(page, 0, 2);
  await functionKey(page, 'F18');
  const colored = (await app(page)).model;
  await page.keyboard.press('Control+z');
  let state = await app(page);
  assert.equal(state.model.nodes[0].text, '保留我的文字');
  assert.ok(state.model.nodes[0].runs.every(run => run.color === 'black'));
  assert.equal(state.focusedEditor, true);
  await page.keyboard.press('Control+y');
  state = await app(page);
  assert.deepEqual(state.model, colored);
  assert.equal(state.focusedEditor, true);
});

test('undoing a newly typed child removes its edge as one step and redo restores the branch', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '保留父块');
  const parentState = (await app(page)).model;
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('新子块');
  const branchState = (await app(page)).model;
  await page.keyboard.press('Control+z');
  let state = await app(page);
  assert.deepEqual(state.model, parentState);
  assert.equal(state.focusedEditor, true);
  assert.equal(state.model.nodes.find(n => n.id === state.editingId)?.text, '保留父块');
  await page.keyboard.press('Control+Shift+z');
  state = await app(page);
  assert.deepEqual(state.model, branchState);
  assert.equal(state.focusedEditor, true);
  assert.equal(state.model.nodes.find(n => n.id === state.editingId)?.text, '新子块');
});

test('independent tabs can be named, closed, reopened and restored after reload', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '第一张的内容');
  await page.keyboard.press('F2');
  await page.locator('.tab input').fill('我的随想');
  await page.locator('.tab input').press('Enter');
  await page.locator('#new-tab').click();
  await writeFirst(page, '第二张的内容');
  await page.keyboard.press('F2');
  await page.locator('.tab input').fill('待研究');
  await page.locator('.tab input').press('Enter');
  await page.keyboard.press('Control+PageUp');
  assert.equal((await app(page)).model.nodes[0].text, '第一张的内容');
  await page.keyboard.press('Control+PageDown');
  assert.equal((await app(page)).model.nodes[0].text, '第二张的内容');
  await page.locator('.tab.active .tab-close').click();
  assert.equal(await page.locator('#tabs [role="tab"]').count(), 1);
  await functionKey(page, 'F19');
  await page.getByRole('button',{name:'草稿与标签，进入子菜单'}).click();
  await page.getByRole('button',{name:/恢复最近关闭/}).click();
  assert.equal(await page.locator('#tabs [role="tab"]').count(), 2);
  await page.keyboard.press('Control+s');
  await page.reload();
  await page.locator('#tabs [role="tab"]').first().waitFor();
  const state = await app(page);
  assert.equal(state.workspace.documents.length, 2);
  assert.equal(state.workspace.documents.find(doc => doc.title === '我的随想')?.model.nodes[0].text, '第一张的内容');
  assert.equal(state.workspace.documents.find(doc => doc.title === '待研究')?.model.nodes[0].text, '第二张的内容');
  assert.equal(state.model.nodes[0].text, '第二张的内容');
});

test('diagonal trackpad wheel pans both axes without ending editing or moving its selection', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '保持输入状态');
  await selectText(page, 2, 4);
  const before = (await app(page)).cam;
  await page.locator('.editor').dispatchEvent('wheel', { deltaX: 37, deltaY: 53, deltaMode: 0, bubbles: true, cancelable: true });
  await page.waitForFunction(({ x, y }) => cam.x !== x && cam.y !== y, before);
  const after = await app(page);
  assert.equal(after.cam.x, before.x - 37);
  assert.equal(after.cam.y, before.y - 53);
  assert.equal(after.cam.z, before.z);
  assert.equal(after.focusedEditor, true);
  const selection = await page.evaluate(() => editing.controller.getSelection());
  assert.deepEqual([selection.start, selection.end], [2, 4]);
});

test('Ctrl+wheel zoom keeps the point beneath the cursor fixed and retains editing', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '以光标位置缩放');
  const before = (await app(page)).cam;
  const box = await page.locator('#paper').boundingBox();
  const position = { x: 520, y: 290 };
  await page.locator('#paper').dispatchEvent('wheel', {
    deltaX: 0, deltaY: -70, deltaMode: 0, ctrlKey: true,
    clientX: box.x + position.x, clientY: box.y + position.y, bubbles: true, cancelable: true
  });
  await page.waitForFunction(z => cam.z !== z, before.z);
  const after = await app(page);
  assert.ok(after.cam.z > before.z);
  assert.ok(Math.abs((position.x - before.x) / before.z - (position.x - after.cam.x) / after.cam.z) < .001);
  assert.ok(Math.abs((position.y - before.y) / before.z - (position.y - after.cam.y) / after.cam.z) < .001);
  assert.equal(after.focusedEditor, true);
});

test('Chinese composition cannot create stray blocks and a Tab after commitment is not swallowed', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '中文');
  await page.locator('.editor').evaluate(host => {
    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }));
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', isComposing: true, bubbles: true, cancelable: true }));
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  });
  assert.equal((await app(page)).model.nodes.length, 1);
  await page.locator('.editor').dispatchEvent('compositionend', { data: '中文', bubbles: true });
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('中文之后的子块');
  const { model } = await app(page);
  assert.equal(model.nodes.length, 2);
  assert.equal(edgeBetween(model, '中文', '中文之后的子块')?.arrow, 'single');
});

test('editing stays on paper without a boxed input, placeholder, or corner tools', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '纸上的文字');
  const appearance = await page.locator('.editor').evaluate(host => {
    const style = getComputedStyle(host);
    return { border: style.borderTopWidth, background: style.backgroundColor, outline: style.outlineStyle, placeholder: host.getAttribute('placeholder') };
  });
  assert.equal(appearance.border, '0px');
  assert.equal(appearance.background, 'rgba(0, 0, 0, 0)');
  assert.equal(appearance.outline, 'none');
  assert.equal(appearance.placeholder, null);
  assert.equal(await page.locator('#status, #controls, #dock, #toast').count(), 0);
});
