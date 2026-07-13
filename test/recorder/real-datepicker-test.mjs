// Regression test for a real bug found with an actual date picker
// (bootstrap-datepicker): selecting a date from the calendar could lose
// the value entirely, or corrupt an unrelated step, depending on exact
// timing. Uses the real library (a devDependency, not a runtime
// dependency of page-pilot itself) rather than a synthetic simulation —
// several attempts at simulating the exact timing artificially (a plain
// synchronous set, a requestAnimationFrame-delayed one, a setTimeout-
// delayed one) each behaved differently from what the real library
// actually does, so this test exercises the real thing directly to stay
// meaningful.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sparticuzChromium from '@sparticuz/chromium';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.error('  FAIL -', name); }
}

function startServer() {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = req.url === '/' ? '/test/recorder/real-datepicker-fixture.html' : req.url;
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
    await page.goto(`${base}/test/recorder/real-datepicker-fixture.html`);
    await page.evaluate(() => window.__recorder.start());
    return page;
  }

  console.log('=== REGRESSION: selecting a date, then immediately clicking Stop (nothing else in between) ===');
  {
    const page = await freshPage();
    await page.locator('#birthdayStr').click();
    await page.waitForSelector('.datepicker-days', { state: 'visible' });
    await page.locator('.datepicker-days td.day:not(.old):not(.new)', { hasText: '15' }).first().click();
    await page.locator('#stop-btn').click(); // no wait at all — matches the exact reported scenario
    const steps = await page.evaluate(() => window.__lastSteps);
    check('no bogus click step targeting a calendar day cell was left behind', !steps.some((s) => s.type === 'click' && typeof s.target === 'string' && s.target.includes('data-date')));
    check('the selected date is correctly captured as a clean type step', steps.some((s) => s.type === 'type' && s.target === '#birthdayStr' && /^\d{2}\/\d{2}\/\d{4}$/.test(s.text)));
    await page.close();
  }

  console.log('=== REGRESSION: selecting a date, waiting a bit, then clicking Stop ===');
  {
    const page = await freshPage();
    await page.locator('#birthdayStr').click();
    await page.waitForSelector('.datepicker-days', { state: 'visible' });
    await page.locator('.datepicker-days td.day:not(.old):not(.new)', { hasText: '15' }).first().click();
    await page.waitForTimeout(100);
    await page.locator('#stop-btn').click();
    const steps = await page.evaluate(() => window.__lastSteps);
    check('no bogus click step targeting a calendar day cell was left behind', !steps.some((s) => s.type === 'click' && typeof s.target === 'string' && s.target.includes('data-date')));
    check('the selected date is correctly captured as a clean type step', steps.some((s) => s.type === 'type' && s.target === '#birthdayStr' && /^\d{2}\/\d{2}\/\d{4}$/.test(s.text)));
    await page.close();
  }

  console.log('=== REGRESSION: typing the date directly (bypassing the calendar UI) still works ===');
  {
    const page = await freshPage();
    await page.locator('#birthdayStr').click();
    await page.keyboard.type('04/15/2022');
    await page.locator('#stop-btn').click();
    const steps = await page.evaluate(() => window.__lastSteps);
    check('captures the typed date as an ordinary type step', steps.some((s) => s.type === 'type' && s.target === '#birthdayStr' && s.text === '04/15/2022'));
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
