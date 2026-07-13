/**
 * Mock-based test suite for extension/background/background.js.
 *
 * This sandbox's available Chromium build turned out not to support
 * extensions at all (its startup log shows zero mention of extensions
 * anywhere, with --load-extension silently ignored — likely compiled
 * out entirely, a common size optimization for a build meant for
 * serverless functions, which have no use for browser extensions) —
 * genuine end-to-end testing (a real browser actually loading this as an
 * unpacked extension) needs to happen in a real Chrome install, which
 * this environment doesn't have. This is the next best thing: a minimal
 * fake `chrome.*` API (in-memory storage, captured message sends) lets
 * background.js's actual state-machine logic run for real and be
 * checked thoroughly, with only the real chrome APIs faked out.
 *
 * Run: node test/extension/background-test.mjs
 */

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.error('  FAIL -', name); }
}

// --- minimal fake chrome.* surface --------------------------------------
const sessionStore = new Map();
const sentMessages = []; // { tabId, message }
const removedListeners = [];

globalThis.chrome = {
  storage: {
    session: {
      async get(key) {
        return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
      async remove(key) {
        sessionStore.delete(key);
      },
    },
  },
  tabs: {
    async sendMessage(tabId, message) {
      sentMessages.push({ tabId, message });
      // Simulate the content script's own SCAN_REQUEST response, since
      // background.js awaits this call's return value for that one
      // message type specifically.
      if (message.type === 'PP_AGENT_SCAN_REQUEST') return fakeElements;
      return undefined;
    },
    onRemoved: {
      addListener(fn) { removedListeners.push(fn); },
    },
  },
  runtime: {
    onMessage: {
      addListener() {}, // background.js registers handleMessage this way; the test calls handleMessage directly instead
    },
  },
};

let fakeElements = [{ selector: '#x', tag: 'input', type: 'text', value: '' }];

const bg = await import('../../extension/background/background.js');

function makeSender(tabId, url = 'https://example.com/') {
  return { tab: { id: tabId, url } };
}

async function main() {
  console.log('=== START_TASK: stores the task, requests a scan, and asks the model ===');
  {
    sentMessages.length = 0;
    let receivedInstruction = null;
    bg.__setCallModelForTesting(async (context) => {
      receivedInstruction = context.instruction;
      return { type: 'action', action: { type: 'click', target: '#submit' } };
    });

    let responded = null;
    bg.handleMessage(
      { type: 'PP_AGENT_START_TASK', instruction: 'Add an employee named Wang', referenceSkill: null },
      makeSender(1),
      (r) => { responded = r; }
    );
    await new Promise((r) => setTimeout(r, 10)); // let the async IIFE inside handleMessage settle

    check('a scan was requested from the content script', sentMessages.some((m) => m.message.type === 'PP_AGENT_SCAN_REQUEST'));
    check('the model was called with the given instruction', receivedInstruction === 'Add an employee named Wang');
    check('the decided action was sent to the content script to execute', sentMessages.some((m) => m.message.type === 'PP_AGENT_EXECUTE_ACTION' && m.message.action.target === '#submit'));
    const task = await bg.getTask(1);
    check('the task is stored with status "running"', task.status === 'running');
    check('the pending action is remembered for when the result comes back', task.pendingAction?.target === '#submit');
  }

  console.log('=== ACTION_RESULT: records history and continues the loop ===');
  {
    sentMessages.length = 0;
    let callCount = 0;
    bg.__setCallModelForTesting(async () => {
      callCount++;
      return { type: 'action', action: { type: 'type', target: '#name', text: 'Wang' } };
    });

    bg.handleMessage(
      { type: 'PP_AGENT_ACTION_RESULT', url: 'https://example.com/', elements: fakeElements, result: 'ok', error: null },
      makeSender(1),
      () => {}
    );
    await new Promise((r) => setTimeout(r, 10));

    const task = await bg.getTask(1);
    check('the previous action + its result was appended to history', task.history.length === 1 && task.history[0].action.target === '#submit' && task.history[0].result === 'ok');
    check('the model was asked again for the next step', callCount === 1);
    check('the new decided action becomes the pending one', task.pendingAction?.target === '#name');
  }

  console.log('=== CONTENT_READY after a navigation: resumes an in-progress task using its existing history ===');
  {
    sentMessages.length = 0;
    let receivedHistoryLength = null;
    bg.__setCallModelForTesting(async (context) => {
      receivedHistoryLength = context.history.length;
      return { type: 'done', summary: 'Employee added successfully' };
    });

    bg.handleMessage(
      { type: 'PP_AGENT_CONTENT_READY', url: 'https://example.com/confirmation', elements: [] },
      makeSender(1),
      () => {}
    );
    await new Promise((r) => setTimeout(r, 10));

    check('the model saw the history accumulated before the navigation', receivedHistoryLength === 1);
    const task = await bg.getTask(1);
    check('a "done" decision marks the task finished', task.status === 'done');
    check('the summary is recorded', task.summary === 'Employee added successfully');
    check('a TASK_DONE message was sent to the content script', sentMessages.some((m) => m.message.type === 'PP_AGENT_TASK_DONE'));
  }

  console.log('=== CONTENT_READY for a task that is already done: does nothing further ===');
  {
    sentMessages.length = 0;
    let called = false;
    bg.__setCallModelForTesting(async () => { called = true; return { type: 'done', summary: 'x' }; });

    bg.handleMessage({ type: 'PP_AGENT_CONTENT_READY', url: 'https://example.com/', elements: [] }, makeSender(1), () => {});
    await new Promise((r) => setTimeout(r, 10));

    check('the model is not called again for an already-finished task', !called);
    check('no message is sent for an already-finished task', sentMessages.length === 0);
  }

  console.log('=== a thrown error from the model call blocks the task with a clear reason, instead of crashing ===');
  {
    sentMessages.length = 0;
    bg.__setCallModelForTesting(async () => { throw new Error('network timeout'); });
    await bg.saveTask(2, { instruction: 'x', referenceSkill: null, history: [], status: 'running' });

    bg.handleMessage({ type: 'PP_AGENT_CONTENT_READY', url: 'https://example.com/', elements: [] }, makeSender(2), () => {});
    await new Promise((r) => setTimeout(r, 10));

    const task = await bg.getTask(2);
    check('the task is marked blocked, not left in an inconsistent state', task.status === 'blocked');
    check('the block reason mentions the underlying error', task.blockedReason.includes('network timeout'));
    check('a TASK_BLOCKED message was sent', sentMessages.some((m) => m.message.type === 'PP_AGENT_TASK_BLOCKED'));
  }

  console.log('=== a malformed (unparseable) model response blocks the task rather than passing garbage through ===');
  {
    bg.__setCallModelForTesting(async () => ({ nonsense: true }));
    await bg.saveTask(3, { instruction: 'x', referenceSkill: null, history: [], status: 'running' });

    bg.handleMessage({ type: 'PP_AGENT_CONTENT_READY', url: 'https://example.com/', elements: [] }, makeSender(3), () => {});
    await new Promise((r) => setTimeout(r, 10));

    const task = await bg.getTask(3);
    check('the task is marked blocked rather than trying to act on garbage', task.status === 'blocked');
  }

  console.log('=== a "blocked" decision from the model is recorded with its given reason ===');
  {
    bg.__setCallModelForTesting(async () => ({ type: 'blocked', reason: 'Cannot find a save button on this page' }));
    await bg.saveTask(4, { instruction: 'x', referenceSkill: null, history: [], status: 'running' });

    bg.handleMessage({ type: 'PP_AGENT_CONTENT_READY', url: 'https://example.com/', elements: [] }, makeSender(4), () => {});
    await new Promise((r) => setTimeout(r, 10));

    const task = await bg.getTask(4);
    check('the task is blocked', task.status === 'blocked');
    check('the model\'s own reason is preserved, not replaced with a generic one', task.blockedReason === 'Cannot find a save button on this page');
  }

  console.log('=== the step-count safety cap stops a task that never finishes, instead of looping forever ===');
  {
    sentMessages.length = 0;
    let modelCallCount = 0;
    bg.__setCallModelForTesting(async () => {
      modelCallCount++;
      return { type: 'action', action: { type: 'click', target: '#again' } };
    });
    // Pre-load history right up to the cap, so the very next step trips it.
    const longHistory = Array.from({ length: 40 }, () => ({ action: { type: 'click', target: '#x' }, result: 'ok' }));
    await bg.saveTask(5, { instruction: 'x', referenceSkill: null, history: longHistory, status: 'running' });

    bg.handleMessage({ type: 'PP_AGENT_CONTENT_READY', url: 'https://example.com/', elements: [] }, makeSender(5), () => {});
    await new Promise((r) => setTimeout(r, 10));

    const task = await bg.getTask(5);
    check('the model was still asked once more (to know whether it would have finished)', modelCallCount === 1);
    check('the task is blocked once the cap is reached, not left running forever', task.status === 'blocked');
    check('the block reason explains it was the step cap, not some other failure', task.blockedReason.includes('40 steps'));
  }

  console.log('=== a tab closing mid-task clears its stored state ===');
  {
    await bg.saveTask(6, { instruction: 'x', referenceSkill: null, history: [], status: 'running' });
    check('the task exists before the tab closes', (await bg.getTask(6)) !== null);
    for (const fn of removedListeners) fn(6);
    check('the task is gone after the tab closes', (await bg.getTask(6)) === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
