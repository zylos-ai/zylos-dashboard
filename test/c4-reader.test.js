import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { C4Reader } from '../src/lib/c4-reader.js';

function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-reader-test-'));
  const commDir = path.join(tmpDir, 'comm-bridge');
  fs.mkdirSync(commDir, { recursive: true });
  const dbPath = path.join(commDir, 'c4.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      endpoint_id TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 3,
      require_idle INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0
    );
  `);
  return { tmpDir, db, reader: new C4Reader(tmpDir) };
}

function cleanup(fixture) {
  fixture.reader.close();
  fixture.db.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

test('C4Reader — getPendingQueue age uses UTC (no timezone drift)', () => {
  const f = makeFixture();
  try {
    f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now', '-7 minutes'), 'in', 'telegram', 'test msg', 'pending')
    `).run();

    const result = f.reader.getPendingQueue();
    assert.equal(result.depth, 1);
    assert.ok(result.oldest_age_s >= 400 && result.oldest_age_s <= 500,
      `expected ~420s, got ${result.oldest_age_s}s`);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getPendingQueue returns null age when no pending', () => {
  const f = makeFixture();
  try {
    f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now'), 'in', 'telegram', 'delivered msg', 'delivered')
    `).run();

    const result = f.reader.getPendingQueue();
    assert.equal(result.depth, 0);
    assert.equal(result.oldest_age_s, null);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getLastOutbound returns ISO UTC timestamps', () => {
  const f = makeFixture();
  try {
    f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now', '-3 minutes'), 'out', 'telegram', 'reply', 'delivered')
    `).run();

    const result = f.reader.getLastOutbound();
    assert.ok(result.telegram, 'expected telegram key');
    assert.ok(result.telegram.endsWith('Z'), `expected UTC suffix, got: ${result.telegram}`);
    assert.ok(result.telegram.includes('T'), `expected ISO format, got: ${result.telegram}`);

    const parsed = new Date(result.telegram);
    const ageMs = Date.now() - parsed.getTime();
    const ageSec = Math.floor(ageMs / 1000);
    assert.ok(ageSec >= 150 && ageSec <= 240,
      `expected ~180s age, got ${ageSec}s (parsed=${parsed.toISOString()})`);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getTodayStats counts by channel and direction', () => {
  const f = makeFixture();
  try {
    const ins = f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now'), ?, ?, 'msg', 'delivered')
    `);
    ins.run('in', 'telegram');
    ins.run('in', 'telegram');
    ins.run('out', 'telegram');
    ins.run('in', 'lark');

    const result = f.reader.getTodayStats();
    assert.ok(result);
    assert.equal(result.channels.telegram.in, 2);
    assert.equal(result.channels.telegram.out, 1);
    assert.equal(result.channels.lark.in, 1);
    assert.equal(result.total_in, 3);
    assert.equal(result.total_out, 1);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — missing db returns safe defaults', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-reader-nodir-'));
  const reader = new C4Reader(tmpDir);
  try {
    assert.equal(reader.getTodayStats(), null);
    assert.deepEqual(reader.getPendingQueue(), { depth: 0, oldest_age_s: null });
    assert.deepEqual(reader.getLastOutbound(), {});
  } finally {
    reader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
