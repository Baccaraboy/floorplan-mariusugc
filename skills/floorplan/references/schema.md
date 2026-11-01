# architecture.json schema

`floorplan/architecture.json` describes the structure: subsystems, modules, external services, flows. Names and descriptions for individual files and routes go in `floorplan/descriptions/*.json` instead (see [writing-descriptions.md](writing-descriptions.md)). They're kept separate so parallel agents can write them without conflicts. `build.mjs` checks both against the scan and reports problems by field.

Contents: [Top level](#top-level) · [nodes](#nodes) · [Assignment rules](#how-files-get-assigned) · [edges](#edges) · [annotations](#annotations) · [flows](#flows) ([What you see](#what-you-see)) · [Recent work](#recent-work) · [Fixed names](#fixed-names) · [Targets](#targets) · [Rules and decisions](#rules-and-decisions) · [Schedules](#schedules) · [Layers](#layers) · [Operations](#operations) · [git](#git) · [Full example](#full-example)

## Top level

| field | type | required | meaning |
|---|---|---|---|
| `$schema` | `"floorplan/architecture@1"` | no | marker |
| `project` | object | yes | `name` (string, required), `summary` (1–3 sentences), `entrypoints` (file paths) |
| `nodes` | array | yes | subsystems and modules. See below |
| `edges` | array | no | connections the scanner can't see |
| `annotations` | array | no | notes pinned to specific files |
| `flows` | array | no | guided walkthroughs through the board |
| `tour` | array | no | the "Start here" tour shown on first open: 3–8 stops `{ "node": "<node id or file path>", "title": "…", "note": "…" }`, in plain language, in the order a newcomer should see them. The first flow is appended automatically |
| `audience` | `"everyone"` \| `"developers"` | no | who names and descriptions are written for. Default `"everyone"`: plain language a non-technical owner understands (what it does for the business, in everyday words). `"developers"`: technical style for engineers |
| `lang` | `"en"` \| `"de"` | no | the language of the map's own words (buttons, panels, the glossary, the Health findings' titles and explanations), one of the tables in `assets/lang/`. Default `"en"`. Write names, descriptions, flows, the tour and recent work in it too. `build.mjs --lang <code>` overrides it for one build |
| `git` | `"none"` \| `"inputs"` | no | whether the map's files may go in git. Default `"none"`: `floorplan/` ignores itself completely. `"inputs"`: it ignores only what a build writes again, so the inputs and `MAP.md` can be committed ([below](#git)) |
| `include` | string[] | no | file categories to map. Default `["code"]`. Others: `config`, `docs` |
| `ignore` | string[] | no | globs for files to leave off the board entirely (generated code, vendored libs, fixtures) |

## nodes

Each node is a chip on the board. Hierarchy comes from `parent`. A node with no parent sits on the top-level board.

| field | type | meaning |
|---|---|---|
| `id` | string | unique; letters, digits, `_ - .`. Convention: dotted by parent (`api.orders`) |
| `label` | string | short display name ("Orders API") |
| `kind` | enum | `ui` `service` `worker` `library` `feature` `data` `config` `test` `script` `infra` `external` |
| `parent` | string | id of the enclosing node |
| `summary` | string | one sentence: what it's responsible for |
| `details` | string | optional longer notes; blank lines separate paragraphs |
| `paths` | string[] | globs claiming files (see below) |
| `exclude` | string[] | globs to carve files back out of `paths`. **Inherited by all descendants**, e.g. `"exclude": ["**/*.test.tsx"]` on a frontend node keeps co-located tests out of every child, so a separate Tests node can claim them |
| `packages` | string[] | **external nodes:** package names this node stands for, e.g. `"stripe"`, `"npm:@stripe/*"`, `"pypi:sqlalchemy"`. Imports of them become edges to this node |
| `hosts` | string[] | **external nodes:** hostnames called from code, e.g. `"api.stripe.com"`, `"*.squareup.com"`. Calls become `http` edges |
| `tags` | string[] | free-form, shown in the panel |

Kinds, briefly:
- `ui`: frontends and apps
- `service`: a deployable server
- `worker`: background jobs and queues
- `library`: shared code
- `feature`: a vertical slice inside a service or UI
- `data`: models, migrations, the DB layer
- `config`
- `test`
- `script`: one-off and ops scripts
- `infra`: deploy, CI, IaC
- `external`: databases and third-party APIs. These own no files.

### Glob syntax
- `**` matches any number of directories, `*` stays within one path segment, `?` matches one character, `{a,b}` is alternation.
- A whole folder name in brackets, like `[id]`, `[...slug]` or `[[...slug]]` (Next.js, SvelteKit), matches that folder literally: `app/orders/[id]/**`. Elsewhere, `[abc]` matches one of those characters.
- A pattern with no wildcard also matches as a directory: `backend/app` equals `backend/app/**`.
- Paths are relative to the codebase root. In a multi-repo root they start with the repo folder.

### How files get assigned
Every included file goes to exactly one node:
1. Collect the nodes whose `paths` match the file and whose `exclude` doesn't.
2. The **deepest** node wins, so a child beats its parent. You can give a parent a broad glob (`web/**`) and children narrower ones; files no child claims stay on the parent.
3. Between nodes at the same depth, the glob with the longer literal prefix wins. Real ties are warned about.
4. Files no node claims go to an automatic **Unassigned** chip. Keep it under ~10%.

