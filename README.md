# page-pilot

**Version 1.1.1** · see [CHANGELOG.md](./CHANGELOG.md) for release history

A dependency-free toolkit for visualized browser automation, in five
layers that live in this one repository:

| Layer | File | What it does |
|---|---|---|
| **Core** | `src/page-pilot.js` | Plays back a step array with a visible animated cursor, click ripples, and highlight borders — so it's obvious what's happening and where |
| **Recorder** | `src/page-pilot-recorder.js` | Turns real clicks/typing/selecting into the exact step array the core expects |
| **Skills** | `src/page-pilot-skills.js` | Turns a recording into a reusable, named "skill" — specific values become named parameters you can swap out later |
| **Toolkit** | `src/toolkit.js` | A bookmarklet: drag one link to your bookmarks bar, click it on any site to get a record/run panel — no install, no extension |
| **Agent** *(preview)* | `src/page-pilot-agent.js` + `extension/` | A Chrome extension: given an instruction and a reference skill, decides one action at a time from the page's real current state — see [Agent](#agent-preview) below |

Each layer only depends on the ones before it in this table — the core
engine has zero dependencies at all, the recorder only produces steps the
core understands, skills depends on nothing beyond the DOM, the toolkit
ties the first three together with a UI, and the agent runs on top of
the core engine and (optionally) a skill as a reference. You can use any
layer on its own.

## Quick start — no code at all

