import { isNewerVersion } from './version-utils.js';

export const CLAUDE_1M_CONTEXT_MIN_TOKENS = 900_000;

export function isClaude1mModelId(model) {
  return typeof model === 'string' && model.includes('[1m]');
}

export function claudeModelSelectionFromRuntime(modelId, contextWindowSize, availableModels = []) {
  if (!modelId) return null;
  const models = new Set(availableModels.map(m => m?.id).filter(Boolean));
  const windowSize = Number(contextWindowSize);
  const hasWindowSize = Number.isFinite(windowSize) && windowSize > 0;
  const oneMillionEffective = hasWindowSize && windowSize >= CLAUDE_1M_CONTEXT_MIN_TOKENS;

  if (isClaude1mModelId(modelId)) {
    const bare = modelId.replace('[1m]', '');
    if (hasWindowSize && !oneMillionEffective && models.has(bare)) return bare;
    return modelId;
  }

  const oneMillion = `${modelId}[1m]`;
  if (oneMillionEffective && models.has(oneMillion)) return oneMillion;
  return modelId;
}

export function claudeModelMatchesRequested(requestedModel, runtimeInfo, availableModels = []) {
  if (!requestedModel) return true;
  const effectiveModel = claudeModelSelectionFromRuntime(
    runtimeInfo?.model_id,
    runtimeInfo?.context_window_size,
    availableModels
  );
  if (!effectiveModel) return true;
  return requestedModel === effectiveModel;
}

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
