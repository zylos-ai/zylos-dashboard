/**
 * Records every access the restore script's own JavaScript makes to one watched
 * path, so a test can assert what the script does to the *source backup* after it
 * has built the frozen artifact — instead of asserting on what the script prints,
 * which a silent access would sail straight past.
 *
 * Preloaded with `node --require`, plus a loader flag on older Node. Build the argv
 * with `observerArgv()` from `source-access-observer-argv.mjs` rather than by hand —
 * it is the one place that knows which mechanism a given Node needs:
 *
 *   node --require scripts/test-support/source-access-observer.cjs scripts/restore-dashboard-db.js ...
 *
 * It sits outside `test/` because `node --test` runs every .js/.cjs it finds there,
 * and a preload has no tests of its own to run.
 *
 * WHAT AN EMPTY LOG DOES AND DOES NOT MEAN
 *
 * This observes three JS-level entry points: the `better-sqlite3` constructor,
 * `fs` functions, and `child_process` spawn/exec. That is the granularity of the
 * claim it can support — "the script opened one SQLite connection on the source,
 * and after that call returned it did not reach for the source again through any
 * of these" — and it is NOT a syscall-level claim. One SQLite connection performs
 * however many low-level reads of the main file and its -wal SQLite decides to;
 * those happen inside native code and are invisible here, by design and not by
 * oversight. Likewise, wrapping `child_process` records the commands the script
 * spawns; it says nothing about what a child process then reads.
 *
 * FAIL-CLOSED
 *
 * A silent observer is worse than none: an assertion of "nothing was recorded"
 * passes just as well when the wrappers were never installed. So the log also
 * carries the accesses that MUST happen (the materialize connection, the
 * `existsSync` probes, the exact pm2 commands), and the test asserts those are
 * present before it asserts anything is absent. If interposition breaks — a Node
 * change to how builtin ESM facades bind named exports, say — those positive
 * assertions fail loudly rather than degrading into a vacuous pass.
 *
 * The same principle governs coverage. Everything this declines to instrument is
 * counted and named in the `observer-ready` line — read-only holder properties,
 * accessor-backed attached properties, anything past the wrapped depth — so the
 * test pins the exclusion set instead of trusting that it is empty. A gap that is
 * reported can be asserted about; a gap that is silently tolerated cannot.
 */
'use strict';

const target = process.env.SOURCE_OBSERVER_TARGET;
const logPath = process.env.SOURCE_OBSERVER_LOG;
if (!target || !logPath) {
  throw new Error('source-access-observer requires SOURCE_OBSERVER_TARGET and SOURCE_OBSERVER_LOG');
}

// `--require` preloads also run on the loader thread — confirmed under both
// `module.register` and `--experimental-loader`. Instrumenting there would log a
// second "ready" line and wrap a thread the script under observation never runs
// on, so only the main thread does any of this.
if (!require('worker_threads').isMainThread) return;

const fs = require('fs');
const childProcess = require('child_process');
const path = require('path');
const { types } = require('util');
const { pathToFileURL, fileURLToPath } = require('url');

/**
 * Phase boundary, named for what it actually is: the flip happens when the SQLite
 * constructor for the source RETURNS — i.e. when the connection is open — which is
 * EARLIER than materialize() returning, since that still runs VACUUM INTO and
 * closes afterwards. The labels used to say "materialize", which implied a later
 * boundary than the code enforces. This one is the more conservative of the two:
 * anything the script does to the source from connection-open onwards is inside
 * the window the "not reached for again" claim covers.
 */
let phase = 'before-source-connection-open';

// Captured before anything below wraps it, so writing the log is never itself an
// observed access.
const appendFileSync = fs.appendFileSync;

const record = (entry) => {
  appendFileSync(logPath, `${JSON.stringify({ phase, ...entry })}\n`);
};

// --- what counts as the watched path -------------------------------------------
//
// Only accesses to the watched path are recorded; the script touches many others.
// So every form `fs` accepts has to be recognised here — a form this does not
// understand is a silent hole in every absence assertion downstream, and review
// found exactly that twice.
//
// The accepted set is `fs.PathLike` as the runtime actually implements it, which
// was measured rather than read off the type declarations:
//
//   string                      a path. NOT a URL, even when it starts with
//                               "file:" — `fs.readFileSync('file:///tmp/x')` gives
//                               ENOENT for a file literally named "file:///tmp/x".
//                               An earlier version url-decoded such strings, which
//                               would have attributed an unrelated read to the
//                               watched path.
//   Buffer                      path bytes, same rule: not url-decoded.
//   URL with protocol "file:"   a path. Other schemes are rejected by fs itself
//                               with ERR_INVALID_URL_SCHEME.
//   url-like plain object       also accepted by fs — `{ protocol: 'file:',
//                               pathname, href, ... }` really does read the file.
//                               Node duck-types here, so recognising only
//                               `instanceof URL` would leave a hole.
//
// Anything else (a plain object, a number fd, undefined) is not a path to the
// watched file, so it is passed straight through and the real function produces
// its own error — ERR_INVALID_ARG_TYPE and friends — unchanged. Deciding "not the
// target" must never turn into deciding "throw differently".
const resolvedTarget = path.resolve(target);

