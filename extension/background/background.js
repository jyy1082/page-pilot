/**
 * PagePilot Agent — background service worker.
 *
 * Owns all task state, keyed by tabId, so a task survives a page
 * navigation or reload even though the content script it's talking to
 * gets destroyed and reloaded from scratch every time that happens. The
 * content script re-announces itself on every page load; this file is
 * what remembers there was a task in progress and what's happened so
 * far, and hands the content script whatever the next thing to do is.
 *
 * MV3 service workers get put to sleep whenever the browser feels like
 * it, wiping any plain in-memory state — task state is kept in
 * chrome.storage.session (cleared when the browser closes, which is the
 * right lifetime for a task; survives the service worker's own sleep
 * cycles, which is the whole reason it's not just a module-level Map).
 */

import { buildAgentContext, decideNextAction } from '../../src/page-pilot-agent.js';

const MSG = {
  CONTENT_READY: 'PP_AGENT_CONTENT_READY',
  ACTION_RESULT: 'PP_AGENT_ACTION_RESULT',
  START_TASK: 'PP_AGENT_START_TASK',
  EXECUTE_ACTION: 'PP_AGENT_EXECUTE_ACTION',
  TASK_DONE: 'PP_AGENT_TASK_DONE',
  TASK_BLOCKED: 'PP_AGENT_TASK_BLOCKED',
};

const STORAGE_KEY_PREFIX = 'agent-task:';

/**
 * NOT WIRED UP TO A REAL MODEL YET — this is the one piece deliberately
 * left as a placeholder until a model is chosen. Swap this out for a
 * real API call; nothing else in this file needs to change, since
 * decideNextAction() (from page-pilot-agent.js) already treats this as
 * an opaque, pluggable function. It must resolve to a decision object
 * matching src/page-pilot-agent.js's validateDecision() shape:
 *   { type: 'action', action: { type, target, ...} }
 *   { type: 'done', summary }
 *   { type: 'blocked', reason }
 */
async function defaultCallModel(context) {
  throw new Error(
    'callModel() is not implemented yet — page-pilot-agent needs a real model wired in here before tasks can run. ' +
    'See the JSDoc above this function for the expected input/output shape.'
  );
}

let callModel = defaultCallModel;

/**
 * Testing hook only — lets a test swap in a fake model without needing
 * a real API call, so the surrounding state machine (task storage, the
 * step loop, the safety cap, done/blocked handling) can be verified on
 * its own. Not used anywhere in real operation; production code always
 * goes through defaultCallModel until a real model is wired in there.
 */
export function __setCallModelForTesting(fn) {
  callModel = fn || defaultCallModel;
}

export async function getTask(tabId) {
  const key = STORAGE_KEY_PREFIX + tabId;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

export async function saveTask(tabId, task) {
  const key = STORAGE_KEY_PREFIX + tabId;
  await chrome.storage.session.set({ [key]: task });
}

export async function clearTask(tabId) {
  const key = STORAGE_KEY_PREFIX + tabId;
  await chrome.storage.session.remove(key);
}

/**
 * Runs one full "ask the model, get a decision, tell the content script
 * what to do" cycle for a task that's already stored. Called both when
 * a task is first started and every time a content script re-announces
 * itself after a navigation.
 */
export async function advanceTask(tabId, task, pageContext) {
  const context = buildAgentContext({
    instruction: task.instruction,
    referenceSkill: task.referenceSkill,
    url: pageContext.url,
    elements: pageContext.elements,
    history: task.history,
  });

  let decision;
  try {
    decision = await decideNextAction(context, callModel);
  } catch (err) {
    task.status = 'blocked';
    task.blockedReason = `Model call failed: ${err.message}`;
    await saveTask(tabId, task);
    chrome.tabs.sendMessage(tabId, { type: MSG.TASK_BLOCKED, reason: task.blockedReason }).catch(() => {});
    return;
  }

  if (!decision) {
    task.status = 'blocked';
    task.blockedReason = 'The model\'s response could not be understood as a valid decision.';
    await saveTask(tabId, task);
    chrome.tabs.sendMessage(tabId, { type: MSG.TASK_BLOCKED, reason: task.blockedReason }).catch(() => {});
    return;
  }

  if (decision.type === 'done') {
    task.status = 'done';
    task.summary = decision.summary;
    await saveTask(tabId, task);
    chrome.tabs.sendMessage(tabId, { type: MSG.TASK_DONE, summary: decision.summary }).catch(() => {});
    return;
  }

  if (decision.type === 'blocked') {
    task.status = 'blocked';
    task.blockedReason = decision.reason;
    await saveTask(tabId, task);
    chrome.tabs.sendMessage(tabId, { type: MSG.TASK_BLOCKED, reason: decision.reason }).catch(() => {});
    return;
  }

  // A safety-net step cap lives here (not just a nice-to-have): a model
  // that keeps deciding on plausible-looking actions that never actually
  // finish the instruction would otherwise loop forever, burning API
  // calls and clicking around a live page indefinitely.
  const MAX_STEPS = 40;
  if (task.history.length >= MAX_STEPS) {
    task.status = 'blocked';
    task.blockedReason = `Stopped after ${MAX_STEPS} steps without finishing — this needs a person to check what's happening.`;
    await saveTask(tabId, task);
    chrome.tabs.sendMessage(tabId, { type: MSG.TASK_BLOCKED, reason: task.blockedReason }).catch(() => {});
    return;
  }

  task.pendingAction = decision.action;
  await saveTask(tabId, task);
  chrome.tabs.sendMessage(tabId, { type: MSG.EXECUTE_ACTION, action: decision.action }).catch(() => {});
}

export function handleMessage(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === MSG.START_TASK) {
    // Sent by whatever UI starts a task (not built yet — a popup, most
    // likely). Kept as a plain message handler rather than assuming a
    // specific caller, so it's easy to wire up once that UI exists.
    (async () => {
      const task = {
        instruction: message.instruction,
        referenceSkill: message.referenceSkill || null,
        history: [],
        status: 'running',
      };
      await saveTask(tabId, task);
      const elements = await chrome.tabs.sendMessage(tabId, { type: 'PP_AGENT_SCAN_REQUEST' }).catch(() => null);
      if (elements) await advanceTask(tabId, task, { url: sender.tab.url, elements });
      sendResponse({ ok: true });
    })();
    return true; // keep the message channel open for the async response
  }

  if (message.type === MSG.CONTENT_READY) {
    (async () => {
      const task = await getTask(tabId);
      if (!task || task.status !== 'running') return;
      // A fresh page after a navigation — re-scan and continue right
      // where the task left off, using the same history.
      await advanceTask(tabId, task, { url: message.url, elements: message.elements });
    })();
    return false;
  }

  if (message.type === MSG.ACTION_RESULT) {
    (async () => {
      const task = await getTask(tabId);
      if (!task || task.status !== 'running') return;
      task.history.push({ action: task.pendingAction, result: message.result, error: message.error });
      task.pendingAction = null;
      await advanceTask(tabId, task, { url: message.url, elements: message.elements });
    })();
    return false;
  }
}

chrome.runtime.onMessage.addListener(handleMessage);

// A tab closing mid-task has nothing left to advance — drop its state
// rather than leaving it in storage indefinitely.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTask(tabId).catch(() => {});
});
