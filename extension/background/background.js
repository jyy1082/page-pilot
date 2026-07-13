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

// ---------------------------------------------------------------------------
// Model configuration — HARDCODED FOR NOW, BY DESIGN, FOR EARLY TESTING.
// Replace OPENAI_API_KEY with a real key to try this. This is deliberately
// temporary: shipping a real key inside extension source is not safe for
// anything beyond the developer's own local testing — the plan is to
// replace this with a settings page (chrome.storage.local, entered by
// the person using the extension, never committed to source) before this
// goes anywhere near a real release. Nothing else in this file needs to
// change when that happens — only this block.
// ---------------------------------------------------------------------------
const OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY_HERE';
const OPENAI_MODEL = 'gpt-4o';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are controlling a real web browser to complete a task, one small action at a time. You will be told the result of each action before deciding the next one — you do not need to (and cannot) plan the whole task in advance.

You will be given, as a JSON object:
- "instruction": what the person wants done, in their own words.
- "referenceSkill": steps recorded from a similar task before, if one exists. Treat this as a rough route map, NOT a script to follow literally — the current page may not match what was recorded (different values, a slightly different layout, an extra step, a missing one). Adapt to what the page actually shows you now.
- "page": the current page's URL and a compact list of its interactive elements — NOT the full HTML. Each element has a "selector" you must use verbatim as "target" if you act on it; a "tag"; a "type"; a "label" when one could be found; and, depending on the element, a current "value", "options" (for a <select>), or "checked" state.
- "history": every action taken so far this run and what happened (its result, or an error if it failed).

Decide exactly ONE next action and respond with ONLY a single JSON object — no other text, no markdown code fence — in one of these exact shapes:

{"type": "action", "reasoning": "brief reason", "action": {"type": "click", "target": "<selector from the page list>"}}
{"type": "action", "reasoning": "brief reason", "action": {"type": "type", "target": "<selector>", "text": "<the value to type>"}}
{"type": "action", "reasoning": "brief reason", "action": {"type": "select", "target": "<selector>", "value": "<one of that element's option values>"}}
{"type": "action", "reasoning": "brief reason", "action": {"type": "check", "target": "<selector>", "checked": true}}
{"type": "action", "reasoning": "brief reason", "action": {"type": "chooseOption", "target": "<trigger selector>", "option": "<option selector>"}}
{"type": "action", "reasoning": "brief reason", "action": {"type": "pressKey", "target": "<selector>", "key": "Enter"}}
{"type": "done", "summary": "brief description of what was accomplished"}
{"type": "blocked", "reason": "why you cannot safely proceed — e.g. no element on the page matches what's needed, the instruction is ambiguous, or this looks like a high-risk action (delete, pay, submit something irreversible) that a person should confirm first"}

Rules:
- Only ever use a "target" selector that appears verbatim in the current "page" element list. Never invent or guess one — if nothing on the page matches what you need, respond with "blocked" instead.
- If the history shows the same action failing repeatedly, do not just retry it unchanged — either try a different approach or respond with "blocked".
- Prefer "blocked" over guessing when unsure, especially for anything that deletes, pays, submits, or otherwise can't easily be undone.`;

async function defaultCallModel(context) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY_HERE') {
    throw new Error(
      'No OpenAI API key configured — set OPENAI_API_KEY at the top of background.js to try this out. ' +
      '(Temporary, for local testing only — see the comment above that constant.)'
    );
  }

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(context) },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI API request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('OpenAI response had no message content to parse.');

  // Deliberately NOT wrapped in a try/catch here that swallows the parse
  // error — decideNextAction() (see page-pilot-agent.js) expects
  // callModel to either resolve to a decision object or throw; a parse
  // failure IS a real failure worth surfacing (as a blocked task with a
  // clear reason — see advanceTask's catch block), not something to
  // silently paper over by guessing at a fallback decision.
  return JSON.parse(raw);
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
