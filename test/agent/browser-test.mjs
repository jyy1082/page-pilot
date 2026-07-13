/**
 * Real-browser test suite for page-pilot-agent. Same Playwright +
 * @sparticuz/chromium setup as the sibling layers — see
 * page-pilot-recorder's README for why.
 *
 * Run: node test/agent/browser-test.mjs
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
      const urlPath = req.url === '/' ? '/test/agent/fixture.html' : req.url;
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
    await page.goto(`${base}/test/agent/fixture.html`);
    return page;
  }

  console.log('=== scanInteractiveElements: finds the expected fields with useful labels ===');
  {
    const page = await freshPage();
    const elements = await page.evaluate(() => window.Agent.scanInteractiveElements());
    const byId = (sel) => elements.find((e) => e.selector === `#${sel}`);

    check('finds the Last Name field with its label', byId('last-name')?.label === 'Last Name:');
    check('a field with an explicit <label> uses that, not its placeholder', byId('first-name')?.label === 'First Name:');
    check('a field with no label falls back to its placeholder', byId('no-label-field')?.label === 'Falls back to this');
    check('a <select> reports its options and current value', JSON.stringify(byId('country-select')?.options) === JSON.stringify(['--', 'US', 'JP']));
    check('a checkbox reports its checked state, not a text value', byId('agree-checkbox')?.type === 'checkbox' && byId('agree-checkbox').checked === false);
    check('a button is described as an action target with its text', byId('submit-btn')?.type === 'action' && byId('submit-btn').text === 'Submit');
    check('a contenteditable region is captured as a text-holding field', byId('rich-text')?.value === 'Some rich text');
    await page.close();
  }

  console.log('=== scanInteractiveElements: correctly skips what it should ===');
  {
    const page = await freshPage();
    const elements = await page.evaluate(() => window.Agent.scanInteractiveElements());
    const selectors = elements.map((e) => e.selector);
    check('a display:none field is not included', !selectors.includes('#hidden-field'));
    check('a disabled field is not included', !selectors.includes('#disabled-field'));
    check('a type="hidden" input is not included', !selectors.includes('#truly-hidden'));
    check('an element whose only id is a duplicate is skipped rather than given a fragile selector', !selectors.includes('#dup-btn'));
    await page.close();
  }

  console.log('=== scanInteractiveElements: respects maxElements ===');
  {
    const page = await freshPage();
    const elements = await page.evaluate(() => window.Agent.scanInteractiveElements(document, { maxElements: 2 }));
    check('stops at the requested cap', elements.length === 2);
    await page.close();
  }

  console.log('=== buildAgentContext: assembles a plain, JSON-safe object ===');
  {
    const page = await freshPage();
    const result = await page.evaluate(() => {
      const ctx = window.Agent.buildAgentContext({
        instruction: 'Fill in the form',
        referenceSkill: { description: 'Add an employee', steps: [{ type: 'type', target: '#x', text: 'y' }] },
        url: 'https://example.com',
        elements: [{ selector: '#x', tag: 'input', type: 'text' }],
        history: [],
      });
      return { ctx, roundTrips: JSON.parse(JSON.stringify(ctx)) };
    });
    check('the context matches what was passed in', result.ctx.instruction === 'Fill in the form');
    check('is safely JSON round-trippable (no functions, no DOM nodes, no circular refs)', JSON.stringify(result.roundTrips) === JSON.stringify(result.ctx));
    await page.close();
  }

  console.log('=== buildAgentContext: a missing reference skill serializes as null ===');
  {
    const page = await freshPage();
    const ctx = await page.evaluate(() => window.Agent.buildAgentContext({ instruction: 'x', referenceSkill: null, url: 'u', elements: [], history: [] }));
    check('referenceSkill is null, not undefined or omitted unpredictably', ctx.referenceSkill === null);
    await page.close();
  }

  console.log('=== validateDecision: accepts well-formed decisions ===');
  {
    const page = await freshPage();
    const results = await page.evaluate(() => {
      const V = window.Agent.validateDecision;
      return {
        action: V({ type: 'action', action: { type: 'click', target: '#submit-btn' } }),
        done: V({ type: 'done', summary: 'finished' }),
        blocked: V({ type: 'blocked', reason: 'cannot find field' }),
        pressKeyNoTarget: V({ type: 'action', action: { type: 'pressKey', key: 'Enter' } }),
      };
    });
    check('a well-formed action decision passes through', results.action !== null);
    check('a "done" signal passes through', results.done !== null);
    check('a "blocked" signal passes through', results.blocked !== null);
    check('pressKey is allowed without a target (matches page-pilot\'s own step shape)', results.pressKeyNoTarget !== null);
    await page.close();
  }

  console.log('=== validateDecision: rejects malformed decisions instead of throwing ===');
  {
    const page = await freshPage();
    const results = await page.evaluate(() => {
      const V = window.Agent.validateDecision;
      return {
        nullInput: V(null),
        notAnObject: V('done'),
        unknownActionType: V({ type: 'action', action: { type: 'deleteEverything', target: '#x' } }),
        missingAction: V({ type: 'action' }),
        missingTargetForClick: V({ type: 'action', action: { type: 'click' } }),
      };
    });
    check('null input returns null, does not throw', results.nullInput === null);
    check('a non-object returns null', results.notAnObject === null);
    check('an action type outside the known vocabulary is rejected', results.unknownActionType === null);
    check('a decision with no action object at all is rejected', results.missingAction === null);
    check('a click with no target is rejected', results.missingTargetForClick === null);
    await page.close();
  }

  console.log('=== decideNextAction: calls the supplied model function and validates its response ===');
  {
    const page = await freshPage();
    const result = await page.evaluate(async () => {
      const ctx = window.Agent.buildAgentContext({ instruction: 'x', referenceSkill: null, url: 'u', elements: [], history: [] });
      let receivedContext = null;
      const fakeModel = async (context) => {
        receivedContext = context;
        return { type: 'action', action: { type: 'click', target: '#submit-btn' } };
      };
      const decision = await window.Agent.decideNextAction(ctx, fakeModel);
      return { decision, sawInstruction: receivedContext?.instruction };
    });
    check('the supplied model function is called with the context', result.sawInstruction === 'x');
    check('its response is validated and returned', result.decision?.action?.target === '#submit-btn');
    await page.close();
  }

  console.log('=== decideNextAction: a malformed model response resolves to null, not a thrown error ===');
  {
    const page = await freshPage();
    const decision = await page.evaluate(async () => {
      const ctx = window.Agent.buildAgentContext({ instruction: 'x', referenceSkill: null, url: 'u', elements: [], history: [] });
      const badModel = async () => ({ nonsense: true });
      return window.Agent.decideNextAction(ctx, badModel);
    });
    check('resolves to null rather than throwing or passing through garbage', decision === null);
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
