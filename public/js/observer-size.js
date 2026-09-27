export const DEFAULT_OBSERVER_SIZE = Object.freeze({ cols: 80, rows: 24 });
export const OBSERVER_SIZE_LIMITS = Object.freeze({ minCols: 20, maxCols: 500, minRows: 5, maxRows: 200 });

export function validObserverSize(value) {
  return !!value && Number.isInteger(value.cols) && Number.isInteger(value.rows) &&
    value.cols >= OBSERVER_SIZE_LIMITS.minCols && value.cols <= OBSERVER_SIZE_LIMITS.maxCols &&
    value.rows >= OBSERVER_SIZE_LIMITS.minRows && value.rows <= OBSERVER_SIZE_LIMITS.maxRows;
}
