/**
 * Which import-interposition mechanism a given Node supports, and the command-line
 * flags that switch it on.
 *
 * This lives apart from the observer because the choice cannot be made from inside
 * it. `module.register` can be called at preload time, but `--experimental-loader`
 * is a flag: by the time a `--require` preload runs, the loader chain for that
 * process is already fixed. So the *spawner* has to decide, which means the
 * decision has to be importable by the tests that spawn.
 *
 *   >= 20.6  `module.register` (the supported API; no flag, no warning)
 *   20.0-20.5  `--experimental-loader` (the same hooks file, loaded the old way)
 *
 * Both were measured on real binaries rather than inferred from release notes:
 * `module.register` is `undefined` on 20.0.0 and 20.5.1 and a function on 20.20.2,
 * and `--experimental-loader` does run the hooks' `resolve` on 20.0.0/20.5.1 and
 * does redirect the specifier. The one difference the hooks have to absorb is that
 * the flag form never calls `initialize`, so they default their own redirect target
 * instead of waiting to be handed one.
 *
 * There is deliberately no third branch that gives up. An observer that was never
 * installed produces exactly the same empty log as a clean run, so "no mechanism"
 * has to reach the test as a failure, not as a skip.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const OBSERVER = path.join(HERE, 'source-access-observer.cjs');
export const HOOKS = path.join(HERE, 'source-access-observer-hooks.mjs');

/**
 * @param {string} version a `process.versions.node` string
 * @returns {'register'|'experimental-loader'|'unsupported'}
 */
export function observerMechanism(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (major > 20) return 'register';
  if (major === 20) return minor >= 6 ? 'register' : 'experimental-loader';
  return 'unsupported'; // below the package's own engines floor
}

/**
 * The argv prefix that installs the observer on `version`, plus the mechanism it
 * selected — returned together so a caller can assert that the observer's own
 * `observer-ready` line reports the same one, rather than trusting either alone.
 */
export function observerArgv(version = process.versions.node) {
  const mechanism = observerMechanism(version);
  const argv = ['--require', OBSERVER];
  if (mechanism === 'experimental-loader') {
    argv.push('--experimental-loader', pathToFileURL(HOOKS).href);
  }
  return { mechanism, argv };
}
