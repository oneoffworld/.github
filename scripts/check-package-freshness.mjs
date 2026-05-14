#!/usr/bin/env node
/**
 * check-package-freshness.mjs
 *
 * Supply-chain hardening for npm: fail if package-lock.json contains any
 * dependency whose specific resolved version was published less than
 * MIN_AGE_DAYS ago on the npm registry.
 *
 * Rationale: compromised package versions (recent axios / chalk / debug
 * incidents, Shai-Hulud, etc.) are typically detected, reported, and
 * yanked from the registry within a week. Refusing to install brand-new
 * versions provides cheap, broad protection.
 *
 * This is the npm equivalent of Bun's `install.minimumReleaseAge` and
 * pnpm 10.16+'s `minimumReleaseAge`.
 *
 * Usage:
 *   node check-package-freshness.mjs
 *   MIN_AGE_DAYS=14 node check-package-freshness.mjs
 *   ALLOW_FRESH=react,react-dom node check-package-freshness.mjs
 *   LOCKFILE=/path/to/package-lock.json node check-package-freshness.mjs
 *
 * By default the lockfile is resolved as `package-lock.json` in the current
 * working directory, which lets this script live in a shared repo and run
 * against any caller's checkout.
 *
 * Exits 0 if all package versions are old enough (or allow-listed),
 * exits 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCKFILE = process.env.LOCKFILE
  ? resolve(process.env.LOCKFILE)
  : resolve(process.cwd(), 'package-lock.json');

const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS ?? 7);
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const ALLOW_FRESH = new Set(
  (process.env.ALLOW_FRESH ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org';
const CONCURRENCY = Number(process.env.FRESHNESS_CONCURRENCY ?? 16);
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Walk the v3 npm lockfile `packages` map and yield {name, version} for
 * every external dependency we resolved. Skips the workspace root and
 * any local/linked packages.
 */
function* iterDeps(lock) {
  const packages = lock.packages ?? {};
  for (const [path, meta] of Object.entries(packages)) {
    if (path === '') continue; // workspace root
    if (meta.link) continue; // local link
    if (!meta.version) continue;
    if (meta.resolved && !meta.resolved.startsWith('http')) continue;
    // Path looks like "node_modules/foo" or "node_modules/@scope/bar".
    // The package's own `name` field (when present) is authoritative for
    // aliased dependencies.
    const fromPath = path.replace(/^.*node_modules\//, '');
    const name = meta.name ?? fromPath;
    yield { name, version: meta.version };
  }
}

// Cache packument responses across versions of the same package.
const packumentCache = new Map();

async function fetchPackument(name) {
  if (packumentCache.has(name)) return packumentCache.get(name);
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`;
  // Note: do NOT request the abbreviated `application/vnd.npm.install-v1+json`
  // format here — it omits the `time` field we need.
  const promise = (async () => {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err?.name === 'TimeoutError' || signal.aborted) {
        throw new Error(
          `registry request for ${name} timed out after ${FETCH_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    }
    if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
    return res.json();
  })();
  packumentCache.set(name, promise);
  return promise;
}

async function fetchPublishTime(name, version) {
  const json = await fetchPackument(name);
  const t = json.time?.[version];
  if (!t) throw new Error(`no publish time for ${name}@${version}`);
  return new Date(t).getTime();
}

async function pool(items, worker, size) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx]);
      } catch (err) {
        results[idx] = { error: err, item: items[idx] };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
  if (lock.lockfileVersion < 2) {
    console.error(
      `package-lock.json lockfileVersion=${lock.lockfileVersion} not supported (need v2+)`,
    );
    process.exit(2);
  }

  // Dedupe (name, version) pairs across the tree.
  const seen = new Map();
  for (const { name, version } of iterDeps(lock)) {
    seen.set(`${name}@${version}`, { name, version });
  }
  const deps = [...seen.values()];
  console.log(`Checking publish dates for ${deps.length} unique packages…`);

  const now = Date.now();
  const tooFresh = [];
  const errors = [];

  await pool(
    deps,
    async ({ name, version }) => {
      if (ALLOW_FRESH.has(name)) return;
      try {
        const publishedAt = await fetchPublishTime(name, version);
        const ageMs = now - publishedAt;
        if (ageMs < MIN_AGE_MS) {
          tooFresh.push({
            name,
            version,
            ageDays: (ageMs / 86_400_000).toFixed(1),
            publishedAt: new Date(publishedAt).toISOString(),
          });
        }
      } catch (err) {
        errors.push({ name, version, error: err.message });
      }
    },
    CONCURRENCY,
  );

  if (errors.length) {
    console.warn(`\n${errors.length} package(s) could not be checked:`);
    for (const e of errors) console.warn(`  - ${e.name}@${e.version}: ${e.error}`);
  }

  if (tooFresh.length) {
    console.error(
      `\nFAIL: ${tooFresh.length} package version(s) published < ${MIN_AGE_DAYS} days ago:`,
    );
    for (const p of tooFresh) {
      console.error(
        `  - ${p.name}@${p.version}  (${p.ageDays}d old, published ${p.publishedAt})`,
      );
    }
    console.error(
      `\nIf you genuinely need one of these, add it to ALLOW_FRESH (comma-separated)\n` +
      `or wait until it is at least ${MIN_AGE_DAYS} days old.`,
    );
    process.exit(1);
  }

  console.log(`OK: all packages are at least ${MIN_AGE_DAYS} days old.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
