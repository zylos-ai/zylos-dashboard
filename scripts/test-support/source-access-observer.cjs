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

const record = (entry) => {
  fs.appendFileSync(logPath, `${JSON.stringify({ phase, ...entry })}\n`);
};

/** Only accesses to the watched path are recorded; the script touches many others. */
const isTarget = (p) => {
  if (typeof p !== 'string' && !Buffer.isBuffer(p)) return false;
  const s = String(p);
  return s === target || path.resolve(s) === path.resolve(target);
};

// --- better-sqlite3: the connection count that carries the claim ---------------
//
// Interposed with `module.registerHooks`, whose resolve hook applies to `import`
// as well as `require`. Overwriting `require.cache[...].exports` was tried first
// and does NOT work here: on Node 22 the ESM translation of a CJS package does not
// read back a mutated cache entry, so `import Database from 'better-sqlite3'` kept
// receiving the real class and the observer recorded nothing. That failure mode is
// exactly why the test asserts the must-happen accesses are present — it is what
// caught this during development.
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

const REDIRECT = path.join(__dirname, 'source-access-observer-sqlite.cjs');
require('module').registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'better-sqlite3' && !String(context.parentURL || '').includes('source-access-observer')) {
      return { url: pathToFileURL(REDIRECT).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

// --- fs: content reads and metadata probes, kept apart ------------------------
//
// `existsSync`/`stat` answer "is it there", which the script legitimately asks
// about the source before opening it. Reading bytes is a different thing, and the
// two must not be conflated in either direction, so they are classified here
// rather than at assertion time.
const CONTENT_READS = [
  'openSync', 'open', 'readFileSync', 'readFile', 'createReadStream',
  'copyFileSync', 'copyFile', 'opendirSync', 'opendir'
];
const METADATA = [
  'existsSync', 'statSync', 'stat', 'lstatSync', 'lstat', 'accessSync', 'access',
  'realpathSync', 'realpath'
];

const wrapFs = (name, kind) => {
  const real = fs[name];
  if (typeof real !== 'function') return;
  fs[name] = function (...args) {
    if (isTarget(args[0])) record({ kind, fn: `fs.${name}`, path: String(args[0]) });
    return real.apply(this, args);
  };
  if (fs.promises && typeof fs.promises[name] === 'function') {
    const realPromise = fs.promises[name];
    fs.promises[name] = function (...args) {
      if (isTarget(args[0])) record({ kind, fn: `fs.promises.${name}`, path: String(args[0]) });
      return realPromise.apply(this, args);
    };
  }
};

for (const name of CONTENT_READS) wrapFs(name, 'content-read');
for (const name of METADATA) wrapFs(name, 'metadata');

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