const fileUrlToPath = (value) => {
  try {
    return fileURLToPath(value);
  } catch {
    return null; // not a usable file: URL — let the real function say so
  }
};

/**
 * @returns {{path: string, form: string}|null} the watched path and the argument
 * form it arrived as, or null when the argument is not the watched path.
 */
const targetPathOf = (p) => {
  let candidate = null;
  let form = null;

  if (typeof p === 'string') {
    candidate = p;
    form = 'string';
  } else if (Buffer.isBuffer(p)) {
    candidate = p.toString();
    form = 'Buffer';
  } else if (p instanceof URL) {
    if (p.protocol !== 'file:') return null;
    candidate = fileUrlToPath(p);
    form = 'URL';
  } else if (p && typeof p === 'object' && p.protocol === 'file:' && typeof p.href === 'string') {
    candidate = fileUrlToPath(p.href);
    form = 'url-like';
  }

  if (candidate === null) return null;
  if (candidate !== target && path.resolve(candidate) !== resolvedTarget) return null;
  return { path: candidate, form };
};

// --- better-sqlite3: the connection count that carries the claim ---------------
//
// Interposed by redirecting the `better-sqlite3` specifier through a loader hook.
// Which API installs that hook depends on the Node version and is decided by the
// spawner, in `source-access-observer-argv.mjs`; this file only reports which one
// ended up in effect. Two other approaches were tried and measured first:
//
//   - `require.cache[path].exports = subclass` reaches neither Node 20 nor Node 22:
//     the ESM translation of a CJS package does not read a mutated cache entry back,
//     so `import Database from 'better-sqlite3'` kept receiving the real class while
//     this observer recorded nothing at all.
//   - `module.registerHooks` works, but only from Node 22.15/23.5. On Node 20.20.2
//     it is simply `undefined`, and an observer that throws on load turns the test
//     using it into a failure on a version the package supports.
const sqlitePath = require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', '..')]
});
const RealDatabase = require(sqlitePath);

class ObservedDatabase extends RealDatabase {
  constructor(file, options) {
    const watched = targetPathOf(file);
    if (watched) record({ kind: 'sqlite-open', path: watched.path, form: watched.form });
    super(file, options);
    // The flip happens here — after the constructor has returned successfully.
    if (watched && phase === 'before-source-connection-open') phase = 'after-source-connection-open';
  }
}

// The redirect target reads the subclass back off this handle.
globalThis.__sourceAccessObserver = { ObservedDatabase };

// --- which interposition mechanism is in effect --------------------------------
//
// `module.register` from 20.6; below that the spawner passes `--experimental-loader`
// instead, which cannot be switched on from in here — by the time a preload runs,
// the loader chain is already fixed. So this branch reports rather than chooses,
// and `none` means the flag was expected and did not arrive. That is a hard error
// for the test to assert on: an observer that never installed itself produces the
// same empty log as a clean run, so it must not be reachable as a pass.
const { register } = require('module');
const hooksPath = path.join(__dirname, 'source-access-observer-hooks.mjs');
let mechanism;

if (typeof register === 'function') {
  mechanism = 'register';
  register(pathToFileURL(hooksPath).href, {
    data: { redirect: pathToFileURL(path.join(__dirname, 'source-access-observer-sqlite.cjs')).href }
  });
} else if (process.execArgv.some((arg) => arg.includes('source-access-observer-hooks'))) {
  // The flag form never calls `initialize`; the hooks default their own redirect.
  mechanism = 'experimental-loader';
} else {
  mechanism = 'none';
}

// --- fs: every function the module actually exposes ---------------------------
//
// Enumerated from `fs` and `fs.promises` at load time rather than from a hand-
// written list of the interesting ones. A hand list was the first version and it
// was wrong in a way review demonstrated rather than argued: it named openSync,
// readFileSync, createReadStream and friends, and `fs.openAsBlob(src)` followed by
// `.arrayBuffer()` then read 8,192 real bytes of the watched file while the log
// stayed empty. Any list of "the ones that matter" is a list of the ones somebody
// thought of; the module's own surface is not.
//
// Two things are still not observed here, and neither is a wording problem:
// reads performed inside native code (better-sqlite3's own I/O), and reads
// performed by a child process. Both are real reads of the file that this cannot
// see, which is why the claim is scoped to the script's own JavaScript.
//
// `existsSync`/`stat` answer "is it there", which the script legitimately asks
// about the source before opening it. Reading bytes is a different thing, and the
// two must not be conflated in either direction, so they are classified — with
// anything not recognised as a metadata call treated as an access, because the
// conservative direction is to over-report rather than to miss one.
const METADATA = new Set([
  'exists', 'existsSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'statfs',
  'statfsSync', 'access', 'accessSync', 'realpath', 'realpathSync', 'readlink',
  'readlinkSync', 'watch', 'watchFile', 'unwatchFile'
]);

