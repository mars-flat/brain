---
name: brain-console-design
description: The design system and judgment for the brain web console (`packages/console` — brain.shanechen.ca, the `/tasks` front door, `/dashboard`, `/graph`, `/vault`, `/architecture`). Use it whenever you touch anything the owner sees in the console — a page, tab, section, list, card, tile, board, button, chip, form, dialog, toast, colour, spacing, or page script — including vague asks like "make it cleaner", "tidy the buttons", "this looks busy", "add a kanban", "put X on the dashboard". Also use it before answering "how should the console look / behave" or reviewing a console PR for look and feel. It carries the structural constraints (CSP, no framework, no assets, forms-first) that make generic frontend advice wrong here. Not for the data encoding of charts (the `dataviz` skill owns colour-by-series and chart form) or for the content of the architecture SVG.
---

# Brain console design

The console is one person's operational dashboard: the owner opens it
several times a day, mostly on `/tasks`, to see what needs doing and do
it, then glances at `/dashboard` to confirm nothing behind the brain is
on fire. It is not a product, has no second user, and sells nothing. So
the reference model is an **operational dashboard** (daily use, a dozen
things in view, scan-then-act), never a landing page: no hero, no
display type, no gradients, no animated entrances, no illustrations for
empty states, no marketing voice. Quiet surfaces, strong hierarchy, one
obvious action per view.

The owner's standing direction (2026-10-27): *a cleaner dashboard-style
interface, not a flashy page with heroes.* Every rule below serves that.

## 1. Constraints that are not design choices

These come from the architecture (§15) and the CSP; generic frontend
advice that violates them is wrong here, however good it looks.

- **Server-rendered HTML, no framework, no build step.** Pages are
  template strings in `packages/console/src/*-view.ts`, rendered through
  `page()` in `html.ts`. There is no SPA and there will not be one.
- **Nothing external.** CSP is `default-src 'self'; style-src
  'unsafe-inline'; img-src 'self' data:; form-action 'self'`. No CDN
  fonts, no icon libraries, no chart libraries, no inline `<script>`,
  no `onclick=`. Inline `style=` attributes are admitted (for the
  hand-rolled SVGs) — use them for nothing else.
- **One stylesheet, one script.** All CSS lives in `STYLE` in `html.ts`;
  a page may add scoped variables under its own `#id` (the way `#audit`
  and `#graphwrap` do) but not a second general stylesheet. The shared
  script is `console-client.js`, served as `/console.js` on every authed
  page; a page-specific script is a second same-origin module registered
  in `server.ts` the way `graph-client.js` is.
- **Forms first.** Every write is a `<form method="post">` carrying the
  session-bound `csrf` input, answered with a 303 redirect and a toast
  (§15.7). The page must work with script disabled; script only makes
  it nicer. A write with no form fallback does not ship.
- **Irreversible acts get their own page**, not a second click (delete
  forever is the model). Reversible writes go straight through.
