'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizedRuns } = require('../dist/editor.js');

test('ink runs retain mixed Chinese text and combine adjacent equal inks', () => {
  assert.deepEqual(normalizedRuns('正文重点观点', 'black', [
    { text: '正', color: 'black' }, { text: '文', color: 'black' },
    { text: '重点', color: 'red' }, { text: '观点', color: 'blue' }
  ]), [{ text: '正文', color: 'black' }, { text: '重点', color: 'red' }, { text: '观点', color: 'blue' }]);
});

test('invalid imported runs cannot move ink onto different text', () => {
  assert.deepEqual(normalizedRuns('原始文字', 'blue', [{ text: '不匹配', color: 'red' }]), [{ text: '原始文字', color: 'blue' }]);
  assert.deepEqual(normalizedRuns('安全', 'black', [{ text: '安', color: 'invalid' }, { text: '全', color: 'black' }]), [{ text: '安全', color: 'black' }]);
  assert.deepEqual(normalizedRuns('', 'gray', null), []);
});

test('Windows newlines keep colors aligned across save and restore', () => {
  assert.deepEqual(normalizedRuns('一\r\n二', 'black', [
    { text: '一\r\n', color: 'black' }, { text: '二', color: 'blue' }
  ]), [{ text: '一\n', color: 'black' }, { text: '二', color: 'blue' }]);
});

// Optional real-browser checks. No browser dependency is added to the app.
// PAPER_BROWSER=/path/to/chromium node --test tests/editor.unit.test.cjs
if (process.env.PAPER_BROWSER) {
  const { chromium } = require('playwright');
  let browser;
  test.before(async () => { browser = await chromium.launch({ executablePath: process.env.PAPER_BROWSER, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
  test.after(async () => { await browser?.close(); });

  async function openEditor(node = { text: '', color: 'black' }) {
    const page = await browser.newPage();
    await page.setContent('<div class="editor" style="font:20px/1.5 sans-serif;white-space:pre-wrap;outline:0;width:400px"></div>');
    await page.addScriptTag({ path: path.resolve(__dirname, '../dist/editor.js') });
    await page.evaluate(node => {
      window.changes = [];
      window.controller = PaperEditor.create({
        host: document.querySelector('.editor'), node, typingColor: node.color,
        inks: { black: ['#272c29'], red: ['#b83a42'], blue: ['#255f9c'], gray: ['#666a6c'] },
        onChange: (value, meta) => changes.push({ value, meta })
      });
      controller.focus({ end: true });
    }, node);
    return page;
  }

  test('selected ink preserves range; cycling a collapsed caret changes only future typing', async () => {
    const page = await openEditor({ text: 'ABC', color: 'black' });
    for (const color of ['red', 'blue', 'gray', 'black']) {
      await page.evaluate(color => controller.setColor(color), color);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await page.evaluate(() => controller.getColor()), color);
      assert.equal(await page.evaluate(() => controller.read().text), 'ABC');
    }
    await page.evaluate(() => { controller.setSelection(1, 2); controller.setColor('red'); });
    assert.deepEqual(await page.evaluate(() => controller.getSelection()), { start: 1, end: 2, direction: 'forward' });
    await page.evaluate(() => { controller.setSelection(3); controller.setColor('blue'); });
    await page.keyboard.type('D');
    assert.equal(await page.evaluate(() => controller.getColor()), 'blue');
    await page.evaluate(() => controller.setColor('gray'));
    await page.keyboard.type('E');
    assert.deepEqual(await page.evaluate(() => controller.read()), {
      text: 'ABCDE', runs: [
        { text: 'A', color: 'black' }, { text: 'B', color: 'red' },
        { text: 'C', color: 'black' }, { text: 'D', color: 'blue' }, { text: 'E', color: 'gray' }
      ]
    });
    assert.deepEqual(await page.evaluate(() => changes.find(change => change.meta.kind === 'color').meta.beforeSelection), { start: 1, end: 2, direction: 'forward' });
    await page.close();
  });

  test('blank lines, emoji deletion and rich text restore remain exact', async () => {
    const page = await openEditor();
    await page.keyboard.type('first');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await page.evaluate(() => controller.read().text), 'first\n\n');
    assert.deepEqual(await page.evaluate(() => controller.getSelection()), { start: 7, end: 7, direction: 'forward' });
    await page.keyboard.insertText('家👨‍👩‍👦');
    await page.keyboard.press('Backspace');
    assert.equal(await page.evaluate(() => controller.read().text), 'first\n\n家');
    const value = await page.evaluate(() => controller.read());
    await page.evaluate(value => controller.setValue(value, { start: 3, end: 3, direction: 'forward' }), value);
    assert.deepEqual(await page.evaluate(() => controller.getSelection()), { start: 3, end: 3, direction: 'forward' });
    await page.keyboard.type('!');
    assert.equal(await page.evaluate(() => controller.read().text), 'fir!st\n\n家');
    await page.close();
  });

  test('pasted HTML is ignored and literal text is retained', async () => {
    const page = await openEditor();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/html', '<img src=x onerror="window.injection=true">');
      data.setData('text/plain', '<img>\n原文');
      controller.element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    assert.equal(await page.evaluate(() => controller.read().text), '<img>\n原文');
    assert.equal(await page.locator('.editor img').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.injection)), false);
    await page.close();
  });

  test('native Chinese composition preserves current ink and releases Tab immediately', async () => {
    const page = await openEditor({ text: '正文', color: 'black' });
    await page.evaluate(() => controller.setColor('blue'));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '启', selectionStart: 1, selectionEnd: 1 });
    assert.equal(await page.evaluate(() => controller.isComposing()), true);
    assert.equal(await page.evaluate(() => getComputedStyle(getSelection().focusNode.parentElement).color), 'rgb(37, 95, 156)');
    await cdp.send('Input.imeSetComposition', { text: '启发', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '启发' });
    assert.deepEqual(await page.evaluate(() => controller.read()), {
      text: '正文启发', runs: [{ text: '正文', color: 'black' }, { text: '启发', color: 'blue' }]
    });
    assert.equal(await page.evaluate(() => controller.isComposing({ key: 'Tab' })), false);
    assert.deepEqual(await page.evaluate(() => controller.getSelection()), { start: 4, end: 4, direction: 'forward' });
    await page.keyboard.type('!');
    assert.equal(await page.evaluate(() => controller.read().text), '正文启发!');
    await page.evaluate(() => controller.setColor('red'));
    await cdp.send('Input.imeSetComposition', { text: '思', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '思想', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '思想' });
    assert.deepEqual(await page.evaluate(() => controller.read()), {
      text: '正文启发!思想', runs: [{ text: '正文', color: 'black' }, { text: '启发!', color: 'blue' }, { text: '思想', color: 'red' }]
    });
    await page.close();
  });

  test('native composition among repeated letters retains the exact color insertion position', async () => {
    const page = await openEditor({ text: '中中中', color: 'black', runs: [
      { text: '中', color: 'black' }, { text: '中', color: 'blue' }, { text: '中', color: 'red' }
    ] });
    await page.evaluate(() => { controller.setSelection(1); controller.setColor('gray'); });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '中' });
    assert.deepEqual(await page.evaluate(() => controller.read()), { text: '中中中中', runs: [
      { text: '中', color: 'black' }, { text: '中', color: 'gray' }, { text: '中', color: 'blue' }, { text: '中', color: 'red' }
    ] });
    await page.close();
  });
}
