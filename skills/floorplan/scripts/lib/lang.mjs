// The map's languages: assets/lang/<code>.json holds every word the map shows (buttons, panels, messages, the
// glossary), under the same keys in each language, with {placeholders} for what gets filled in. en.json is the
// source; a key another language lacks falls back to English. build.mjs embeds only the chosen language.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'lang');
const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** The language codes there is a table for, English first. */
export const languages = () => fs.readdirSync(LANG_DIR).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((c) => CODE.test(c))
  .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));

function read(code) {
  if (!CODE.test(String(code))) throw new Error(`not a language code: ${code}`);
  return JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${code}.json`), 'utf8'));
}

/** Every key the map uses, in this language, with English for the keys it doesn't have. */
export const strings = (code = 'en') => (code === 'en' ? read('en') : { ...read('en'), ...read(code) });

/** Fills {name} placeholders from vars, as the map's own t() does. */
export const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/**
 * t() and tn() over one table, as the map's own page has them: t(key, vars) fills the placeholders of a text (a key the
 * table lacks comes back as it is), and tn(key, n, vars) picks the plural form the language uses for n (key.one,
 * key.other, …; key.other when the form is missing) and fills {n} too. Used wherever the build writes words people
 * read: MAP.md, the Health findings, the Clock's words. `has(key)` says whether the table knows a key.
 */
export function translator(words, code = 'en') {
  const t = (key, vars) => fill(words[key] ?? key, vars);
  let plural;
  try { plural = new Intl.PluralRules(code); } catch { plural = new Intl.PluralRules('en'); }
  const tn = (key, n, vars) => { const k = `${key}.${plural.select(n)}`; return t(k in words ? k : `${key}.other`, { n, ...vars }); };
  return { t, tn, has: (key) => key in words };
}

/** For a map in another language: the line worksheets give the AI, so what it writes matches the map. Empty for English. */
export function languageNote(code) {
  if (!code || code === 'en') return '';
  let name = String(code);
  try { name = strings(code)['lang.englishName'] || name; } catch {}
  return `Language: ${name} ("lang": "${code}" in architecture.json). Write every name, description, title, note and summary in ${name}; keep code names, paths and the user's own words as they are.`;
}