In the viewer, a node with more than ~24 files of its own groups them into folder chips automatically, so you don't need a node for every directory. Make a node when it means something.

## edges

Only add what static analysis can't find. Imports (`import`) and HTTP calls matched to routes (`http`) are already in the scan.

| field | type | meaning |
|---|---|---|
| `from`, `to` | string | node id **or** file path |
| `kind` | enum | `import` `call` `http` `rpc` `event` `queue` `data` `config` |
| `label` | string | short, e.g. `"POST /orders"`, `"order.paid"`, `"reads/writes"` |
| `description` | string | optional sentence shown when the trace is clicked |

Good candidates:
- service → database (`data`)
- publisher → queue → consumer (`queue` / `event`)
- webhooks coming in from third parties (`http`, from the external node to the handler)
- cron/scheduler → job (`call`); a schedule the scan finds, or one listed in [schedules.json](#schedules), draws its own `event` edge
- Firebase background functions (schedules, Firestore/Storage/Pub/Sub triggers, from the scan's FIREBASE FUNCTIONS list) → a `worker` node; link the collection or topic that triggers them (`event`)
- calls through env-configured base URLs that the matcher missed (`http`)

An edge between two external nodes (a database that notifies a mail service, a sign-in provider that calls a hosting platform) is kept and listed in both nodes' details, but not drawn: every external node sits in the last column of the layout, which allows no line between two of them. The build warns `edges[i]: both ends are external nodes; shown in the panels, not drawn on the board` and marks the link `drawn: false` in graph.json.

## annotations

`{ "path": "<file>", "note": "…", "tags": ["hotspot"] }` pins a note to a file. The file's chip gets an accent outline. Use these sparingly, for god-files, tricky invariants, or deprecated code still in use.

## flows

```json
{ "id": "checkout", "title": "Checkout", "description": "optional",
  "steps": [ { "node": "web.cart", "note": "User clicks Pay" }, { "node": "api.orders", "note": "Creates the order" } ] }
```
- Each step's `node` is a node id or a file path. There must be at least 2 steps.
- The viewer moves to the board where each pair of consecutive steps is visible and animates a signal between them.
- Write the notes as a narration a new engineer would want.

### What you see

A flow tells which parts work one after the other. For the owner, who may not be an engineer, two things are missing: **what starts it** (a click, a clock, a mail, a webhook) and **what they see of it** (a message on their phone, an entry in their calendar, a new record in their database, a draft in their inbox). Three optional fields add them, and the map turns them round into a **What you see** panel: per place, what arrives there and from which flow.

```json
{ "id": "order", "title": "An order comes in",
  "trigger": { "kind": "click", "text": "The customer presses «Buy»", "node": "web.pages" },
  "steps": [
    { "node": "api.routes", "note": "Checks the cart and creates the order",
      "you_see": { "where": "x.mail", "text": "A confirmation mail in your inbox", "example": "Order #1234 received" } },
    { "node": "stripe", "note": "Charges the card" }
  ],
  "outcome": { "where": "x.mail", "text": "The customer has a confirmation, you have the order in the admin list." } }
```

| field | type | meaning |
|---|---|---|
| `trigger` | object | optional: what starts the flow. `kind` (required): `click` · `schedule` · `message` · `webhook` · `file` · `manual` · `other`. `text` (required): in plain words. `node` (optional): where it starts, a node id or a file path. `schedule` (optional): the id of a schedule from the [Clock](#schedules) (one the scan found, like `actions-report`, or one in schedules.json); the flow then shows the schedule's words ("daily at 02:30") and time zone |
| `steps[].you_see` | object | optional: what the owner sees at this step. `where` (required): the place, a node id or a file path, usually an external node (a phone, a calendar, a database, a mailbox). `text` (required): one sentence on what they see. `example` (optional): one short line, like the message as it would read. Never a secret |
| `outcome` | object | optional: what the owner has when the flow is done, with the same `where`, `text` and `example` |

- **Checked like the steps:** an unknown `where`, `node` or `schedule`, an unknown `kind` or field, and a missing `text` are errors with a "did you mean …".
- **In `graph.json`:** the flow keeps `trigger` (with `node` as a card, and `when`, `tz` and `cron` from the schedule), each step its `you_see` and the flow its `outcome`, every `where` as a card (`n:…`, `f:…`). `graph.outcomes` is the index by place: `{ "n:x.mail": [{ "flow": "order", "step": 0, "text": "…", "example": "…" }, { "flow": "order", "text": "…" }] }`, an entry without `step` being the flow's outcome. The build reports `FLOWS  N · with trigger a · with outcome b · outcomes at c place(s)`.
- **On the map:** the flow list and the guided view show the trigger at the top ("Starts when: …", with a clock and the schedule's words for a `schedule`), an eye card "You see: …" with the example at a step that has one, and "In the end: …" at the last step. A **What you see** button opens the panel: every place with what arrives there and the flow that brings it, and a sentence opens that flow at its step; a place's own card lists **What arrives here**.
- **In `MAP.md`:** each flow gets a `Trigger:` line and a `You see:` line (its outcome), a step with `you_see` says so on its line, and a `## What you see` section after Flows lists the sentences by place, each with its flow's title in brackets.
- **Write it from the owner's side:** what they see, not what the code does. "A message on your phone with the customer's name", not "sends the Telegram payload" ([writing-descriptions.md](writing-descriptions.md#what-you-see)). A flow without these fields is shown exactly as before.

## recent work

`floorplan/recent-work.json` is a separate file, rewritten on every make and update. It holds what was just worked on, framed against what the user asked for. The viewer gives those cards a green "Changed"/"New" tag, shows "N changed" on the parts containing them, adds each `note` to the card's hover, and lists the tasks under a **Recent work** button and in the overview panel.

```json
{
  "updatedAt": "2026-10-27T10:30:00Z",
  "tasks": [
    {
      "title": "Refunds from the order page",
      "request": "Let staff refund an order straight from its order page",
      "summary": "Staff can now refund all or part of an order from its page. The money goes back to the customer's card through Stripe, and they get an email. Refunds over $500 need a manager.",
      "items": [
        { "ref": "shop-api/app/services/refunds.py", "change": "new", "note": "New: works out how much to refund, sends it back through Stripe and records it on the order. This is the heart of what was asked." },
        { "ref": "POST /api/orders/<int:order_id>/refund", "change": "new", "note": "The request the Refund button sends; it checks the manager limit before anything is refunded." }
      ]
    }
  ]
}
```

| field | meaning |
|---|---|
| `tasks[].title` | 2–5 words, shown on hover and as the board title |
| `tasks[].request` | what the user asked for, in their words (shortened). Shown as "You asked: …" |
| `tasks[].summary` | 1–2 sentences: what was done toward it, and where it stands. Mention deletions here; deleted files aren't on the map |
| `items[].ref` | a file path, a node id, or `"METHOD /path"` exactly as on the map. Refs that aren't on the map are left out with a warning |
| `items[].change` | `"new"` or `"changed"` (default) |
| `items[].note` | 1–2 plain sentences: what changed on this card, and how it serves the request |

`{ "tasks": [] }` clears all highlights.

## fixed names

`floorplan/names.json` is optional. It holds the owner's own names for parts, files and endpoints, the words they use for them, so that no rebuild, refresh or new description changes them. The build applies it last: an entry wins over the node's `label` and `summary` in architecture.json, over `descriptions/*.json` and over plan.json.

```json
{
  "parts": {
    "api": { "name": "The Back Office", "description": "Where every order is kept and changed." },
    "web": { "name": { "en": "The Shop Window", "de": "Das Schaufenster" } }
  },
  "files": {
    "shop-api/app/services/refunds.py": { "name": "The Refund Desk" }
  },
  "routes": {
    "POST /api/orders/<int:order_id>/refund": { "name": "Refund an order" }
  }
}
```

| field | meaning |
|---|---|
| `parts` | keyed by node id from architecture.json |
| `files` | keyed by file path, as on the map |
| `routes` | keyed by `"METHOD /path"`, exactly as the worksheets print it |
| `name` | required. The name shown on the map |
| `description` | optional. Without it, the description still comes from architecture.json or `descriptions/` |

- **Languages:** a `name` or `description` is a string, the same in every language, or one per language: `{ "en": "…", "de": "…" }`. The map uses its own language (`lang`), else English, else the first one given.
- **Checked like everything else:** an id, path or route that isn't on the map is an error with a "did you mean …", so a fixed name never disappears quietly.
- **describe.mjs** writes no worksheet entry for something whose name and description are both fixed (not even with `--all`). With only the name fixed, the worksheet marks it `FIXED NAME`: keep the name, write the description.
- **refresh.mjs** never changes names.json. When a fixed file is moved or deleted, or a fixed endpoint changes address, NEXT says so, and the entry is moved or removed by hand.

## targets

`floorplan/targets.json` is optional. It lists the places the app writes to or reads from (databases, services, files, APIs, queues), which parts write to each and which only read, and whether a target allows **one writer only**. Many apps built with AI have that rule ("only the orders service changes the orders table"), and this is where the map checks it. The map then has a **Targets** panel, write and read lines from each part to the target's box, and Health findings when the rule is broken.

```json
{
  "targets": [
    { "id": "orders-db", "name": "Orders", "kind": "database", "external": "pg",
      "writers": ["api.orders"], "readers": ["api.reports", "worker"], "policy": "single-writer",
      "note": "Only the orders API changes orders; everything else reads." },
    { "id": "payments", "name": { "en": "Card payments", "de": "Kartenzahlungen" }, "kind": "api", "external": "stripe",
      "writers": ["shop-api/app/services/refunds.py", "shop-api/app/routes/checkout.py"], "policy": "any" },
    { "id": "price-list", "name": "Price list", "kind": "file",
      "writers": ["scripts/import_prices.py"], "readers": ["shop-api/app/**"], "policy": "single-writer" }
  ]
}
```

| field | type | meaning |
|---|---|---|
| `id` | string | required, unique; letters, digits, `_ - .` |
| `name` | string or one per language | required. Shown in the panel and on the lines. Same rule as in [names.json](#fixed-names): `{ "en": "…", "de": "…" }` |
| `kind` | enum | `database` `service` `file` `api` `queue` `other` |
| `external` | string | optional. The node in architecture.json that stands for the target on the map, normally an external node. Without it the target is listed and checked, but nothing is drawn |
| `writers` | string[] | required (may be empty). Each entry is a node id, or a file path or glob. A glob that matches every file of a part stands for that part |
| `readers` | string[] | optional, same form |
| `policy` | `"single-writer"` \| `"any"` | required. `single-writer`: more than one writer is a Health finding (important) |
| `note` | string or one per language | optional. One plain sentence shown with the target |

A bare list (`[ … ]`) works as well as `{ "targets": [ … ] }`.

- **Counting writers:** each entry is a writer, except one that lies inside another (a file of a part that's listed, or the same entry twice).
- **Only listed writers count.** The scan's own findings never add a writer. When it sees a web request to a target's hosts, or an import of its packages, from a part that isn't listed as a writer or reader of any target on that box, it adds a minor Health finding: `POST`, `PUT`, `PATCH` and `DELETE` read as writes, `GET` as reads, and anything else (an imported package, a request whose method isn't in the code) as direction unknown. Tests are left out.
- **Checked like everything else:** an unknown `kind`, `policy`, `external`, part id or path is an error with a "did you mean …".
- A read is drawn like a write, from the part to the target, but dashed; on hover its data flows back to the reader.

## rules and decisions

`floorplan/rules.json` is optional. A project has rules ("one writer per target", "the AI delivers data, the code decides", "nothing is sent automatically") and decisions with a date ("since 26 Oct the lead merges once CI is green"). They sit in CLAUDE.md, READMEs, decision records and logs, scattered and without a link to the map. This file hangs them on the parts, files, endpoints and targets they apply to: whoever looks at a card sees which rules hold there, and whoever opens a rule sees where it holds. **Floorplan never makes a rule up.** Write the file only from what the project documents, and quote the place in `source`; a rule nobody wrote down is not a rule.

```json
{
  "rules": [
    { "id": "one-writer", "kind": "rule", "title": "One writer per target",
      "text": "Only the worker writes to the database; the apps call its door.",
      "applies": ["api.orders", "orders-db", "shop-web/src/lib/api.ts", "POST /orders"],
      "source": "CLAUDE.md § Build rules", "since": "2026-10-25", "status": "active" },
    { "id": "merge-when-green", "kind": "decision", "title": "The lead merges when CI is green",
      "text": "Owner, 26 Oct: \"merge yourself once the checks pass\".", "applies": [],
      "source": "docs/decisions.md", "since": "2026-10-26" }
  ]
}
```

| field | type | meaning |
|---|---|---|
| `id` | string | required, unique; letters, digits, `_ - .` |
| `kind` | `"rule"` \| `"decision"` | required. A rule is how things are done; a decision is what someone settled, with a date |
| `title` | string or one per language | required. One line, shown in the lists and on the cards |
| `text` | string or one per language | required. The rule in one or two sentences, in the project's own words where possible |
| `applies` | string[] | where it holds. Each entry is a node id, a file path or glob (a glob that covers every file of a part stands for the part), `"METHOD /path"` exactly as on the map, or a target id from [targets.json](#targets), which puts the rule on the target's box. An empty list means **the whole project** |
| `source` | string | required. Where it is written down: a file and its section (`CLAUDE.md § Build rules`), a decision log, who said it and when |
| `since` | date | optional, `YYYY-MM-DD`: since when it holds |
| `until` | date | optional: when it stopped holding. A retired rule keeps its history |
| `status` | `"active"` (default) \| `"retired"` | a retired rule stays in the file, dimmed at the end of the list |
| `tags` | string[] | optional, free-form |

A bare list (`[ … ]`) works as well as `{ "rules": [ … ] }`.

- **Checked like everything else:** an unknown ref in `applies`, an unknown `kind`, `status` or field, a date in another format, a missing `title`, `text` or `source` is an error with a "did you mean …". A part id wins over a target with the same id.
- **In `graph.json`:** `graph.rules` = `[{ id, kind, title, text, source, since, until, status, tags?, items }]`, with `items` the cards each ref resolved to (`n:…`, `f:…`, `r:…`, and `t:<target id>` for a target). The build reports `RULES  N rules, M decisions · K retired`, or `RULES  none (no rules.json)`.
- **On the map:** a **Rules** button opens the list, the rules that apply everywhere first, then the rules and the decisions, the retired ones dimmed at the end; a rule opens with its text, source and places as links, and its cards on a board. Every card the rules reach, itself, its part or one of its parents, shows **Rules here** in its details.
- **Health:** a retired rule that still names places is a minor finding, "Retired rule still applied", so the owner sees what is left to clean up in the file or in the code. Nothing else: the refs were checked by the build.
- **In `MAP.md`:** a `## Rules` section after Targets, one block per rule: kind, dates, where it applies (by the names of the parts, targets and files, up to 8), the text in one line, the source.

## schedules

Much of what a system does, no person starts: a cron every five minutes, a nightly job, a weekly report, a pipeline that runs in the morning. The scan finds those schedules in the files that hold them, `floorplan/schedules.json` (optional) adds the ones it can't see and corrects the ones it found, and the map shows them under a **Clock** button: a 24-hour strip with a mark for every start, the list, and a mark on every card a schedule starts.

**What the scan finds**, with no parser beyond a few lines of looking:

| form | where | what it reads |
|---|---|---|
| `github-actions` | `.github/workflows/*.yml` | `on.schedule[].cron` (`- cron: '30 2 * * *'`), the workflow's `name` as the title; times are UTC |
| `vercel` | `vercel.json` | `crons[].{ path, schedule }`; the path is what the cron calls, as `GET /path`; UTC |
| `n8n` | a `*.json` with `"nodes"` and a Schedule Trigger or Cron node | the rule as a cron expression where cron can say it exactly (every N minutes or hours, daily, weekly, monthly), else an interval ("every 2 days at 02:30"); the workflow's `name`, its `settings.timezone`, the HTTP Request nodes as what it calls (`POST /path`); a disabled node is switched off |
| `crontab` | `crontab`, `*.cron`, `*.crontab`, `cron.d/*` | `m h dom mon dow command` and `@daily command`; `CRON_TZ=` or `TZ=` lines set the zone for the lines below; in `cron.d/` the user before the command is dropped; `@reboot` is not a time |
| `ofelia` | `docker-compose*.yml` | `ofelia.job-exec.<name>.schedule` (and `job-run`) with `.command`, as a map or a list of labels; `@every 1h` and 6-field expressions become 5 fields, `@every 90m` an interval; the service is named in the title |

Each find gets an id from its form and name (`actions-report`, `vercel-api-cron-cleanup`, `n8n-weekly-digest`, `cron-holer-sh`, `ofelia-backup`; a second find of the same name gets `-2`), the file as its `source` and `trigger`, and the scan lists them (`SCHEDULES  N found: …`), so an owner can refer to them by id.

```json
{
  "schedules": [
    { "id": "nightly-report", "title": "Nightly report", "cron": "30 2 * * *", "tz": "Europe/Berlin",
      "trigger": ".github/workflows/report.yml", "runs": ["api.reports"], "calls": "POST /reports/run",
      "note": "Builds the daily PDF and mails it.", "source": "README § Schedules" },
    { "id": "actions-ci", "runs": ["tests"], "enabled": false },
    { "id": "by-hand", "title": { "en": "Monthly invoices", "de": "Monatsrechnungen" }, "human": "on the first working day of the month", "source": "docs/billing.md" }
  ]
}
```

| field | type | meaning |
|---|---|---|
| `id` | string | required, unique; letters, digits, `_ - .`. The id of a find **overrides that find field by field**: a better title, the parts it runs, a note, `"enabled": false`. Any other id is a plan of its own |
| `title` | string or one per language | required for a plan of its own. As in [names.json](#fixed-names): `{ "en": "…", "de": "…" }` |
| `cron` | string | five fields, `minute hour day month weekday` (`@daily`, `@hourly` and the like work too). Required for a plan of its own unless `human` says when it runs. An expression that isn't five fields is a warning and is shown as written |
| `human` | string or one per language | when it runs, in words, for a plan cron can't express; shown in place of the words the build makes |
| `tz` | string | optional, a time zone name like `Europe/Berlin`; shown with the plan. A find from GitHub Actions or Vercel carries `UTC` |
| `trigger` | string | optional: what starts the plan, a part id, a file path or `"METHOD /path"`. A file the scan saw but the map doesn't show (a workflow or a crontab is config) stays as its path |
| `runs` | string[] | optional: what the plan runs, each a part id, a file path or glob (a glob that covers a whole part stands for the part), `"METHOD /path"` or a target id from [targets.json](#targets) |
| `calls` | string | optional: what the plan calls, as `METHOD /path` or a command. A call that names an endpoint on the map counts as a run too |
| `note` | string or one per language | optional, one plain sentence |
| `source` | string | optional: where the schedule is written down (`README § Schedules`); a find's source is its file |
| `enabled` | boolean | default `true`. `false` keeps the plan in the list, dimmed, with no mark on the strip and nothing on the map |

A bare list (`[ … ]`) works as well as `{ "schedules": [ … ] }`.

- **Checked like everything else:** an unknown field, an unknown ref in `trigger` or `runs`, a repeated id, a plan of its own without title or without `cron` or `human` is an error with a "did you mean …". A `cron` that isn't five fields and a `tz` this Node doesn't know are warnings: the plan is shown as written.
- **Words and the strip:** the build puts a cron into words in the map's language ("every 20 minutes", "hourly at :30", "daily at 02:30", "weekdays at 08:00", "every Sunday at 03:00", "monthly on the 1st at 06:00"; a rarer form is shown as written) and works out `times`, the minutes of one day it starts at: the series for a plan that runs any day, none for a weekly or monthly one.
- **In `graph.json`:** `graph.schedules` = `[{ id, title, cron, tz, human, trigger, runs, calls, note, source, kind, found, enabled, times }]`, with `trigger` a card (`n:…`, `f:…`, `r:…`) or a path, `runs` the cards each ref resolved to (`t:<target id>` for a target), `kind` the form the scan found it in (`github-actions`, `vercel`, `n8n`, `crontab`, `ofelia`; `null` for a plan of the owner's own). The build reports `SCHEDULES  N (a found, b declared) · next: HH:MM Title`, or `SCHEDULES  none`.
- **On the board:** a plan in force whose trigger and runs are both on the map draws an `event` edge from the one to the other, labelled with its cron, so the clock shows among the connections. With `"include": ["code", "config"]` the workflow or compose file is on the map and the edge starts there.
- **On the map:** a **Clock** switch in the top bar. Switched on, every card a plan starts (its trigger, what it runs, and the parts holding them) carries a small clock mark with the plans on hover, and the panel opens: a 24-hour strip with a mark for every start (a band where a plan runs every ten minutes or more often), then the list, next start first, the switched-off plans dimmed at the end. A plan opens with its details, its trigger and its places as links, and puts its cards on a board.
- **In `MAP.md`:** a `## Schedules` section after Rules, one line per plan: title and id, the cron and its words with the time zone, the trigger, what runs (by name), the call, the note, the source, and `off` for a switched-off plan.
- **The agent never makes a time up.** It writes `runs` for what the scan found and adds plans the project documents (a README section, a deploy guide, a hosting dashboard the user describes), with `source`; a schedule nobody wrote down is not one.

## layers

`floorplan/layers.json` is optional. It sorts the project's files into three layers, for an owner who might one day publish the code:

- **system**: the code and docs anyone could install and run, which is what would be published;
- **config** ("Setup" on the map): the setup of this one installation, like key names, ids, paths, calendars and private settings;
- **content**: the owner's own data, like customers, amounts and mails.

The map then has a **Layers** switch that colours every box by its layer, and Health gets a **Publishability** group ([below](#publishability)).

```json
{
  "layers": [
    { "id": "config", "name": { "en": "Setup", "de": "Einrichtung" }, "description": "This installation's settings.",
      "patterns": ["config/**", "**/*.local.*", "**/.env*"] },
    { "id": "content", "patterns": ["content/**", "tests/data/**"] }
  ],
  "default": "system",
  "privateWords": "~/.config/floorplan/private-words.txt"
}
```

| field | type | meaning |
|---|---|---|
| `layers` | list | required. Each layer has an `id` (`system`, `config` or `content`, each at most once) and `patterns`: globs relative to the codebase root, as in `paths` (may be empty). `name` and `description` are optional: a string, or one per language as in [names.json](#fixed-names). Without a name the map says System, Setup and Content in its own language |
| `default` | `"system"` \| `"config"` \| `"content"` | the layer of a file no pattern takes. Default `"system"`, so whatever nobody sorted is checked as publishable |
| `privateWords` | string | optional. The path to your private word list: relative to the codebase root, absolute, or starting with `~/` for your home folder. Keep it outside the repo ([below](#the-private-word-list)) |

- **Which file goes where:** each file takes the layer of the first pattern that matches it, in the order of the list (a layer's patterns in their order), else the default. So list the narrower layer first: with `config/**` before `config/customers/**` in content, `config/customers/list.js` is config.
- **Parts:** a part takes the layer more than half of its files have; otherwise it's **mixed**. Mixed parts are where the layers stick together, and the map draws them with a dashed ring.
- **Checked like everything else:** an unknown or repeated `id`, `patterns` that aren't a list, or an unknown `default` is an error with a "did you mean …"; a pattern that matches no file is a warning.
- On a blueprint the layers are drawn, but there's no code to check yet.

### Publishability

With layers.json, Health also lists what would keep the system from being published. It's a group of its own, counted apart from the other findings ("Publishability: 5 findings in System, 1 in Setup"), so it never pushes one of them off the list; a finding marked **Not a problem** on the map leaves that count too. Every finding names the file and the line, never the value it found:

| finding | in | severity |
|---|---|---|
| **Identifiers of one installation**: UUIDs (`8-4-4-4-12`), 32-character hex ids, and codes of 20 or more letters and digits that look generated, in strings and settings. Not hashes, nil UUIDs or API keys, which are the secret check's | system | medium |
| **Private words**: the names of customers, people and places in your word list, as whole words in any case (`ACME_KEY` and `fetchAcmeOrders` count, `Acmes` doesn't), in code, comments and docs. Shown only by their first letter: `A***` | system, config | medium |
| **Contact details**: email addresses and phone numbers. Not addresses at example.com, .test and the like, or noreply addresses | system | minor |
| **Absolute paths of one computer**: `/Users/…`, `/home/<name>/…`, `/volume1/…`, `C:\…`. Not CI and container folders like `/home/runner/…` or `/home/node/…` | system | minor |
| **System depends on content**: a system file imports a content file. Importing the setup is what it's for, so that's no finding | system | medium |

Tests and fixtures are left out of all but the private words: their ids and addresses are usually made up, and a real name in a test is exactly what should be found. Content is never checked.

- **In `graph.json`:** every Health finding, this group included, is `{ id, kind, severity, title, detail, items, notes, locations, fix }`. The `id` is fixed, `<check>` or `<check>:<instance>` (`large-files`, `secret:src/config.py`, `publish:private-word:system`), so a program finds a finding again whatever the language; `title`, `detail` and the `notes` on the cards are in the map's language (`lang`), from the `health.<check>.*` keys of the language table (`docs/i18n.md` in the repository says how they are translated); `fix` is the request to paste into the agent and stays English. A finding of this group also has `group: "publish"`, its `layer`, and `finds`, the number of places it counts (`locations` stops at 200). A finding never carries a value from the code, only a file, a line and a kind.

### The private word list

A plain text file with one word or name per line; lines starting with `#` are skipped, and entries under two characters are left out (they would match almost anywhere). It belongs outside the repo, for example in your home folder, and is never committed: the build reads it, finds the words, and writes only their first letter and where they are, never the words, nor the list's path. If the file isn't there, the build says so and skips that check. If it's inside the project and git doesn't ignore it, the build warns.

## operations

`floorplan/ops.json` is optional, and it is the one file in the folder that **the owner's own tooling writes**: a cron job, a deploy pipeline, a script on the server. It says what is running right now: a status per part, file, endpoint or target, the version that is deployed, when it last ran and last ran well, the last error, a note and a few numbers. Floorplan only knows the code; it never knows what runs, so neither the build nor the agent ever writes this file or makes a status up. If the user hands you the data ("the worker is down since 3 am"), you may write what they said, nothing more. The map shows the file as an overlay under an **Ops** switch, like recent work.

```json
{
  "asOf": "2026-11-01T04:00:00+01:00",
  "source": "tools/ops-export.sh",
  "items": [
    { "ref": "api", "status": "ok", "version": "v2026.11.01", "lastRun": "2026-11-01T03:40:00+01:00",
      "lastOk": "2026-11-01T03:40:00+01:00", "lastError": "", "note": "Cron every 5 min",
      "metrics": { "runs today": 12, "queue": 0 } },
    { "ref": "POST /api/notes", "status": "down", "lastRun": "2026-11-01T02:00:00+01:00", "lastError": "503 from the notes service" },
    { "ref": "orders-db", "status": "warn", "note": "Backup overdue" }
  ]
}
```

| field | meaning |
|---|---|
| `asOf` | required: when the file was written (ISO 8601). Older than 24 hours, the file is **stale**: the build warns (`OPS  stale: as of …`) and the map says so. Missing, the file's own modification time stands in, with a warning |
| `source` | optional: what writes the file, shown in the panel |
| `items[].ref` | a node id, a file path, `"METHOD /path"` exactly as on the map, or a target id from [targets.json](#targets), which marks the target's box. A ref that isn't on the map is left out with a warning, like recent work |
| `items[].status` | `ok` · `warn` · `down` · `unknown` (the default, also for anything else) |
| `items[].version`, `lastRun`, `lastOk`, `lastError`, `note` | optional, one line each (a longer text is cut to its first line). `lastRun` and `lastOk` are dates (ISO 8601) |
| `items[].metrics` | optional: a small object of label → number or short text, shown as it is (up to 12) |

- **Warnings, never errors.** The file comes from a machine, so nothing in it can break a build: a bad field, an unknown ref, a missing `asOf` or a file that isn't JSON is a warning, and the rest is shown.
- **In `graph.json`:** `graph.ops` = `{ asOf, source, stale, counts, items }`, with each item's `id` on the map. The build reports `OPS  N items: a ok · b warn · c down · d unknown (as of …)`, or `OPS  none (no ops.json)`.
- **On the map:** every box with an item gets a status dot (green, amber, red, grey) and the details on hover; a part shows the worst status of everything inside it, so an endpoint that is down turns its server red too. The **Operations** panel lists every item worst first, and a click goes to its box. While the map is served by `serve.mjs`, the page fetches the file again every minute, so the owner's cron can rewrite it between builds; a static copy keeps what the build saw.
- **Not in `MAP.md`**, and never a pointer to it there: the file changes with every run, and `MAP.md` is written only when the map changes. An exported copy carries it only when asked (`--include ops`). With `"git": "inputs"` the folder's `.gitignore` ignores it, like `recent-work.json`.

What a script has to produce: the JSON above, written whole (write to a temporary file and rename it, so the server never hands out a half-written file), with `asOf` set every time, refs spelled as the map spells them (node ids from architecture.json, paths relative to the codebase root, `"METHOD /path"` as the worksheets print it, target ids from targets.json), and statuses from the four words only.

## git

`"git"` in architecture.json says whether the map's files may go in git. Every script that writes the folder reads it and rewrites the folder's own `.gitignore` to match, so the mode lives in architecture.json, not in that file.

- **`"none"`** (the default, and what a missing field means): the `.gitignore` in `floorplan/` ignores everything in the folder, itself included. Nothing of the map is ever committed, and `git status` doesn't show the folder.
- **`"inputs"`**: the `.gitignore` ignores only what a build writes again: `index.html`, `graph.json`, `artifact.html`, `query.mjs`, `serve.mjs`, `recent-work.json`, `.cache/` and an exported `<project>-map.html`, and `ops.json`, which the owner's tooling rewrites with every run. What is left can be committed: `architecture.json`, `plan.json`, `names.json`, `targets.json`, `rules.json`, `schedules.json`, `layers.json`, `custom-flows.json`, `health-dismissed.json` (the findings marked **Not a problem**, with their reasons), `descriptions/`, `MAP.md` and the `.gitignore` itself. Floorplan only reads and writes files; it never commits anything.

Any other value is an error with a "did you mean …". When git already tracks files that the folder now ignores, the build prints the `git rm --cached` command that untracks them. If a rule from outside the folder (a `.gitignore` above it, `.git/info/exclude`) ignores `MAP.md`, the build warns that the inputs can't be committed.

### MAP.md

Every build writes `floorplan/MAP.md`, whatever `git` says: the map as plain text for AI workers that start in the repo. It is written in the map's language (`lang`), and in at most 1,500 lines: where a list would take it over, the list ends in "… and N more". It is written again only when its text changes, not when only the `As of` line would, so a committed copy changes when the map does and not on every build. The file says at its top that it is generated: edit the inputs, not this file.

| part | what it holds |
|---|---|
| head | the project name and summary, the day and commit it was last written at (`As of`), the language, the numbers (parts, files, connections), the Health sum, and the inputs in the folder |
| `## Parts` | per part, in tree order: its description, kind and size in files, path patterns, layer (with `layers.json`), the part it is in and the parts inside it, the targets it writes and reads, its key files (up to 12, the most connected first, each with its name and one sentence) and its endpoints |
| `## Targets` | per target: kind, policy, writers, readers, the note, calls the Health check found that targets.json doesn't list; a target with more writers than its policy allows is marked |
| `## Rules` | per rule or decision: kind, status and dates, where it applies (the names of the parts, targets and files, up to 8), the text in one line, the source; the retired ones last |
| `## Schedules` | per schedule, one line: title and id, cron and words with the time zone, trigger, what runs (by name), call, note, source; the switched-off ones last, marked `off` |
| `## Flows` | per flow: its description, what starts it, the numbered steps (with what you see at one) and what you have in the end |
| `## What you see` | per place (a phone, a calendar, a database, a mailbox): what arrives there, each sentence with the flow that brings it |
| `## Health` | one line per finding: severity, title and the number of places. Never a place, a line or a value. A finding marked **Not a problem** on the map comes last, marked as such, without its reason, and is out of the count in the head |
| `## Recent work` | the tasks of `recent-work.json` and the cards each one touched |

Each section has a marker right above its heading (`<!-- floorplan:parts -->`, `targets`, `rules`, `schedules`, `flows`, `outcomes`, `health`, `recent`), so a program finds it whatever the language. A section with nothing in it says "None.". Text from the code or from people is cut to one line, so it can't add a heading or a marker of its own.

## Full example

A frontend repo and a backend repo side by side:

```json
{
  "$schema": "floorplan/architecture@1",
  "project": {
    "name": "Acme Shop",
    "summary": "Next.js storefront talking to a Flask API over REST; Postgres for storage; Stripe for payments.",
    "entrypoints": ["shop-api/app.py", "shop-web/src/app/page.tsx"]
  },
  "ignore": ["shop-api/migrations/versions/**"],
  "nodes": [
    { "id": "web", "label": "Storefront", "kind": "ui", "summary": "Next.js app router UI.", "paths": ["shop-web/src"] },
    { "id": "web.pages", "parent": "web", "label": "Pages", "kind": "feature", "paths": ["shop-web/src/app"] },
    { "id": "web.api", "parent": "web", "label": "API client", "kind": "library", "summary": "Typed fetch wrapper for every backend call.", "paths": ["shop-web/src/lib/api*"] },
    { "id": "api", "label": "Shop API", "kind": "service", "summary": "Flask REST API.", "paths": ["shop-api/app.py", "shop-api/app"] },
    { "id": "api.routes", "parent": "api", "label": "Routes", "kind": "feature", "paths": ["shop-api/app/routes"] },
    { "id": "api.models", "parent": "api", "label": "Models", "kind": "data", "paths": ["shop-api/app/models"] },
    { "id": "tests", "label": "Tests", "kind": "test", "paths": ["shop-api/tests", "shop-web/**/*.test.{ts,tsx}"] },
    { "id": "pg", "label": "Postgres", "kind": "external", "packages": ["pypi:sqlalchemy", "pypi:psycopg2"] },
    { "id": "stripe", "label": "Stripe", "kind": "external", "packages": ["stripe"], "hosts": ["api.stripe.com"] }
  ],
  "edges": [
    { "from": "stripe", "to": "api.routes", "kind": "http", "label": "webhooks", "description": "payment_intent.succeeded marks orders paid." }
  ],
  "annotations": [
    { "path": "shop-api/app/routes/orders.py", "note": "All order state transitions live here.", "tags": ["hotspot"] }
  ],
  "flows": [
    { "id": "checkout", "title": "Checkout", "steps": [
      { "node": "web.pages", "note": "Cart page submits the order" },
      { "node": "web.api", "note": "POST /api/orders" },
      { "node": "api.routes", "note": "Validates and creates the order" },
      { "node": "stripe", "note": "Creates a PaymentIntent" }
    ]}
  ]
}
```