/**
 * A class must not be wrapped: it is called with `new`, and a plain wrapper
 * function forwarding through `.apply` would throw. Source text is the reliable
 * test — `Function.prototype.toString` on an ES class starts with `class`, while a
 * native function reports `[native code]` — and unlike a capitalised-name rule it
 * also works for the symbol-keyed properties below, whose key spells out
 * "Symbol(...)" and would trip any check that looks at the first letter.
 */
const isClassLike = (value) =>
  typeof value === 'function' && /^\s*class[\s{]/.test(Function.prototype.toString.call(value));

/** Own function properties that describe the wrapper itself, not the wrapped API. */
const FUNCTION_INTRINSIC = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);

/** How deep attached callables are instrumented. `.native` lives at 1. */
const MAX_ATTACHED_DEPTH = 1;

/** Everything declined, in the form `<label>:<reason>`; reported and asserted on. */
const excludedAttached = [];
const wrappedAttached = [];

/**
 * Build a wrapper whose *kind* matches the function it replaces.
 *
 * A plain function forwarding an async function's promise behaves identically to
 * callers — but `util.types.isAsyncFunction` then answers differently, and that is
 * an observable change to the API this is supposed to leave alone. The differential
 * probe caught exactly that on `fs.promises.readFile` (true → false) and it was the
 * only divergence across the whole surface, so it is fixed here rather than
 * documented as acceptable. Generators get the same treatment: `fs.promises.watch`
 * is an async generator function, and delegating with `yield*` preserves both the
 * tag and the iteration protocol.
 */
const makeWrapper = (real, note) => {
  // `util.types` has no isAsyncGeneratorFunction, so the intrinsic tag is the test
  // that covers all four kinds at once.
  switch (Object.prototype.toString.call(real)) {
    case '[object AsyncGeneratorFunction]':
      return async function* (...args) { note(args); yield* real.apply(this, args); };
    case '[object GeneratorFunction]':
      return function* (...args) { note(args); yield* real.apply(this, args); };
    case '[object AsyncFunction]':
      return async function (...args) { note(args); return real.apply(this, args); };
    default:
      return function (...args) { note(args); return real.apply(this, args); };
  }
};

/**
 * Wrap one function, and then instrument the functions hanging off it.
 *
 * That second part is not decoration. The previous version carried attached
 * properties across with `Object.assign(wrapper, real)` so that wrapping would not
 * quietly delete parts of the API — and thereby republished the ORIGINAL,
 * uninstrumented `fs.realpathSync.native` on the wrapper. Review reached the
 * watched file through exactly that. Preserving an API and instrumenting it are
 * two requirements, and satisfying only the first leaves a back door.
 *
 * `Object.assign` was also lossy in a second way, which is why this walks
 * descriptors instead: it copies own *enumerable* keys only, so the symbol-keyed
 * `util.promisify.custom` on `fs.exists` and `customPromisifyArgs` on `fs.read`
 * were dropped outright, and `util.promisify` over a wrapped fs function silently
 * changed behaviour. Descriptors carry the attributes too, so a non-enumerable,
 * non-writable property stays that way on the wrapper.
 */
