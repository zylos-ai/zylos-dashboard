/**
 * Exercises the parts of the `fs` API that `source-access-observer.cjs` replaces,
 * and prints what it observed as JSON.
 *
 * The point is differential: the test runs this twice on the same file — once with
 * the observer preloaded and once without — and requires the two reports to be
 * identical. Anything the wrappers change about the API shows up as a diff, so the
 * check is a dynamic one. Reading the observer's source and reasoning that
 * descriptors "should" be preserved is exactly the kind of argument that has been
 * wrong twice here already: `Object.assign` looked like it preserved the API and
 * silently dropped every symbol-keyed property, and republished an uninstrumented
 * `realpathSync.native`.
 *
 * So the report covers the properties that wrapping is most likely to lose:
 *
 *   - descriptors of the callable attached properties (`realpathSync.native`),
 *     including enumerability and writable/configurable;
 *   - the full own-key set of functions carrying symbol-keyed metadata
 *     (`util.promisify.custom` on `fs.exists`, `customPromisifyArgs` on `fs.read`) —
 *     these are non-enumerable, which is what made them invisible to `Object.assign`;
 *   - that `util.promisify` still produces the *custom* behaviour rather than a
 *     generic callback adaptation, which is the observable consequence of losing them;
 *   - arity and name, which callers and `util.promisify` both read;
 *   - callback-style, promise-style and sync-style calls of the same operation, since
 *     a wrapper that returns the wrong thing breaks only one of the three;
 *   - error behaviour for the argument forms the observer inspects, so that deciding
 *     "not the watched path" can never turn into throwing differently. A non-file URL,
 *     a plain object, a "file:"-prefixed *string* (a literal path, not a URL) and a
 *     missing path must all fail exactly as they do uninstrumented.
 *
 * Run as `node source-access-observer-semantics-probe.cjs <existing-file>`.
 */
'use strict';

const fs = require('fs');
const util = require('util');
const { pathToFileURL } = require('url');

const file = process.argv[2];
if (!file) throw new Error('usage: source-access-observer-semantics-probe.cjs <existing-file>');

const report = {};

/** Records a value or the failure, so error behaviour is compared like any result. */
const record = async (name, fn) => {
  try {
    report[name] = { ok: await fn() };
  } catch (error) {
    report[name] = { code: error.code || error.name, message: error.message };
  }
};

const describe = (holder, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (!descriptor) return 'absent';
  if (!('value' in descriptor)) return { accessor: true, enumerable: descriptor.enumerable };
  return {
    type: typeof descriptor.value,
    enumerable: descriptor.enumerable,
    writable: descriptor.writable,
    configurable: descriptor.configurable
  };
};

/** A url-like plain object: fs duck-types these, so it is a real path form. */
const urlLike = () => {
  const url = pathToFileURL(file);
  return {
    protocol: url.protocol,
    pathname: url.pathname,
    href: url.href,
    hostname: url.hostname,
    search: url.search,
    hash: url.hash
  };
};

