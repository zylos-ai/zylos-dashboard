import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DarwinObserverContainment, cleanGuardianEnvironment, privateDirectory,
} from './observer-containment-darwin.js';

// The guardian implements the same ownership/liveness CLI on Linux. Sharing
// the lifecycle keeps stop, retry and reconciliation on the accepted contract.
// Product installation remains gated by observerArtifactFor, independently of
// this adapter's availability for isolated native experiments.
export class LinuxObserverContainment extends DarwinObserverContainment {
  constructor(options) {
    super({
      ...options,
      helperDir: options.helperDir ?? fileURLToPath(new URL('../../assets/observer/linux-x64', import.meta.url)),
    });
  }

  get helperPlatform() { return 'linux-x64'; }

  get guardianFileName() { return 'linux-guardian'; }

  async reconcilePersisted() {
    try {
      if ((await fs.promises.readdir(this.runtimeRoot)).length === 0) return [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return super.reconcilePersisted();
  }

  async _privateEnvironment(root, socketRoot) {
    const directories = {
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_RUNTIME_DIR: socketRoot,
      XDG_CONFIG_DIRS: path.join(root, 'config-dirs'),
      XDG_DATA_DIRS: path.join(root, 'data-dirs'),
      ZELLIJ_CONFIG_DIR: path.join(root, 'config'),
      ZELLIJ_CACHE_DIR: path.join(root, 'cache'),
      ZELLIJ_DATA_DIR: path.join(root, 'data'),
      ZELLIJ_SOCKET_DIR: socketRoot,
    };
    const temporary = path.join(root, 'tmp');
    for (const directory of new Set([root, temporary, ...Object.values(directories)])) {
      await privateDirectory(directory);
    }
    const environment = cleanGuardianEnvironment();
    // Do not inherit roots or session/config overrides from the producer.
    for (const key of Object.keys(environment)) {
      if (key.startsWith('XDG_') || key === 'ZELLIJ' || key.startsWith('ZELLIJ_')) delete environment[key];
    }
    return {
      ...environment, ...directories,
      TMPDIR: `${temporary}/`, TMP: temporary, TEMP: temporary,
      TERM: 'xterm-256color',
    };
  }
}
