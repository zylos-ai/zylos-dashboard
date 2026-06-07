import { isNewerVersion } from './version-utils.js';

export function applyVersionUpdateFields(info, latest, {
  zylosVersion,
  ccEffectiveVersion,
  codexInstalledVersion,
}) {
  if (latest.cc && ccEffectiveVersion && isNewerVersion(latest.cc, ccEffectiveVersion)) {
    info.cc_update = latest.cc;
  }
  if (latest.zylos && zylosVersion && isNewerVersion(latest.zylos, zylosVersion)) {
    info.zylos_update = latest.zylos;
  }
  if (latest.codex) {
    info.codex_latest = latest.codex;
    if (codexInstalledVersion && isNewerVersion(latest.codex, codexInstalledVersion)) {
      info.codex_update = latest.codex;
    }
  }
  return info;
}
