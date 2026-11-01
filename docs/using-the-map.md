# Using the map

The map is a board of cards connected by lines. Each card is a part of your app: a big area like "Main server", a group of files, a single file, or an endpoint (a request the server can receive). Lines show what uses what.

## Getting around

| To… | Do this |
|---|---|
| go inside a card | double-click it, or select it and press **Enter** |
| go back up | **Backspace**, the back arrow, or the breadcrumbs at the top |
| pan | drag the background |
| zoom | scroll, or **+** / **−** |
| fit everything on screen | **F**, or the frame button bottom-left |
| find anything | **/** or **Ctrl/⌘ K**, then type a name, file or URL |
| see details | click a card; the panel on the right fills in |
| show or hide the panel | **P**, or the panel button top-right |
| close a menu, stop a flow, clear a selection | **Esc** |

The details on cards simplify as you zoom out: descriptions drop away and titles get bigger, so the map stays readable from far away.

### On a phone or tablet

- **Drag** with one finger to pan, and **pinch** with two to zoom.
- **Tap a card** to see its details in a sheet at the bottom. **Open** in the sheet goes inside the card. Tapping empty space, going in or up, or **Esc** puts the sheet away.
- The top bar wraps onto two rows and its buttons show only their icons. On a phone the zoom buttons sit in the top row, and the description under the title folds to one line, with **More** to read the rest.

Nothing changes with a mouse in a window 1000 px wide or wider. Phone and tablet support was built by [@menachem-kurkus](https://github.com/menachem-kurkus).

## Cards

- **Title and description:** a plain-English name, and one line on what it does.
- **Footer:** how much is inside (modules, files or endpoints) on the left. On the right, a green tag when it's part of recent work.
- **Endpoint cards** show the method and address (`POST /api/orders`) above their name.
- **A small amber dot** after a title means there's a note pinned to that file.
- **Pill-shaped cards at the edges** of a view are things outside it. The brackets above each column say which side is which:
  - **Used by:** outside parts that use or call into this one.
  - **Inside ‹name›:** what this part is made of.
  - **Uses:** outside parts it relies on, like a database or Stripe.

  Double-click an outside card to jump there.

<img src="images/inside.png" alt="Inside a part of the server: what uses it on the left, its files in the middle, outside services on the right">

Hover over a card for a moment to see what kind of thing it is, where it lives, and how big it is. Hover over a line to see what it carries, for example which endpoints a screen calls.

## The side panel

Click anything to see it in the panel: its full description, what it's part of, what's inside it, what it's **used by** and what it **depends on**, its endpoints, and buttons to open it or ask about it. With nothing selected, the panel describes the current view, or the whole app at the top level.

Drag the panel's left edge to resize it.

## Header buttons

### Health
A count of important issues, and a plain-language list of problems the scan found:
- passwords and keys written into the code, or into a committed `.env` file;
- secret keys in settings the browser gets, like an OpenAI key in a `VITE_` or `NEXT_PUBLIC_` variable;
- Supabase tables with row-level security switched off, and database rules that let anyone change a table;
- Firebase rules that let anyone read or change your data or files, including "test mode" rules and when they run out;
- Stripe webhooks that act on payments without checking Stripe's signature, so anyone could fake one;
- servers that let any website call them, flagged as worth fixing when login cookies go along too;
- endpoints that let anyone change or read data without signing in;
- files nothing uses;
- files over about 1,000 lines, which AI struggles to edit safely;
- with a `targets.json`: a target that allows one writer but has more, and calls into a target that the file doesn't list (see [Targets](#targets));
- with a `layers.json`: a **Publishability** group of its own, with its count by layer, listing what would keep the system from being published (see [Layers](#layers));
- with a `rules.json`: a retired rule that still names places (see [Rules](#rules)).

Each issue has **Show on map**, which highlights the affected files and endpoints with notes, and **Fix with Claude** (or **Fix with Codex**, for a map made in Codex), which copies a ready-made prompt naming the exact files and lines and the safe fix. It's a quick automatic check, not a security audit. On a blueprint this button is **Review** instead (see [Blueprints](#blueprints)).

Health leaves password hashes and encrypted values alone (bcrypt, argon2, dotenvx, sops, Ansible Vault and similar), and goes by the value, so a backup with one value left unencrypted is still flagged. It can only recognise encryption that marks itself, and it can't read a `.env` file that git ignores.

If an issue is wrong, press **Not a problem** and add a reason if you like. It moves to the bottom of the list and out of the count, and stays that way when the map is rebuilt. Editing elsewhere in the file won't bring it back, but it does show again if the same check finds something new in that file or the issue changes severity. **Show again** undoes it. Exported copies keep the issue set apart but leave your reason out.

You can also tick the box to tell the Floorplan developer. That opens a GitHub issue for you to read, edit and send yourself, with the check's name and title, the kinds of files involved and your note. A title can name a file or an endpoint, and the preview shows you exactly what will go. It never includes your code or any values, and nothing is sent unless you send it.

### Recent work
Appears when Claude or Codex has just changed things. It lays the changed cards out on one board, with what you asked for, a summary of what was done, and a note on every card. Elsewhere on the map, changed cards have a green ring and a **Changed** or **New** tag, and the parts that contain them show **N changed**, so you can follow the green down from the top level.

### Screens
Every page of your app that Floorplan detected. Pick one to see everything behind it: its components, the requests it makes, the server code that answers them, the data they touch, and outside services.

### Targets
Appears when the project has a `floorplan/targets.json`: the databases, services, files, APIs and queues the app writes to or reads from, and which parts do it. Each target lists its **Writers** and **Readers** as tiles (click one to go there on the map) and the parts the scan saw calling it that the file doesn't list. A target that allows **One writer only** but has more than one turns red here and on the map, with the writes into it, and the Health check has a fix for it. On the map, writes and reads are their own kinds of line (a read is dashed), and selecting a part shows what it writes to and reads from. See the [format](../skills/floorplan/references/schema.md#targets).

### Layers
Appears when the project has a `floorplan/layers.json`, which sorts its files into the **System** you could publish one day, the **Setup** of this one installation, and your own **Content**. Switched on, every box gets a ring and a tag in its layer's colour; a part whose files are spread over layers, none with more than half, is **Mixed**, with a dashed ring. The panel's legend lists the layers with their files: click one to show only that layer (the rest fades), and again to show all. The details of a file or part always name its layer, and with the switch on, every file and part listed there shows its layer too.

The Health check then adds **Publishability**: identifiers and folders of this installation and contact details in system code, names from your private word list in the system and the setup, and system code that imports your content. Each finding names the file and line, never the value; a private word shows only its first letter, and the list itself stays outside your repo. A finding here can be marked **Not a problem** like any other, and then leaves the group's count by layer. See the [format](../skills/floorplan/references/schema.md#layers).

### Rules
Appears when the project has a `floorplan/rules.json`: the rules it documents ("one writer per target") and its decisions with a date, each with the place it is written down, hung on the parts, files, endpoints and targets they apply to. The list shows the ones that hold **Everywhere** first, then the **Rules** and the **Decisions**, and the **Retired** ones dimmed at the end, each with its date and how many places it reaches. Open one to read its text and source and to see its places as links; its cards go on a board, each with the rule as its note. The details of any card the rules reach, itself, its part or a parent, list them under **Rules here**. Floorplan and the AI never make a rule up: the file is written only from what the project documents. See the [format](../skills/floorplan/references/schema.md#rules-and-decisions).

### Clock
Appears when the scan found schedules in the code (crons in GitHub Actions workflows and `vercel.json`, n8n workflows with a Schedule Trigger, crontab files, ofelia labels in compose files) or the project has a `floorplan/schedules.json`: what a clock starts, not a person. The button is a switch: on, every card a schedule starts (its trigger, what it runs, and the parts holding them) gets a small clock mark, with the schedules on hover, and the panel opens with a 24-hour strip, a mark for every start of the day (a band where a plan runs every ten minutes or more often) and the hours underneath, then the list, next start first, each with its cron in words ("every 20 minutes", "daily at 02:30", "weekdays at 08:00"), its time zone, where it was found and what it triggers and runs; hover a plan to light its marks on the strip. A plan switched off in `schedules.json` is dimmed at the end. Open one to see its cron, what it calls, its note and source, and its trigger and places as links; its cards go on a board, each with the plan as its note. The details of any card a schedule reaches list them under **Schedules here**. A plan whose trigger and runs are both on the map draws an event line between them, so the clock shows among the connections. Floorplan never makes a time up: it shows what the files say and what you list. See the [format](../skills/floorplan/references/schema.md#schedules).

### Ops
Appears when the project has a `floorplan/ops.json`, which your own cron, pipeline or deploy script writes (Floorplan never does): a status per part, file, endpoint or target, the deployed version, the last run, the last good run, the last error, a note and a few numbers. Switched on, every box with an entry gets a dot: green for **running**, amber for a **warning**, red for **down**, grey for **unknown**; a part shows the worst status of everything inside it, so you can follow a red dot down from the top level. Hovering shows the details, and the **Operations** panel lists every entry worst first (click one to go to its box), with the time the data was written, what wrote it, and a **Stale** warning when that was more than a day ago. On a map served by `serve.mjs` the data is fetched again every minute; a copy opened from its file or exported shows what the build saw. See the [format](../skills/floorplan/references/schema.md#operations).

### Export
Saves a copy of the map to send to anyone, such as a teammate, a client, or someone without Claude or Codex. It's one HTML file that opens in any browser with nothing to install. The copy has the whole map, search, screens, the tour and flows, but no Ask bar, no **Fix with Claude** or **Build this** requests, no editor links, and nothing about your computer, like its folder path. An **Exported** label beside the title shows the date, and a small **Made with Floorplan** link at the bottom leads here.

You choose what goes in:
- **Flows and the tour**, and **notes pinned to files**, on by default;
- **Recent work**, off by default;
- **Health check** (or the **design review** on a blueprint), off by default. Health lists the endpoints anyone can use and where secrets sit in the code (never their values), so only include it for people you trust;
- **Operations**, off by default: what your tooling reported when the map was built, last errors included.

Every copy shows how the app fits together (each part, file and endpoint, with names and descriptions), but not your source code. Export needs the map's server; on a map opened straight from its file, the button shows the command to run instead. You can also ask Claude or Codex to "export the floorplan".

### Start here
Replays the one-minute tour that runs the first time you open a map.

### Flows
Guided walkthroughs of the app's main jobs, like "Checkout" or "Sign up". A flow moves across the board step by step, with a narration at each stop. Use **←** / **→** or the flow bar's buttons to step through, and **Esc** to stop.

**Request a new flow** lets you describe one in plain words ("how does a refund get back to the customer's card?"), and Claude or Codex traces it through the code. Flows you request are saved with the map.

### Filters
- **Show connections:** turn kinds of lines on or off (Uses, Web requests, Background jobs and so on).
- **Show technical detail:** switch to developer terms (Imports, HTTP, Queues), and show each file's exports.
- **Highlight recent work:** turn the green highlights off for a clean map.

## Asking questions

<img src="images/ask.png" alt="An answer board with numbered cards and a written walkthrough">

Type into the Ask bar at the bottom and press **Enter**. Claude or Codex answers in a few sentences and shows an **answer board**: just the cards involved, how they connect, a short note on each, and a numbered walkthrough when the answer is a sequence. Follow-up suggestions appear under the answer. **Back to map** returns to where you were.

- **Right-click → Ask about this** on any card or line adds it to your question as context.
- The other floors answer too, once they're filled in: who writes where (**Targets**), which rule or decision holds at a card (**Rules**), when a schedule runs next (**Clock**), what is running (**Ops**) and what you see where (**What you see**). Ask "who may write to the orders table", "which rule holds for the checkout", "when does the report run" or "is the worker up", and the answer comes from the map before the code. From a terminal, the same lookups are `node floorplan/query.mjs targets`, `rules`, `schedules`, `ops`, `outcomes` and `flows` (`--help` lists them).
- The label in the bar shows what's answering. **Claude Code** means the Claude Code CLI and **Codex** means Codex, both running on your computer and able to read your source code. **Claude** means the map was opened in the Claude app, which answers from the map alone.
- If neither is available, the bar explains what's needed. See [Troubleshooting](troubleshooting.md).

## Blueprints

Everything above describes a map of existing code, which is what most maps are. A blueprint is the other kind: a map planned from a PRD or a spec before the code exists (see [Getting started](getting-started.md#plan-something-you-havent-built-yet)). It works the same way, with a few differences:

- **Dashed cards and a Blueprint label** beside the board's title show it's a plan. With nothing selected, the panel says which document it was planned from, the stack and the assumptions made.
- **Review** replaces Health. It's a design review of the plan: endpoints anyone could use to change data, endpoints with no decision on who may use them, questions the PRD leaves open, and pieces nothing connects to. Each item has **Show on map** and **Resolve on the map**, which switches the Ask bar to Change and fills in a request to settle it. For an open question, type your answer after "My answer:" and press **Enter**. (When the map isn't served, the button is **Resolve with Claude** or **Resolve with Codex**, a request to paste instead.)
- **Who may use it:** an endpoint's panel says whether anyone, signed-in people (and which ones), your own team, or another service may use it.
- **Build it:** every part and file has **Build this with Claude** (or Codex), which shows a request to build just that piece the way the plan describes (its files, endpoints, what it relies on and any open questions), ready to copy into Claude Code or Codex.
- **Ask and Change:** the Ask bar has a switch. **Ask** answers questions from the plan and the PRD. **Change** takes requests like "also plan out refunds" or "drop the admin page". It takes a few minutes; then the map redraws, the new and changed cards are highlighted as recent work, and a summary offers **Show N changes**, **Undo** and suggested next changes.

## Right-click menus

| On | You get |
|---|---|
| a card | Open · Show on the map · Ask about this · Show details · Copy name · Copy path (or endpoint) · Open in editor |
| a line | Ask about this connection · Show details |
| the background | Ask about this view · Up one level · Back to overview · Fit to screen · Search |

**Open in editor** opens the file in VS Code (or another editor that handles `vscode://` links) at the right line.
