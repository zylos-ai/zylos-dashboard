import fs from 'node:fs';
export function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'missing' };
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return { ok: false, error: 'empty' };
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function readJsonlTail(filePath, limit = 100) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'missing', value: [] };
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return { ok: true, value: [] };
    const lines = raw.split(/\r?\n/).slice(-limit);
    const value = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        value.push(JSON.parse(line));
      } catch {
        value.push({ raw: line, parse_error: true });
      }
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message, value: [] };
  }
}