- **Both colour schemes always.** `prefers-color-scheme` switches the
  tokens; there is no theme toggle and no hard-coded hex outside the
  token blocks (see §3 — a few status hexes still are; promote them,
  don't add more).
- **The console never writes the vault.** The tasks store is the one
  write path; a new write anywhere else is an architecture decision
  first (`architecture-sync`), a UI second.

## 2. The hierarchy question comes before any pixel

Before changing a page, answer in one sentence: *what must the owner see
first on this page, and what is the one thing they most often do here?*
Then lay the page out so the eye lands there. The reference heuristic
is the 5-second test — glance, look away, say what mattered. If the
answer is "the buttons" or "the chips", the hierarchy is inverted.

Rank for each tab:

| Tab | See first | Do most |
|---|---|---|
| `/tasks` | what is overdue / due today / due tomorrow | mark done |
| `/tasks/:id` | the due date and the done action | done, reschedule |
| `/dashboard` | anything red or amber | refresh, follow a link |
| `/graph` | the graph itself | hover, search, click a node |
| `/vault` | the node list / timeline | open a node |

**Attention before inventory.** On `/tasks` the urgent band (overdue,
today, tomorrow) is the hero of the page — not a visual hero, a
*positional* one: top of the main column, the only place colour is
spent. The one thing beside it is the **proposed sidebar** (owner,
2026-10-28; §4): candidates waiting to be vetted, a 20rem column on the
right that drops under the lists below 64rem. The next-7-days list and
the later list are inventory and sit below, denser and greyer. Retired
stays behind the segmented toggle. A section the owner cannot act on
today should never sit above one they can.

**Counts carry the headline.** The reference says titles should state
the insight; here the equivalent is the muted fact line under `h1`
("3 overdue · 2 today · 14 open") and the count after every section
heading. Those lines are what the owner scans; keep them accurate and
short.

## 3. The design surface

Tokens are the whole palette. Read `STYLE` in `html.ts` for the current
truth before adding anything; this section records what the tokens mean
and how to extend them, not their values.

**Colour.**
- `--bg / --card / --line / --fg / --muted` are the surface. Structure
  is drawn with 1px `--line` borders, not shadows; the only shadows in
  the console are the toast and the dialog backdrop. Keep it that way.
- `--accent` (a muted green) is for links, focus, the selected segment,
  and **the one primary button**. It is not a status colour and not a
  decoration colour.
- Status is the ok / warn / bad trio (green / amber / red). It appears on
  due chips, dashboard tiles, expiry rows, audit outcomes — and on at
  most one button in any group (§5). These should be tokens (`--ok`,
  `--warn`, `--bad`); when you touch a place that still carries the hex
  literals, promote them rather than copying them.
- Categorical colour (node types in the graph, the audit outcome trio)
  comes from the CVD-validated palette in `graph.ts` / `audit-view.ts`
  via the `dataviz` skill. Do not invent new categorical colours; do
  not reuse those for anything that is not a category.
- Grey is the default. Colour is spent only where it means something,
  and meaning never rides colour alone: a red chip also says "2 days
  overdue", a type colour also has its type name.

**Type.** System sans, 15px / 1.6 body. Headings are lowercase, as are
labels, button text, and notices — the console speaks in lowercase and
never shouts. `h1` is the page name (one word where possible), `h2`
groups sections on the wide dashboard, `h3` names a section or a card.
Small text is `.85rem`; chips are `.72rem`. No display sizes, no
weights above 600.

**Space.** The rhythm is roughly `.35 / .6 / .9 / 1.5rem`. Padding
inside cards is `.9rem 1.1rem`; gaps in grids and bars are `.5–.7rem`;
sections are separated by heading margin, not rules — `hr.rule` is used
once, under the page bar. A page that needs more rules than that is
asking for better grouping.

**Shape.** Radius 6px on controls, 8px on segmented groups and `pre`,
10px on cards and dialogs, pill on chips. One border weight (1px).

**Width.** Reading pages (`/tasks/:id`, `/vault`, `/node`) sit in the
52rem column. Boards and dashboards use `wide` (80rem). Nothing is
full-bleed.

## 4. Layout patterns already in the system

Reuse these before inventing a new one; they are what makes the tabs
feel like one place.

- **Page header:** `h1` → one `.muted` fact line → `.bar` (segmented
  view toggle on the left, actions on the right) → `hr.rule`. Every
  tab opens this way; the header is not a place for new ideas.
- **Section:** `h3` with a `.muted` count, then a list or grid. The
  heading tells the owner where they are while scrolling.
- **List (`ul.tasks`):** one row per item, title first (underlined so
  rows read as links), chips, due, row actions pushed right. Use lists
  for ten or more items — cards at that count turn into a wall.
- **Grid of cards (`.grid` + `.card`):** auto-fill, 24rem minimum, for
  tiles that each carry a status (dashboard). Keep a tile to a heading
  and two or three lines; a tile that needs a scrollbar is a section.
- **Segmented control (`.seg`):** mutually exclusive views of the same
  data (open / retired, nodes / episodes). Not for navigation between
  pages — that is the top nav.
- **Chips (`.chip`):** small facts that double as filters. A chip is
  never the primary carrier of anything important.
- **Stack form (`form.stack`):** label above control, 32rem max, the
  off-by-default toggles revealed by `:has()`. The edit dialog is the
  same form inside a native `<dialog>`.
- **Toast:** the result of every POST. Green auto-dismisses, warnings
  stay until dismissed. Never put a notice inline on the page.
- **Confirmation page:** for the irreversible. One sentence of
  consequence, one red button, one cancel link.

**Sidebar (the proposed list on `/tasks`, 2026-10-28).** The open
view is a two-column grid (`.cols`): the board and lists in `.main`, an
`<aside class="side">` headed *proposed · N* on the right. Rows are the
dense `ul.tasks.props` shape — title as plain text (no detail page), a
kind chip, a due chip when there is a guess, one muted breadcrumb
(*account · sender · date*, never a link to the mail), and two controls:
*accept* (plain button, opens the create form prefilled) and *dismiss*
(quiet, a POST). At zero it shows one muted line, *nothing proposed.*,
so the layout never jumps between ticks. The only other control is the
quiet *dismiss older than 7 days* form, present only when something
qualifies. Nothing in the sidebar is draggable, and a proposal reaches
the board only by being accepted and having its date arrive. The retired
view has no sidebar; `/tasks/proposed` is the full page with notes and
a `<details>` of the last 30 days, each dismissed row carrying *restore*.

**Board (the urgent band on `/tasks`, 2026-10-27).** Two columns —
*todo · done* (the owner declined a *doing* lane: no in-progress state,
no schema change) — in one bordered region, divided by a rule rather
than nested cards: a lowercase heading with its count, then item cards
of one fixed shape (title + quiet verbs on the first line, due chip,
date and tags on the second). *todo* is overdue first, then today, then
tomorrow; *done* is today's closed occurrences, read-only and greyed,
each saying where the task went next. On narrow screens the columns
stack in that order. Dragging a todo card onto *done* is an enhancement
(§6) that opens the same *schedule again?* page the card's *done* button
opens — never a write of its own. **Only the urgent band is a board.**
Next-7-days and later stay lists, and nothing drags into or out of the
board: it is reserved for what is due now, and a list item becomes a
board item only by its date arriving (or by a reschedule from its own
page). A board that accepts anything stops meaning "urgent".

## 5. Buttons and actions — the clean rule

This is where the console was loudest, and where the owner asked for
cleaner. The problem was never the buttons' shape; it was that every
action got a colour and every link became an action. The rule:

**Three emphasis levels, nothing else.**

| Level | Looks like | Use for |
|---|---|---|
| `primary` | filled `--accent`, light text, weight 600 | the single most likely action on this view: *done* on a task, *create* on the new form, *save* in the dialog, *confirm* on the close prompt |
| default (`.btn`) | `--card` fill, 1px `--line` border, `--fg` text; hover → accent border and text | every other action: *skip*, *reschedule*, *edit*, *reopen*, *refresh all cards*, *tags* |
| `quiet` | no border, no fill, `--muted` text, same padding so it aligns; hover → `--fg` | row-level and tertiary actions: *done* / *skip* in a list row, *manage tags*, *cancel* |

**Danger is a modifier, not a level.** `quiet.danger` for *retire* and
*delete forever* wherever they sit beside other actions (muted red text,
no border); the outlined red button exists only on a confirmation page,
where it *is* the primary act. The green / amber / red outline trio on
one line is exactly what to retire: colour on a button should say "this
one is different", and it cannot when all three are.

**One primary per view.** If two actions both feel primary, one of them
is not; demote it. A dialog counts as its own view.

**Same box for `a.btn` and `button.btn`** — height, padding, radius,
font. An `<a>` that performs an action (opens the close prompt) is
styled as a button; an `<a>` that merely navigates (back to tasks,
manage tags) is styled as a link or a quiet button. The reader should
be able to tell "this will do something" from "this will take me
somewhere" without hovering.

**Labels** are lowercase verbs, one to three words, no leading `+`, no
trailing punctuation, no exclamation. *new task*, not *+ New Task!*.
Glyphs are limited to the three the console already uses — `×` dismiss,
`←` back, `→` onward — because there is no icon budget and a glyph
without a word is a guess.

**Groups** keep `.5rem` gaps, primary first, then default, with the
destructive action last and pushed away (`margin-left:auto`) so a slip
of the hand does not land on it. Every button has a visible
`:focus-visible` ring in `--accent`; disabled buttons drop to `--muted`
on both text and border, never to a lighter fill.

## 6. Script and interaction policy

The baseline page works with no script; the script layer makes the same
actions faster. In practice:

- Hooks are `data-*` attributes read by the module (`[data-dialog]`,
  `[data-toast]` today; `[data-drag]`/`[data-drop]` for a board). No
  inline handlers — the CSP forbids them, and the discipline keeps
  behaviour in one file.
- A scripted write (drag-and-drop, a fetch-POST) submits **the same
  form** the no-script button would — same route, same `csrf` field,
  same 303 — via `fetch(form.action, {method:"POST", body:new
  FormData(form)})`. The server does not grow a second JSON API for the
  browser; a 403 (stale token) reloads the page; any other failure
  reverts the optimistic move and shows the warning toast.
- Drag-and-drop uses the native HTML5 events (`draggable`, `dragover`,
  `drop`) with a pointer-events fallback only if touch proves to need
  it; the items are also moveable by their buttons, so keyboard and
  screen-reader paths exist without extra work.
- Touch targets are at least `2.25rem` tall on narrow screens; row
  actions that are quiet text on desktop get that height on mobile
  through padding, not through a different control.
- Motion is limited to the toast's enter/exit and the graph's physics.
  No entrance animations, no skeleton loaders (the pages render
  complete, server-side), no hover scale.

## 7. Process when changing a page

1. **Recall.** `brain.recall` the owner's past calls on this surface
   before deciding anything — several are load-bearing and not visible
   in the code: tasks are the front door (2026-09-18); notices are
   toasts (2026-09-18); the graph stays steady under the cursor, no
   dimming on hover (2026-08-28); due times are optional and off by
   default; the "schedule again?" page is a deliberate blocking step
   (confirmed 2026-09-24); the board is reserved for the urgent band
   (2026-10-27).
2. **Read** `STYLE` in `html.ts` and the view file you are touching.
   Reuse a class before adding one; add a token before writing a hex.
3. **State the hierarchy** (§2) and sketch the layout in a few lines
   of ASCII in the commit message or PR body — it is cheaper to argue
   with a sketch than with a diff.
4. **Implement** in this order: tokens → `STYLE` classes → view markup
   → `console-client.js` (only if the baseline is already right).
5. **Verify** with the ship checklist (§8) and `bun test
   packages/console`. New routes or forms get a test next to the
   existing `/tasks` round-trip in `test/console.test.ts`.
6. **Keep the docs true** (`architecture-sync`): a mechanism change on
   the tasks tab lands in `packages/tasks/README.md` §16.4; a changed
   console invariant lands in `architecture/15-console.md`. A pure look
   change needs neither.
7. **Capture** any UI decision the owner makes in the brain the moment
   it is made (`brain.note`) — they are exactly the facts the next
   session will not find in the code.

## 8. Ship checklist

- [ ] Both colour schemes rendered and readable; no new hex literals
      outside the token blocks.
- [ ] The page works with script disabled; every scripted write has a
      form twin.
- [ ] CSP intact: no inline `<script>`, no `on*=` attributes, no
      external URL in `src`/`href` for assets.
- [ ] One primary button per view; no row of coloured outlines; danger
      actions quiet unless on their confirmation page.
- [ ] Nothing means something by colour alone.
- [ ] Narrow viewport: columns stack, 1rem gutter, no horizontal page
      scroll (only `.scroll` / `.svgwrap` regions scroll sideways).
- [ ] Every POST: `csrf` input, same-origin check, 303, toast.
- [ ] Headings and labels lowercase; counts in section headings; the
      fact line under `h1` still true.
- [ ] Tests pass and cover any new route; docs updated where a
      mechanism changed; owner decisions captured.

## 9. What "flashy" means here — do not build

Hero sections and welcome copy · display type above `h1` size ·
gradients, glass, or coloured backgrounds behind content · drop shadows
as decoration · card-inside-card nesting · icon fonts or emoji as UI ·
entrance animations and skeletons · a modal for anything that is not a
short form · a row of three coloured buttons · a toggle for dark mode ·
a client-side router · a second stylesheet, a CSS framework, or a
component library.
