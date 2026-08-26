/**
 * Loader hooks for `source-access-observer.cjs`: they redirect the
 * `better-sqlite3` specifier to the observer's subclass, so an `import` in the
 * script under observation goes through it.
 *
 * Loaded two different ways, because one API does not cover the range the package
 * claims to support (`engines.node: >=20`, which means 20.0.0):
 *
 *   - `module.register(...)`, from Node 20.6 onwards. That call passes `data`, so
 *     `initialize` runs and hands over the redirect target.
 *   - `--experimental-loader`, on 20.0.0-20.5.x, where `module.register` does not
 *     exist yet. The flag form has no way to pass data and never calls
 *     `initialize` — measured, not assumed — so the redirect target has to be
 *     worked out here.
 *
 * Hence the default below, rather than an assignment inside `initialize`: it is
 * what makes one file serve both mechanisms. The two files sit side by side, so
 * `import.meta.url` is enough to find the sibling — nothing to configure, nothing
 * to go stale if the directory moves.
 *
 * These hooks run on their own thread and hold no observer state. The redirect
 * target reads the subclass off `globalThis` in the main thread, where the preload
 * built it.
 */

let redirect = new URL('./source-access-observer-sqlite.cjs', import.meta.url).href;

export function initialize(data) {
  if (data && data.redirect) redirect = data.redirect;
}

export function resolve(specifier, context, nextResolve) {
  const from = String((context && context.parentURL) || '');
  // The redirect target imports the real package; letting that request through is
  // what keeps this from resolving to itself.
  if (redirect && specifier === 'better-sqlite3' && !from.includes('source-access-observer')) {
    return { url: redirect, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
