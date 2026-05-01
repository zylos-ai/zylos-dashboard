import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function querySqlite(dbPath, sql, timeout = 3000) {
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      timeout,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, rows: stdout.trim() ? JSON.parse(stdout) : [] };
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
}
