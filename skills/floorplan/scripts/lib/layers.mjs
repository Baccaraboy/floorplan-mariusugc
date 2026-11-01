// Layers: an optional floorplan/layers.json sorts a project's files into three layers, so its owner can see which
// files they could one day publish, and where the layers stick together in the code:
//   system   the code and docs anyone could install and run: what would be published
//   config   the setup of this one installation: key names, ids, paths, calendars, private settings ("Setup")
//   content  the owner's own data: customers, amounts, mails
// Each file takes the layer of the first pattern it matches, in the order of the list, else the default; a part takes
// the layer more than half of its files have, else "mixed". build.mjs reads layers.json and the private word list,
// and buildHealth (health.mjs) turns what findPublishable() finds into the Publishability findings.
//
// As everywhere in Health, precision beats recall, and a finding records where something is, never what it is: a
// line and a kind ("a UUID-style id"), and for a private word only its first letter.

import { compileGlob } from './common.mjs';

export const LAYER_IDS = ['system', 'config', 'content'];

/** A function that gives a path its layer: the first pattern that matches it, in the order of the list, else the default. */
export function layerAssigner(list, fallback) {
  const globs = list.flatMap((l) => l.patterns.map((p) => ({ id: l.id, g: compileGlob(p) })));
  return (p) => globs.find((x) => x.g.test(p))?.id || fallback;
}

/** The layer more than half of a part's files have, else "mixed"; null for a part without files. */
export function majority(counts) {
  const entries = Object.entries(counts || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  return entries[0][1] * 2 > total ? entries[0][0] : 'mixed';
}

// ---------- the private word list ----------

/**
 * The owner's private words (names of customers, people, places): one word or name per line, in a file that lives
 * outside the repo. Blank lines and lines starting with "#" are skipped. An entry under two characters would match
 * almost anywhere, so it's left out and counted instead.
 */
export function parseWords(text) {
  const src = String(text);
  const seen = new Set(), words = [];
  let short = 0;
  for (const raw of (src.charCodeAt(0) === 0xfeff ? src.slice(1) : src).split(/\r?\n/)) {
    const w = raw.trim().replace(/\s+/g, ' ').normalize('NFC');
    if (!w || w.startsWith('#')) continue;
    if ([...w].length < 2) { short++; continue; }
    const key = w.toLowerCase();
    if (!seen.has(key)) { seen.add(key); words.push(w); }
  }
  return { words, short };
}

/** "M*****": a private word's first letter, then a star for every other character, so a finding never shows the word. */
export const maskWord = (w) => { const c = [...w]; return c[0] + '*'.repeat(c.length - 1); };

const WORDISH = /[\p{L}\p{N}]/u, UPPER = /\p{Lu}/u, LOWER = /\p{Ll}/u;
/**
 * Finds the private words in a text, whole words only and ignoring case. A word ends where a letter or digit stops:
 * at spaces and punctuation, at "_" and "-" (ACME_KEY, acme-client) and where camelCase starts a new word
 * (fetchAcmeOrders), but not inside a longer word (Acmes, Macmillan). Returns [{ index, word }], word as listed.
 */
export function wordFinder(words) {
  if (!words?.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const re = new RegExp([...words].sort((a, b) => b.length - a.length).map(esc).join('|'), 'giu');
  const listed = new Map(words.map((w) => [w.toLowerCase(), w]));
  return (text) => {
    const out = [];
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      const s = m[0], a = m.index, b = a + s.length;
      const prev = [...text.slice(Math.max(0, a - 2), a)].pop() || '', next = [...text.slice(b, b + 2)][0] || '';
      const chars = [...s];
      const startsWord = !prev || !WORDISH.test(prev) || (LOWER.test(prev) && UPPER.test(chars[0]));
      const endsWord = !next || !WORDISH.test(next) || (UPPER.test(next) && LOWER.test(chars[chars.length - 1]));
      if (startsWord && endsWord) out.push({ index: a, word: listed.get(s.toLowerCase().replace(/\s+/g, ' ')) || s });
      else re.lastIndex = a + 1; // a shorter word may still start inside this one
    }
    return out;
  };
}

// ---------- what would keep a file from being published ----------

const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};
function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let e = 0;
  for (const n of counts.values()) { const p = n / s.length; e -= p * Math.log2(p); }
  return e;
}

