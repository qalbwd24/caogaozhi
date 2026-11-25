'use strict';

// BROWSER_EXECUTABLE=/path/to/chromium node --test tests/editor-continuity.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
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
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(filename)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(contents);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.BROWSER_EXECUTABLE || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined);
  browser = await playwright.chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function pageFor(t) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'no uncaught page errors'); });
  await page.goto(baseURL);
  await page.locator('#tabs [role="tab"]').first().waitFor();
  return page;
}
async function writeFirst(page, text) {
  await page.locator('#paper').click({ position: { x: 180, y: 130 } });
  await page.locator('.editor[contenteditable]').waitFor();
  await page.keyboard.insertText(text);
}
async function editorState(page) {
  return page.evaluate(() => ({
    model: JSON.parse(JSON.stringify(model)), editId: editing?.id || null,
    selection: editing?.controller.getSelection() || null,
    focused: Boolean(document.activeElement?.matches('.editor[contenteditable]'))
  }));
}

test('changing pen color separates later IME typing from earlier text in undo history', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '正文');
  const cdp = await page.context().newCDPSession(page);
  const f18 = { key: 'F18', code: 'F18', windowsVirtualKeyCode: 129, nativeVirtualKeyCode: 129 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...f18 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...f18 });
  await cdp.send('Input.imeSetComposition', { text: '错', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '错点', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '错点' });
  const complete = await editorState(page);
  assert.deepEqual(complete.model.nodes[0].runs, [{ text: '正文', color: 'black' }, { text: '错点', color: 'red' }]);
  await page.keyboard.press('Control+z');
  const undone = await editorState(page);
  assert.equal(undone.model.nodes.length, 1);
  assert.equal(undone.model.nodes[0].text, '正文');
  assert.equal(undone.editId, complete.editId);
  assert.equal(undone.focused, true);
  await page.keyboard.press('Control+y');
  const redone = await editorState(page);
  assert.deepEqual(redone.model, complete.model);
  assert.equal(redone.focused, true);
});

test('clicking between tabs restores the original editing range and accepts immediate typing', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '甲乙丙丁戊');
  await page.locator('#new-tab').click();
  await writeFirst(page, '另一张');
  await page.keyboard.press('Control+PageUp');
  await page.evaluate(() => editing.controller.setSelection(1, 3, 'backward'));
  const original = await editorState(page);
  await page.locator('#tabs .tab-button').nth(1).click();
  await page.locator('#tabs .tab-button').nth(0).click();
  const returned = await editorState(page);
  assert.equal(returned.editId, original.editId);
  assert.deepEqual(returned.selection, original.selection);
  assert.equal(returned.focused, true);
  assert.deepEqual(returned.model, original.model);
  await page.keyboard.insertText('续');
  assert.equal((await editorState(page)).model.nodes[0].text, '甲续丁戊');
});

test('undoing an Alt-drag restores both coordinates and the active editor caret', async t => {
  const page = await pageFor(t);
  await writeFirst(page, '正在编辑的内容');
  await page.evaluate(() => editing.controller.setSelection(2));
  const original = await editorState(page);
  const bounds = await page.locator('.note').first().boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(bounds.x + 18, bounds.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 78, bounds.y + 55, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const moved = await editorState(page);
  assert.notEqual(moved.model.nodes[0].x, original.model.nodes[0].x);
  assert.notEqual(moved.model.nodes[0].y, original.model.nodes[0].y);
  assert.equal(moved.editId, original.editId);
  assert.deepEqual(moved.selection, original.selection);
  await page.keyboard.press('Control+z');
  const undone = await editorState(page);
  assert.deepEqual(undone.model, original.model);
  assert.equal(undone.editId, original.editId);
  assert.deepEqual(undone.selection, original.selection);
  assert.equal(undone.focused, true);
});
