/**
 * Every path the frontend asks for, against every route Express registers.
 *
 * A 404 on a screen is almost always this: the client asks for a path the
 * server never served. Chasing it one screen at a time finds one; comparing
 * the two lists finds all of them in seconds. Run once on 2026-09-09 it turned
 * up five, of which exactly one had been reported — the other four were
 * buttons that had never worked in production and quietly toasted a failure.
 *
 * THE BUG CLASS IT CATCHES. A component rolls its own `useMutation` +
 * `apiPost` instead of using the shared hook, and gets the path or the verb
 * wrong. Two of the five were exactly that, and in both a CORRECT
 * implementation already existed as a hook another screen used — so the same
 * button worked in one place and had never once worked in the other. When this
 * check flags something, look for an existing hook before correcting the path.
 *
 * WHY A BASELINE. Some gaps need a product decision rather than a path fix —
 * an endpoint that was never built, hooks left behind by a module that was
 * replaced. A check that is red on the day it ships gets ignored, so those are
 * listed in known-route-gaps.json and this fails only on something NEW. Same
 * ratchet as the ESLint block: never add to it to make a build pass. Leaving an
 * entry behind once it is fixed is also an error — a baseline nobody prunes
 * stops describing anything.
 *
 * WHAT IT CANNOT SEE. A path built from a variable (`apiGet(url)`) is skipped:
 * there is no string to check. Everything written inline, which is nearly all
 * of it, is checked.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { app } from '../src/app';

const API_PREFIX = '/api/v1';
const BACKEND_ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'known-route-gaps.json');

/**
 * The frontend is a SEPARATE repository, checked out beside this one. Point
 * FRONTEND_SRC somewhere else if it lives anywhere but ../frontend/src.
 */
const FRONTEND_SRC =
  process.env.FRONTEND_SRC ?? path.resolve(BACKEND_ROOT, '..', 'frontend', 'src');

/**
 * What a `${...}` in a path becomes at runtime. Two shapes reach here and they
 * are opposites:
 *
 *   `/hr/leaves/${id}/${approve ? 'approve' : 'reject'}` — the last segment is
 *   a LITERAL, which the server declares as a fixed word;
 *
 *   `/nursing-forms/${id}` — the segment carries a value, and must line up
 *   with a `:param`.
 *
 * Treating both as a wildcard stops the first being noise and stops the second
 * being reported — and the second is a real 404. An interpolation containing a
 * quoted string is choosing between literals; one that does not is carrying a
 * value. That separates them without evaluating anything.
 */
const PARAM = '\u0001';
const LITERAL = '\u0002';

function interpolationKind(expr: string): string {
  return /['"`]/.test(expr) ? LITERAL : PARAM;
}

// ── 1. What the server serves ───────────────────────────────────────────────

interface Registered {
  method: string;
  path: string;
  segments: string[];
}

/**
 * A router mounted at /patients with a '/' route registers '/patients/', while
 * the client calls '/patients'. Same route; strip the trailing slash so the
 * two compare equal.
 */
function normalise(p: string): string {
  const bare = p.split('?')[0];
  return bare.length > 1 && bare.endsWith('/') ? bare.slice(0, -1) : bare;
}

/** Express keeps a mounted router's prefix as a regexp; recover the literal. */
function decodePrefix(layer: { regexp: RegExp; path?: string }): string {
  if (layer.path) return layer.path;
  const src = layer.regexp.source;
  if (src === String.raw`^\/?(?=\/|$)`) return '';
  let s = src;
  if (s.startsWith('^')) s = s.slice(1);
  s = s.replace(String.raw`\/?(?=\/|$)`, '');
  return s.split(String.raw`\/`).join('/');
}

function collectRoutes(): Registered[] {
  const out: Registered[] = [];
  const walk = (stack: unknown[], prefix: string) => {
    for (const raw of stack ?? []) {
      const layer = raw as {
        route?: { path: string; methods: Record<string, boolean> };
        name?: string;
        regexp: RegExp;
        path?: string;
        handle?: { stack?: unknown[] };
      };
      if (layer.route) {
        const full = prefix + layer.route.path;
        if (!full.startsWith(API_PREFIX)) continue;
        const p = normalise(full.slice(API_PREFIX.length));
        for (const m of Object.keys(layer.route.methods)) {
          if (!layer.route.methods[m]) continue;
          out.push({ method: m.toUpperCase(), path: p, segments: p.split('/') });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + decodePrefix(layer));
      }
    }
  };
  const a = app as unknown as { _router?: { stack: unknown[] }; router?: { stack: unknown[] } };
  walk(a._router?.stack ?? a.router?.stack ?? [], '');
  return out;
}

// ── 2. What the client asks for ─────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  segments: string[];
  /** True when only a prefix is known, because a nested template cut it short. */
  prefixOnly: boolean;
  where: string[];
}

