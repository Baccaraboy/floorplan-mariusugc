// Health check: plain-language warnings about the codebase (secrets, endpoints anyone can call,
// the usual Supabase / Firebase / Stripe / CORS mistakes, unused files, oversized files), written for
// people who built an app with AI and don't know its insides. It's a check, not an audit. Precision
// beats recall: a false alarm costs this audience more than a missed one.
//
// findIssues(src, file)  — called by scan.mjs for every code/config/docs file with its source.
//                           Returns raw findings for that file, stored in scan.json files[].issues.
//                           Findings never contain a secret's value, only its line, kind and a masked hint.
// buildHealth(ctx)       — called by build.mjs with { graph, scan, arch, root, layers } after the graph is built.
//                           Returns { summary: { high, medium, low }, issues: [...] }, stored as graph.health.
//                           With floorplan/layers.json, also the Publishability group: its issues (group
//                           "publish") come after the others, and its counts are in publish, not in summary.

import fs from 'node:fs';
import path from 'node:path';
import { git, compileGlob } from './common.mjs';
import { findPublishable, wordFinder } from './layers.mjs';

const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

/** Shannon entropy in bits per character: random keys score ~4+, words and placeholders ~2-3. */
function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let e = 0;
  for (const n of counts.values()) { const p = n / s.length; e -= p * Math.log2(p); }
  return e;
}

// Files where keys are usually fake: tests, fixtures, examples, docs.
export const TEST_FILE = /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?|testdata|mocks?)\/|\.(test|spec|stories)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/i;
const EXAMPLE_FILE = /(^|\/)(examples?|samples?|docs?|demo)\/|\.(example|sample|template|dist|tmpl)(\.|$)|(^|\/)[^/]*example[^/]*$/i;
const PLACEHOLDER = /your|xxxx|example|changeme|change[-_]?me|placeholder|replace|dummy|fake|sample|redacted|insert|<[^>]*>|\$\{|\{\{|%\(|\*\*\*|0{8,}|1234567|abcdef|_here\b|-here\b/i;

// ---------- 1. secrets ----------

// Well-known key formats. `sev` defaults to high; `live` formats are flagged even in test files.
const FORMATS = [
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'an Amazon Web Services (AWS) access key', svc: 'AWS', live: true },
  { re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/g, what: 'a Stripe live secret key', svc: 'Stripe', live: true },
  { re: /\b(?:sk|rk)_test_[0-9a-zA-Z]{20,}/g, what: 'a Stripe test key', svc: 'Stripe', sev: 'medium' },
  { re: /\bwhsec_[A-Za-z0-9]{24,}/g, what: 'a Stripe webhook signing secret', svc: 'Stripe' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, what: 'a GitHub access token', svc: 'GitHub', live: true },
  { re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g, what: 'a GitHub access token', svc: 'GitHub', live: true },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, what: 'a GitLab access token', svc: 'GitLab', live: true },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, what: 'a Slack token', svc: 'Slack', live: true },
  { re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g, what: 'a Slack webhook address (anyone with it can post to your Slack)', svc: 'Slack', sev: 'medium' },
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/g, what: 'a Google API key', svc: 'Google Cloud', sev: 'medium', skipIf: /firebase|authDomain|messagingSenderId/i },
  { re: /\bGOCSPX-[A-Za-z0-9_\-]{20,}/g, what: 'a Google sign-in client secret', svc: 'Google Cloud' },
  { re: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_\-]{40,}/g, what: 'an Anthropic (Claude) API key', svc: 'Anthropic', live: true },
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{16,}T3BlbkFJ[A-Za-z0-9_\-]{16,}/g, what: 'an OpenAI API key', svc: 'OpenAI', live: true },
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{40,}/g, what: 'an OpenAI API key', svc: 'OpenAI', live: true },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, what: 'a private key', svc: null, whole: true },
  { re: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g, what: 'a SendGrid email API key', svc: 'SendGrid', live: true },
  { re: /\bsq0csp-[0-9A-Za-z_\-]{40,}/g, what: 'a Square app secret', svc: 'Square', live: true },
  { re: /\bsq0atp-[0-9A-Za-z_\-]{20,}/g, what: 'a Square access token', svc: 'Square', live: true },
  { re: /\bEAAA[A-Za-z0-9_\-]{60,}/g, what: 'a Square access token', svc: 'Square', live: true },
  { re: /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, what: 'a Shopify access token', svc: 'Shopify', live: true },
  { re: /\bhf_[A-Za-z0-9]{30,}\b/g, what: 'a Hugging Face token', svc: 'Hugging Face', live: true },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, what: 'an npm publishing token', svc: 'npm', live: true },
  { re: /\bsbp_[a-f0-9]{40}\b/g, what: 'a Supabase account token', svc: 'Supabase', live: true },
  { re: /\bsb_secret_[A-Za-z0-9_\-]{20,}/g, what: 'a Supabase secret key', svc: 'Supabase', live: true },
  { re: /\b\d{8,10}:AA[0-9A-Za-z_\-]{33}\b/g, what: 'a Telegram bot token', svc: 'Telegram', live: true },
  { re: /\bdop_v1_[a-f0-9]{64}\b/g, what: 'a DigitalOcean token', svc: 'DigitalOcean', live: true },
  { re: /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/g, what: 'an Airtable token', svc: 'Airtable', live: true },
];
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g;
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?)(?:\+\w+)?:\/\/([^:\s\/'"@]+):([^@\s'"]+)@([^\/\s'":?,]+)/g;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|mysql|redis|mongo|database|host\.docker\.internal)$/i;

