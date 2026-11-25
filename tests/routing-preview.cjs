'use strict';

// Render actual app screenshots for a human routing review.
// BROWSER_EXECUTABLE=/path/to/chromium node tests/routing-preview.cjs --out artifacts/routing-review
// No zero-collision assertion: occasional overlap can be preferable to an awkward detour.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || '', 'playwright')); }

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/routing-scenes.json'), 'utf8'));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex !== -1 && !args[outIndex + 1]) throw Error('--out requires a directory');
const output = outIndex === -1 ? path.join(root, 'artifacts/routing-review') : path.resolve(args[outIndex + 1]);

function modelCoordinates(model) { return model.nodes.map(({ id, x, y }) => ({ id, x, y })); }
function modelRelationships(model) { return model.edges.map(({ id, a, b, style, arrow, color, label }) => ({ id, a, b, style, arrow, color, label })); }

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
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
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const executablePath = process.env.BROWSER_EXECUTABLE || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined);
    browser = await playwright.chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: fixtures.viewport, deviceScaleFactor: 1 });
    const documents = fixtures.scenes.map(scene => ({ id: scene.id, title: scene.title, model: scene.model, cam: { x: 0, y: 0, z: 1 }, ink: 'black' }));
    await context.addInitScript(state => localStorage.setItem('caogaozhi.workspace.v2', JSON.stringify(state)), {
      version: 2, activeId: documents[0].id, openIds: documents.map(doc => doc.id), closedIds: [], documents
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#tabs [role="tab"]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const report = { viewport: fixtures.viewport, browser: browser.version(), generatedAt: new Date().toISOString(), scenes: [] };

    for (const scene of fixtures.scenes) {
      await page.getByRole('tab', { name: scene.title, exact: true }).click();
      await page.keyboard.press('Control+0');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const current = await page.evaluate(() => ({ model: JSON.parse(JSON.stringify(model)), camera: { ...cam }, pathCount: document.querySelectorAll('#links .wire').length }));
      assert.deepEqual(modelCoordinates(current.model), modelCoordinates(scene.model), scene.id + ': routing must not move source text');
      assert.deepEqual(modelRelationships(current.model), modelRelationships(scene.model), scene.id + ': routing must preserve relationship endpoints and attributes');
      assert.equal(current.pathCount, scene.model.edges.length, scene.id + ': all connections remain rendered');
      const screenshot = path.join(output, scene.id + '.png');
      await page.screenshot({ path: screenshot, fullPage: false });
      report.scenes.push({
        id: scene.id, title: scene.title, description: scene.description,
        nodes: scene.model.nodes.length, edges: scene.model.edges.length,
        camera: current.camera,
        sourceCoordinatesUnchanged: true, relationshipsUnchanged: true,
        screenshot
      });
      console.log(scene.id + ': ' + scene.model.nodes.length + ' nodes, ' + scene.model.edges.length + ' edges → ' + screenshot);
    }
    assert.deepEqual(errors, [], 'screenshots must not hide application runtime errors');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await context.close();
  } finally {
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