const CALL_RE = /api(Get|Post|Patch|Put|Delete)\s*(?:<[^>(]*>)?\s*\(\s*([`'"])(.*?)\2/gs;
const METHODS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Patch: 'PATCH',
  Put: 'PUT',
  Delete: 'DELETE',
};

/** Every .ts/.tsx under the frontend, tests excluded — a test may call anything. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      acc.push(full);
    }
  }
  return acc;
}

function collectCalls(): Call[] {
  const byKey = new Map<string, Call>();
  for (const file of sourceFiles(FRONTEND_SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL_RE)) {
      let raw = m[3];
      if (!raw.startsWith('/')) continue; // computed elsewhere; nothing to check
      // A nested template literal — `${qs ? `?${qs}` : ''}` — ends the capture
      // at the inner backtick, so the braces do not balance. Keep the prefix.
      const prefixOnly = (raw.match(/\$\{/g) ?? []).length !== (raw.match(/\}/g) ?? []).length;
      if (prefixOnly) raw = raw.slice(0, raw.indexOf('${'));
      const p = normalise(raw.replace(/\$\{[^{}]*\}/g, (expr) => interpolationKind(expr)));
      const method = METHODS[m[1]];
      const line = src.slice(0, m.index).split('\n').length;
      const rel = path.relative(FRONTEND_SRC, file).split(path.sep).join('/');
      const key = `${method} ${p} ${prefixOnly}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.where.push(`${rel}:${line}`);
      } else {
        byKey.set(key, {
          method,
          path: p,
          segments: p.split('/'),
          prefixOnly,
          where: [`${rel}:${line}`],
        });
      }
    }
  }
  return [...byKey.values()];
}

// ── 3. Compare ──────────────────────────────────────────────────────────────

/**
 * A client segment lines up with a server one.
 *
 * A value-carrying `${id}` must meet a `:param`; a segment chosen between
 * quoted literals may meet anything. Getting this wrong in either direction
 * makes the report noisy or blind, and both get it ignored.
 */
function segmentsMatch(call: string[], route: string[]): boolean {
  if (call.length !== route.length) return false;
  return call.every((c, i) => {
    if (c === PARAM) return route[i].startsWith(':');
    if (c === LITERAL) return true;
    return route[i].startsWith(':') || route[i] === c;
  });
}

function servedBy(call: Call, routes: Registered[]): string[] {
  const hit = call.prefixOnly
    ? routes.filter((r) => r.path.startsWith(call.path))
    : routes.filter((r) => segmentsMatch(call.segments, r.segments));
  return [...new Set(hit.map((r) => r.method))].sort();
}

interface Gap {
  method: string;
  path: string;
  where: string[];
  servedAs: string[];
}

// ── 4. The ratchet ──────────────────────────────────────────────────────────

interface BaselineEntry {
  method: string;
  path: string;
  /** Why it is still here. An entry without one is an entry nobody owns. */
  reason: string;
}

function loadBaseline(): BaselineEntry[] {
  if (!fs.existsSync(BASELINE)) return [];
  return (JSON.parse(fs.readFileSync(BASELINE, 'utf8')).known ?? []) as BaselineEntry[];
}

/** The sentinels back into something a person can read. */
function show(p: string): string {
  return p.split(PARAM).join('${id}').split(LITERAL).join('${…}');
}

function main(): void {
  if (!fs.existsSync(FRONTEND_SRC)) {
    console.error(`Cannot read the frontend at ${FRONTEND_SRC}.`);
    console.error('It is a separate repository — check it out beside this one,');
    console.error('or set FRONTEND_SRC to where it lives.');
    process.exit(1);
  }

  const routes = collectRoutes();
  const calls = collectCalls();

  const gaps: Gap[] = [];
  for (const call of calls) {
    const servedAs = servedBy(call, routes);
    if (servedAs.includes(call.method)) continue;
    gaps.push({ method: call.method, path: call.path, where: call.where, servedAs });
  }

  const baseline = loadBaseline();
  // Keyed on the READABLE path, because the baseline is a file people edit —
  // it holds `/nursing-forms/${id}`, not the sentinel the matcher works in.
  const key = (m: string, p: string) => `${m} ${p}`;
  const accepted = new Set(baseline.map((b) => key(b.method, b.path)));
  const live = new Set(gaps.map((g) => key(g.method, show(g.path))));

  const fresh = gaps.filter((g) => !accepted.has(key(g.method, show(g.path))));
  const stale = baseline.filter((b) => !live.has(key(b.method, b.path)));

  console.log(
    `${calls.length} frontend calls checked against ${routes.length} registered routes` +
      ` — ${gaps.length} gap(s), ${baseline.length} accepted\n`,
  );

  if (fresh.length) {
    console.error(`${fresh.length} CALL(S) THE SERVER DOES NOT SERVE:\n`);
    for (const g of fresh) {
      console.error(`  ${g.method.padEnd(6)} ${show(g.path)}`);
      console.error(
        g.servedAs.length
          ? `         this path IS served, but as ${g.servedAs.join(', ')} — wrong verb`
          : '         nothing is served at this path',
      );
      for (const w of g.where.slice(0, 5)) console.error(`         ${w}`);
      console.error('');
    }
    console.error('Look for an existing hook that already calls this endpoint before');
    console.error('correcting the path inline — usually one exists and works.\n');
  }

  if (stale.length) {
    const rel = path.relative(BACKEND_ROOT, BASELINE).split(path.sep).join('/');
    console.error(`${stale.length} BASELINE ENTR(IES) NO LONGER BROKEN — delete them from ${rel}:\n`);
    for (const b of stale) console.error(`  ${b.method.padEnd(6)} ${b.path}`);
    console.error('');
  }

  if (fresh.length || stale.length) process.exit(1);

  if (baseline.length) {
    console.log('No new gaps. Still accepted, each needing a decision rather than a path fix:');
    for (const b of baseline) console.log(`  ${b.method.padEnd(6)} ${b.path} — ${b.reason}`);
  } else {
    console.log('Every frontend call matches a registered route.');
  }
}

main();
process.exit(0);
