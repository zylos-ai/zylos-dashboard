/**
 * What `import Database from 'better-sqlite3'` resolves to while
 * `source-access-observer.cjs` is preloaded: the observed subclass it built.
 *
 * Kept as its own file because the redirect has to point at a module *path*. It
 * holds no logic of its own on purpose — the subclass is constructed in the
 * observer, so there is exactly one place where "what counts as an access" lives.
 */
'use strict';

const observer = globalThis.__sourceAccessObserver;
if (!observer || !observer.ObservedDatabase) {
  throw new Error('source-access-observer-sqlite loaded without the observer preloaded');
}

module.exports = observer.ObservedDatabase;
