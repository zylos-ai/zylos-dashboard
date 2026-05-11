import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export class C4Reader {
  constructor(zylosDir) {
    this._dbPath = path.join(zylosDir, 'comm-bridge', 'c4.db');
    this._db = null;
  }

  _open() {
    if (this._db) return this._db;
    if (!fs.existsSync(this._dbPath)) return null;
    try {
      this._db = new Database(this._dbPath, { readonly: true });
      this._db.pragma('busy_timeout = 3000');
    } catch {
      this._db = null;
    }
    return this._db;
  }

  getTodayStats() {
    const db = this._open();
    if (!db) return null;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const rows = db.prepare(`
        SELECT channel, direction, COUNT(*) as count
        FROM conversations
        WHERE timestamp >= ?
        GROUP BY channel, direction
      `).all(today);

      const channels = {};
      for (const r of rows) {
        if (!channels[r.channel]) channels[r.channel] = { in: 0, out: 0 };
        channels[r.channel][r.direction === 'in' ? 'in' : 'out'] += r.count;
      }

      let totalIn = 0, totalOut = 0;
      for (const r of rows) {
        if (r.direction === 'in') totalIn += r.count;
        else totalOut += r.count;
      }

      return { channels, total_in: totalIn, total_out: totalOut };
    } catch {
      return null;
    }
  }

  getPendingQueue() {
    const db = this._open();
    if (!db) return { depth: 0, oldest_age_s: null };
    try {
      const row = db.prepare(`
        SELECT COUNT(*) as depth,
               CAST(strftime('%s','now') - strftime('%s', MIN(timestamp)) AS INTEGER) as oldest_age_s
        FROM conversations
        WHERE direction = 'in' AND status IN ('pending', 'running')
      `).get();

      return {
        depth: row.depth || 0,
        oldest_age_s: row.oldest_age_s ?? null
      };
    } catch {
      return { depth: 0, oldest_age_s: null };
    }
  }

  getLastOutbound() {
    const db = this._open();
    if (!db) return {};
    try {
      const rows = db.prepare(`
        SELECT channel, MAX(timestamp) as last_ts
        FROM conversations
        WHERE direction = 'out'
        GROUP BY channel
      `).all();

      const result = {};
      for (const r of rows) {
        result[r.channel] = r.last_ts ? r.last_ts.replace(' ', 'T') + 'Z' : r.last_ts;
      }
      return result;
    } catch {
      return {};
    }
  }

  close() {
    this._db?.close();
    this._db = null;
  }
}
