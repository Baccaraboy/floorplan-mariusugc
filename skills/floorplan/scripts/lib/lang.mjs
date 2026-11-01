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

/** For a map in another language: the line worksheets give the AI, so what it writes matches the map. Empty for English. */
export function languageNote(code) {
  if (!code || code === 'en') return '';
  let name = String(code);
  try { name = strings(code)['lang.englishName'] || name; } catch {}
  return `Language: ${name} ("lang": "${code}" in architecture.json). Write every name, description, title, note and summary in ${name}; keep code names, paths and the user's own words as they are.`;
}
