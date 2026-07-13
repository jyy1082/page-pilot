/**
 * PagePilot Agent — content script.
 *
 * Injected fresh into every page load — including after the page
 * navigates away mid-task, which is exactly the situation this whole
 * extension exists to survive. On load, this always re-announces itself
 * to the background and hands over a fresh scan of the current page;
 * the background is what remembers whether a task was actually in
 * progress and, if so, continues it from here. This file holds no task
 * state of its own — see background.js for why.
 */

(function () {
  const MSG = {
    CONTENT_READY: 'PP_AGENT_CONTENT_READY',
    ACTION_RESULT: 'PP_AGENT_ACTION_RESULT',
    EXECUTE_ACTION: 'PP_AGENT_EXECUTE_ACTION',
    TASK_DONE: 'PP_AGENT_TASK_DONE',
    TASK_BLOCKED: 'PP_AGENT_TASK_BLOCKED',
    SCAN_REQUEST: 'PP_AGENT_SCAN_REQUEST',
  };

  let PagePilot, Agent, cursor;

  async function ensureLoaded() {
    if (PagePilot && Agent) return;
    const [pagePilotModule, agentModule] = await Promise.all([
      import(chrome.runtime.getURL('src/page-pilot.js')),
      import(chrome.runtime.getURL('src/page-pilot-agent.js')),
    ]);
    PagePilot = pagePilotModule.PagePilot;
    Agent = agentModule;
    cursor = new PagePilot();
  }

  async function scanNow() {
    await ensureLoaded();
    return Agent.scanInteractiveElements(document);
  }

  /**
   * Runs a single decided action through page-pilot's core — the same
   * engine the bookmarklet toolkit uses, so this gets the same animated
   * cursor, the same modal-obstruction handling, and the same iframe
   * reload waiting for free, with no separate execution path to keep in
   * sync.
   */
  async function executeAction(action) {
    await ensureLoaded();
    switch (action.type) {
      case 'click':
        return cursor.click(action.target);
      case 'type':
        return cursor.type(action.target, action.text);
      case 'select':
        return cursor.select(action.target, action.value);
      case 'check':
        return cursor.check(action.target, action.checked);
      case 'chooseOption':
        return cursor.chooseOption(action.target, action.option);
      case 'pressKey':
        return cursor.pressKey(action.target, action.key, action.options);
      case 'waitFor':
        return cursor.waitFor(action.target, action.options);
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  async function announceReady() {
    const elements = await scanNow();
    chrome.runtime.sendMessage({ type: MSG.CONTENT_READY, url: location.href, elements }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === MSG.SCAN_REQUEST) {
      scanNow().then(sendResponse);
      return true;
    }

    if (message.type === MSG.EXECUTE_ACTION) {
      (async () => {
        let result = null;
        let error = null;
        try {
          result = await executeAction(message.action);
        } catch (err) {
          error = err.message;
        }
        // The action may have navigated the page (a form submit, a link
        // click) — if so, this whole script is about to be torn down and
        // this message never gets sent; the fresh content script that
        // loads on the new page announces itself instead (see
        // announceReady, called unconditionally below), and the
        // background continues the task from there using the same
        // history. Nothing needs to detect the navigation explicitly.
        const elements = await scanNow();
        chrome.runtime.sendMessage({ type: MSG.ACTION_RESULT, url: location.href, elements, result, error }).catch(() => {});
      })();
      return false;
    }

    if (message.type === MSG.TASK_DONE || message.type === MSG.TASK_BLOCKED) {
      // Deliberately a no-op for now — no UI has been built yet to
      // surface this to a person. Wiring point for later: show a banner,
      // a badge on the extension icon, whatever fits once there's a UI
      // to design around.
      return false;
    }
  });

  announceReady();
})();