**[Open the install page](https://jyy1082.github.io/page-pilot/demo/install.html)**
and drag the button there to your bookmarks bar. Click it on any site to
record a sequence of clicks/typing, save it as a reusable skill, or just
run a pasted-in step array directly. See "Toolkit" below for details.

## Quick start — as a library

```bash
npm install page-pilot
```

```js
import { PagePilot } from 'page-pilot'
import { PagePilotRecorder } from 'page-pilot/recorder'
import { detectParameters, saveSkill, fillSkillParameters } from 'page-pilot/skills'

const recorder = new PagePilotRecorder()
recorder.start()
// ...person interacts with the page...
const steps = recorder.stop()

const cursor = new PagePilot()
await cursor.run(steps) // plays it back with a visible cursor
```

---

# Core: page-pilot (playback)

Plays back a sequence of steps with a visible cursor, click animations,
and persistent highlight borders. It does **not** decide what to click —
it only animates and executes a step you already know you want, so you
(or the recorder, or the skills layer) stay in control of the actual
automation logic.

## Usage

```js
import { PagePilot } from 'page-pilot'

const cursor = new PagePilot()
await cursor.click(document.querySelector('#submit'))
await cursor.type(document.querySelector('#name'), 'Acme Corp')
await cursor.select(document.querySelector('#country'), 'US')
await cursor.check(document.querySelector('#agree'), true)
await cursor.chooseOption('#menu-trigger', '.menu-item[data-value="pro"]')
await cursor.pressKey('#search', 'Enter')
await cursor.hover('#info-icon')
await cursor.unhover()
await cursor.dragTo('#item-1', '#drop-zone')
await cursor.waitFor('#async-result', { timeout: 8000 })
await cursor.waitFor('#save-btn', { state: 'gone', timeout: 3000 }) // wait for something to disappear instead
await cursor.waitForFrameReload('#payment-iframe') // wait for a same-origin iframe to reload
cursor.destroy()
```

Or run a whole recorded/hand-written step array at once:

```js
await cursor.run([
  { type: 'click', target: '#submit' },
  { type: 'type', target: '#name', text: 'Acme Corp' },
])
```

## Target shapes

`target` accepts an `Element`, a CSS selector string, or an object
combining `selector` with:
- **`frame`** — for an element inside a same-origin iframe (a selector,
  or an array of them for nested iframes). Cross-origin iframes can't be
  targeted at all — that's a hard browser security limitation.
- **`index`** — to pick the Nth match of a selector that isn't unique on
  its own (duplicate `id`s happen a lot on real, messier sites).
- **`text`** — to match a button/link by its visible text content (native
  CSS has no "match by text" selector, so this fills that gap — often the
  most human-recognizable identifier a button has).

All three combine freely, including with `frame`. These are exactly the
shapes page-pilot-recorder generates automatically, so recorded steps
replay with no manual adjustment.

## Modals and overlays

Because clicks are dispatched straight to a resolved element instead of
through the browser's normal hit-testing, this library can click
"through" something a real mouse never could — most commonly a modal's
backdrop still covering the page. Set `verifyClickable: true` to check
for this before every click; it throws a clear error naming what's
covering the target instead of clicking through it. Provide
`onObstruction: async (blockingEl, targetEl) => boolean` to handle it
yourself (e.g. dismiss the modal) instead of erroring — return `true` if
you dismissed it (use plain `element.click()` in this callback, not
`cursor.click()`, or you'll deadlock the queue).

## iframe reloads

If a click causes a same-origin iframe to reload its own content
(embedded payment widgets, multi-step forms), `waitForFrameReload(selector)`
waits for its document identity to actually change, without needing to
know anything about the new content:

```js
await cursor.click('#refresh-iframe-btn')
await cursor.waitForFrameReload('#payment-iframe')
await cursor.click({ selector: '#new-btn', frame: '#payment-iframe' })
```

Or set `autoWaitForIframeReload: true` to have every click watch for this
automatically, with no explicit wait step — the right choice when you're
running steps you can't hand-edit (recorded/pasted JSON, a saved skill).

## Config (defaults)

```js
new PagePilot({
  color: '#378ADD', size: 16, moveDuration: 480, clickPause: 260, typeDelay: 45,
  respectReducedMotion: true, zIndex: 999999,
  showCursorDot: true, showScrollIndicator: false, showPageGlow: false,
  pageGlowColor: null, pageGlowWidth: 4, pageGlowTarget: null, pageGlowRadius: 0,
  pageGlowMessage: null,          // status label shown atop the glow area
  blockInteraction: true,         // block real clicks inside the glow area while it's showing
  pointerBlockAllowlist: [],      // selectors that stay clickable even while blocked
  highlightEnabled: true, highlightColor: null, highlightDuration: null,
  autoWaitForIframeReload: false, autoIframeReloadGrace: 400, autoIframeReloadMaxWait: 4000,
  verifyClickable: false, onObstruction: null,
  onExecuteClick: (el) => { /* pointerdown/mousedown/pointerup/mouseup/click sequence */ },
  onExecuteInput: (el, text) => { /* native-setter input */ },
  onBeforeStep: (step) => {}, onAfterStep: (step) => {},
})
```

## Known limits

- Native `<select>` dropdown menus, native date/color pickers — the popup
  itself is OS/browser-rendered, not in the DOM, so only the trigger click
  can be animated.
- File inputs (`<input type="file">`) can't be set by any script, for
  security reasons, in any browser.
- `dragTo()` covers mouse-event-driven drag (custom sortable lists,
  sliders) — not native HTML5 drag-and-drop (`draggable="true"` +
  `DataTransfer`), which needs a real user gesture in most browsers.
- Every event dispatched is genuine but `isTrusted: false` — no page-level
  JS can change that. Most sites don't check `event.isTrusted`; a few
  (deliberate anti-automation logic) do and will silently ignore it.

---

# Recorder: page-pilot-recorder

Turns real clicks/typing/selecting into the exact step array the core
expects. Only listens to real (`isTrusted`) DOM events — never dispatches
anything itself, the mirror image of the core engine.

## Usage

```js
import { PagePilotRecorder } from 'page-pilot/recorder'

const recorder = new PagePilotRecorder({ ui: true }) // floating start/stop/copy panel
recorder.start()
// ...person interacts with the page...
const steps = recorder.stop()
```

## What gets recorded

click, typing (buffered until blur, not per-keystroke — Enter inside a
`<textarea>`/`contenteditable` is just a newline, not a shortcut, so
multi-line text isn't cut off after the first line), native `<select>`
(single/multi), checkbox/radio (as `check` steps), non-character keys and
modifier shortcuts (Ctrl+A etc., as `pressKey`), debounced window/
container scrolling, drag gestures past a distance threshold (skips
likely text-selection drags), and opening a custom dropdown + picking an
option (auto-merged into one `chooseOption` step via a `MutationObserver`,
instead of two separate clicks).

If a field gets typed into, left, and come back to and retyped — fixing a
typo by leaving and returning, say — with nothing else happening in
between the two edits, only the final value is recorded, along with
whatever led up to it (Backspace, Ctrl+A, etc. are cleaned up too, since
the merged step alone already reproduces the same end result on replay).
The moment anything else genuinely happens in between — even an
incidental click elsewhere — both edits are kept as separate steps in
order, since that timing can matter for what replays correctly.

**Never recorded, on any site, no matter what:** password fields — a
hard, non-configurable rule.

**Not recorded, needs a person to decide:** `waitFor()` steps (a
`gapBefore` field on the following step hints that a pause happened, in
case something was loading asynchronously) and hover gestures (too hard
to distinguish from incidental mouse movement reliably).

## Date pickers and similar widgets

If a date field also accepts typing directly (most do — check by trying
it), just type the date as text instead of clicking through a calendar
popup: it records as an ordinary `type` step, which is simpler and more
reliable to replay than reproducing exactly which day cell was clicked in
whatever month happened to be showing at the time.

If a field's value can only be set by clicking through a picker UI (a
genuinely `readonly` field, say), this is still handled correctly — even
though some real widgets (confirmed with bootstrap-datepicker) set the
field's value directly with no `input`/`change` event at all once a day
is clicked, which would otherwise leave nothing to observe. The click
that triggered it doesn't get left behind as its own step either (it
would target something like a specific calendar day cell that isn't even
in the DOM at replay time, since the calendar wouldn't be open) — only a
clean `type` step with the final value remains, the same as if it had
been typed directly.

## Selector generation

Every target is generated by trying, in priority order: `id` (disambiguated
by position if duplicated — common on messier sites), `data-testid`/`-cy`/
`-test`/`-qa`, any other `data-*` attribute, `aria-label`, `name`, visible
text content for buttons/links (also disambiguated by position if
duplicated), non-utility class names, then a structural `nth-of-type` path
as a last resort. A step that had to fall back to position-disambiguation
or the structural path carries `fragile: true`.

Interactions inside a same-origin iframe get a `frame` field automatically.

## Config (defaults)

```js
new PagePilotRecorder({
  ui: true, scrollSettleDelay: 250,
  mergeChooseOption: true, chooseOptionMergeWindow: 4000,
  recordDragTo: true, dragThreshold: 10,
  waitHintThreshold: 1200,
  recordIframes: true,
  onStep: null, onWaitHint: null,
})
```

---

# Skills: page-pilot-skills

Turns a recorded step array into a reusable "skill": a short description,
a list of named parameters, and the original steps with concrete values
swapped for `{{parameter}}` placeholders — so the same recording can be
run again later with different values. **No AI here at all** — a person
picks what becomes a parameter, names it, confirms before saving, and
provides real values again later to run it. Retrieval (matching a new
instruction to the right skill) and natural-language value extraction are
a separate, later layer, not part of this one.

## Usage

```js
import { showArchivePanel, listSkills, fillSkillParameters } from 'page-pilot/skills'

const steps = recorder.stop()
const skill = await showArchivePanel(steps) // null if "one-time use" was picked; saves itself otherwise

// later, to run a saved skill with new values:
const saved = listSkills()[0]
const filledSteps = fillSkillParameters(saved, { 'Last Name': 'Tanaka', 'Department': 'Engineering' })
await cursor.run(filledSteps)
```

## What gets detected as a parameter candidate

Every `type` step's `text`, `select` step's `value`, and `check` step's
`checked` state, each with a suggested name tried in this order: a
`<label for="...">`, a wrapping `<label>`, `aria-label`, `placeholder`,
then `name`. `select` values suggest checked by default; `check` states
and values over 200 characters suggest unchecked (usually a fixed part of
the flow or free-form text, not something worth re-parameterizing).

A `select` step's raw `value` is often an opaque code (an internal id, a
numeric gender code) with no meaning to someone reviewing candidates — the
panel shows the actual visible text of the selected `<option>`(s) instead
wherever it can find one, while the real recorded value (what's actually
used at replay time) stays untouched underneath.

If several steps end up targeting the exact same field — typed something,
moved to another field, came back and typed something else entirely —
that's two genuinely separate, real edits, not a bug, but only the *last*
one determines what the field actually holds once the whole recording
replays. Only that last one becomes a candidate; the earlier, now-stale
value doesn't show up at all, so there's no risk of accidentally
parameterizing (or renaming) the one that no longer matters.

## What's saved, and what deliberately isn't

**Example values are never persisted** — only parameter *names*, even if
a draft happens to carry one alongside. Skills are scoped per domain
(`location.hostname` by default). `fragile` and `highRisk` (checked
against common dangerous-action words — delete/submit/pay/transfer, in
English and Chinese — pre-filling, not enforcing, the panel's checkbox)
get set automatically but never block saving.

## API

| Function | Description |
|---|---|
| `detectParameters(steps)` | Scan a step array, return candidates with suggested names |
| `hasFragileSteps(steps)` / `isHighRisk(steps)` | Heuristic checks used to pre-fill the panel's warnings |
| `buildSkillDraft(description, steps, acceptedParams)` | Build a draft with placeholders substituted in |
| `saveSkill` / `listSkills` / `getSkill` / `deleteSkill` | `localStorage`-backed storage, scoped per domain |
| `fillSkillParameters(skill, values)` | Substitute real values back in, ready for `cursor.run()` |
| `showArchivePanel(steps, options?)` | The full review UI; saves itself, resolves with the record or `null` |

---

# Toolkit: the bookmarklet

Ties the other three layers together with a floating panel, injected by a
bookmarklet — see "Quick start" at the top for the install link.

## What it does

- **Start recording** / **Stop** — records via the recorder layer; Stop
  also opens the skills archive panel (save as a reusable skill, or use it
  just this once — either way, the JSON box below keeps the *originally
  recorded* values, so Run/Copy work immediately regardless).
- **My Skills** — everything saved for the current site. **Run** opens a
  small form (one field per parameter) to fill in new values; high-risk
  skills confirm first; **Delete** removes one, with confirmation.
- **Run** / **Copy** — run the JSON in the box (recorded, pasted, or
  hand-written — recording isn't required), or copy it elsewhere.
- Automatically handles a step that reloads a same-origin iframe
  (`autoWaitForIframeReload: true`), and refuses to click through a still-
  open modal's backdrop (`verifyClickable: true`) — both on by default
  here, since there's no practical way to hand-edit a wait step into
  recorded/pasted JSON from this panel.

## Security notes

- A page you run this on gets exactly the same access your browser
  session already has to it — same as any bookmarklet or user script.
- The panel renders inside a closed Shadow DOM, so the host page's CSS
  can't break it and it can't leak styles onto the host page.
- Saved skills live in that site's own `localStorage` — clearing the
  browser's site data for it removes them too.
- The bookmarklet pins this repo to a specific version tag (see
  `demo/install.html`) — updating means re-dragging the bookmark, so an
  already-installed one keeps behaving the same way until you choose to.
- Some sites' Content-Security-Policy blocks the external `<script>` this
  injects entirely — the bookmarklet shows an alert if that happens.
  That's the site's own security setting; a bookmarklet has no privilege
  to work around it (a browser extension would).

---

---

# Agent (preview)

A Chrome extension (Manifest V3) built on the core engine. Given a
natural-language instruction and, optionally, a reference skill (a
recorded step sequence used as a rough route map, not a script to
blindly replay), it decides one action at a time from the page's actual
current state — so it can adapt when the real page doesn't quite match
what the reference skill assumed, rather than committing to a full plan
before anything has actually happened.

## Why this needed to be an extension, not the bookmarklet

The bookmarklet's injected script lives and dies with the current page —
fine for the toolkit, since recording and running a skill both happen
within a single page's lifetime. An agent loop is different: a real
task's steps often submit a form or follow a link, reloading or
navigating the page entirely, which would destroy a bookmarklet's script
mid-task with no way to resume. This extension keeps all task state
(the instruction, the reference skill, the history of what's happened so
far) in its background service worker, keyed by tab — not in the page —
so a fresh content script reloading after a navigation can pick the same
task back up exactly where it left off.

## Current state

The step loop, task state management, page scanning, and validation of
whatever a model decides are all built and tested. The actual model call
is a deliberate stub (`callModel()` in `extension/background/background.js`)
— it throws with a clear message rather than silently doing nothing.
Wiring in a real model only requires changing that one function; nothing
else needs to know or care which model it ends up being.

Tested with a real page and a real page-pilot core engine, with only the
`chrome.*` extension APIs faked — the strongest verification available
in the environment this was built in, which turned out not to be able to
load a real, unpacked Chrome extension at all (see CHANGELOG.md's 1.1.1
entry for what was actually tried). Genuine end-to-end confirmation — a
real Chrome actually loading this — still needs to happen in an actual
install; see "Trying it" below.

## Trying it

```bash
git clone https://github.com/jyy1082/page-pilot
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the cloned repository's root folder (where
`manifest.json` lives). Opening the browser's own extension inspector for
the service worker shows `PP_AGENT_CONTENT_READY` messages arriving as
content scripts announce themselves on each page — useful for confirming
the wiring is working even before a real model is connected.

## Testing

```bash
npm install
npm test               # all five layers
npm run test:core      # just one layer
npm run test:recorder
npm run test:skills
npm run test:toolkit
npm run test:agent
npm run test:extension-background
npm run test:extension-content
```

Runs real-browser suites (Playwright + Chromium via `@sparticuz/chromium`
— its npm package ships the browser binary inside its own tarball instead
of a separate download step, which matters in sandboxed environments that
can't reach Playwright's own CDN). Real-browser testing caught several
bugs across this project's history that a simulated DOM environment
(jsdom) passed cleanly — cross-realm `instanceof` failing for iframe
content, `activeElement` checks scoped to the wrong document, `el.click()`
never simulating `mousedown` at all, and more — each documented in
[CHANGELOG.md](./CHANGELOG.md) where it was found.

## License

MIT
