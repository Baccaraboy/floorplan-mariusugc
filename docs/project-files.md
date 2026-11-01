# What's in your project

Floorplan writes to exactly two places in your project: the `floorplan/` folder, and (in Claude Code, only if you say yes) a short section in `CLAUDE.local.md`. Neither is committed to git (unless you ask for the map's inputs to be, [below](#keeping-the-inputs-in-git)), and nothing else in your project is touched.

## The `floorplan/` folder

| File | What it is | Edit it? |
|---|---|---|
| `index.html` | The map: one self-contained page | No. Rebuilt every time |
| `graph.json` | Everything the map shows, as data | No. Rebuilt every time |
| `MAP.md` | The map as plain text for AI workers: the parts with their key files and endpoints, who writes where, the rules and decisions, the schedules, the flows, the Health findings (a title and a count each) and the recent work. In the map's language, in at most 1,500 lines | No. Rewritten when the map changes |
| `architecture.json` | The parts of your app, outside services, extra connections, flows and the tour | **Yes** |
| `descriptions/*.json` | The name and description of every file and endpoint, one file per part | **Yes** |
| `names.json` | Optional: names you've fixed for parts, files and endpoints, which win over everything else and no update changes. Only there if you or the AI made it | **Yes** |
| `targets.json` | Optional: the databases, services and files your app writes to or reads from, which parts write and which read each one, and whether a target allows one writer only. Drives the **Targets** panel and its Health findings | **Yes** |
| `rules.json` | Optional: the rules your project documents and its dated decisions, each with its source and the parts, files, endpoints or targets it applies to. Drives the **Rules** panel, **Rules here** on the cards and the retired-rule Health finding. Written only from what the project documents, never made up | **Yes** |
| `schedules.json` | Optional: what a clock starts. The scan already finds crons in workflows, `vercel.json`, n8n workflows, crontabs and ofelia labels; this file says what each one runs, renames or switches one off, and adds the schedules the scan can't see, each with its source. Drives the **Clock** panel, the marks on the cards and the event lines from a trigger to what it runs | **Yes** |
| `layers.json` | Optional: which files are the system you could publish, which are the setup of this installation, and which are your content, by patterns. Drives the **Layers** switch and the Publishability findings. The private word list it names is not in this folder: keep it outside the repo | **Yes** |
| `plan.json` | Blueprints only: the planned files, endpoints and screens, who may use each endpoint, the stack, assumptions and open questions. Names and descriptions live here instead of `descriptions/` | **Yes** |
| `recent-work.json` | What was just worked on, and why. Replaced on every update | Rarely. The AI writes it |
| `ops.json` | Optional: what is running, from your own cron, pipeline or deploy script: a status per part, file, endpoint or target, the deployed version, the last runs and the last error. Drives the **Ops** switch and the **Operations** panel. Floorplan and the AI never write it | Your tooling does |
| `custom-flows.json` | Flows requested from the map | Only to delete one |
| `health-dismissed.json` | Health issues you marked **Not a problem**, with your reasons | Only to undo one. **Show again** on the map does it too |
| `serve.mjs` | Serves the map locally and answers questions through the Claude Code CLI or Codex | No |
| `query.mjs` | Looks things up in the map from the command line; Claude and Codex use it too | No |
| `artifact.html` | A copy for opening in the Claude app, only if you asked for one | No |
| `<project>-map.html` | An exported copy to share, only if you exported one from Claude or Codex (the map's Export button downloads it instead) | No |
| `.cache/` | The scan, the description worksheets, the last update's changes, the running server's address, and, for a blueprint, the last 20 versions of the plan that **Undo** goes back to | No. Safe to delete, though Undo then has nothing to go back to |
| `.gitignore` | Keeps this whole folder out of git, or, with `"git": "inputs"`, only what a build writes again | No |

### Editing names and structure

Your edits to `architecture.json` and `descriptions/` are kept on every update. You can:
- rename a part, or reword a description;
- move files between parts by changing the `paths` patterns;
- add a connection the scan missed;
- pin a note to a file;
- add or change flows and the tour.

Or just ask Claude or Codex ("rename 'Main server' to 'Shop API' on the floorplan").

Names you want to keep exactly, whatever the AI writes later, go in `names.json` ("freeze the names on the floorplan"). Each one is a string or one per language, like `{ "en": "Order desk", "de": "Bestellannahme" }`. An update never edits this file: if a file named there moves or is deleted, it tells you, and the entry is moved by hand.

A blueprint is edited the same way, through `plan.json` and `architecture.json`, or from the map with the Ask bar's **Change** switch. The plan's format is in [`blueprint.md`](../skills/floorplan/references/blueprint.md).

The full format is in [`skills/floorplan/references/schema.md`](../skills/floorplan/references/schema.md), and the style guide for names and descriptions is in [`writing-descriptions.md`](../skills/floorplan/references/writing-descriptions.md).

## `CLAUDE.local.md`

In Claude Code, after the first map, Claude asks whether future sessions in your project should use it. Only if you say yes, Floorplan adds a short marked section here, telling future Claude Code sessions that the map exists and how to look things up in it. `CLAUDE.local.md` is Claude Code's file for personal project notes, loaded at the start of every session like `CLAUDE.md`. Floorplan:
- creates the file if you don't have one;
- only ever rewrites its own section, between `<!-- floorplan:start -->` and `<!-- floorplan:end -->`, and keeps it current on each update;
- adds the file to your clone's private ignore list, `.git/info/exclude`.

To remove it, delete the section. To keep it from coming back, put `<!-- floorplan:off -->` anywhere in `CLAUDE.local.md`. (Before 0.4.4, Floorplan added the section without asking; if you have it from then, it stays until you remove it.)

A blueprint adds no section, since there's no code to look up yet. Claude offers it once the map switches to the real code.

In Codex this file isn't touched. Codex has no personal, uncommitted notes file (`AGENTS.md` is shared with your team), so Floorplan doesn't add a note there.

## Staying out of git

- **`floorplan/`** contains its own `.gitignore` that ignores everything in the folder, including itself. Your `.gitignore` isn't changed, and the folder never appears in `git status`.
- **`CLAUDE.local.md`** is listed in `.git/info/exclude`, the per-clone ignore list that is never committed. If your project already ignores it, nothing is added.

The map is personal to each clone. Teammates who install Floorplan make their own. (If you want the inputs shared, see the next section.)

If you committed a `floorplan/` folder before, ignoring it doesn't untrack those files. The build tells you the command that does, which keeps the files on disk:

```bash
git rm -r --cached floorplan
```

## Keeping the inputs in git

Sometimes the map's inputs belong in the repo: so a fresh clone, or an AI worker that starts a session with no memory of the last one, finds the structure and the names without anyone building a map first. Add `"git": "inputs"` to `floorplan/architecture.json` (the default is `"none"`, which is everything above):

```json
{ "git": "inputs", "project": { "name": "Acme Shop" }, "nodes": [] }
```

- **`floorplan/.gitignore`** then ignores only what a build writes again: `index.html`, `graph.json`, `artifact.html`, `query.mjs`, `serve.mjs`, `recent-work.json`, `.cache/` and exported `*-map.html` copies, plus `ops.json`, which your tooling rewrites with every run. It no longer ignores itself.
- **What can be committed:** `architecture.json`, `descriptions/`, `names.json`, `targets.json`, `rules.json`, `schedules.json`, `layers.json`, `plan.json`, `custom-flows.json`, `.gitignore` and `MAP.md`. Floorplan never commits anything: after a build, you (or the session that owns the repo) do.
- **`MAP.md`** is the map as text, whatever `git` says. It's written again only when its text changes (the `As of` line doesn't count), so a committed copy changes when the map does, not on every build. A worker reads it first and changes the inputs, never that file. Its format is in [schema.md](../skills/floorplan/references/schema.md#mapmd).
- **A fresh clone** has the inputs and `MAP.md`, but no map yet. `status.mjs` says so, and `refresh.mjs` scans the code and builds one from the inputs (a blueprint is redrawn from `plan.json`).
- **The note in `CLAUDE.local.md`**, if you have one, then starts with a paragraph that points to `MAP.md`.
- **Files git already tracks stay tracked.** If it tracks files the folder now ignores, the build prints the `git rm --cached` command for them.
- **A rule from outside the folder** (a `.gitignore` above it, `.git/info/exclude`) that ignores `MAP.md` keeps the inputs out of git. The build warns and names the command that finds the rule: `git check-ignore -v floorplan/MAP.md`.
- **Going back:** set `"git": "none"` (or remove the field) and build. The folder ignores itself again; what you committed stays tracked until you run `git rm -r --cached floorplan`.

The inputs are descriptions an AI wrote from your code, and `MAP.md` repeats them. They don't hold secrets or code, but they do hold your file paths and names, so read them before you push a repo that others can see. See [Is it safe?](is-it-safe.md) and [Privacy & security](privacy-and-security.md).
