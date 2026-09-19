import { PosixObserverContainment } from './observer-containment-posix.js';

// Keep the public platform adapter import stable for existing callers.
export { ObserverContainmentError, cleanGuardianEnvironment, privateDirectory } from './observer-containment-posix.js';
export class DarwinObserverContainment extends PosixObserverContainment {}
