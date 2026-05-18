export function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${Math.round(n < 1 ? n * 100 : n)}%`;
}

export function resolveCpuDisplay(rawVal, lastGood) {
  const n = Number(rawVal);
  if (Number.isFinite(n)) return { display: pct(n), lastGood: n };
  if (lastGood !== null && lastGood !== undefined) return { display: pct(lastGood), lastGood };
  return { display: '--', lastGood: null };
}