function wrap(real, label, kind, depth = 0) {
  const note = (args) => {
    const watched = targetPathOf(args[0]);
    if (watched) record({ kind, fn: label, path: watched.path, form: watched.form });
  };
  const wrapper = makeWrapper(real, note);

  // Arity and name are read by callers — `util.promisify` among them — and a
  // wrapper's own are wrong. Copied from the real function, descriptor and all.
  for (const key of ['length', 'name']) {
    const descriptor = Object.getOwnPropertyDescriptor(real, key);
    if (descriptor) Object.defineProperty(wrapper, key, descriptor);
  }

  for (const key of Reflect.ownKeys(real)) {
    if (FUNCTION_INTRINSIC.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(real, key);
    if (!descriptor) continue;
    const name = `${label}.${String(key)}`;

    // An accessor cannot be instrumented without invoking the getter at wrap time,
    // which would move when its side effects happen. The accessor itself is carried
    // over so the property keeps working, and the exclusion is reported — a callable
    // arriving from a getter is then a stated gap, not a silent one.
    if (!('value' in descriptor)) {
      Object.defineProperty(wrapper, key, descriptor);
      excludedAttached.push(`${name}:accessor`);
      continue;
    }

    if (typeof descriptor.value === 'function' && !isClassLike(descriptor.value)) {
      if (depth < MAX_ATTACHED_DEPTH) {
        Object.defineProperty(wrapper, key, {
          ...descriptor,
          value: wrap(descriptor.value, name, kind, depth + 1)
        });
        wrappedAttached.push(name);
      } else {
        Object.defineProperty(wrapper, key, descriptor);
        excludedAttached.push(`${name}:depth`);
      }
      continue;
    }

    if (isClassLike(descriptor.value)) {
      Object.defineProperty(wrapper, key, descriptor);
      excludedAttached.push(`${name}:class`);
      continue;
    }

    Object.defineProperty(wrapper, key, descriptor);
  }
  return wrapper;
}

/** Plain fs functions that could not be replaced, in the form `<label>:<reason>`. */
const unwrappable = [];

/** Functions that had to be read through a getter to be reached; see below. */
const wrappedViaGetter = [];

/**
 * Instrument every plain function a holder exposes.
 *
 * Accessor-backed properties are read rather than skipped, which matters on exactly
 * one version in the support range: on Node 20.20.2 `fs.opendir` and
 * `fs.opendirSync` are accessors while on 20.0.0, 20.5.1, 22 and 24 they are plain
 * data properties. Skipping accessors left those two uninstrumented on 20.20.2 —
 * a hole in the absence claim on a version the package supports.
 *
 * Reading them is safe, and that was measured rather than assumed: they are Node's
 * own self-replacing lazy getters, so reading converts the property into a data
 * property holding the identical function, which is precisely what the first caller
 * would have triggered anyway. The properties that stay accessors — `fs.promises`
 * (an object, instrumented below as its own holder) and the stream classes — are
 * filtered out by the type and class checks, not by the descriptor shape.
 */
const wrapAll = (holder, label) => {
  const wrapped = [];
  for (const name of Object.keys(holder)) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, name);
    if (!descriptor) continue;
    const viaGetter = !('value' in descriptor);

    let real;
    try {
      real = viaGetter ? holder[name] : descriptor.value;
    } catch {
      unwrappable.push(`${label}.${name}:throwing-getter`);
      continue;
    }

    if (typeof real !== 'function') continue; // fs.promises, fs.constants…
    if (/^[A-Z]/.test(name) || isClassLike(real)) continue; // ReadStream, Dir, Stats…

    // Re-read: the getter above may have replaced itself with a data property.
    const current = Object.getOwnPropertyDescriptor(holder, name);
    if (!current.configurable && !('value' in current ? current.writable : false)) {
      unwrappable.push(`${label}.${name}:${'value' in current ? 'read-only' : 'sealed-accessor'}`);
      continue;
    }

    const kind = METADATA.has(name) ? 'metadata' : 'access';
    const value = wrap(real, `${label}.${name}`, kind);
    Object.defineProperty(holder, name, 'value' in current
      ? { ...current, value }
      : { value, enumerable: current.enumerable, writable: true, configurable: true });
    wrapped.push(name);
    if (viaGetter) wrappedViaGetter.push(name);
  }
  return wrapped;
};

const wrappedFs = wrapAll(fs, 'fs');
const wrappedPromises = fs.promises ? wrapAll(fs.promises, 'fs.promises') : [];

// --- child_process: which commands the script itself launches ------------------
//
// Recorded so the test can pin the subprocess contract to exactly the pm2 calls
// the script is supposed to make. This is a record of what the parent launched —
// not evidence about any file the child then touched.
for (const name of ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec']) {
  const real = childProcess[name];
  if (typeof real !== 'function') continue;
  childProcess[name] = function (command, args, ...rest) {
    record({
      kind: 'spawn',
      fn: `child_process.${name}`,
      command: String(command),
      args: Array.isArray(args) ? args.map(String) : []
    });
    return real.call(this, command, args, ...rest);
  };
}

// --- what the test needs in order to trust an empty log -----------------------
//
// First line of every log: which interposition mechanism ended up in effect, how
// much of the fs surface got wrapped, and everything that did not. Without this, a
// test asserting "no accesses after the connection opened" cannot tell a clean run
// from an observer that never installed itself. The exclusion lists are sorted so a
// test can assert the exact set and go red when it grows.
record({
  kind: 'observer-ready',
  mechanism,
  node: process.versions.node,
  wrappedFsFunctions: wrappedFs.length,
  wrappedFsPromisesFunctions: wrappedPromises.length,
  wrappedAttached: wrappedAttached.sort(),
  excludedAttached: excludedAttached.sort(),
  wrappedViaGetter: wrappedViaGetter.sort(),
  unwrappable: unwrappable.sort()
});
