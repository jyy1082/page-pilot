/**
 * page-pilot-agent — AI-guided, step-by-step execution loop.
 *
 * Given a natural-language instruction and a reference skill (recorded
 * steps used as a rough route map, not a script to blindly replay), this
 * module scans the current page into a compact, model-readable summary,
 * asks a pluggable "decide the next action" function what to do next,
 * and returns one action at a time — never the whole plan up front. The
 * caller (the extension's background service worker) is responsible for
 * actually executing each action (via page-pilot's core engine) and
 * feeding the result back in before asking for the next one. This module
 * itself never touches the DOM to *execute* anything and never calls any
 * AI API directly — both of those are the caller's job, kept out of here
 * so this stays testable without a live model or a live extension.
 *
 * This is deliberately NOT a one-shot planner: the whole point of a
 * step-by-step loop is that the real page after step N may not match
 * what was expected, and the next decision should see that real state
 * rather than a plan made before anything happened.
 */

// ---------------------------------------------------------------------------
// Page scanning
// ---------------------------------------------------------------------------

const INTERACTIVE_SELECTOR = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'button',
  'a[href]',
  '[role="button"]',
  '[contenteditable="true"]',
].join(',');

/**
 * Scans `root` (defaults to the whole document) for interactive elements
 * and returns a compact, model-readable summary of each one — enough to
 * decide what to click/type/select next, without the cost (and noise) of
 * handing over the page's full HTML. Elements that are hidden, disabled,
 * or otherwise not actually usable right now are skipped, since they
 * aren't real candidates for the next action either way.
 *
 * Each entry uses the same target/field vocabulary as page-pilot's own
 * steps (selector, tag, label, value, options for a <select>, checked
 * for a checkbox/radio) so a decided action can be executed directly
 * through page-pilot's core with no translation step in between.
 */
export function scanInteractiveElements(root = document, options = {}) {
  const { maxElements = 200 } = options;
  const doc = root.ownerDocument || root;
  const elements = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
  const results = [];

  for (const el of elements) {
    if (results.length >= maxElements) break;
    if (!isUsable(el)) continue;
    const entry = describeElement(el, doc);
    if (entry) results.push(entry);
  }

  return results;
}

function isUsable(el) {
  if (el.disabled) return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

function describeElement(el, doc) {
  const tag = el.tagName.toLowerCase();
  const selector = buildStableSelector(el, doc);
  if (!selector) return null; // nothing stable enough to reference later — skip rather than guess

  const base = { selector, tag, label: findLabel(el) };

  if (tag === 'select') {
    const options = Array.from(el.options || []).map((o) => o.textContent.trim());
    return { ...base, type: el.multiple ? 'select-multiple' : 'select', options, value: el.value };
  }
  if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
    return { ...base, type: el.type, checked: el.checked };
  }
  if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
    return { ...base, type: el.type || 'text', value: el.isContentEditable ? el.textContent : el.value, placeholder: el.placeholder || undefined };
  }
  // button, link, [role=button] — an action target, not a value holder
  const text = (el.textContent || el.value || '').trim().slice(0, 80);
  return { ...base, type: 'action', text: text || undefined };
}

/**
 * Prefers `id` when it's actually unique on the page (duplicate ids are
 * common on real, messier sites — the same reason page-pilot-recorder
 * disambiguates them by position for its own selectors), falls back to
 * a handful of other stable-ish attributes, and gives up rather than
 * returning a fragile, purely-structural selector no one could recognize
 * — an element the model can't reliably re-find later is worse than one
 * left out of the summary entirely.
 */
function buildStableSelector(el, doc) {
  if (el.id && doc.querySelectorAll(`[id="${cssEscape(el.id)}"]`).length === 1) return `#${cssEscape(el.id)}`;
  for (const attr of ['data-testid', 'data-cy', 'data-test', 'name']) {
    const value = el.getAttribute(attr);
    if (value && doc.querySelectorAll(`[${attr}="${cssEscape(value)}"]`).length === 1) {
      return `[${attr}="${cssEscape(value)}"]`;
    }
  }
  return null;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function findLabel(el) {
  if (el.id) {
    const matches = (el.ownerDocument || document).querySelectorAll(`[id="${cssEscape(el.id)}"]`);
    if (matches.length === 1) {
      const label = (el.ownerDocument || document).querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (label && label.textContent.trim()) return label.textContent.trim();
    }
  }
  const wrappingLabel = el.closest && el.closest('label');
  if (wrappingLabel) {
    const text = wrappingLabel.textContent.replace(el.value || '', '').trim();
    if (text) return text;
  }
  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  if (el.placeholder) return el.placeholder;
  return undefined;
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/**
 * Assembles everything one "decide the next action" call needs: the
 * instruction, the reference skill (a route map, not a script), the
 * current page's scanned elements, and what's happened so far this run.
 * Kept as a plain, serializable object — this is what actually crosses
 * the boundary to the model, so it needs to be JSON-safe on its own.
 */
export function buildAgentContext({ instruction, referenceSkill, url, elements, history }) {
  return {
    instruction,
    referenceSkill: referenceSkill
      ? { description: referenceSkill.description, steps: referenceSkill.steps }
      : null,
    page: { url, elements },
    history: history || [],
  };
}

// ---------------------------------------------------------------------------
// Action schema helpers
// ---------------------------------------------------------------------------

/** The same step vocabulary page-pilot's core already understands. */
export const ACTION_TYPES = ['click', 'type', 'select', 'check', 'chooseOption', 'pressKey', 'waitFor'];

/** Terminal signals a decision can return instead of an action. */
export const CONTROL_SIGNALS = ['done', 'blocked'];

/**
 * Loose validation for whatever a model returns — this is a trust
 * boundary (model output, not hand-written code), so nothing here should
 * be executed against a real page without first passing this check.
 * Returns null (not a throw) for invalid input, since a malformed
 * decision should be treated as "ask again" or "flag it," not crash the
 * whole run.
 */
export function validateDecision(decision) {
  if (!decision || typeof decision !== 'object') return null;
  if (CONTROL_SIGNALS.includes(decision.type)) return decision;
  if (!decision.action || typeof decision.action !== 'object') return null;
  if (!ACTION_TYPES.includes(decision.action.type)) return null;
  if (decision.action.type !== 'pressKey' && decision.action.target === undefined) return null;
  return decision;
}

// ---------------------------------------------------------------------------
// The decision loop's single step
// ---------------------------------------------------------------------------

/**
 * Asks `callModel` (supplied by the caller — this module never calls any
 * AI API itself, see the file header) what to do next, given the current
 * context, and returns a validated decision or null if the model's
 * response couldn't be understood at all.
 *
 * `callModel(context)` should return a promise resolving to a decision
 * object: either `{ type: 'action', action: {...} }`,
 * `{ type: 'done', summary }`, or `{ type: 'blocked', reason }`.
 */
export async function decideNextAction(context, callModel) {
  const raw = await callModel(context);
  return validateDecision(raw);
}