// identifiers of one installation: a database, a calendar, a document, an account
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX32 = /\b[0-9a-f]{32}\b/gi;
// UUIDs that are the same for everyone: nil and max, the namespaces of RFC 4122, the textbook example, and Windows' IUnknown/IDispatch family
const GENERIC_UUID = /^(?:0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12}|6ba7b81[0-4]-9dad-11d1-80b4-00c04fd430c8|123e4567-e89b-12d3-a456-426614174000|[0-9a-f]{8}-0{4}-0{4}-c000-0{10}46)$/i;
// lines about a checksum (a hash of a file is no installation's id), and lines about a secret, which Health's secret
// check already looks at: the identifier check never doubles it
const HASH_LINE = /md5|sha-?\d|hash|checksum|digest|etag|integrity|fingerprint|nonce|salt/i;
const SECRET_LINE = /(?<![a-z])(?:api[_-]?key|apikey|secrets?|token|passw(?:or)?d|passwd|pwd|private[_-]?key|access[_-]?key|credentials?|bearer|authorization)(?![a-z])/i;
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const CONFIG_VALUE = /^\s*(?:export\s+)?[\w.-]+\s*[:=]\s*([^\s#'"`]+)\s*(?:#.*)?$/;
const CONFIG_LANGS = new Set(['yaml', 'yml', 'ini', 'cfg', 'conf', 'properties', 'env', 'toml']);
const PLACEHOLDER = /your|xxxx|example|changeme|placeholder|replace|dummy|fake|sample|redacted/i;
/** A code that looks generated rather than written: 20+ letters, digits, "_" and "-", mixed often, and not a hash. */
function tokenLike(s) {
  // hex, with or without dashes, is a hash or a UUID: the UUID and 32-character rules (and their exceptions) have it
  if (s.length < 20 || s.length > 100 || !/^[A-Za-z0-9_-]+$/.test(s) || /^[0-9a-f-]+$/i.test(s) || PLACEHOLDER.test(s)) return false;
  if ((s.match(/\d/g) || []).length < 3 || (s.match(/[a-z]/gi) || []).length < 3) return false;
  let switches = 0, prev = null;
  for (const c of s) {
    const k = c >= '0' && c <= '9' ? 'd' : c >= 'a' && c <= 'z' ? 'l' : c >= 'A' && c <= 'Z' ? 'u' : null;
    if (k && prev && k !== prev) switches++;
    if (k) prev = k;
  }
  return switches >= 6 && entropy(s) >= 3.5;
}
/** The values on a line a token could hide in: quoted strings, `code`, and the value of a setting in a config file. */
function values(text, f) {
  const out = [];
  for (const m of text.matchAll(QUOTED)) out.push(m[2]);
  if (f.category === 'config' && CONFIG_LANGS.has(f.lang)) { const v = CONFIG_VALUE.exec(text); if (v) out.push(v[1]); }
  return out;
}
function identifiers(text, f, known) {
  if (SECRET_LINE.test(text) || HASH_LINE.test(text)) return null;
  for (const m of text.matchAll(UUID)) if (!GENERIC_UUID.test(m[0]) && new Set(m[0].replace(/-/g, '').toLowerCase()).size > 4) return 'a UUID-style id';
  for (const m of text.matchAll(HEX32)) if (/\d/.test(m[0]) && /[a-f]/i.test(m[0]) && new Set(m[0].toLowerCase()).size > 4) return 'a 32-character id';
  if (text.length > 400) return null; // minified or data lines: too much noise for the looser check
  for (const v of values(text, f)) {
    // data: addresses and base64 blobs hold random-looking text that isn't an id
    if (/^data:|base64,/i.test(v) || (/^[A-Za-z0-9+/=_-]{40,}$/.test(v) && /[+/]|=$/.test(v))) continue;
    for (const seg of v.split(/[/?&=#:@.\s,;|()[\]{}<>"'`+\\]+/)) if (tokenLike(seg) && !known?.(seg)) return `a ${seg.length}-character id`;
  }
  return null;
}

// contact details: email addresses and phone numbers
const EMAIL = /(?<![\w.%+\-/])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})(?![\w-])/g;
// example.com and friends, special-use names (RFC 2606, 6761) and local networks, and file names like logo@2x.png
const EXAMPLE_DOMAIN = /(?:^|\.)example\.(?:com|org|net)$|\.(?:example|test|invalid|localhost|local|internal|lan|arpa)$|^(?:your-?domain|my-?domain|domain|company|your-?company)\.com$|noreply/i;
const FILE_TLD = /^(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|m?js|cjs|ts|tsx|jsx|css|scss|less|json|html?|txt|md|pdf|map|lock|ya?ml|vue|svelte|woff2?|ttf|otf|mp[34]|webm|mov|wav|py|rb|go|rs|java|kt|sh|zip|t?gz|xml|csv|log)$/i;
const NOT_A_PERSON = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|git|you|your|yourname|your[-_.]name|user|username|someone|name|test|foo)$/i;
// "+" and a country code, but not a signed decimal number like a map coordinate (+52.5200)
const PHONE_INTL = /(?<![\w+#&/.=-])\+(?!\d{1,4}[.,]\d)[1-9]\d{0,3}(?:[ /-]?\(?\d{1,6}\)?)(?:[ ./-]?\(?\d{1,6}\)?){0,5}(?![\w])/g;
const PHONE_US = /(?<![\w(])\((\d{3})\) ?(\d{3})[-. ]\d{4}(?!\d)/g;
const PHONE_NATIONAL = /(?<![\w.+-])\(?0\d{1,5}\)?[ /.-]?\d{2,}(?:[ .-]?\d{2,}){0,4}(?![\w.-])/g;
const PHONE_WORD = /(?<![a-z])(?:phone|telephone|tel|telefon|fax|mobile?|mobil|handy|whatsapp)(?![a-z])/i;
/** Digits that don't look like a real number: one digit over and over, a run of zeros, or counting up or down. */
const madeUp = (d) => /^(\d)\1+$/.test(d) || /0{5,}/.test(d) || /0123456|1234567|2345678|3456789|9876543/.test(d);
function contact(text) {
  for (const m of text.matchAll(EMAIL)) {
    const [, local, domain] = m;
    const before = text.slice(Math.max(0, m.index - 7), m.index);
    if (/:$/.test(before) && !/mailto:$/i.test(before)) continue; // user:password@host in an address
    const tld = domain.split('.').pop();
    // a generated name before the @ (a shared calendar's id, a service's inbox) is an id, which the identifier check has
    if (EXAMPLE_DOMAIN.test(domain) || FILE_TLD.test(tld) || NOT_A_PERSON.test(local) || tokenLike(local)) continue;
    return 'an email address';
  }
  for (const m of text.matchAll(PHONE_INTL)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length < 8 || d.length > 15 || madeUp(d)) continue;
    if (d[0] === '1' && (d.slice(1, 4) === '555' || d.slice(4, 7) === '555')) continue; // North America's numbers for films and examples
    return 'a phone number';
  }
  for (const m of text.matchAll(PHONE_US)) if (m[1] !== '555' && m[2] !== '555' && !madeUp(m[0].replace(/\D/g, ''))) return 'a phone number';
  if (PHONE_WORD.test(text) || /tel:/i.test(text)) for (const m of text.matchAll(PHONE_NATIONAL)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 7 && d.length <= 15 && !madeUp(d)) return 'a phone number';
  }
  return null;
}

// absolute paths that only exist on one computer
const NOT_A_HOME = /^(?:you|your|yourname|your[-_.]?name|user|username|user[-_.]name|name|me|someone|somebody|example|shared|guest|default|public|runner|node|app|vscode|codespace|gitpod|circleci|jenkins|travis|docker|nobody|x{3,}|[<$%{[*].*|\.{3}|\u2026)$/i;
const MACHINE_PATHS = [
  { re: /(?<![\w.~$/-])\/Users\/([^/\s'"`<>$%{}()[\]*]+)\/[^\s'"`<>]/g, what: 'a folder on one Mac (/Users/\u2026)', user: 1 },
  { re: /(?<![\w.~$/-])\/home\/([a-z_][a-z0-9_.-]{0,31})\/[^\s'"`<>]/g, what: 'a home folder on one Linux machine (/home/\u2026)', user: 1 },
  { re: /(?<![\w.~$/-])\/(volume(?:USB)?\d+)\/[^\s'"`<>]/g, what: (m) => `a folder on one NAS (/${m[1]}/\u2026)` },
  { re: /(?<![A-Za-z0-9_])([A-Za-z]):\\{1,2}(?!\\)([^\\\s'"`<>|*?:]+)(?:\\{1,2}([^\\\s'"`<>|*?:]+))?/g, what: (m) => `a folder on one Windows computer (${m[1].toUpperCase()}:\\\u2026)`, win: true },
];
function machinePath(text) {
  for (const p of MACHINE_PATHS) for (const m of text.matchAll(p.re)) {
    if (p.user && NOT_A_HOME.test(m[p.user])) continue;
    // C:\Windows and C:\Program Files are on every Windows computer; C:\Users\<you> is a placeholder
    if (p.win && (/^(?:windows|program|programdata)$/i.test(m[2]) || (/^users$/i.test(m[2]) && (!m[3] || NOT_A_HOME.test(m[3]))))) continue;
    return typeof p.what === 'function' ? p.what(m) : p.what;
  }
  return null;
}

/**
 * What in one file would keep the system from being published, by the file's layer:
 * - system: ids of one installation, private words, contact details and absolute machine paths;
 * - config (the setup): private words only, since ids, paths and contact details are what a setup is for;
 * - content: nothing, it's the owner's own data.
 * Tests and fixtures are left out of all but the private words: their ids and addresses are usually made up, and a
 * real name in a test is exactly what should be found. `skipLines` holds the lines Health's secret check already
 * reports; `known` tells a key in a known format (Health's job too). Returns
 * [{ k: 'identifier' | 'private-word' | 'contact' | 'path', line, what?, mask? }], at most one per kind and line.
 */
export function findPublishable(src, f, { layer, find, test = false, skipLines, known } = {}) {
  const out = [];
  if (layer !== 'system' && layer !== 'config') return out;
  if (find) {
    const text = src.normalize('NFC'), at = lineIndex(text);
    const byLine = new Map();
    for (const hit of find(text)) {
      const line = at(hit.index), mask = maskWord(hit.word);
      if (!byLine.has(line)) byLine.set(line, []);
      if (!byLine.get(line).includes(mask)) byLine.get(line).push(mask);
    }
    for (const [line, masks] of byLine) out.push({ k: 'private-word', line, mask: masks.join(', ') });
  }
  if (layer !== 'system' || test) return out;
  src.split('\n').forEach((text, i) => {
    const line = i + 1;
    if (!skipLines?.has(line)) { const what = identifiers(text, f, known); if (what) out.push({ k: 'identifier', line, what }); }
    const who = contact(text);
    if (who) out.push({ k: 'contact', line, what: who });
    const where = machinePath(text);
    if (where) out.push({ k: 'path', line, what: where });
  });
  return out.sort((a, b) => a.line - b.line);
}