// Names that hold secrets (after camelCase → snake_case). Public-by-design keys are excluded below.
const SECRET_NAME = /(?:^|[_.-])(api_?key|apikey|secret(?:_?key)?|client_?secret|app_?secret|token|access_?token|refresh_?token|auth_?token|authtoken|bearer_?token|passw(?:or)?d|passwd|pwd|private_?key|secret_?access_?key|signing_?(?:key|secret)|signature_?key|webhook_?secret|encryption_?key|auth(?:orization)?_?key|master_?key|credentials?)$/i;
const PUBLIC_NAME = /(^|_)(public|publishable|anon|site_?key|example|sample|test|dummy|fake|mock|placeholder|default|field|label|header|name|type|url|uri|endpoint|path|file|env|var|prefix|length|len|min|max|regex|pattern|format|expires?|ttl)(_|$)|^(next_public|vite|react_app|expo_public|nuxt_public|gatsby)_/i;
const ENV_LOOKUP = /os\.environ|os\.getenv|getenv\(|process\.env|import\.meta\.env|ENV\[|ENV\.fetch|System\.getenv|Deno\.env|secrets\.|config\(\s*['"]|env\(\s*['"]|\$\{\{/;
const PASSWORD_NAME = /pass|pwd/i;
const CONFIG_LANGS = new Set(['yaml', 'yml', 'ini', 'cfg', 'conf', 'properties', 'env', 'toml']);

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const kindFromName = (name) => {
  const n = snake(name);
  if (/pass|pwd/.test(n)) return 'a password';
  if (/private_?key/.test(n)) return 'a private key';
  if (/token/.test(n)) return 'an access token';
  if (/api_?key|apikey/.test(n)) return 'an API key';
  if (/credential/.test(n)) return 'login credentials';
  return 'a secret key';
};
const mask = (v, password) => password || v.length < 12 ? `${v.length} characters` : `starts “${v.slice(0, 4)}…”, ${v.length} characters`;

function valueLooksReal(v, name) {
  if (/\s/.test(v) || PLACEHOLDER.test(v)) return false;
  if (/^(none|null|nil|undefined|true|false|string|number|text|required|optional|bearer|basic|secret|token|password|test|dev|development|local|admin)$/i.test(v)) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(v)) return false;                 // the NAME of an env var
  if (/^env\([A-Za-z_][\w]*\)$/.test(v)) return false;           // Supabase config.toml reading one: "env(S3_SECRET_KEY)"
  if (/^[a-z_]+(\.[a-z_]+)+$/i.test(v)) return false;            // dotted identifier / key path
  if (/^(\.{0,2}\/|~\/|https?:\/\/|[a-z]:\\)/i.test(v)) return false; // paths and URLs
  if (/\.(json|pem|key|txt|ya?ml|env|crt|p12)$/i.test(v)) return false; // a file name, not the key
  if (/^x-[\w-]+$/i.test(v) || /^(application|text)\//.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false;
  if (/^(pass(word)?|secret|admin|test|user|changeit|letmein|qwerty|demo|guest|root|welcome)[\d!@#$._-]*$/i.test(v)) return false;
  if (PASSWORD_NAME.test(name)) return v.length >= 6 && !/^[a-z]+$/.test(v);
  return v.length >= 16 && entropy(v) >= 3.2 && /\d/.test(v) && /[a-zA-Z]/.test(v);
}

// Tokens that are public by design, because the browser has to send them: Cloudflare Web Analytics'
// beacon (data-cf-beacon='{"token":"…"}') and Mapbox public tokens (pk.…)
const PUBLIC_TOKEN_LINE = /data-cf-beacon|cloudflareinsights\.com/i;
const PUBLIC_TOKEN_VALUE = /^pk\.[\w-]{20,}\.[\w-]{10,}$/;

/** 1-based line numbers inside docstrings or block comments (examples there aren't real config). */
function docLines(src, lang) {
  const set = new Set();
  if (!['python', 'typescript', 'javascript', 'java', 'kotlin', 'go', 'csharp', 'php', 'rust', 'swift'].includes(lang)) return set;
  const re = lang === 'python' ? /("""|''')[\s\S]*?\1/g : /\/\*[\s\S]*?\*\//g;
  const at = lineIndex(src);
  for (const m of src.matchAll(re)) { const a = at(m.index), b = at(m.index + m[0].length); for (let l = a; l <= b; l++) set.add(l); }
  return set;
}

function findSecrets(src, f, out) {
  const at = lineIndex(src);
  const isTest = TEST_FILE.test(f.path) || EXAMPLE_FILE.test(f.path);
  const seenLines = new Set();
  const add = (line, rec) => { if (seenLines.has(line)) return; seenLines.add(line); out.push({ k: 'secret', line, ...rec }); };

  for (const fm of FORMATS) {
    if (fm.skipIf?.test(src)) continue;
    for (const m of src.matchAll(fm.re)) {
      const v = m[0];
      if (isTest && (!fm.live || fm.whole)) continue;
      if (!fm.whole && (/EXAMPLE|xxxx|XXXX|0{10,}/.test(v) || entropy(v) < 3)) continue;
      add(at(m.index), { what: fm.what, svc: fm.svc, sev: fm.sev || 'high', hint: fm.whole ? 'private key block' : mask(v) });
    }
  }
  if (!isTest) {
    for (const m of src.matchAll(JWT)) {
      let payload = null;
      try { payload = JSON.parse(Buffer.from(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { continue; }
      if (payload?.role !== 'service_role') continue; // "anon" keys are public by design
      add(at(m.index), { what: 'a Supabase service-role key (full access to your database, skipping all security rules)', svc: 'Supabase', sev: 'high', hint: mask(m[0]) });
    }
    for (const m of src.matchAll(DB_URL)) {
      const [, user, pw, host] = m;
      if (LOCAL_HOST.test(host) || PLACEHOLDER.test(pw) || /^[:$%{<]/.test(pw) || pw.length < 4 || /^(password|pass|postgres|root|secret|admin|user)$/i.test(pw)) continue;
      add(at(m.index), { what: 'a database password inside a connection address', svc: 'your database', sev: 'high', hint: mask(pw, true) });
    }
  }
  if (isTest || f.category === 'docs') return;

  // Assignments: api_key = "…", "password": "…", PASSWORD=… (config files may leave values unquoted).
  const lines = src.split('\n');
  const inDoc = docLines(src, f.lang);
  // CI / docker-compose database containers get throwaway passwords
  const throwawayDb = /(^|\/)\.github\/|(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i.test(f.path);
  const quoted = /(["']?)([A-Za-z_][\w.-]*)\1\s*(?::=|=>|=|:)\s*(?:[rbuRBU]{1,2})?(["'`])([^"'`\n]{6,200})\3/g;
  const unquoted = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s#'"]{6,200})\s*(?:#.*)?$/;
  lines.forEach((text, i) => {
    if (text.length > 400 || ENV_LOOKUP.test(text) || PUBLIC_TOKEN_LINE.test(text) || inDoc.has(i + 1) || /^\s*(#|\/\/|\*|\/\*|<!--)/.test(text)) return;
    const pairs = [...text.matchAll(quoted)].map((m) => [m[2], m[4]]);
    if (!pairs.length && (f.category === 'config' && CONFIG_LANGS.has(f.lang))) { const u = unquoted.exec(text); if (u) pairs.push([u[1], u[2]]); }
    for (const [name, value] of pairs) {
      const n = snake(name.split('.').pop());
      if (!SECRET_NAME.test(n) || PUBLIC_NAME.test(n) || PUBLIC_TOKEN_VALUE.test(value) || !valueLooksReal(value, n)) continue;
      if (throwawayDb && /^(postgres|mysql|mariadb|mongo(_initdb_root)?|redis|pg|rabbitmq_default|db|database)_(root_)?(password|pass|pwd)$/.test(n)) continue;
      add(i + 1, { what: kindFromName(name), name: name.split('.').pop(), sev: 'high', hint: mask(value, PASSWORD_NAME.test(n)), generic: true });
    }
  });
}

// ---------- 2. who may call each endpoint ----------

// Decorators / middleware / dependencies whose names say "check who is calling".
const GUARD_NAME = /(^|_)(login|auth|authenticated|authorized?|jwt|token|permission|permissions|perm|role|roles|staff|admin|superuser|owner|scope|scopes|session|api_?key|signature|signed|hmac|device|member|user)(_|$)|_required$|^requires?_|^ensure_|^verify_|^check_(auth|token|user|session|permission|role|api)|protect|^is_?authenticated|^is_?admin/i;
const NOT_GUARD = /^(route|get|post|put|patch|delete|cached?|limit|limiter|rate_?limit\w*|cross_origin|wraps|staticmethod|classmethod|property|retry|timed|log\w*|swag_from|validate\w*|expects|marshal\w*|doc|json_required|fields?_required|params?_required|body_required|transaction\w*|csrf\w*|exempt)$/i;
const isGuardName = (name) => !!name && !NOT_GUARD.test(name) && GUARD_NAME.test(snake(name));
// FastAPI dependencies that hand over a database session rather than check the caller
// (SessionDep, get_db, get_sql_session, SessionLocal, a unit of work), matched on the snake_case name
const DB_DEPENDENCY = /^(get_|new_|create_)?(async_)?(db|database|session|db_session|sessionmaker)$|(^|_)(db|database|sql\w*|engine|conn|connection|cursor|uow|unit_of_work)(_|$)|session_?(local|maker|factory)/i;
const isDbDep = (name) => DB_DEPENDENCY.test(snake(name));
const isGuardDep = (name) => isGuardName(name) && !isDbDep(name);
// A handler body that inspects the caller itself.
const INLINE_CHECK = /request\.headers(?:\.get)?\(?\s*\[?\s*['"](authorization|x-api-key|x-[\w-]*(token|key|secret|signature)[\w-]*)['"]|req\.headers(?:\.|\[\s*['"])(authorization|x-api-key)|\b(verify|check|require|validate|authenticate|authorize)_?\w*(auth|token|session|user|key|signature|webhook|hmac|jwt|device|staff|admin|permission|role|request|caller)\w*\s*\(|\bcurrent_user\b|get_jwt_identity|verify_jwt_in_request|compare_digest|abort\(\s*40[13]\b|,\s*40[13]\s*\)?\s*$|status(?:Code)?\s*[:=(]\s*40[13]\b|\.status\(\s*40[13]\s*\)|req\.user\b|req\.session\.user|req\.auth\b|jwt\.verify|jwtVerify|getServerSession|auth\(\)|currentUser\(|getAuth\(|auth\.getUser|getSession\(|verifyIdToken|getToken\(/m;
const FIREBASE_CHECK = /\b\w+\.auth\b(?!\s*\()|HttpsError\(\s*["'](unauthenticated|permission-denied)["']|enforceAppCheck\s*:\s*true|\b\w+\.app\b\s*(==|!=|===|!==)\s*(undefined|null)|!\s*\w+\.app\b/;
const SIGNATURE_CHECK =/hmac|signature|verify_?webhook|construct_?event|x-hub-signature|compare_digest|svix|webhooks?\.verify|jwt\.decode|oidc|id_token|authenticated|verify_\w*(token|request|push)/i;
const NEXT_GUARD = /getServerSession|\bauth\(\)|currentUser\(|getAuth\(|auth\.getUser|supabase\.auth\.get(User|Session)|getSession\(|verifyIdToken|jwt\.verify|jwtVerify|getToken\(|clerkClient|requireAuth|requireUser|withAuth|validateRequest|headers\(\)\.get\(\s*['"]authorization|status:\s*40[13]\b/;
const NEXT_MIDDLEWARE_GUARD = /getToken|withAuth|clerkMiddleware|authMiddleware|auth\(|supabase|getSession|jwtVerify|jwt\.verify|cookies\.get\([^)]*(session|token|auth)|redirect\([^)]*login/i;

function blockAfter(lines, defIdx) {
  // A Python def's body: every line after it that's more indented, up to 120 lines.
  const ind = /^\s*/.exec(lines[defIdx])[0].length;
  let end = defIdx + 1;
  while (end < lines.length && end < defIdx + 120 && (!lines[end].trim() || /^\s*/.exec(lines[end])[0].length > ind || /^\s*[)\]]/.test(lines[end]))) end++;
  return lines.slice(defIdx, end).join('\n');
}

function pyRoutes(src, f, out) {
  const lines = src.split('\n');
  // Blueprint / app-wide before_request hooks and router-level dependencies that check the caller.
  const guardedVars = new Map();
  for (const m of src.matchAll(/^@(\w+)\.before_(?:app_)?request\s*\n(?:@.*\n)*\s*def\s+(\w+)/gm)) {
    const defIdx = src.slice(0, m.index + m[0].length).split('\n').length - 1;
    const body = blockAfter(lines, defIdx);
    if (!/\b40[13]\b|Unauthorized|Forbidden|verify_jwt_in_request|login_required|is_authenticated|current_user/.test(body)) continue;
    guardedVars.set(m[1], m[2]);
    if (m[1] === 'app') out.push({ k: 'global-guard', framework: 'flask', name: m[2], line: defIdx + 1 });
  }
  for (const m of src.matchAll(/^\s*(\w+)\s*=\s*(?:\w+\.)?APIRouter\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gm)) {
    const dep = /dependencies\s*=\s*\[[^\]]*Depends\(\s*([\w.]+)/.exec(m[2]);
    if (dep && isGuardDep(dep[1].split('.').pop())) guardedVars.set(m[1], dep[1]);
  }
  // FastAPI dependency aliases, `AdminUser = Annotated[Session, Depends(admin_user)]`, and the dependency
  // functions behind them. They're usually imported from a shared deps.py, so build decides repo-wide
  // which ones check the caller (see pyAliasGuards).
  const lineAt = (i) => src.slice(0, i).split('\n').length - 1;
  const sigAt = (idx) => lines.slice(idx, idx + 15).join('\n').split(/\)\s*(->[^:]*)?:\s*$/m)[0];
  const depsIn = (text) => [...text.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/g)].map((m) => m[1].split('.').pop());
  const typesIn = (sig) => [...new Set([...sig.matchAll(/\b\w+\s*:\s*(?:[\w.]*Annotated\[\s*)?([A-Za-z_][\w.]*)/g)].map((m) => m[1].split('.').pop()))];
  if (/\b(Depends|Security)\(/.test(src)) {
    for (const m of src.matchAll(/^(?:type\s+)?(\w+)\s*(?::[^=\n]*)?=\s*(?:[\w.]+\.)?Annotated\[/gm)) {
      let depth = 1, j = m.index + m[0].length;
      while (j < src.length && depth && j - m.index < 800) { if (src[j] === '[') depth++; else if (src[j] === ']') depth--; j++; }
      const fn = depsIn(src.slice(m.index, j))[0];
      if (fn) out.push({ k: 'py-alias', name: m[1], fn, line: lineAt(m.index) + 1 });
    }
    // top-level functions that aren't routes, with the dependencies and types they take
    for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
      const idx = lineAt(m.index);
      if (idx > 0 && /^\s*@/.test(lines[idx - 1])) continue;
      const sig = sigAt(idx), deps = depsIn(sig), types = typesIn(sig);
      if (deps.length || types.length) out.push({ k: 'py-dep-fn', name: m[1], ...(deps.length ? { deps } : {}), ...(types.length ? { types } : {}) });
    }
  }
  // Decorators defined here: auth-named ones, and project wrappers like `@endpoint(write=True)` whose
  // body applies an auth decorator itself. Repeat once so a wrapper of a wrapper counts too.
  const localGuards = new Set();
  const defs = [...src.matchAll(/^def\s+(\w+)\s*\(/gm)].map((m) => { const idx = src.slice(0, m.index).split('\n').length - 1; return { name: m[1], line: idx + 1, body: blockAfter(lines, idx) }; });
  const decoratorish = (body) => /wraps|decorat|def\s+\w+\(\s*\*args|return\s+\w+\s*$/m.test(body);
  for (let pass = 0; pass < 2; pass++) for (const d of defs) {
    if (localGuards.has(d.name) || !decoratorish(d.body)) continue;
    const applied = [...d.body.matchAll(/^\s*@([\w.]+)/gm)].map((m) => m[1].split('.').pop());
    const wraps = applied.some((a) => isGuardName(a) || localGuards.has(a));
    if (isGuardName(d.name) || wraps) { localGuards.add(d.name); out.push({ k: 'guard-def', name: d.name, line: d.line, ...(wraps && !isGuardName(d.name) ? { wrapper: true } : {}) }); }
  }

  for (const r of f.routes || []) {
    if (r.framework === 'django') continue;
    const i0 = r.line - 1;
    // decorators above the route decorator (wrong place in Flask/FastAPI: the route registers the unwrapped function)
    const above = [];
    for (let i = i0 - 1; i >= 0 && /^\s*@/.test(lines[i]); i--) above.push(/^\s*@([\w.]+)/.exec(lines[i])[1].split('.').pop());
    // decorators below it, up to the def
    const below = [];
    let defIdx = -1;
    for (let i = i0 + 1; i < lines.length && i < i0 + 30; i++) {
      if (/^\s*(async\s+)?def\s/.test(lines[i])) { defIdx = i; break; }
      const d = /^\s*@([\w.]+)/.exec(lines[i]);
      if (d) below.push(d[1].split('.').pop());
    }
    const decoText = lines.slice(i0, defIdx > 0 ? defIdx : i0 + 1).join('\n');
    const sig = defIdx > 0 ? lines.slice(defIdx, defIdx + 15).join('\n').split(/\)\s*(->[^:]*)?:\s*$/m)[0] : '';
    const body = defIdx > 0 ? blockAfter(lines, defIdx) : '';
    const rec = { k: 'route', line: r.line, method: r.method };
    const deco = below.find((d) => (isGuardName(d) || localGuards.has(d)) && !/^(route|get|post|put|patch|delete)$/.test(d));
    const dep = /Depends\(\s*([\w.]+)|Security\(\s*([\w.]+)/g;
    const deps = [...(decoText + '\n' + sig).matchAll(dep)].map((m) => (m[1] || m[2]).split('.').pop());
    if (deco) Object.assign(rec, { guard: deco, via: 'decorator' });
    else if (guardedVars.has(r.var)) Object.assign(rec, { guard: guardedVars.get(r.var), via: 'blueprint' });
    else if (deps.some(isGuardDep)) Object.assign(rec, { guard: deps.find(isGuardDep), via: 'dependency' });
    else if (INLINE_CHECK.test(body)) Object.assign(rec, { via: 'inline' });
    else {
      const misplaced = above.find((d) => isGuardName(d) && !/^(route|get|post|put|patch|delete)$/.test(d));
      if (misplaced) rec.misplaced = misplaced;
      // other decorators may be auth wrappers defined in another file; build resolves them
      const other = below.filter((d) => !/^(route|get|post|put|patch|delete|api_route|websocket)$/.test(d));
      if (other.length) rec.decos = other;
      // so may parameter types: `user: AdminUser`, a dependency alias (pyAliasGuards)
      const types = typesIn(sig);
      if (types.length) rec.types = types;
    }
    if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    if (defIdx > 0) rec.fn = /def\s+(\w+)/.exec(lines[defIdx])[1];
    out.push(rec);
  }
}

function jsRoutes(src, f, out) {
  const routes = f.routes || [];
  if (!routes.length && !/\.use\(/.test(src) && !/(^|\/)middleware\.(t|j)s$/.test(f.path)) return;
  const lines = src.split('\n');
  // Next.js middleware.ts protecting the app
  if (/(^|\/)(src\/)?middleware\.(t|j)s$/.test(f.path) && NEXT_MIDDLEWARE_GUARD.test(src)) {
    const matcher = /matcher\s*:\s*([^\n]+)/.exec(src)?.[1] || '';
    if (!matcher || /api|\(\?!/.test(matcher)) out.push({ k: 'global-guard', framework: 'next', line: 1 });
  }
  // app.use(auth) / router.use(requireAuth) without a path guards everything registered after it
  const uses = [];
  for (const m of src.matchAll(/\b(\w+)\.use\(\s*([^'"`)][^)]*)\)/g)) {
    const names = m[2].match(/[A-Za-z_$][\w$]*/g) || [];
    if (names.some(isGuardName)) uses.push({ v: m[1], line: src.slice(0, m.index).split('\n').length, name: names.find(isGuardName) });
  }
  for (const u of uses) if (u.v === 'app' || u.v === 'server') out.push({ k: 'global-guard', framework: 'express', name: u.name, line: u.line });

  routes.forEach((r, idx) => {
    const rec = { k: 'route', line: r.line, method: r.method };
    if (r.framework === 'firebase') {
      // a callable checks request.auth (v1: context.auth) or turns on App Check; an onRequest function
      // checks a token or signature itself, like any other handler
      const next = routes.slice(idx + 1).find((x) => x.line > r.line)?.line || r.line + 80;
      const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 80)).join('\n');
      if (FIREBASE_CHECK.test(body) || INLINE_CHECK.test(body)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(body)) rec.signed = true;
      rec.fn = r.handler;
      out.push(rec);
      return;
    }
    if (r.framework === 'next') {
      if (NEXT_GUARD.test(src)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(src)) rec.signed = true;
      rec.fn = r.method;
      out.push(rec);
      return;
    }
    // the route call's own arguments: router.post('/x', requireAuth, async (req, res) => …)
    const head = lines.slice(r.line - 1, r.line + 4).join('\n');
    const args = (/\.\w+\(\s*["'`][^"'`]*["'`]\s*,([\s\S]*?)(?:async\s*)?(?:\(\s*req\b|function\b|\breq\s*=>|\(\s*\{|\(\s*c\s*\)|\(\s*ctx\b)/.exec(head)?.[1] || '');
    const mw = (args.match(/[A-Za-z_$][\w$.]*/g) || []).map((x) => x.split('.').pop()).find(isGuardName);
    const next = routes[idx + 1]?.line || r.line + 60;
    const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 60)).join('\n');
    const prior = uses.find((u) => u.v === r.var && u.line < r.line);
    if (mw) Object.assign(rec, { guard: mw, via: 'middleware' });
    else if (prior) Object.assign(rec, { guard: prior.name, via: 'router' });
    else if (INLINE_CHECK.test(body)) rec.via = 'inline';
    if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    out.push(rec);
  });
}

/**
 * FastAPI dependency aliases that check the caller, per repo: Map(repo -> Map(alias -> file)).
 * An alias checks the caller when its dependency function does: by its name (admin_user), by taking a
 * checking dependency (Depends(require_login)), or by taking a checking alias itself, e.g.
 * `AdminOffice = Annotated[Office, Depends(admin_owned_office)]` where admin_owned_office takes `admin: AdminUser`.
 * An alias whose own name reads as a check counts too (`AdminAccess = Annotated[dict, Depends(check)]`),
 * unless either name says it's a database session (`SqlSessionDep` over `get_sql_session`).
 */
function pyAliasGuards(files, findings) {
  const byRepo = new Map(); // repo -> { aliases: Map(name -> {fn, file}), fns: Map(name -> {deps, types}) }
  for (const f of files) for (const x of findings(f.path)) {
    if (x.k !== 'py-alias' && x.k !== 'py-dep-fn') continue;
    const k = f.repo ?? '';
    if (!byRepo.has(k)) byRepo.set(k, { aliases: new Map(), fns: new Map() });
    const r = byRepo.get(k);
    if (x.k === 'py-alias') r.aliases.set(x.name, { fn: x.fn, file: f.path });
    else r.fns.set(x.name, { deps: x.deps || [], types: x.types || [] });
  }
  const out = new Map();
  for (const [repo, { aliases, fns }] of byRepo) {
    const ok = new Map();
    const checks = (fn) => isGuardDep(fn) || (!isDbDep(fn) && !!fns.get(fn) && (fns.get(fn).deps.some(isGuardDep) || fns.get(fn).types.some((t) => ok.has(t))));
    const aliasChecks = (name, fn) => checks(fn) || (isGuardDep(name) && !isDbDep(fn));
    // a few passes, so aliases built on other aliases resolve in any file order
    for (let pass = 0; pass < 3; pass++) for (const [name, a] of aliases) if (!ok.has(name) && aliasChecks(name, a.fn)) ok.set(name, a.file);
    if (ok.size) out.set(repo, ok);
  }
  return out;
}

// ---------- 3. the usual mistakes in apps built on Supabase, Firebase, Stripe, Next.js and Vite ----------

// Frontend build tools copy variables with these prefixes into the code every visitor downloads.
// (A bare PUBLIC_ prefix only means that to SvelteKit and Astro, so it counts only where they read it.)
const PUBLIC_PREFIX = /^(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|PUBLIC)_/;
const CLIENT_ONLY_PREFIX = /^(VITE|REACT_APP|EXPO_PUBLIC|GATSBY|PUBLIC)_/; // these exist only in browser code
// After the prefix: names that hold something private…
const PRIVATE_NAME = /(^|_)(SECRETS?|SERVICE_ROLE|SERVICE_KEY|PRIVATE|PASSWORD|PASSWD|PWD|DATABASE_URL|DB_URL|CONNECTION_STRING|ADMIN_KEY|ADMIN_TOKEN|AUTH_TOKEN|JWT_SECRET)(_|$)/;
// …or a key or token for a service that charges you or acts as you (AI, email, messaging, code hosting)
const PRIVATE_SERVICE = /(^|_)(OPENAI|ANTHROPIC|CLAUDE|GEMINI|GROQ|GROK|XAI|MISTRAL|REPLICATE|ELEVEN_?LABS|SENDGRID|RESEND|POSTMARK|MAILGUN|BREVO|TWILIO|OPENROUTER|DEEPSEEK|PERPLEXITY|COHERE|TOGETHER|FIREWORKS|HUGGING_?FACE|HF|STABILITY|FAL|ASSEMBLY_?AI|DEEPGRAM|PINECONE|SERPAPI|TAVILY|FIRECRAWL|AIRTABLE|NOTION|GITHUB|SLACK|DISCORD|TELEGRAM|STRIPE)(_|$)/;
const KEYISH = /(^|_)(KEY|API_?KEY|TOKEN|SECRET)$/;
// Keys that are public by design: Supabase's anon key, Stripe's publishable key, reCAPTCHA site keys, IDs
const PUBLIC_BY_DESIGN = /(^|_)(PUBLISHABLE|ANON|PK|PUBLIC|SITE|CLIENT_ID|APP_ID|PROJECT_ID|MEASUREMENT_ID)(_|$)/;
const SERVICE_LABEL = { OPENAI: 'OpenAI', ANTHROPIC: 'Anthropic', CLAUDE: 'Anthropic', GEMINI: 'Google Gemini', GROQ: 'Groq', GROK: 'xAI', XAI: 'xAI', ELEVENLABS: 'ElevenLabs', ELEVEN_LABS: 'ElevenLabs', SENDGRID: 'SendGrid', OPENROUTER: 'OpenRouter', DEEPSEEK: 'DeepSeek', HF: 'Hugging Face', HUGGINGFACE: 'Hugging Face', HUGGING_FACE: 'Hugging Face', ASSEMBLYAI: 'AssemblyAI', ASSEMBLY_AI: 'AssemblyAI', SERPAPI: 'SerpApi', GITHUB: 'GitHub' };

/** For a variable like VITE_OPENAI_API_KEY: the service it unlocks ('OpenAI', or '' for a generic secret), or null when it's fine to be public. */
export function leakyPublicVar(name) {
  const m = PUBLIC_PREFIX.exec(name);
  if (!m) return null;
  const rest = name.slice(m[0].length);
  if (PUBLIC_BY_DESIGN.test(rest)) return null;
  const svc = PRIVATE_SERVICE.exec(rest)?.[2];
  if (svc && KEYISH.test(rest)) return SERVICE_LABEL[svc] || svc.charAt(0) + svc.slice(1).toLowerCase();
  if (PRIVATE_NAME.test(rest)) return /SERVICE_ROLE|SERVICE_KEY/.test(rest) ? 'Supabase' : '';
  return null;
}

function findPublicEnv(src, f, out) {
  const at = lineIndex(src);
  const seen = new Set();
  const add = (name, idx) => { if (leakyPublicVar(name) === null || seen.has(name)) return; seen.add(name); out.push({ k: 'public-env', name, line: at(idx) }); };
  for (const m of src.matchAll(/\b(process\.env\.|process\.env\[\s*['"]|import\.meta\.env\.)([A-Z][A-Z0-9_]*)/g)) {
    if (/^PUBLIC_/.test(m[2]) && m[1].startsWith('process')) continue; // PUBLIC_ means nothing to Node
    add(m[2], m.index);
  }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\$env\/(?:static|dynamic)\/public['"]/g)) for (const n of m[1].match(/[A-Z][A-Z0-9_]*/g) || []) add(n, m.index);
}

// Stripe: code that acts on payment events. Without checking Stripe's signature first, anyone can send
// a fake "payment succeeded" event to the webhook address.
const STRIPE_EVENT = /(?:\bcase\s*|[!=]==?\s*)["'](checkout\.session\.(?:completed|async_payment_succeeded)|payment_intent\.succeeded|invoice\.(?:paid|payment_succeeded|payment_failed)|customer\.subscription\.(?:created|updated|deleted)|charge\.(?:succeeded|refunded))["']/g;
const STRIPE_VERIFIED = /constructEvent(?:Async)?\s*\(|construct_event\s*\(|verifyHeader|verify_header|events\.retrieve\s*\(|Event\.retrieve\s*\(/;

function findStripeWebhook(src, f, out) {
  if (!/stripe/i.test(src) || STRIPE_VERIFIED.test(src)) return;
  const hits = [...src.matchAll(STRIPE_EVENT)];
  if (!hits.length) return;
  out.push({ k: 'stripe-unsigned', line: lineIndex(src)(hits[0].index), events: [...new Set(hits.map((m) => m[1]))].slice(0, 4) });
}

// CORS: a server that tells browsers any website may call it. Harmless for a public API without login
// cookies; with them, any site a signed-in visitor opens could act as them.
function findCors(src, f, out) {
  const at = lineIndex(src);
  const add = (idx, how, credentials) => out.push({ k: 'cors-any', line: at(idx), how, credentials });
  if (['typescript', 'javascript'].includes(f.lang)) {
    if (/require\(\s*['"]cors['"]\s*\)|from\s+['"]cors['"]/.test(src)) {
      for (const m of src.matchAll(/\bcors\(\s*\)/g)) add(m.index, 'cors()', false);
      for (const m of src.matchAll(/\bcors\(\s*\{([^}]*)\}/g)) {
        const origin = /\borigin\s*:\s*(?:(['"`])\*\1|(true)\b)/.exec(m[1]);
        // '*' with credentials is refused by browsers; origin: true echoes whichever site asks
        if (origin) add(m.index, origin[2] ? 'cors({ origin: true })' : "cors({ origin: '*' })", !!origin[2] && /\bcredentials\s*:\s*true/.test(m[1]));
      }
    }
    const credHeader = /['"]Access-Control-Allow-Credentials['"]\s*[,:]\s*['"`]?true/i.test(src);
    for (const m of src.matchAll(/['"]Access-Control-Allow-Origin['"]\s*[,:]\s*(?:(['"`])\*\1|(req(?:uest)?\.headers(?:\.origin\b|\[\s*['"]origin['"]\s*\]|\.get\(\s*['"]origin['"]\s*\))))/gi)) {
      add(m.index, m[2] ? 'Access-Control-Allow-Origin set to the caller’s origin' : 'Access-Control-Allow-Origin: *', !!m[2] && credHeader);
    }
  } else if (f.lang === 'python') {
    for (const m of src.matchAll(/CORSMiddleware\s*,([\s\S]{0,800}?)\)\s*$/gm)) {
      if (/allow_origins\s*=\s*\[\s*(['"])\*\1\s*\]|allow_origin_regex\s*=\s*r?(['"])\.\*\2/.test(m[1])) add(m.index, 'CORSMiddleware with allow_origins=["*"]', /allow_credentials\s*=\s*True/.test(m[1]));
    }
    for (const m of src.matchAll(/\bCORS\(\s*\w+\s*(?:\)|,([^)]*)\))/g)) {
      const opts = m[1] || '';
      if (/\borigins["']?\s*[:=]\s*(?!(['"])\*\1)/.test(opts)) continue; // a list of allowed sites (origins=… or "origins": …)
      add(m.index, 'CORS(app) with every origin allowed', /supports_credentials\s*=\s*True/.test(opts));
    }
    const all = /^\s*CORS_(?:ALLOW_ALL_ORIGINS|ORIGIN_ALLOW_ALL)\s*=\s*True\b/m.exec(src);
    if (all) add(all.index, 'CORS_ALLOW_ALL_ORIGINS = True', /^\s*CORS_ALLOW_CREDENTIALS\s*=\s*True\b/m.test(src));
  }
}

// Supabase / Postgres migrations: tables, row-level security switched on or off, tables dropped or
// renamed, and security rules that let anyone change a table. build.mjs replays them in file order.
const SQL_ID = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const SQL_NAME = String.raw`(?:${SQL_ID}\s*\.\s*)?${SQL_ID}`;
const sqlName = (raw) => {
  const parts = raw.split(/\s*\.\s*(?=(?:"[^"]*"|[^"])*$)/).map((p) => p.trim().replace(/^"|"$/g, '').toLowerCase());
  return parts.length > 1 ? `${parts[0]}.${parts[1]}` : `public.${parts[0]}`;
};

function findSql(src, f, out) {
  // blank out comments, keeping line breaks so line numbers stay right
  const s = src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const at = lineIndex(s);
  const found = [];
  for (const m of s.matchAll(new RegExp(String.raw`\bcreate\s+(?:(temp|temporary)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${SQL_NAME})`, 'gi'))) {
    if (!m[1]) found.push({ i: m.index, k: 'sql-table', table: sqlName(m[2]) });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${SQL_NAME})\s+(enable|disable|force|no\s+force)\s+row\s+level\s+security`, 'gi'))) {
    found.push({ i: m.index, k: 'sql-rls', table: sqlName(m[1]), on: !/^(disable|no)/i.test(m[2]) });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${SQL_NAME})\s+rename\s+to\s+(${SQL_ID})`, 'gi'))) {
    const from = sqlName(m[1]);
    found.push({ i: m.index, k: 'sql-rename', table: from, to: `${from.split('.')[0]}.${m[2].replace(/^"|"$/g, '').toLowerCase()}` });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(${SQL_NAME}(?:\s*,\s*${SQL_NAME})*)`, 'gi'))) {
    for (const t of m[1].split(/\s*,\s*/)) found.push({ i: m.index, k: 'sql-drop', table: sqlName(t) });
  }
  // a permissive rule that lets signed-out visitors add, change or delete rows: `using (true)` / `with check (true)`
  for (const m of s.matchAll(new RegExp(String.raw`\bcreate\s+policy\s+(${SQL_ID})\s+on\s+(${SQL_NAME})([^;]*)`, 'gi'))) {
    const body = m[3];
    if (/\bas\s+restrictive\b/i.test(body)) continue;
    const cmd = (/\bfor\s+(all|select|insert|update|delete)\b/i.exec(body)?.[1] || 'all').toLowerCase();
    if (cmd === 'select') continue;
    const to = /\bto\s+([\w\s,"]+?)(?=\s+(?:using|with)\b|\s*$)/i.exec(body)?.[1];
    const roles = to ? to.split(/\s*,\s*/).map((r) => r.replace(/"/g, '').trim().toLowerCase()) : ['public'];
    if (!roles.some((r) => r === 'anon' || r === 'public')) continue;
    const yes = (clause) => new RegExp(String.raw`\b${clause}\s*\(\s*\(?\s*true\s*\)?\s*\)`, 'i').test(body);
    const open = cmd === 'insert' ? yes('with\\s+check') : cmd === 'all' ? yes('using') || yes('with\\s+check') : yes('using');
    if (open) found.push({ i: m.index, k: 'sql-open-policy', table: sqlName(m[2]), policy: m[1].replace(/^"|"$/g, ''), cmd, signedOut: roles.includes('anon') || !to });
  }
  for (const x of found.sort((a, b) => a.i - b.i)) { const { i, ...rest } = x; out.push({ ...rest, line: at(i) }); }
}

const USES_SUPABASE = /@supabase\/(?:supabase-js|ssr|auth-helpers[\w-]*)|from\s+supabase\s+import|^\s*import\s+supabase\b/m;

// ---------- per-file entry point ----------

export function findIssues(src, f) {
  const out = [];
  findSecrets(src, f, out);
  if (f.category !== 'code') return out;
  if (f.lang === 'sql') findSql(src, f, out);
  if (!TEST_FILE.test(f.path) && !EXAMPLE_FILE.test(f.path)) {
    if (['typescript', 'javascript', 'vue', 'svelte', 'astro'].includes(f.lang)) findPublicEnv(src, f, out);
    if (['typescript', 'javascript', 'python'].includes(f.lang)) { findStripeWebhook(src, f, out); findCors(src, f, out); }
  }
  if (['typescript', 'javascript', 'python'].includes(f.lang) && USES_SUPABASE.test(src)) out.push({ k: 'uses-supabase' });
  if (f.lang === 'python') pyRoutes(src, f, out);
  else if (['typescript', 'javascript'].includes(f.lang)) jsRoutes(src, f, out);
  // run directly or registered by name (so "nothing imports it" doesn't mean unused)
  if (/^#!|if\s+__name__\s*==\s*['"]__main__['"]|@(?:\w+\.)*(?:task|shared_task|command|group|receiver|scheduled_job|on_event|listener|hookimpl|periodic_task|cli\.command)\b|require\.main\s*===\s*module|import\.meta\.main/m.test(src)) out.push({ k: 'runnable' });
  // a frontend calling a fixed localhost address (breaks once deployed)
  // (only in files with no environment / hostname switching, where it can't be a dev-only fallback)
  if (['typescript', 'javascript', 'vue', 'svelte'].includes(f.lang) && !TEST_FILE.test(f.path) && !/process\.env|import\.meta\.env|NODE_ENV|location\.(hostname|host|origin)|isDev|__DEV__/.test(src)) {
    src.split('\n').forEach((t, i) => {
      if (/["'`]https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(t) && !/\?\?|\|\||local|dev|fallback|default|^\s*(\/\/|\*)/i.test(t.replace(/https?:\/\/(localhost|127\.0\.0\.1)/g, ''))) out.push({ k: 'localhost', line: i + 1 });
    });
  }
  return out;
}

// ======================= build: turn findings into issues =======================

const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const PUBLIC_PATH = /(^|\/)(health|healthz|healthcheck|ping|status|ready|readiness|live|liveness|version|metrics|robots\.txt|sitemap[\w.]*|favicon[\w.]*|\.well-known|login|logout|signin|pair|sign-in|signout|signup|sign-up|register|forgot[\w-]*|reset[\w-]*|verify[\w-]*|oauth\w*|callback|auth|token|refresh|static|assets|public|newsletter|contact|waitlist|unsubscribe|openapi\.json|docs|swagger[\w.]*|i|images?)(\/|$)/i;
const WEBHOOK_PATH = /webhook|\/hooks?\//i;
// endpoints under a webhook URL that manage the webhooks (create, list, test…) rather than receive them
const WEBHOOK_ADMIN = /\/(manage|admin|setup|settings|config|list|create|register|delete|test[\w-]*)(\/|$)/i;
const NOT_USED_KINDS = new Set(['test', 'script', 'infra', 'config', 'worker', 'external']);
const SPECIAL_FILE = /(^|\/)(index|main|app|server|cli|manage|wsgi|asgi|__init__|__main__|conftest|setup|config|settings|env|middleware|instrumentation|layout|page|route|loading|error|not-found|template|default|global-error|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon|_app|_document|_error|404|500|models|admin|apps|views|urls|signals|tasks|forms|serializers|celery|gunicorn\.conf|vite-env\.d|worker|sw|service-worker)\.[a-z]+$|\.d\.ts$|\.config\.[a-z]+$|\.stories\.|(^|\/)(pages|migrations|alembic|versions|scripts|bin|tools|seeds?|fixtures?|examples?|docs?|public|static|templates|\.github|e2e|cypress|playwright)\//i;
const USED_LANGS = new Set(['typescript', 'javascript', 'python', 'vue', 'svelte', 'astro']);
const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + 's'}`;

export function buildHealth({ graph, scan, arch, root, layers }) {
  const issues = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const fileByPath = new Map(graph.files.map((f) => [f.p, f]));
  const scanByPath = new Map(scan.files.map((f) => [f.path, f]));
  const lineage = (id) => { const out = []; let n = nodeById.get(id); while (n) { out.push(n); n = n.parent ? nodeById.get(n.parent) : null; } return out; };
  const kinds = (id) => lineage(id).map((n) => n.kind);
  const isFrontend = (p) => { const f = fileByPath.get(p); return !!f && kinds(f.n).includes('ui'); };
  const nameOf = (p) => fileByPath.get(p)?.name || p.split('/').pop();
  const label = (id) => nodeById.get(id)?.label || id;
  // Files outside the map (config, .env, Firebase rules) point at the module that owns their folder, or
  // failing that the most specific part of the map whose paths name them.
  const archGlobs = (arch?.nodes || []).filter((n) => n?.id && nodeById.has(n.id) && Array.isArray(n.paths)).flatMap((n) => n.paths.map((p) => ({ id: n.id, g: compileGlob(p) })));
  const globOwner = (p) => archGlobs.filter((x) => x.g.test(p)).sort((a, b) => b.g.specificity - a.g.specificity)[0]?.id;
  const dirOwner = new Map();
  for (const f of graph.files) { let d = f.p; while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); if (!dirOwner.has(d)) dirOwner.set(d, new Map()); const m = dirOwner.get(d); m.set(f.n, (m.get(f.n) || 0) + 1); } }
  const itemFor = (p) => {
    if (fileByPath.has(p)) return 'f:' + p;
    let d = p;
    while (d.includes('/')) {
      d = d.slice(0, d.lastIndexOf('/'));
      const m = dirOwner.get(d);
      const top = m && [...m.entries()].filter(([n]) => n !== 'unassigned').sort((a, b) => b[1] - a[1])[0];
      if (top) return 'n:' + top[0];
    }
    const owner = globOwner(p);
    return owner ? 'n:' + owner : null;
  };
  const findings = (p) => scanByPath.get(p)?.issues || [];

  // ---------- secrets in code and config ----------
  const secretFiles = [];
  for (const f of scan.files) {
    const s = findings(f.path).filter((x) => x.k === 'secret');
    if (s.length) secretFiles.push({ path: f.path, list: s });
  }
  // credential files (service-account JSON, .pem keys) that the scanner doesn't read as config
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (TEST_FILE.test(f.path) || EXAMPLE_FILE.test(f.path) || /\.pub$/.test(base)) continue;
    if (!/\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)$|service[-_]?account.*\.json$|^credentials?\.json$|firebase-adminsdk.*\.json$|^client_secret.*\.json$|-key\.json$/i.test(base)) continue;
    let head = '';
    try { head = readHead(path.join(root, f.path), 65536); } catch { continue; }
    if (/PRIVATE KEY|"private_key"\s*:\s*"-----|"client_secret"\s*:\s*"[^"]{8,}/.test(head) || /\.(p12|pfx|jks|keystore)$/i.test(base)) secretFiles.push({ path: f.path, list: [{ k: 'secret', line: 1, what: 'a credentials file (a private key that logs in as your app)', sev: 'high', hint: 'whole file' }], file: true });
  }
  const secretIssue = (group) => {
    const locations = [], notes = {}, items = [];
    const kinds = new Set(), svcs = new Set();
    let frontend = false;
    for (const { path: p, list, file } of group) {
      list.sort((a, b) => a.line - b.line);
      const it = itemFor(p);
      if (it && !items.includes(it)) items.push(it);
      for (const s of list) {
        locations.push({ file: p, line: s.line });
        kinds.add(s.what);
        if (s.svc) svcs.add(s.svc);
      }
      if (isFrontend(p)) frontend = true;
      if (it) notes[it] = (notes[it] ? notes[it] + ' · ' : '') + list.slice(0, 4).map((s) => `${file ? p.split('/').pop() : `line ${s.line}`}: ${s.name ? `${s.name}, ` : ''}${s.what.replace(/ \(.*\)$/, '')} (${s.hint})`).join(' · ') + (list.length > 4 ? ` · +${list.length - 4} more` : '');
    }
    const n = locations.length;
    const sev = group.some((g) => g.list.some((s) => s.sev === 'high')) ? 'high' : 'medium';
    const one = group.length === 1 ? group[0].path : null;
    const kindText = kinds.size === 1 ? [...kinds][0].replace(/ \(.*\)$/, '') : 'passwords or keys';
    return {
      id: 'secret:' + (one || group.map((g) => g.path).join('|')),
      kind: 'secret', severity: sev,
      title: n === 1 ? `A secret key is written into ${one ? one.split('/').pop() : `${group.length} more files`}` : `${n} passwords or keys are written into ${one ? one.split('/').pop() : `${group.length} more files`}`,
      detail: `${one ? `${nameOf(one)} (${one})` : plural(group.length, 'file')} contains ${n === 1 ? kindText : `${n} secrets (${kindText})`}. Anyone who can see the code can use ${n === 1 ? 'it' : 'them'} to get into ${svcs.size ? [...svcs].slice(0, 4).join(', ') : 'the services they unlock'} as you${frontend ? ', and this code is sent to every visitor’s browser' : ''}. Treat ${n === 1 ? 'it' : 'them'} as leaked: move ${n === 1 ? 'it' : 'them'} out of the code and replace ${n === 1 ? 'it with a new one' : 'them with new ones'}.`,
      items, notes, locations,
      fix: [
        `Security fix: hard-coded secrets. Do not print, echo or repeat any secret value in your replies, commits or logs.`,
        ``,
        `These lines contain ${n === 1 ? 'a secret' : 'secrets'} written directly in the code:`,
        ...group.flatMap(({ path: p, list, file }) => list.map((s) => `- ${p}${file ? ' (the whole file)' : `:${s.line}`}: ${s.name ? `${s.name} — ` : ''}${s.what.replace(/ \(.*\)$/, '')}`)),
        ``,
        `For each one:`,
        `1. Replace the literal with an environment variable lookup (${group.some((g) => /\.py$/.test(g.path)) ? `os.environ["NAME"] in Python` : ''}${group.some((g) => /\.py$/.test(g.path)) && group.some((g) => /\.[jt]sx?$/.test(g.path)) ? ', ' : ''}${group.some((g) => /\.[jt]sx?$/.test(g.path)) ? 'process.env.NAME in JavaScript/TypeScript' : ''}${!group.some((g) => /\.(py|[jt]sx?)$/.test(g.path)) ? 'or a secret manager reference' : ''}), using a clear variable name. If the app can't run without it, fail with a clear error when it is missing instead of falling back to a hard-coded value.`,
        `2. Add each variable name (with an empty value, never the real one) to .env.example, and make sure .env is listed in .gitignore.`,
        frontend ? `3. This is frontend code that ships to the browser. Move the call that needs the secret to a server-side route or function so the key never reaches visitors.` : `3. Update any deployment config (Docker, Cloud Run, Vercel, etc.) so the variable is set in production.`,
        group.some((g) => g.file) ? `4. Remove the credentials file from the repository (git rm --cached), add its name to .gitignore, and load it from a path given by an environment variable.` : `4. Run the app or its tests to confirm it still starts with the variables set.`,
        ``,
        `Then give me a short checklist (without the values) of which services these keys belong to, so I can rotate each one: create a new key in that service's dashboard, put it in my environment, and revoke the old one. Because the old values are in git history, assume they are compromised.`,
      ].join('\n'),
    };
  };
  secretFiles.sort((a, b) => b.list.length - a.list.length);
  const MAX_SECRET_ISSUES = 8;
  secretFiles.slice(0, MAX_SECRET_ISSUES).forEach((g) => issues.push(secretIssue([g])));
  if (secretFiles.length > MAX_SECRET_ISSUES) issues.push(secretIssue(secretFiles.slice(MAX_SECRET_ISSUES)));

  // ---------- .env files that are (or will be) committed ----------
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!/^\.env(\.[\w.-]+)?$/i.test(base) || /example|sample|template|dist|defaults?|schema|test/i.test(base)) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    const secretVars = [];
    src.split('\n').forEach((t, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*["']?([^"'#\s]*)/.exec(t);
      if (!m || !m[2]) return;
      const n = snake(m[1]);
      const known = FORMATS.some((fm) => { fm.re.lastIndex = 0; const hit = fm.re.test(m[2]); fm.re.lastIndex = 0; return hit; });
      if (known || (SECRET_NAME.test(n) && !PUBLIC_NAME.test(n) && valueLooksReal(m[2], n)) || (/url|uri|dsn/i.test(n) && /:\/\/[^:\s\/]+:[^@\s]+@/.test(m[2]))) secretVars.push({ name: m[1], line: i + 1 });
    });
    if (!secretVars.length) continue;
    const repoAbs = f.repo ? path.join(root, f.repo) : root;
    const relInRepo = f.repo ? f.path.slice(f.repo.length + 1) : f.path;
    const tracked = !!git(repoAbs, ['ls-files', '--', relInRepo]);
    const it = itemFor(f.path);
    issues.push({
      id: 'env-file:' + f.path, kind: 'env-file', severity: tracked ? 'high' : 'medium',
      title: tracked ? 'Your private settings file is saved in git' : 'Your private settings file isn’t hidden from git',
      detail: tracked
        ? `${f.path} holds ${plural(secretVars.length, 'password or key', 'passwords and keys')} and is committed, so everyone with access to the code (and its history) can read them. This file is meant to stay on your computer only.`
        : `${f.path} holds ${plural(secretVars.length, 'password or key', 'passwords and keys')} and isn’t listed in .gitignore, so the next commit will upload it with your code.`,
      items: it ? [it] : [], notes: it ? { [it]: `${f.path}: ${secretVars.slice(0, 6).map((v) => v.name).join(', ')}${secretVars.length > 6 ? '…' : ''}` } : {},
      locations: secretVars.map((v) => ({ file: f.path, line: v.line })),
      fix: [
        `Security fix: ${f.path} contains secrets and ${tracked ? 'is committed to git' : 'is not ignored by git'}. Do not print or repeat any value from it.`,
        ``,
        `1. Add ${base} (and .env*.local) to ${f.repo ? f.repo + '/' : ''}.gitignore, keeping .env.example tracked.`,
        tracked ? `2. Stop tracking it without deleting my local copy: git rm --cached "${relInRepo}" (run inside ${f.repo || 'the repo'}), then commit.` : `2. Confirm with git status that the file no longer shows up as a new file.`,
        `3. Create or update .env.example next to it with the same variable names and empty values: ${secretVars.map((v) => v.name).join(', ')}.`,
        tracked ? `4. Give me a checklist (names only, no values) of which keys I need to rotate in each service's dashboard, since they are in git history. Mention that removing them from history needs a tool like git filter-repo, and ask before doing that.` : `4. Tell me which deployment settings need these variables.`,
      ].join('\n'),
    });
  }

  // ---------- secret keys in variables the browser gets (NEXT_PUBLIC_, VITE_ …) ----------
  const live = (p) => !TEST_FILE.test(p) && !EXAMPLE_FILE.test(p);
  const publicVars = new Map(); // name -> { svc, refs: [{file, line}], defs: [{file, line}] }
  const publicVar = (name) => { if (!publicVars.has(name)) publicVars.set(name, { name, svc: leakyPublicVar(name), refs: [], defs: [] }); return publicVars.get(name); };
  for (const f of scan.files) if (live(f.path)) for (const x of findings(f.path)) if (x.k === 'public-env') publicVar(x.name).refs.push({ file: f.path, line: x.line });
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!/^\.env(\.[\w.-]+)?$/i.test(base) || /example|sample|template|dist|schema/i.test(base) || !live(f.path)) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    src.split('\n').forEach((t, i) => {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*["']?([^"'#\s]*)/.exec(t);
      if (m && m[2] && !PLACEHOLDER.test(m[2]) && !/^\$/.test(m[2]) && leakyPublicVar(m[1]) !== null) publicVar(m[1]).defs.push({ file: f.path, line: i + 1 });
    });
  }
  if (publicVars.size) {
    const vars = [...publicVars.values()];
    const browserSide = (p) => isFrontend(p) || /\.(jsx|tsx|vue|svelte|astro)$/.test(p);
    const sev = vars.some((v) => CLIENT_ONLY_PREFIX.test(v.name) || v.refs.some((r) => browserSide(r.file))) ? 'high' : 'medium';
    const svcs = [...new Set(vars.map((v) => v.svc).filter(Boolean))];
    const locations = vars.flatMap((v) => [...v.defs, ...v.refs]);
    const items = [], notes = {};
    for (const v of vars) for (const loc of [...v.refs, ...v.defs]) {
      const it = itemFor(loc.file);
      if (!it) continue;
      if (!items.includes(it)) items.push(it);
      const note = `line ${loc.line}: ${v.name}`;
      if (!(notes[it] || '').includes(note)) notes[it] = (notes[it] ? notes[it] + ' · ' : '') + note;
    }
    const names = vars.map((v) => v.name);
    issues.push({
      id: 'public-env', kind: 'public-env-secret', severity: sev,
      title: vars.length === 1 ? `${names[0]} is sent to every visitor’s browser` : `${vars.length} secret keys are sent to every visitor’s browser`,
      detail: `Settings whose names start with NEXT_PUBLIC_, VITE_ and the like are copied into the code your site sends to every visitor, where anyone can read them in their browser’s developer tools. ${vars.length === 1 ? `${names[0]} looks like a secret key` : `${names.slice(0, 4).join(', ')}${vars.length > 4 ? '…' : ''} look like secret keys`}${svcs.length ? ` (for ${svcs.slice(0, 4).join(', ')})` : ''}, so anyone could use ${vars.length === 1 ? 'it' : 'them'} as you: run up your bill, send messages as you, or reach your data.${sev === 'medium' ? ' Right now only server code seems to read it, so it may not have reached a browser yet, but the name invites that.' : ''}`,
      items, notes, locations,
      fix: [
        `Security fix: secret keys in public environment variables (the browser gets every variable with these prefixes). Do not print, echo or repeat any key value.`,
        ``,
        ...vars.map((v) => `- ${v.name}${v.svc ? ` (${v.svc})` : ''}: ${[...v.defs.map((d) => `set in ${d.file}:${d.line}`), ...v.refs.map((r) => `used in ${r.file}:${r.line}`)].slice(0, 6).join(', ')}`),
        ``,
        `For each one:`,
        `1. Rename it without the public prefix (for example OPENAI_API_KEY instead of VITE_OPENAI_API_KEY) in the .env files, .env.example and the hosting settings.`,
        `2. Move every place that uses it into server-side code (a Next.js route handler or server action, a Supabase Edge Function, a serverless function or the existing backend) and have the frontend call that instead, so the key never reaches the browser.`,
        vars.some((v) => v.svc === 'Supabase') ? `3. For the Supabase service-role key: browser code should use the anon key and rely on row-level security; only server code may use the service-role key.` : `3. Keep the frontend working the same way, and run the app to check.`,
        ``,
        `Then give me a checklist (names only, no values) of the keys to rotate in each service's dashboard: anyone who loaded the site may have copied them.`,
      ].join('\n'),
    });
  }

  // ---------- Supabase tables anyone can read and change ----------
  const usesSupabase = scan.files.some((f) => /(^|\/)supabase\/(migrations\/|config\.toml$|functions\/)/.test(f.path) || findings(f.path).some((x) => x.k === 'uses-supabase'));
  if (usesSupabase) {
    const byRepo = new Map(); // repo -> [file, …] in path order (migrations are named by timestamp)
    for (const f of scan.files) if (f.lang === 'sql' && live(f.path) && findings(f.path).some((x) => x.k.startsWith('sql-'))) { const k = f.repo ?? ''; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(f.path); }
    for (const [repo, sqlFiles] of byRepo) {
      const tables = new Map(); // table -> { file, line, rls, off }
      const policies = [];
      for (const p of sqlFiles.sort()) for (const x of findings(p)) {
        const t = tables.get(x.table);
        if (x.k === 'sql-table' && !t) tables.set(x.table, { file: p, line: x.line, rls: null });
        else if (x.k === 'sql-rls' && t) { t.rls = x.on; t.off = x.on ? null : { file: p, line: x.line }; }
        else if (x.k === 'sql-rename' && t) { tables.delete(x.table); tables.set(x.to, t); for (const pol of policies) if (pol.table === x.table) pol.table = x.to; }
        else if (x.k === 'sql-drop') tables.delete(x.table);
        else if (x.k === 'sql-open-policy') policies.push({ ...x, file: p });
      }
      const short = (t) => t.replace(/^public\./, '');
      const open = [...tables.entries()].filter(([name, t]) => name.startsWith('public.') && t.rls !== true);
      if (open.length) {
        const items = [], notes = {};
        for (const [name, t] of open) {
          const it = itemFor(t.file);
          if (!it) continue;
          if (!items.includes(it)) items.push(it);
          notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `line ${t.line}: ${short(name)} (row-level security ${t.off ? 'switched off' : 'never switched on'})`;
        }
        const list = open.map(([name]) => short(name));
        issues.push({
          id: 'rls:' + repo, kind: 'database-rules', severity: 'high',
          title: open.length === 1 ? `Anyone can read and change your ${list[0]} table` : `Anyone can read and change ${open.length} of your database tables`,
          detail: `Your app talks to Supabase with a public key that every visitor’s browser has. Row-level security is what stops one person from reading or changing someone else’s rows, and it’s off for ${open.length === 1 ? `the ${list[0]} table` : `${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''}`}. Without it, anyone can use that key to read, change or delete every row${open.length === 1 ? '' : ' in them'}. If your app only reaches the database from its own server, the risk is lower, but switching it on is still the safe default.`,
          items, notes,
          locations: open.map(([, t]) => t.off || { file: t.file, line: t.line }),
          fix: [
            `Security fix: Supabase tables without row-level security (RLS). Do not print any keys.`,
            ``,
            `Anyone with the app's public (anon) key can read and change these tables:`,
            ...open.map(([name, t]) => `- ${name}: created in ${t.file}:${t.line}${t.off ? `, row-level security switched off in ${t.off.file}:${t.off.line}` : ''}`),
            ``,
            `1. Read how the app uses each table: which pages read or write it, and whether rows belong to a user (for example a user_id column that should match auth.uid()).`,
            `2. Write one new migration (don't edit the old ones) that runs \`alter table <table> enable row level security;\` for each table, plus policies so the app keeps working: usually signed-in users can read and change only their own rows (\`using (auth.uid() = user_id)\`), and tables meant to be public get a read-only policy. Server code that uses the service-role key isn't affected by these rules.`,
            `3. Explain the policies to me in plain words before applying anything, and don't loosen any existing policy.`,
            `4. Tell me how to apply the migration (for example \`supabase db push\`) and how to check, while signed out, that I can't read other people's rows.`,
          ].join('\n'),
        });
      }
      const loose = policies.filter((pol) => tables.get(pol.table)?.rls === true);
      if (loose.length) {
        const verb = (cmd) => ({ insert: 'add', update: 'change', delete: 'delete' }[cmd] || 'add, change and delete');
        const rowsOf = (cmd, t) => `${verb(cmd)} rows ${{ insert: 'to', delete: 'from' }[cmd] || 'in'} ${t}`;
        const items = [], notes = {};
        for (const pol of loose) {
          const it = itemFor(pol.file);
          if (!it) continue;
          if (!items.includes(it)) items.push(it);
          notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `line ${pol.line}: “${pol.policy}” lets anyone ${rowsOf(pol.cmd, short(pol.table))}`;
        }
        issues.push({
          id: 'open-policy:' + repo, kind: 'database-rules', severity: 'medium',
          title: loose.length === 1 ? `A database rule lets anyone change your ${short(loose[0].table)} table` : `${loose.length} database rules let anyone change your data`,
          detail: `${loose.length === 1 ? `The rule “${loose[0].policy}” lets anyone` : `These rules let anyone`}${loose.some((pol) => pol.signedOut) ? ', even people who aren’t signed in,' : ''} ${loose.length === 1 ? rowsOf(loose[0].cmd, short(loose[0].table)) : `add, change or delete rows in ${[...new Set(loose.map((pol) => short(pol.table)))].slice(0, 5).join(', ')}`}. If a table is a public form (like a waitlist or contact form), letting anyone add rows is fine; otherwise limit it to signed-in users and their own rows.`,
          items, notes,
          locations: loose.map((pol) => ({ file: pol.file, line: pol.line })),
          fix: [
            `Security review: Supabase row-level security policies that allow anyone to change data (\`using (true)\` / \`with check (true)\` for anon or public):`,
            ...loose.map((pol) => `- “${pol.policy}” on ${pol.table} (for ${pol.cmd}) — ${pol.file}:${pol.line}`),
            ``,
            `For each one, tell me in plain words what it allows and whether the app needs that. If the table isn't meant to be public, replace \`true\` with a check such as \`auth.uid() = user_id\`, limited to authenticated users, in a new migration. If it's a public form, keep adding rows open but make sure nobody can read, change or delete other people's rows. Show me the change before applying it.`,
          ].join('\n'),
        });
      }
    }
  }

  // ---------- Firebase security rules that let anyone in ----------
  const today = new Date();
  const longDate = (d) => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!live(f.path) || !(/\.rules$/i.test(base) || /^database(\.[\w-]+)?\.rules\.json$/i.test(base))) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    const rtdb = /\.json$/i.test(base);
    const service = rtdb ? 'Realtime Database' : /service\s+firebase\.storage/.test(src) ? 'Storage' : /service\s+cloud\.firestore/.test(src) ? 'Firestore' : null;
    if (!service) continue;
    const rules = rtdb ? firebaseRtdbRules(src, today) : firebaseRules(src, today);
    // the whole database, or (Firestore and Storage) any change beyond adding new records to one place
    const severe = (r) => r.wide || (!rtdb && !r.createOnly);
    const writes = rules.filter((r) => r.write && r.open !== 'expired' && severe(r));
    const deepWrites = rules.filter((r) => r.write && r.open === 'always' && !severe(r));
    const reads = rules.filter((r) => r.read && !r.write && r.open !== 'expired' && r.wide);
    const until = rules.find((r) => r.open === 'until');
    const expired = rules.find((r) => r.open === 'expired');
    if (!writes.length && !deepWrites.length && !reads.length && !expired) continue;
    const files = service === 'Storage';
    const what = files ? 'files' : 'data';
    const deploy = { Firestore: 'firestore:rules', Storage: 'storage', 'Realtime Database': 'database' }[service];
    const shown = [...writes, ...deepWrites, ...reads, ...(expired ? [expired] : [])];
    let title, detail, severity;
    if (until && writes.length) {
      severity = 'high';
      title = `Your Firebase ${service} is open to anyone until ${longDate(until.until)}`;
      detail = `${base} still has Firebase’s “test mode” rules: anyone can read and change ${files ? 'every file' : 'everything'} until ${longDate(until.until)}, without signing in or using your app. After that date every request is refused and the app stops working, so replace them with real rules rather than moving the date.`;
    } else if (writes.length) {
      severity = 'high';
      title = files ? 'Anyone can upload, replace or delete your Firebase files' : `Anyone can change or delete your Firebase ${service} data`;
      detail = `A rule in ${base} (line ${writes[0].line}, at ${writes[0].where}) lets anyone, signed in or not, ${files ? 'upload, replace or delete files' : 'add, change or delete data'}. Your app’s Firebase settings are in every visitor’s browser, so anyone can use them to reach your ${service} directly, without going through your app.`;
    } else if (deepWrites.length || reads.length) {
      severity = 'medium';
      title = reads.length && !deepWrites.length ? `Anyone can read everything in your Firebase ${service}` : `Anyone can change part of your Firebase ${service}`;
      detail = [
        reads.length ? `A rule in ${base} (line ${reads[0].line}) lets anyone read every ${files ? 'file' : 'record'}, including data that may belong to your users. If everything there is meant to be public, that’s fine; otherwise it needs a sign-in check.` : '',
        deepWrites.length ? `A rule in ${base} (line ${deepWrites[0].line}) lets anyone ${deepWrites[0].createOnly ? 'add to' : 'change'} ${deepWrites[0].where} without signing in. If that’s a public form (like a waitlist or contact form), that can be fine; otherwise it needs a sign-in check.` : '',
      ].filter(Boolean).join(' ');
    } else {
      severity = 'medium';
      title = `Your Firebase ${service} test-mode rules ran out on ${longDate(expired.until)}`;
      detail = `${base} has Firebase’s “test mode” rules, which stopped allowing access on ${longDate(expired.until)}. Every read and write is now refused, so the parts of the app that use ${service} won’t work. Replace them with real rules instead of moving the date, which would open everything to anyone again.`;
    }
    const it = itemFor(f.path);
    issues.push({
      id: 'firebase-rules:' + f.path, kind: 'database-rules', severity, title, detail,
      items: it ? [it] : [], notes: it ? { [it]: shown.slice(0, 4).map((r) => `line ${r.line}: ${r.text}`).join(' · ') } : {},
      locations: shown.map((r) => ({ file: f.path, line: r.line })),
      fix: [
        `Security fix: Firebase ${service} security rules in ${f.path}.`,
        ``,
        `These rules let anyone in (or have expired):`,
        ...shown.map((r) => `- line ${r.line}: ${r.text}`),
        ``,
        `1. Read how the app uses each ${rtdb ? 'path' : files ? 'storage folder' : 'collection'}: what each screen reads and writes, and which data belongs to a user (for example ${files ? 'files under a folder named after the user’s uid' : 'documents keyed by the user’s uid, or with an ownerId field'}).`,
        `2. Rewrite the rules so signed-in users can only read and write their own ${what} (${rtdb ? 'auth != null && auth.uid === $uid' : files ? 'request.auth != null && request.auth.uid == userId' : 'request.auth != null && request.auth.uid == resource.data.ownerId'}), public content is read-only, and everything else is denied. Don't use test-mode dates.`,
        `3. Explain the new rules to me in plain words and wait for my OK.`,
        `4. Then deploy them with \`firebase deploy --only ${deploy}\` and check them in the Firebase console's Rules Playground (or the emulator): a signed-out user shouldn't be able to read or change anything private.`,
      ].join('\n'),
    });
  }

  // ---------- Stripe webhooks that don't check Stripe's signature ----------
  const stripeFiles = new Map(); // file -> finding
  for (const f of scan.files) if (live(f.path)) { const x = findings(f.path).find((y) => y.k === 'stripe-unsigned'); if (x) stripeFiles.set(f.path, x); }
  for (const [file, x] of stripeFiles) {
    const routesHere = graph.routes.map((r, i) => ({ r, i })).filter(({ r }) => r.f === file && r.m !== 'GET');
    const it = itemFor(file);
    const items = [...(it ? [it] : []), ...routesHere.map(({ i }) => 'r:' + i)];
    const py = /\.py$/.test(file);
    const next = /(^|\/)app\/.*route\.[jt]s$|(^|\/)pages\/api\//.test(file);
    issues.push({
      id: 'stripe-webhook:' + file, kind: 'stripe-webhook', severity: 'high',
      title: `Anyone could fake a Stripe payment in ${nameOf(file)}`,
      detail: `${file.split('/').pop()} acts on Stripe events (like “${x.events[0]}”) without checking Stripe’s signature, so anyone who finds the address can send a fake “payment succeeded” message and get orders, credits or a subscription for free. Stripe signs every real event; checking that signature takes a few lines.`,
      items, notes: Object.fromEntries(items.map((id) => [id, id.startsWith('r:') ? 'Receives Stripe events without checking they’re real' : `line ${x.line}: handles ${x.events.join(', ')} without checking Stripe’s signature`])),
      locations: [{ file, line: x.line }],
      fix: [
        `Security fix in ${file}: verify Stripe webhook signatures before acting on any event. Do not print any secret values.`,
        ``,
        `It handles ${x.events.join(', ')} (line ${x.line}) without calling ${py ? 'stripe.Webhook.construct_event' : 'stripe.webhooks.constructEvent'}.`,
        ``,
        py
          ? `1. Read the raw request body as bytes (FastAPI: \`await request.body()\`; Flask: \`request.get_data()\`), not the parsed JSON.`
          : next ? `1. Read the raw request body with \`await req.text()\` (App Router) or turn off the body parser for this route (Pages Router), not the parsed JSON.` : `1. Give this route the raw body: \`express.raw({ type: 'application/json' })\` on it, registered before \`express.json()\` runs for it.`,
        py
          ? `2. Call \`stripe.Webhook.construct_event(payload, request.headers["stripe-signature"], os.environ["STRIPE_WEBHOOK_SECRET"])\` and return 400 if it raises.`
          : `2. Call \`stripe.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET)\` (the \`stripe-signature\` header) and return 400 if it throws.`,
        `3. Use only the verified event from then on, and handle each event once even if Stripe sends it again.`,
        `4. Add STRIPE_WEBHOOK_SECRET (empty) to .env.example and tell me where to get it: the Stripe dashboard (Developers → Webhooks → the endpoint → Signing secret), or \`stripe listen\` when testing locally.`,
      ].join('\n'),
    });
  }

  // ---------- servers that let any website call them (CORS) ----------
  const cors = [];
  for (const f of scan.files) if (live(f.path)) for (const x of findings(f.path)) if (x.k === 'cors-any') cors.push({ file: f.path, ...x });
  if (cors.length) {
    const cred = cors.filter((c) => c.credentials);
    const filesC = [...new Set(cors.map((c) => c.file))];
    const items = [], notes = {};
    for (const c of cors) {
      const it = itemFor(c.file);
      if (!it) continue;
      if (!items.includes(it)) items.push(it);
      notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `line ${c.line}: ${c.how}${c.credentials ? ', with login cookies' : ''}`;
    }
    issues.push({
      id: 'cors', kind: 'cors', severity: cred.length ? 'medium' : 'low',
      title: cred.length ? 'Any website could act as your signed-in users' : 'Any website can call your server from a visitor’s browser',
      detail: cred.length
        ? `${cred[0].file.split('/').pop()} lets any website call this server from a visitor’s browser and send along their login cookies. So a site a signed-in user happens to visit could quietly read their data or act as them. Allow only your own app’s address instead.`
        : `${filesC.length === 1 ? filesC[0].split('/').pop() : `${filesC.length} files`} tell browsers that any website may call this server. That’s fine for a public API that doesn’t use login cookies (for example one that checks a token in the Authorization header); otherwise, allow only your own app’s address.`,
      items, notes,
      locations: cors.map((c) => ({ file: c.file, line: c.line })),
      fix: [
        `Security review: CORS settings that allow every website:`,
        ...cors.map((c) => `- ${c.file}:${c.line}: ${c.how}${c.credentials ? ' (with credentials)' : ''}`),
        ``,
        `First tell me in plain words whether this server uses login cookies or sessions, and which websites legitimately call it. Then replace the allow-everything setting with an explicit list of allowed origins read from an environment variable (for example ALLOWED_ORIGINS=https://myapp.com,http://localhost:3000). Keep credentials only if the app logs in with cookies, and never combine them with "*" or with echoing back whatever origin asks. Show me the change before making it, and change nothing else.`,
      ].join('\n'),
    });
  }

  // ---------- endpoints anyone can call ----------
  const routeFinding = new Map(); // `${file}|${line}|${method}` -> finding
  const globalGuards = new Map(); // repo -> [{framework, name, file}]
  const guardDefs = new Map();    // name -> [{ file, wrapper }]
  for (const f of scan.files) for (const x of findings(f.path)) {
    if (x.k === 'route') routeFinding.set(`${f.path}|${x.line}|${x.method}`, x);
    // app-wide checks count only from the app itself, not from scripts or tests that spin up their own
    if (x.k === 'global-guard' && !TEST_FILE.test(f.path) && !/(^|\/)(scripts?|tools|bin|examples?)\//.test(f.path) && !(fileByPath.has(f.path) && kinds(fileByPath.get(f.path).n).some((k) => NOT_USED_KINDS.has(k)))) { const k = f.repo ?? ''; if (!globalGuards.has(k)) globalGuards.set(k, []); globalGuards.get(k).push({ ...x, file: f.path }); }
    if (x.k === 'guard-def' && !TEST_FILE.test(f.path)) { if (!guardDefs.has(x.name)) guardDefs.set(x.name, []); guardDefs.get(x.name).push({ file: f.path, wrapper: !!x.wrapper }); }
  }
  const aliasGuards = pyAliasGuards(scan.files.filter((f) => !TEST_FILE.test(f.path)), findings);
  for (const [repo, aliases] of aliasGuards) for (const [name, file] of aliases) {
    if (!guardDefs.has(name)) guardDefs.set(name, []);
    guardDefs.get(name).push({ file, alias: true, repo });
  }
  // a sign-in check applied where the route's router is mounted: app.use('/admin', requireStaff, adminRouter),
  // or app.include_router(admin.router, dependencies=[Depends(require_admin)]) (a database session isn't one)
  const mountGuard = new Map((scan.routes || []).filter((r) => r.mountMw?.some(isGuardDep)).map((r) => [`${r.file}|${r.line}|${r.method}`, r.mountMw.find(isGuardDep)]));
  const perRepo = new Map(); // repo -> { guarded, open: [], guardCounts }
  graph.routes.forEach((r, i) => {
    const fnd = routeFinding.get(`${r.f}|${r.l}|${r.m}`);
    if (!fnd) return; // framework we don't analyse: say nothing
    const gf = fileByPath.get(r.f);
    if (!gf || kinds(gf.n).some((k) => NOT_USED_KINDS.has(k)) || TEST_FILE.test(r.f)) return;
    const repo = gf.r ?? '';
    if (!perRepo.has(repo)) perRepo.set(repo, { guarded: 0, total: 0, open: [], misplaced: [], guardCounts: new Map(), fileGuards: new Map(), guardedIn: new Map() });
    const pr = perRepo.get(repo);
    pr.total++;
    const global = (globalGuards.get(repo) || []).find((g) => g.framework === 'flask' || g.framework === 'express' || (g.framework === 'next' && fnd.fn === r.m));
    // an unrecognised decorator that turns out to be an auth wrapper defined elsewhere in the project
    const viaWrapper = !fnd.via && fnd.decos?.find((d) => guardDefs.get(d)?.some((g) => (g.file.split('/')[0] === r.f.split('/')[0])));
    const mounted = !fnd.via && mountGuard.get(`${r.f}|${r.l}|${r.m}`);
    // a parameter typed with a dependency alias that checks the caller: `user: AdminUser`
    const viaAlias = !fnd.via && fnd.types?.find((t) => aliasGuards.get(repo)?.has(t));
    if (fnd.via || global || viaWrapper || mounted || viaAlias) {
      pr.guarded++; pr.guardedIn.set(r.f, (pr.guardedIn.get(r.f) || 0) + 1);
      const name = fnd.guard || viaWrapper || mounted || viaAlias;
      if (name) {
        pr.guardCounts.set(name, (pr.guardCounts.get(name) || 0) + 1);
        if (!pr.fileGuards.has(r.f)) pr.fileGuards.set(r.f, new Map());
        pr.fileGuards.get(r.f).set(name, (pr.fileGuards.get(r.f).get(name) || 0) + 1);
      }
      return;
    }
    if (r.m === 'OPTIONS' || r.m === 'HEAD') return;
    // webhook receivers: by URL, or a webhook-ish handler in a webhook file (not that file's admin endpoints)
    const webhook = (WEBHOOK_PATH.test(r.p) && !WEBHOOK_ADMIN.test(r.p)) || (/webhook|hooks?\//i.test(r.f) && /webhook|hook|notify|event|ingress|pubsub|callback|receive|inbound/i.test(r.h || '') && !/create|list|manage|register|delete|test|setup|sync/i.test((r.h || '') + r.p));
    if (webhook && fnd.signed) return;
    // a Stripe webhook that doesn't check Stripe's signature has its own, more specific issue
    if (stripeFiles.has(r.f) && (webhook || /stripe|payment|hook/i.test(r.p) || graph.routes.filter((x) => x.f === r.f && x.m !== 'GET').length === 1)) return;
    if (!webhook && PUBLIC_PATH.test(r.p.replace(/<[^>]*>|\{[^}]*\}|:\w+|\[[^\]]*\]/g, 'x'))) return;
    if (r.p === '/' && r.m === 'GET') return;
    const entry = { i, r, fnd, write: !['GET', 'ANY'].includes(r.m), webhook };
    if (fnd.misplaced) pr.misplaced.push(entry); else pr.open.push(entry);
  });
  for (const [repo, pr] of perRepo) {
    const top = (m) => m && [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    // prefer what this file already uses, then the project's most common real (non-wrapper) check
    const guardHint = (file, lang) => {
      const local = top(pr.fileGuards.get(file));
      const name = local || top(new Map([...pr.guardCounts].filter(([n]) => !guardDefs.get(n)?.every((g) => g.wrapper))));
      if (!name) return `the project's existing login check (find how other protected endpoints verify the user; if there is none, ask me before adding one)`;
      const defs = guardDefs.get(name) || [];
      const where = defs.find((g) => g.file === file) ? 'defined in this file' : defs.length ? `defined in ${defs[0].file}` : '';
      const how = defs.some((g) => g.alias) ? `a parameter typed ${name}` : `${lang === 'python' ? '@' : ''}${name}`;
      return `the same check ${local ? 'the other endpoints in this file' : 'the protected endpoints'} already use (${how}${where ? ', ' + where : ''})`;
    };
    const routeLine = (e) => `- ${e.r.m} ${e.r.p} — ${e.r.f}:${e.r.l}${e.fnd.fn && !/^[A-Z]+$/.test(e.fnd.fn) ? ` (${e.fnd.fn})` : ''}`;
    if (pr.misplaced.length) {
      const list = pr.misplaced;
      issues.push({
        id: 'misplaced-guard:' + repo, kind: 'unprotected-endpoint', severity: 'high',
        title: 'A login check is in the wrong place, so it does nothing',
        detail: `On ${plural(list.length, 'endpoint')} the login check (@${list[0].fnd.misplaced}) is written above the route line instead of below it. Flask only sees what's below, so ${list.length === 1 ? 'it is' : 'they are'} open to anyone even though ${list.length === 1 ? 'it looks' : 'they look'} protected.`,
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, `@${e.fnd.misplaced} sits above the route line, so it is skipped`])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [`Security fix: these endpoints have their auth decorator above the route decorator, so the framework registers the unprotected function:`, ...list.map(routeLine), ``, `Move each auth decorator directly below the @…route(...) line (route decorator first, then the auth decorator, then def). Change nothing else, then run the tests that cover these endpoints.`].join('\n'),
      });
    }
    if (!pr.open.length) continue;
    // Nothing in this repo checks the caller: probably protected elsewhere (gateway, private network) or not at all.
    if (pr.guarded === 0) {
      const list = pr.open.sort((a, b) => b.write - a.write);
      issues.push({
        id: 'no-auth:' + repo, kind: 'unprotected-endpoint', severity: 'medium',
        title: `None of ${repo ? `${repo}’s` : 'your'} endpoints check who is calling`,
        detail: `${plural(list.length, 'endpoint')} answer anyone who knows the address, with no login check in the code. That's fine only if this server is private (for example behind a company network or a gateway that checks logins); otherwise anyone could read or change its data.`,
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, e.write ? 'Changes data, no login check' : 'No login check'])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [`Review access control${repo ? ` in ${repo}` : ''}. None of these endpoints verify the caller in code:`, ...list.slice(0, 40).map(routeLine), list.length > 40 ? `- …and ${list.length - 40} more` : null, ``, `First tell me in plain words whether this server is reachable from the internet and whether anything in front of it (gateway, network rules) checks logins. If it is public, propose the smallest safe way to require login for the data-changing endpoints (POST/PUT/PATCH/DELETE) first, show me the plan, and wait for my OK before changing code.`].filter((x) => x !== null).join('\n'),
      });
      continue;
    }
    // One issue per route file
    const byFile = new Map();
    for (const e of pr.open) { if (!byFile.has(e.r.f)) byFile.set(e.r.f, []); byFile.get(e.r.f).push(e); }
    for (const [file, list] of byFile) {
      list.sort((a, b) => b.write - a.write || a.r.l - b.r.l);
      const writes = list.filter((e) => e.write && !e.webhook), hooks = list.filter((e) => e.webhook), reads = list.filter((e) => !e.write && !e.webhook);
      // many providers can't sign webhooks at all, so an unsigned one alone stays low
      const sev = writes.length ? 'high' : reads.length > 2 ? 'medium' : 'low';
      const lang = scanByPath.get(file)?.lang;
      const fileGuarded = pr.guardedIn.get(file) || 0;
      const sv = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const parts = [];
      if (writes.length) parts.push(sv(writes.length, 'endpoint that changes data (create, update or delete)', 'endpoints that change data (create, update or delete)'));
      if (reads.length) parts.push(sv(reads.length, 'endpoint that returns data', 'endpoints that return data'));
      const nOpen = writes.length + reads.length;
      const hookText = hooks.length ? `${sv(hooks.length, 'webhook (an automatic message from another service) is', 'webhooks (automatic messages from another service) are')} accepted without checking that ${hooks.length === 1 ? 'it really comes' : 'they really come'} from that service, so anyone could send fake ones. Some providers can't sign their messages; if so, that's expected.` : '';
      issues.push({
        id: 'open-endpoints:' + file, kind: 'unprotected-endpoint', severity: sev,
        title: writes.length ? `Anyone could change data through ${nameOf(file)}` : hooks.length ? `Anyone could send fake events to ${nameOf(file)}` : `Anyone could read data from ${nameOf(file)}`,
        detail: [
          parts.length ? `${file.split('/').pop()} has ${parts.join(' and ')} with no login check, so anyone who finds the address can use ${nOpen === 1 ? 'it' : 'them'}${fileGuarded > 0 ? ` (${sv(fileGuarded, 'other endpoint', 'other endpoints')} in the same file ${fileGuarded === 1 ? 'is' : 'are'} protected)` : ''}. If ${nOpen === 1 ? 'it is' : 'some are'} meant to be public, that's fine; otherwise ${nOpen === 1 ? 'it needs' : 'they need'} a login check.` : '',
          parts.length && hooks.length ? `It also accepts ${sv(hooks.length, 'webhook', 'webhooks')} without checking who sent ${hooks.length === 1 ? 'it' : 'them'}.` : hookText,
        ].filter(Boolean).join(' '),
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, e.webhook ? 'Webhook with no visible signature check' : e.write ? 'Changes data, no login check' : 'Returns data, no login check'])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [
          `Security fix in ${file}: these endpoints don't check who is calling:`,
          ...list.map((e) => routeLine(e) + (e.webhook ? ' [webhook]' : '')),
          ``,
          `For each endpoint that isn't meant to be public, add ${guardHint(file, lang)}.`,
          hooks.length ? `For webhooks, verify the provider's signature (using its signing secret from an environment variable) before doing anything, and reject requests that fail.` : null,
          `If an endpoint is intentionally public (for example a public page or a health check), leave it and tell me why. Don't change anything else; afterwards list exactly which endpoints you protected and run the related tests.`,
        ].filter((x) => x !== null).join('\n'),
      });
    }
  }

  // ---------- unused files ----------
  const incoming = new Set();
  for (const l of graph.links) if (l.a !== l.b && l.b.startsWith('f:')) incoming.add(l.b.slice(2));
  const entry = new Set(graph.project?.entrypoints || []);
  const routeFiles = new Set(graph.routes.map((r) => r.f));
  for (const fl of graph.flows || []) for (const s of fl.steps || []) if (s.ref?.startsWith('f:')) entry.add(s.ref.slice(2));
  const candidates = graph.files.filter((f) => {
    if (incoming.has(f.p) || entry.has(f.p) || routeFiles.has(f.p) || !USED_LANGS.has(f.l)) return false;
    if (TEST_FILE.test(f.p) || SPECIAL_FILE.test(f.p) || /(^|\/)app\/.*\/(page|layout|route|loading|error|template|default)\.[jt]sx?$/.test(f.p)) return false;
    if (/(^|\/)src\/routes\//.test(f.p) && /\+|\$|\[/.test(f.p.split('/').pop())) return false;
    if (kinds(f.n).some((k) => NOT_USED_KINDS.has(k))) return false;
    if (findings(f.p).some((x) => x.k === 'runnable' || x.k === 'route')) return false;
    return true;
  });
  // Safety net for dynamic loading: skip a file whose name appears in any other source file.
  if (candidates.length) {
    const want = new Map(candidates.map((f) => [stemOf(f.p), f.p]));
    const mentioned = new Set();
    for (const f of scan.files) {
      if (!['code', 'config', 'docs'].includes(f.category) || f.tooLarge) continue;
      let src;
      try { src = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
      for (const tok of new Set(src.match(/[\w$-]+/g) || [])) { const p = want.get(tok); if (p && p !== f.path) mentioned.add(p); }
    }
    const unused = candidates.filter((f) => !mentioned.has(f.p));
    // A module where most files look unused is more likely loaded in a way we can't see; stay quiet.
    const byNode = new Map();
    for (const f of unused) { if (!byNode.has(f.n)) byNode.set(f.n, []); byNode.get(f.n).push(f); }
    const groups = [...byNode.entries()].filter(([n, list]) => { const total = graph.files.filter((f) => f.n === n).length; return n === 'unassigned' || list.length <= 3 || list.length / total <= 0.6; }).sort((a, b) => b[1].length - a[1].length);
    const MAX = 5;
    const merged = groups.length > MAX ? [...groups.slice(0, MAX - 1), ['', groups.slice(MAX - 1).flatMap(([, l]) => l)]] : groups;
    for (const [nid, list] of merged) {
      list.sort((a, b) => b.loc - a.loc);
      const where = nid ? label(nid) : 'other areas';
      const lines = list.reduce((s, f) => s + f.loc, 0);
      issues.push({
        id: 'unused:' + (nid || 'other'), kind: 'unused-file', severity: 'low',
        title: list.length === 1 ? `A file in ${where} looks unused` : `${list.length} files in ${where} look unused`,
        detail: `Nothing in the app imports or calls ${list.length === 1 ? 'this file' : 'these files'} (${lines.toLocaleString('en-US')} lines). Leftover code confuses AI assistants, which may edit or copy the wrong version. Double-check before deleting: some files are loaded in ways the map can't see.`,
        items: list.slice(0, 24).map((f) => 'f:' + f.p),
        notes: Object.fromEntries(list.slice(0, 24).map((f) => ['f:' + f.p, `Nothing uses this file (${f.loc.toLocaleString('en-US')} lines)`])),
        locations: list.map((f) => ({ file: f.p, line: 1 })),
        fix: [`Cleanup check: these files look unused (nothing imports or calls them):`, ...list.slice(0, 40).map((f) => `- ${f.p}`), list.length > 40 ? `- …and ${list.length - 40} more` : null, ``, `For each file, search the codebase (including configs, scripts, HTML templates and dynamic imports) to confirm nothing uses it. Then tell me which ones are safe to delete and which are actually used, with one line of evidence each. Don't delete anything until I confirm.`].filter((x) => x !== null).join('\n'),
      });
    }
  }

  // ---------- very large files ----------
  const big = graph.files.filter((f) => f.loc > 1000 && USED_LANGS.has(f.l) && !TEST_FILE.test(f.p) && !/(^|\/)(migrations|alembic|versions|fixtures?|seeds?|generated|__generated__)\//i.test(f.p) && !/\.d\.ts$/.test(f.p)).sort((a, b) => b.loc - a.loc);
  if (big.length) {
    const huge = big.filter((f) => f.loc >= 2000);
    issues.push({
      id: 'large-files', kind: 'large-file', severity: huge.length ? 'medium' : 'low',
      title: big.length === 1 ? 'One file is very large' : `${big.length} files are very large`,
      detail: `${big.length === 1 ? 'This file has' : 'These files each have'} over 1,000 lines${huge.length ? ` (the biggest has ${big[0].loc.toLocaleString('en-US')})` : ''}. AI assistants read and edit big files less reliably: they lose track of what's where and can break one part while fixing another. Splitting them into smaller files by job makes future changes safer.`,
      items: big.slice(0, 24).map((f) => 'f:' + f.p),
      notes: Object.fromEntries(big.slice(0, 24).map((f) => ['f:' + f.p, `${f.loc.toLocaleString('en-US')} lines${f.tooLarge ? ': too big for Floorplan to read, so what it connects to and any secrets in it weren’t checked' : ''}`])),
      locations: big.map((f) => ({ file: f.p, line: 1 })),
      fix: [`Refactor plan: these files are very large:`, ...big.slice(0, 15).map((f) => `- ${f.p} (${f.loc.toLocaleString('en-US')} lines)`), ``, `Start with ${big[0].p}. Read it and propose how to split it into smaller files, each with one clear job (for example by feature or by type of work), keeping every public function name and behaviour the same. Show me the plan first. After I approve, move code in small steps, update the imports, and run the tests after each step. Don't change behaviour.`].join('\n'),
    });
  }

  // ---------- frontend hard-coded to localhost ----------
  const local = [];
  for (const f of graph.files) if (isFrontend(f.p)) for (const x of findings(f.p)) if (x.k === 'localhost') local.push({ file: f.p, line: x.line });
  if (local.length) {
    const filesL = [...new Set(local.map((x) => x.file))];
    issues.push({
      id: 'localhost-url', kind: 'hardcoded-url', severity: 'low',
      title: 'The app points at your own computer’s address',
      detail: `${filesL.length === 1 ? 'A frontend file' : `${filesL.length} frontend files`} call${filesL.length === 1 ? 's' : ''} a fixed “localhost” address. That only works on your machine; once the app is online those calls will fail for everyone else.`,
      items: filesL.slice(0, 24).map((p) => 'f:' + p),
      notes: Object.fromEntries(filesL.slice(0, 24).map((p) => ['f:' + p, `localhost address on line ${local.filter((x) => x.file === p).map((x) => x.line).join(', ')}`])),
      locations: local,
      fix: [`These frontend lines use a hard-coded localhost URL:`, ...local.map((x) => `- ${x.file}:${x.line}`), ``, `Replace each with the project's existing API base URL setting (or add one read from a public environment variable such as NEXT_PUBLIC_API_URL / VITE_API_URL, with the localhost value only in .env.development). Don't change anything else.`].join('\n'),
    });
  }

  // ---------- who writes where (graph.targets, from floorplan/targets.json) ----------
  // A target that allows one writer only, with more than one listed, and calls into a target's box that the list
  // doesn't mention. Only listed writers count, so the second finding is how a missing writer comes to light.
  const itemName = (id) => (id.startsWith('n:') ? label(id.slice(2)) : nameOf(id.slice(2)));
  const itemPath = (id) => (id.startsWith('n:') ? (nodeById.get(id.slice(2))?.paths || []).join(', ') || id.slice(2) : id.slice(2));
  const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const entryName = (e) => (e.items.length === 1 ? itemName(e.items[0]) : `${e.ref} (${plural(e.items.length, 'match', 'matches')})`);
  const targets = graph.targets || [];
  for (const t of targets.filter((x) => x.conflict)) {
    const writers = t.writers.filter((w) => !w.in);
    const items = [...new Set(t.writers.flatMap((w) => w.items))];
    const box = t.node ? label(t.node.slice(2)) : null;
    issues.push({
      id: 'single-writer:' + t.id, kind: 'single-writer', severity: 'high',
      title: `${t.writerCount === 2 ? 'Two' : t.writerCount} writers for a single-writer target: ${t.name}`,
      detail: `floorplan/targets.json says only one part may write to ${t.name}, but lists ${t.writerCount}: ${and(writers.map(entryName))}. Two writers can overwrite each other’s changes or disagree about what is true. Pick the one that owns ${t.name}, and have the others hand their changes to it.`,
      items: [...items.slice(0, 23), ...(t.node ? [t.node] : [])],
      notes: { ...Object.fromEntries(items.slice(0, 23).map((x) => [x, `Writes to ${t.name}`])), ...(t.node ? { [t.node]: `${t.name}: one writer allowed, ${t.writerCount} listed` } : {}) },
      locations: [],
      fix: [
        `Single-writer check: floorplan/targets.json says only one part may write to the ${t.kind} "${t.name}"${box && box !== t.name ? ` (${box} on the map)` : ''}, but it lists ${t.writerCount} writers:`,
        ...writers.map((w) => `- ${w.ref}: ${and(w.items.slice(0, 6).map((x) => `${itemName(x)} (${itemPath(x)})`))}${w.items.length > 6 ? ` and ${w.items.length - 6} more` : ''}`),
        ``,
        `For each of them, find where and what it writes to ${t.name}. Then propose which one should own all the writing, and how the others would hand their changes to it instead (for example by calling it). Show me the plan first, and don't change any code until I agree. If one of them doesn't really write there, say so, and I'll move it to "readers" in floorplan/targets.json.`,
      ].join('\n'),
    });
  }
  for (const node of new Set(targets.filter((x) => x.node && x.undeclared?.length).map((x) => x.node))) {
    const t = targets.find((x) => x.node === node);
    const ext = label(node.slice(2));
    const names = targets.filter((x) => x.node === node).map((x) => x.name);
    const parts = t.undeclared;
    const calls = parts.flatMap((u) => u.calls.map((c) => ({ ...c, part: u.part })));
    const how = { write: 'sends changes', read: 'reads', unknown: 'direction unknown' };
    const notes = {};
    for (const c of calls) { const k = 'f:' + c.file; notes[k] = (notes[k] ? notes[k] + ' · ' : '') + `${c.method ? `${c.method} request` : 'uses its package'} on line ${c.line}, not in targets.json`; }
    issues.push({
      id: 'undeclared-target-call:' + node, kind: 'undeclared-target-call', severity: 'low',
      title: parts.length === 1 ? `Detected call from ${itemName(parts[0].part)} to ${ext} not declared as reader or writer` : `Detected calls from ${parts.length} parts to ${ext} not declared as readers or writers`,
      detail: `The scan saw ${and(parts.map((u) => `${itemName(u.part)} (${how[u.dir] || how.unknown})`))} call ${ext}, but floorplan/targets.json doesn’t list ${parts.length === 1 ? 'it' : 'them'} as a writer or reader of ${and(names)}. Only the parts listed there are counted, so a writer missing from the list can break a one-writer rule without anyone noticing.`,
      items: [...new Set(calls.map((c) => 'f:' + c.file))].slice(0, 23).concat(node),
      notes, locations: calls.map((c) => ({ file: c.file, line: c.line })),
      fix: [
        `Targets check: the scan found these calls to ${ext}, from parts that floorplan/targets.json doesn't list as writers or readers of ${and(names.map((n) => `"${n}"`))}:`,
        ...calls.map((c) => `- ${c.file}:${c.line}${c.method ? ` (${c.method})` : ' (imports its package)'}, in ${itemName(c.part)}`),
        ``,
        `For each one, read the code and tell me whether it writes to ${ext} (creates, changes or deletes something there) or only reads from it. Then add the part's id or the file's path to that target's "writers" or "readers" in floorplan/targets.json, and update the floorplan. If that gives a single-writer target a second writer, tell me instead of changing the code.`,
      ].join('\n'),
    });
  }

  // ---------- rules and decisions (graph.rules, from floorplan/rules.json) ----------
  // A retired rule that still names places: either the code there still follows the old rule, or the entry wasn't
  // cleaned up. Minor, so the owner sees what is left to tidy; the refs themselves were checked by the build.
  const targetBox = (id) => targets.find((x) => x.id === id)?.node || null;
  const boxOf = (item) => (item.startsWith('t:') ? targetBox(item.slice(2)) : item);
  const placeName = (item) => (item.startsWith('t:') ? targets.find((x) => x.id === item.slice(2))?.name || item.slice(2) : item.startsWith('r:') ? `${graph.routes[+item.slice(2)]?.m} ${graph.routes[+item.slice(2)]?.p}` : itemName(item));
  for (const r of (graph.rules || []).filter((x) => x.status === 'retired' && x.items.length)) {
    const boxes = [...new Set(r.items.map(boxOf).filter(Boolean))];
    const names = r.items.map(placeName);
    issues.push({
      id: 'retired-rule:' + r.id, kind: 'retired-rule', severity: 'low',
      title: `Retired rule still applied: ${r.title}`,
      detail: `floorplan/rules.json retires “${r.title}”${r.until ? ` (until ${r.until})` : ''}, but it still applies to ${plural(r.items.length, 'place')}: ${and(names)}. Either the code there still follows the old rule, or the entry just wasn't cleaned up. Source: ${r.source}.`,
      items: boxes.slice(0, 24),
      notes: Object.fromEntries(boxes.slice(0, 24).map((x) => [x, `Still listed under the retired ${r.kind} “${r.title}”`])),
      locations: [],
      fix: [
        `Retired rule check: floorplan/rules.json says the ${r.kind} "${r.title}" (${r.source}) is retired${r.until ? ` since ${r.until}` : ''}, but it still applies to:`,
        ...r.items.map((x) => `- ${placeName(x)}${boxOf(x) && !x.startsWith('t:') ? ` (${itemPath(x.startsWith('r:') ? 'f:' + graph.routes[+x.slice(2)]?.f : x)})` : ''}`),
        ``,
        `The rule said: ${r.text}`,
        ``,
        `For each place, read the code and tell me whether it still follows the retired rule. If it does, propose what to change so it follows what replaced it (the source says where that is written), and show me the plan before changing any code. If it doesn't, remove the place from the rule's "applies" in floorplan/rules.json, or delete the rule, and update the floorplan.`,
      ].join('\n'),
    });
  }

  const KIND_ORDER = ['secret', 'public-env-secret', 'database-rules', 'stripe-webhook', 'env-file', 'unprotected-endpoint', 'single-writer', 'cors', 'large-file', 'hardcoded-url', 'unused-file', 'undeclared-target-call', 'retired-rule'];
  issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.locations?.length || 0) - (a.locations?.length || 0));
  const kept = issues.slice(0, 40);
  const summary = { high: 0, medium: 0, low: 0 };
  for (const i of kept) summary[i.severity]++;
  if (!layers) return { summary, issues: kept };
  // a group of its own: counted apart from the checks above, and never pushing one of them off the list
  const pub = publishIssues({ scan, root, layers, itemFor, nameOf, findings });
  return { summary, issues: [...kept, ...pub.issues], publish: pub.summary };
}

// ---------- publishability (floorplan/layers.json) ----------
// What would keep the system from being published, by the layers in floorplan/layers.json: ids, folders and contact
// details of this one installation in system files, words from the owner's private list (kept outside the repo) in
// system and setup files, and system code that imports content. The finders are in lib/layers.mjs. One issue per
// check and layer; each place is a file and a line, never a value: only its kind, or a private word's first letter.
const PUBLISH_ORDER = ['layer-mixing', 'private-word', 'hardcoded-identifier', 'contact-data', 'machine-path'];
const PUBLISH_KIND = { identifier: 'hardcoded-identifier', 'private-word': 'private-word', contact: 'contact-data', path: 'machine-path' };
const isKnownKey = (s) => FORMATS.some((fm) => { fm.re.lastIndex = 0; const hit = fm.re.test(s); fm.re.lastIndex = 0; return hit; });
function publishIssues({ scan, root, layers, itemFor, nameOf, findings }) {
  const { layerOf } = layers;
  const find = wordFinder(layers.words);
  const hits = new Map(); // "kind|layer" -> [{ file, line, what }]
  const add = (kind, layer, x) => { const k = `${kind}|${layer}`; if (!hits.has(k)) hits.set(k, []); hits.get(k).push(x); };
  for (const f of scan.files) {
    if (!['code', 'config', 'docs'].includes(f.category) || f.tooLarge || f.path === layers.wordsFile) continue;
    const layer = layerOf(f.path);
    if (layer !== 'system' && layer !== 'config') continue;
    let src;
    try { src = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
    // lines with a secret are the secret check's: the identifier check doesn't report them again
    const secretLines = new Set(findings(f.path).filter((x) => x.k === 'secret').map((x) => x.line));
    for (const x of findPublishable(src, f, { layer, find, test: TEST_FILE.test(f.path), skipLines: secretLines, known: isKnownKey })) add(PUBLISH_KIND[x.k], layer, { file: f.path, line: x.line, what: x.what || x.mask });
  }
  // system code that imports a content file (the setup is there to be imported, content isn't); tests left out
  for (const e of scan.edges || []) if (layerOf(e.from) === 'system' && layerOf(e.to) === 'content' && !TEST_FILE.test(e.from)) add('layer-mixing', 'system', { file: e.from, line: e.line || 1, what: e.to });

  const patterns = (id) => layers.list.find((l) => l.id === id)?.patterns || [];
  const where = (id) => (patterns(id).length ? `layers.json patterns: ${patterns(id).join(', ')}` : 'add patterns for it to layers.json');
  const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const summary = { system: 0, config: 0, words: layers.wordsStatus };
  const out = [];
  for (const [key, all] of hits) {
    const [kind, layer] = key.split('|');
    summary[layer] += all.length;
    all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const n = all.length;
    const files = [...new Set(all.map((x) => x.file))];
    const one = files.length === 1 ? files[0] : null;
    const filesText = one ? `${nameOf(one)} (${one})` : plural(files.length, 'file');
    const verb = (s, p) => (one ? s : p);
    const kinds = [...new Set(all.map((x) => x.what))];
    // "a UUID-style id and 2 32-character ids", "an email address and a phone number"
    const many = (what) => {
      const c = all.filter((x) => x.what === what).length;
      if (c === 1) return what;
      const w = what.replace(/^an? /, ''), at = / on /.test(w) ? w.indexOf(' on ') : w.includes(' (') ? w.indexOf(' (') : w.length;
      return `${c} ${w.slice(0, at)}${/(s|sh|ch|x)$/.test(w.slice(0, at)) ? 'es' : 's'}${w.slice(at)}`;
    };
    const counted = and(kinds.map(many));
    const items = [], noted = new Map();
    for (const x of all) {
      const it = itemFor(x.file);
      if (!it) continue;
      if (!items.includes(it)) items.push(it);
      if (!noted.has(it)) noted.set(it, []);
      const at = it === 'f:' + x.file ? `line ${x.line}` : `${x.file.split('/').pop()}, line ${x.line}`;
      noted.get(it).push(`${at}: ${kind === 'layer-mixing' ? `imports ${x.what}` : x.what}`);
    }
    const shown = items.slice(0, 24);
    const notes = Object.fromEntries(shown.map((it) => { const l = noted.get(it); return [it, l.slice(0, 4).join(' · ') + (l.length > 4 ? ` · +${l.length - 4} more` : '')]; }));
    const places = [...all.slice(0, 60).map((x) => `- ${x.file}:${x.line}: ${kind === 'layer-mixing' ? `imports ${x.what}` : x.what}`), ...(n > 60 ? [`- …and ${n - 60} more`] : [])];
    const setup = layer === 'config';
    const text = {
      'hardcoded-identifier': {
        severity: 'medium',
        title: n === 1 ? 'An identifier of one installation sits in system code' : `${n} identifiers of one installation sit in system code`,
        detail: `${filesText} ${verb('holds', 'hold')} ${counted}. An identifier of one installation sits in system code: anyone who installs the system would be pointed at this installation's database, calendar, documents or accounts. Move ${n === 1 ? 'it' : 'them'} to configuration, like an environment variable or a setup file in the config layer.`,
        fix: [
          `Publishability fix: identifiers of one installation in system code. Do not print, echo or repeat any of these values in your replies, commits or logs.`,
          ``,
          `floorplan/layers.json puts these files in the system layer, the part that could be published. They contain ids that belong to this one installation:`,
          ...places,
          ``,
          `For each one:`,
          `1. Find out what the id stands for (a database, a calendar, a document, an account) and give it a clear setting name, for example ORDERS_DATABASE_ID.`,
          `2. Read it from configuration instead: an environment variable, or a setup file in the config layer (${where('config')}). If the code can't run without it, stop with a clear message when it's missing; don't fall back to the old value.`,
          `3. Add the setting's name, never its value, to .env.example or an example setup file, so someone installing the system knows what to fill in.`,
          `If an id is the same for everyone (a fixed id of a public service), leave it and tell me why.`,
        ],
      },
      'private-word': {
        severity: 'medium',
        title: n === 1 ? `A name from your private word list is in ${setup ? 'a setup file' : 'system files'}` : `Names from your private word list are in ${setup ? 'setup files' : 'system files'} (${n} places)`,
        detail: `${filesText} ${verb('contains', 'contain')} ${n === 1 ? 'a word' : 'words'} from your private word list (${and([...new Set(all.flatMap((x) => x.what.split(', ')))])}). ${setup
          ? 'These are setup files, the part someone else replaces with their own, so names of customers, people and places belong in your content instead.'
          : 'These files are the system you could publish, so the names would go out with it.'} Only each word's first letter is shown; the list itself stays on your computer.`,
        fix: [
          `Publishability fix: words from my private word list in ${setup ? 'setup files (the config layer)' : 'system files'}. The list itself stays outside the repo. Never write any of these words in your replies, commits, logs or new files; I know which ones they are.`,
          ``,
          `These lines contain a private word (the name of a customer, a person or a place), shown by its first letter:`,
          ...places,
          ``,
          setup
            ? `Setup is what someone else would replace with their own, so names don't belong here. For each line, move the name into the content layer (${where('content')}) and have the setup point at it, or replace it with a neutral placeholder.`
            : `For each line, replace the name with a neutral or made-up one (in comments, docs, tests and examples), or, where the code needs the real value, move it into the content layer (${where('content')}) and read it from there.`,
          `Don't change what the code does. Then tell me which files you changed, without naming the words.`,
        ],
      },
      'contact-data': {
        severity: 'low',
        title: n === 1 ? `Contact details are written into ${nameOf(all[0].file)}` : `Contact details are written into system code (${n} places)`,
        detail: `${filesText} ${verb('contains', 'contain')} ${counted}, most likely this installation's own or a person's. ${n === 1 ? 'It' : 'They'} would be published with the system. Addresses at example.com and noreply addresses don't count.`,
        fix: [
          `Publishability fix: contact details in system code. Do not repeat the addresses or numbers in your replies, commits or logs.`,
          ``,
          `These lines in the system layer contain an email address or a phone number:`,
          ...places,
          ``,
          `For each one, tell me whose it is: this installation's own, a customer's or another person's, or a public address that's meant to ship with the system. Move the ones that belong to this installation or to people into configuration (an environment variable, or a setup file in the config layer: ${where('config')}) or into content, and keep a placeholder like name@example.com where the code needs an example. Show me the plan before changing code.`,
        ],
      },
      'machine-path': {
        severity: 'low',
        title: n === 1 ? 'System code points at a folder on one computer' : `System code points at folders on one computer (${n} places)`,
        detail: `${filesText} ${verb('uses', 'use')} ${counted}. A folder like that exists only on this computer, so on anyone else's the system can't find it. Read it from configuration instead, or build it relative to the project.`,
        fix: [
          `Publishability fix: absolute paths of one computer in system code.`,
          ``,
          `These lines in the system layer use a folder that exists only on this machine:`,
          ...places,
          ``,
          `For each one, read the folder from configuration instead (an environment variable, or a setting in the config layer: ${where('config')}), or build it relative to the project or the user's home folder (path.join(os.homedir(), …) in Node, Path.home() in Python). Keep today's folder as this installation's setting, so nothing changes here. Then run the app or its tests to check that it still finds its files.`,
        ],
      },
      'layer-mixing': {
        severity: 'medium',
        title: n === 1 ? 'System code imports a content file' : `System code imports content files (${n} places)`,
        detail: `${filesText} ${verb('imports', 'import')} ${kinds.length === 1 ? kinds[0] : plural(kinds.length, 'file')} from the content layer. System depends on content: the system will not run without this owner's content.`,
        fix: [
          `Publishability fix: system code imports content. floorplan/layers.json puts these files in the system layer, and what they import in the content layer, the owner's own data:`,
          ...places,
          ``,
          `The system depends on content, so it will not run without this owner's content. For each import, tell me what the code needs from the file. Then propose one of: load the content at run time from a place the setup names (a path in configuration), or move what the code really needs (a schema, defaults, an example with made-up data) into the system. Show me the plan first, and don't change any code until I agree.`,
        ],
      },
    }[kind];
    out.push({
      id: `publish:${kind}:${layer}`, kind, severity: text.severity, group: 'publish', layer,
      title: text.title, detail: text.detail, items: shown, notes,
      locations: all.slice(0, 200).map(({ file, line }) => ({ file, line })),
      fix: text.fix.join('\n'),
    });
  }
  out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || PUBLISH_ORDER.indexOf(a.kind) - PUBLISH_ORDER.indexOf(b.kind) || (a.layer === 'system' ? -1 : 1));
  return { issues: out, summary };
}

/** Test mode, in Firestore/Storage rules (request.time < timestamp.date(Y, M, D)) or Realtime Database rules (now < ms). */
const testModeEnd = (cond) => {
  const d = /^request\.time\s*<\s*timestamp\.date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)$/.exec(cond);
  if (d) return new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
  const ms = /^now\s*<\s*(\d{12,14})$/.exec(cond);
  return ms ? new Date(+ms[1]) : null;
};

/** Firestore / Storage rules that let anyone in: `allow …: if true`, `allow …;` (no condition) and test mode. */
function firebaseRules(src, now) {
  const s = src.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  const at = lineIndex(s);
  const matches = [...s.matchAll(/\bmatch\s+(\/\S*)\s*\{/g)].map((m) => ({ i: m.index, path: m[1] }));
  const out = [];
  for (const m of s.matchAll(/\ballow\s+([a-z][a-z,\s]*?)\s*(?::\s*if\s+([^;]+?))?\s*;/g)) {
    const ops = m[1].split(/[\s,]+/).filter(Boolean);
    const cond = (m[2] || 'true').trim().replace(/\s+/g, ' ');
    const end = cond === 'true' ? null : testModeEnd(cond);
    if (cond !== 'true' && !end) continue;
    const where = matches.filter((x) => x.i < m.index).pop()?.path || '/';
    const writeOps = ops.filter((o) => /^(write|create|update|delete)$/.test(o));
    out.push({
      line: at(m.index), text: `allow ${ops.join(', ')}${m[2] ? `: if ${cond}` : ' (no condition)'} at ${where}`,
      read: ops.some((o) => /^(read|get|list)$/.test(o)), write: writeOps.length > 0, createOnly: writeOps.length > 0 && writeOps.every((o) => o === 'create'),
      open: !end ? 'always' : end > now ? 'until' : 'expired', until: end, where,
      wide: /=\*\*\}/.test(where) || /\/documents$/.test(where) || where === '/',
    });
  }
  return out;
}

/** Realtime Database rules (database.rules.json) with ".read" / ".write" set to true or test mode. */
function firebaseRtdbRules(src, now) {
  const s = src.replace(/(^|[^:"])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
  const at = lineIndex(s);
  const out = [];
  for (const m of s.matchAll(/"\.(read|write)"\s*:\s*(true\b|"([^"]*)")/g)) {
    const cond = m[2] === 'true' ? 'true' : (m[3] || '').trim();
    const end = cond === 'true' ? null : testModeEnd(cond);
    if (cond !== 'true' && !end) continue;
    // how deep it sits: { "rules": { ".read": … } } is the whole database
    let depth = 0;
    for (let i = 0; i < m.index; i++) { if (s[i] === '{') depth++; else if (s[i] === '}') depth--; }
    const keys = [...s.slice(0, m.index).matchAll(/"([^".][^"]*)"\s*:\s*\{/g)].map((k) => k[1]);
    const where = depth <= 2 ? 'the whole database' : '/' + keys.slice(-(depth - 2)).join('/');
    out.push({
      line: at(m.index), text: `"${m[1] === 'read' ? '.read' : '.write'}": ${m[2]} for ${where}`,
      read: m[1] === 'read', write: m[1] === 'write', createOnly: false,
      open: !end ? 'always' : end > now ? 'until' : 'expired', until: end, where, wide: depth <= 2, root: depth <= 2,
    });
  }
  return out;
}

function readHead(file, max) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(max); const n = fs.readSync(fd, buf, 0, max, 0); return buf.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function stemOf(p) {
  const base = p.split('/').pop().replace(/\.[^.]+$/, '');
  return base === 'index' ? p.split('/').slice(-2, -1)[0] : base;
}
