/**
 * Loader hooks for `source-access-observer.cjs`: they redirect the
 * `better-sqlite3` specifier to the observer's subclass, so an `import` in the
 * script under observation goes through it.
 *
 * Registered with `module.register`, which exists from Node 20.6 and therefore
 * covers the whole range the repo claims to support (`engines.node: >=20`). These
 * hooks run on their own thread and hold no observer state — the redirect target
 * reads the subclass off `globalThis` in the main thread, where it was built.
 */

let redirect;

export function initialize(data) {
  redirect = data?.redirect;
}

export function resolve(specifier, context, nextResolve) {
  const from = String(context?.parentURL || '');
  // The redirect target imports the real package; letting that request through is
  // what keeps this from resolving to itself.
  if (redirect && specifier === 'better-sqlite3' && !from.includes('source-access-observer')) {
    return { url: redirect, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
