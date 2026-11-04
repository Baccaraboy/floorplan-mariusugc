# AGENTS.md — Floorplan-Fork (für Codex und jedes Werkzeug außer Claude)

Stand 04.11.2026 · gepflegt von der Bauleitung (Claude-Chat «A - NAS-Automation»). Diese Datei gehört nur zum Fork, wie
`CLAUDE.md`: Sie kommt nie in einen PR an den Autor.

## Was das ist

Ein Fork von [haydenschmitty/floorplan](https://github.com/haydenschmitty/floorplan) (MIT): ein Skill für Claude Code und
Codex, der aus einem Repo eine in sich geschlossene Karte macht (`floorplan/index.html`). Reines Node, keine
Abhängigkeiten. Der Fork bringt Floorplan auf Deutsch (Sprachtafeln) und baut eigene «Stockwerke» — jedes generisch, so
gebaut, dass der Autor es ohne Umbau übernehmen kann. Wie Floorplan in Codex läuft, steht in `docs/codex.md`.

## Zuerst lesen

1. `CLAUDE.md` — die verbindlichen Regeln dieses Forks, vor allem «upstream-tauglich» (Englisch im Code, kleine saubere
   Commits, Vorgabe unverändert, sichtbare Texte nur über die Sprachtafeln). Sie gelten für dich genauso wie für Claude.
2. `docs/development.md` (Aufbau, lokal testen), `docs/how-it-works.md` (die Karte), `docs/i18n.md` (Sprachtafeln),
   `docs/is-it-safe.md` mit `tests/supply-chain.test.mjs` (nur gemeinsam ändern).

## Was für dich anders ist als für Claude

- **Nur für Claude-Sitzungen** gelten in `CLAUDE.md` der Abschnitt «Umgebung einer Claude-Sitzung» (GitHub nur über REST,
  Proxy) und die Zeilen `Co-Authored-By: … <noreply@anthropic.com>` und `Claude-Session: …`. Du nutzt `git` und `gh` wie
  gewohnt; ans Ende jeder Commit-Nachricht schreibst du `Built-with: Codex` (Commits sind englisch), ans Ende der
  PR-Beschreibung «Gebaut mit Codex».
- **Nicht lesbar für dich:** das Claude-Projekt, die Notion-Landkarte und das Brett «Stand der Vorhaben». Was du brauchst,
  steht hier und in `docs/`. Fehlt etwas, rate nicht: frag Marius oder schreib die Frage in den PR.
- **Je Repo baut genau einer zur Zeit.** Vor dem Start `git fetch origin` und `gh pr list`; berührt ein offener PR dieselben
  Dateien, fängst du nicht an und sagst es Marius.
- **Du mergst nie.** PR auf `main` des Forks, dann nennst du Marius die PR-Nummer; prüfen und mergen tut die Bauleitung.
  Ein Nachzug des Originals wird mit Merge-Commit gemergt, alles andere per Squash (`CLAUDE.md`, «Upstream»).
- **Öffentliches Repo:** nichts Persönliches, keine Namen, Pfade oder Dienste aus Marius' Projekten — weder im Code noch in
  Tests, Beispielen oder Commits.

## So wird gebaut

1. `git fetch origin main`, Zweig ab `origin/main` (Kleinbuchstaben, Bindestriche). Nie auf `main`, nie Force-Push.
2. Erst der Test, dann der Code. Bestehende Tests bleiben grün; muss einer angepasst werden, bleibt seine Absicht, und der PR
   sagt, warum.
3. Vor dem Push: `npm test` komplett grün. Den Viewer prüfen: eine Beispielkarte bauen (`tests/helpers.mjs` → `shopApp()`,
   dann `scripts/scan.mjs` und `scripts/build.mjs`) und `floorplan/index.html` im Browser ansehen, ohne Konsolenfehler.
4. Kein Versionssprung (`plugin.json`, Badge, `CHECKSUMS.txt`); Neues im CHANGELOG unter «Unreleased».
5. PR auf Deutsch: Entwurf · Gebaut · Tests (vorher/nachher) · Was upstream-tauglich ist · Offenes · Fehlte in den Dateien.

## Nie

- Einen PR, ein Issue oder einen Kommentar beim Autor (haydenschmitty/floorplan) ohne Marius' Wort.
- Neue Abhängigkeiten, Hooks oder Netzzugriffe (`tests/supply-chain.test.mjs`).
- Schlüssel, Token oder Zugangsdaten lesen, anlegen oder ins Repo schreiben; Testdaten sind erfunden.

## Stand (04.11.2026) — was als Nächstes dran ist

Der Fork steht auf dem Original 0.6.1 (PR #13, Merge-Commit), dazu Deutsch und zehn Stockwerke (PRs #1–#11). Offen, je ein
eigener Auftrag:

1. Ein Schalter, mit dem die Karte die Reihenfolge der Bereiche einhält (ELK `forceNodeModelOrder`) — für Baupläne, deren
   Bereiche Phasen in fester Reihenfolge sind.
2. Der Hinweis «Sag es dem Entwickler» soll nicht bei Prüfungen erscheinen, die nur der Fork hat.
3. Ein Fehlalarm der Prüfung «Kontaktdaten» bei Daten- und Rechnungsdateien.
4. Später, nur mit Marius' Wort: die upstream-tauglichen Änderungen als PR an den Autor.
