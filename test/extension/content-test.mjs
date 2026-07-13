/**
 * Real-DOM test suite for extension/content/content.js — a real page and
 * a real page-pilot core engine, with only the chrome.* extension APIs
 * faked (see content-fixture.html). See background-test.mjs for why this
 * environment can't do genuine end-to-end extension-loading tests, and
 * why this combination (real DOM + real execution engine, faked chrome
 * APIs) is the strongest verification available here short of that.
 *
 * Run: node test/extension/content-test.mjs
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sparticuzChromium = require('@sparticuz/chromium').default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.error('  FAIL -', name); }
}

function startServer() {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = req.url === '/' ? '/test/extension/content-fixture.html' : req.url;
      const filePath = path.join(ROOT, urlPath);
      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const executablePath = await sparticuzChromium.executablePath();
  const args = sparticuzChromium.args.filter((a) => a !== '--single-process' && a !== '--no-zygote');
  const browser = await chromium.launch({ executablePath, args, headless: true });

  async function freshPage() {
    const page = await browser.newPage();
    await page.goto(`${base}/test/extension/content-fixture.html`);
    await page.waitForFunction(() => window.__sentMessages.length > 0); // content.js's initial announceReady()
    return page;
  }

  console.log('=== on load: announces itself with a scan of the current page ===');
  {
    const page = await freshPage();
    const readyMessage = await page.evaluate(() => window.__sentMessages.find((m) => m.type === 'PP_AGENT_CONTENT_READY'));
    check('sent a CONTENT_READY message', !!readyMessage);
    check('included the current URL', readyMessage.url.includes('content-fixture.html'));
    check('included a scan finding the real fixture fields', readyMessage.elements.some((e) => e.selector === '#last-name') && readyMessage.elements.some((e) => e.selector === '#submit-btn'));
    await page.close();
  }

  console.log('=== SCAN_REQUEST: responds with a fresh scan when asked directly ===');
  {
    const page = await freshPage();
    const elements = await page.evaluate(async () => {
      const listener = window.__messageListeners[0];
      return new Promise((resolve) => {
        listener({ type: 'PP_AGENT_SCAN_REQUEST' }, {}, resolve);
      });
    });
    check('responds with the current scan', elements.some((e) => e.selector === '#last-name'));
    await page.close();
  }

  console.log('=== EXECUTE_ACTION: runs a decided action through the real page-pilot core, then reports the result ===');
  {
    const page = await freshPage();
    await page.evaluate(() => {
      window.__sentMessages.length = 0; // clear the initial announce so ACTION_RESULT is easy to find
      const listener = window.__messageListeners[0];
      listener({ type: 'PP_AGENT_EXECUTE_ACTION', action: { type: 'type', target: '#last-name', text: 'Wang' } }, {}, () => {});
    });
    await page.waitForFunction(() => window.__sentMessages.some((m) => m.type === 'PP_AGENT_ACTION_RESULT'));
    const fieldValue = await page.locator('#last-name').inputValue();
    const resultMessage = await page.evaluate(() => window.__sentMessages.find((m) => m.type === 'PP_AGENT_ACTION_RESULT'));
    check('the action actually ran against the real page (typed through page-pilot\'s core)', fieldValue === 'Wang');
    check('reports back with no error', resultMessage.error === null);
    check('the reported scan reflects the field\'s new value', resultMessage.elements.find((e) => e.selector === '#last-name')?.value === 'Wang');
    await page.close();
  }

  console.log('=== EXECUTE_ACTION: an action that fails is reported as an error, not left silent ===');
  {
    const page = await freshPage();
    await page.evaluate(() => {
      window.__sentMessages.length = 0;
      const listener = window.__messageListeners[0];
      listener({ type: 'PP_AGENT_EXECUTE_ACTION', action: { type: 'click', target: '#does-not-exist' } }, {}, () => {});
    });
    await page.waitForFunction(() => window.__sentMessages.some((m) => m.type === 'PP_AGENT_ACTION_RESULT'));
    const resultMessage = await page.evaluate(() => window.__sentMessages.find((m) => m.type === 'PP_AGENT_ACTION_RESULT'));
    check('the failure is reported with a non-null error, not silently swallowed', resultMessage.error !== null && typeof resultMessage.error === 'string');
    await page.close();
  }

  console.log('=== TASK_DONE / TASK_BLOCKED: handled without throwing (no UI built yet, but must not crash) ===');
  {
    const page = await freshPage();
    const threw = await page.evaluate(() => {
      try {
        const listener = window.__messageListeners[0];
        listener({ type: 'PP_AGENT_TASK_DONE', summary: 'x' }, {}, () => {});
        listener({ type: 'PP_AGENT_TASK_BLOCKED', reason: 'x' }, {}, () => {});
        return false;
      } catch {
        return true;
      }
    });
    check('handling these message types does not throw', !threw);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
