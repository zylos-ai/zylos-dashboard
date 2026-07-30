/**
 * Records every access the restore script's own JavaScript makes to one watched
 * path, so a test can assert what the script does to the *source backup* after it
 * has built the frozen artifact — instead of asserting on what the script prints,
 * which a silent access would sail straight past.
 *
 * Preloaded with `node --require`, so every wrapper below is installed before the
 * script's module graph is linked:
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
 */
'use strict';

const target = process.env.SOURCE_OBSERVER_TARGET;
const logPath = process.env.SOURCE_OBSERVER_LOG;
if (!target || !logPath) {
  throw new Error('source-access-observer requires SOURCE_OBSERVER_TARGET and SOURCE_OBSERVER_LOG');
}

// `--require` preloads also run on worker threads, and `module.register` starts one
// for the hooks. Instrumenting there would log a second "ready" line and wrap a
// thread the script under observation never runs on, so only the main thread does
// any of this.
if (!require('worker_threads').isMainThread) return;

const fs = require('fs');
const childProcess = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Phase boundary, as agreed in review: it flips when the materialize connection
 * on the source RETURNS, not when it is requested. Everything the script does to
 * the source before that point is how the artifact gets built; anything after it
 * is what the "not reached for again" claim is about.
 */
let phase = 'before-materialize';

// Captured before anything below wraps it, so writing the log is never itself an
// observed access.
const appendFileSync = fs.appendFileSync;

const record = (entry) => {
  appendFileSync(logPath, `${JSON.stringify({ phase, ...entry })}\n`);
};

/** Only accesses to the watched path are recorded; the script touches many others. */
const isTarget = (p) => {
  if (typeof p !== 'string' && !Buffer.isBuffer(p)) return false;
  const s = String(p);
  return s === target || path.resolve(s) === path.resolve(target);
};

// --- better-sqlite3: the connection count that carries the claim ---------------
//
// Interposed by redirecting the `better-sqlite3` specifier through a loader hook
// registered with `module.register`, which exists from Node 20.6 — the repo
// supports `>=20`, so the mechanism has to work there and not only on current
// Node. Two other approaches were tried and measured first:
//
//   - `require.cache[path].exports = subclass` reaches neither Node 20 nor Node 22:
//     the ESM translation of a CJS package does not read a mutated cache entry back,
//     so `import Database from 'better-sqlite3'` kept receiving the real class while
//     this observer recorded nothing at all.
//   - `module.registerHooks` works, but only from Node 22.15/23.5. On Node 20.20.2
//     it is simply `undefined`, and an observer that throws on load turns the test
//     using it into a failure on the repo's own minimum version.
//
// If even `register` is missing (Node < 20.6), nothing is interposed and the
// mechanism is reported as `none`, so the test can skip with a stated reason rather
// than assert absences against an observer that was never installed.
const sqlitePath = require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', '..')]
});
const RealDatabase = require(sqlitePath);

class ObservedDatabase extends RealDatabase {
  constructor(file, options) {
    const watched = isTarget(file);
    if (watched) record({ kind: 'sqlite-open', path: String(file) });
    super(file, options);
    // The flip happens here — after the constructor has returned successfully.
    if (watched && phase === 'before-materialize') phase = 'after-materialize';
  }
}

// The redirect target reads the subclass back off this handle.
globalThis.__sourceAccessObserver = { ObservedDatabase };

const { register } = require('module');
const mechanism = typeof register === 'function' ? 'register' : 'none';

if (mechanism === 'register') {
  register(pathToFileURL(path.join(__dirname, 'source-access-observer-hooks.mjs')).href, {
    data: { redirect: pathToFileURL(path.join(__dirname, 'source-access-observer-sqlite.cjs')).href }
  });
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

/** Classes (ReadStream, Dir, …) must not be wrapped: they are called with `new`. */
const isPlainFunction = (value, name) =>
  typeof value === 'function' && !/^[A-Z]/.test(name);

const wrapAll = (holder, label) => {
  const wrapped = [];
  for (const name of Object.keys(holder)) {
    let real;
    try {
      real = holder[name];
    } catch {
      continue; // a throwing getter is not something to interpose on
    }
    if (!isPlainFunction(real, name)) continue;
    const kind = METADATA.has(name) ? 'metadata' : 'access';
    try {
      const wrapper = function (...args) {
        if (isTarget(args[0])) record({ kind, fn: `${label}.${name}`, path: String(args[0]) });
        return real.apply(this, args);
      };
      // Carry over attached properties — fs.realpath.native, the promisify hooks —
      // so wrapping does not quietly remove parts of the API.
      Object.assign(wrapper, real);
      holder[name] = wrapper;
      wrapped.push(name);
    } catch {
      // read-only property: nothing to do but leave it uninstrumented. The count
      // below is what the test uses to see how much of the surface is covered.
    }
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
// First line of every log: which interposition mechanism was available, and how
// much of the fs surface got wrapped. Without this, a test asserting "no accesses
// after materialize" cannot tell a clean run from an observer that never installed
// itself — and on Node < 20.6 there is no mechanism at all, which the test must be
// able to see and skip on rather than silently report as proof.
record({
  kind: 'observer-ready',
  mechanism,
  node: process.versions.node,
  wrappedFsFunctions: wrappedFs.length,
  wrappedFsPromisesFunctions: wrappedPromises.length
});