async function main() {
  // --- shape of the functions themselves ---------------------------------------
  report.descriptors = {
    'fs.realpathSync.native': describe(fs.realpathSync, 'native'),
    'fs.realpath.native': describe(fs.realpath, 'native'),
    'fs.exists[promisify.custom]': describe(fs.exists, util.promisify.custom),
    'fs.promises.opendir[promisify.custom]': describe(fs.promises.opendir, util.promisify.custom)
  };

  report.ownKeys = {
    'fs.exists': Reflect.ownKeys(fs.exists).map(String).sort(),
    'fs.read': Reflect.ownKeys(fs.read).map(String).sort(),
    'fs.realpathSync': Reflect.ownKeys(fs.realpathSync).map(String).sort()
  };

  report.signatures = {
    'fs.readFileSync': [fs.readFileSync.name, fs.readFileSync.length],
    'fs.realpathSync': [fs.realpathSync.name, fs.realpathSync.length],
    'fs.realpathSync.native': [fs.realpathSync.native.name, fs.realpathSync.native.length],
    'fs.promises.readFile': [fs.promises.readFile.name, fs.promises.readFile.length]
  };

  // The *kind* of every callable on both holders, not a hand-picked sample of them.
  // A wrapper that forwards an async function's promise behaves the same but stops
  // reporting as async, and the same goes for generators — so the whole surface is
  // enumerated, for the same reason the observer enumerates rather than hand-lists:
  // a sample only covers the cases somebody thought of.
  report.callableKinds = {};
  for (const [label, holder] of [['fs', fs], ['fs.promises', fs.promises]]) {
    const kinds = {};
    for (const name of Object.keys(holder)) {
      let value;
      try {
        value = holder[name];
      } catch {
        continue;
      }
      if (typeof value !== 'function' || /^[A-Z]/.test(name)) continue;
      // The intrinsic tag, not util.types: that namespace has no
      // isAsyncGeneratorFunction, and the tag distinguishes all four kinds.
      kinds[name] = Object.prototype.toString.call(value);
    }
    report.callableKinds[label] = kinds;
  }

  // --- the same operation through all three calling conventions -----------------
  await record('syncRead', () => fs.readFileSync(file).length);
  await record('promiseRead', () => fs.promises.readFile(file).then((b) => b.length));
  await record('callbackRead', () => new Promise((resolve, reject) => {
    fs.readFile(file, (error, buffer) => (error ? reject(error) : resolve(buffer.length)));
  }));

  // --- callable attached properties, actually called ----------------------------
  await record('nativeMatchesPlain', () => fs.realpathSync.native(file) === fs.realpathSync(file));
  await record('nativeCallback', () => new Promise((resolve, reject) => {
    fs.realpath.native(file, (error, resolved) => (error ? reject(error) : resolve(resolved === fs.realpathSync(file))));
  }));

  // --- symbol-keyed metadata, via its observable consequence --------------------
  // `util.promisify(fs.exists)` resolves to a boolean only while the custom
  // implementation survives; a generic adaptation would reject or resolve undefined.
  await record('promisifiedExists', () => util.promisify(fs.exists)(file));
  // `customPromisifyArgs` is what makes this resolve to an object with named keys
  // instead of just the byte count.
  await record('promisifiedRead', async () => {
    const fd = fs.openSync(file, 'r');
    try {
      const result = await util.promisify(fs.read)(fd, Buffer.alloc(4), 0, 4, 0);
      return Object.keys(result).sort().join(',');
    } finally {
      fs.closeSync(fd);
    }
  });

  // --- path forms, including the ones that must keep failing --------------------
  await record('urlRead', () => fs.readFileSync(pathToFileURL(file)).length);
  await record('urlLikeRead', () => fs.readFileSync(urlLike()).length);
  await record('bufferRead', () => fs.readFileSync(Buffer.from(file)).length);
  await record('fdRead', () => {
    const fd = fs.openSync(file, 'r');
    try {
      return fs.readFileSync(fd).length;
    } finally {
      fs.closeSync(fd);
    }
  });
  await record('nonFileUrl', () => fs.readFileSync(new URL('http://example.com/x')).length);
  await record('plainObjectPath', () => fs.readFileSync({}).length);
  // A *string* beginning with "file:" is a literal relative path, not a URL. It has
  // to keep failing with ENOENT: url-decoding it would attribute an unrelated read
  // to the watched file.
  await record('fileSchemeString', () => fs.readFileSync(`file://${file}`).length);
  await record('missingPath', () => fs.readFileSync(`${file}.absent`).length);
  await record('nullPath', () => fs.readFileSync(null).length);

  // --- a stream, which is built from the class the observer must not wrap --------
  await record('streamRead', () => new Promise((resolve, reject) => {
    let bytes = 0;
    fs.createReadStream(file)
      .on('data', (chunk) => { bytes += chunk.length; })
      .on('end', () => resolve(bytes))
      .on('error', reject);
  }));

  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
