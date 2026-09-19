import { fileURLToPath } from 'node:url';
import { PosixObserverContainment } from './observer-containment-posix.js';

// Both Linux architectures use the shared lifecycle; artifact installation is
// independently governed by the product catalog.
export class LinuxObserverContainment extends PosixObserverContainment {
  constructor(options) {
    const arch = options.arch ?? process.arch;
    super({
      ...options,
      helperDir: options.helperDir ?? fileURLToPath(new URL(`../../assets/observer/linux-${arch}`, import.meta.url)),
    });
  }

  get helperPlatform() { return this.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'; }

  get guardianFileName() { return 'linux-guardian'; }
}
