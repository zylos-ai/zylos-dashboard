#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.ZYLOS_DATA_DIR
  || path.join(process.env.HOME, 'zylos/components/dashboard');
const DB_PATH = path.join(DATA_DIR, 'dashboard.db');

const SCRYPT_KEYLEN = 64;

function hashApiKey(key) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(key, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

const [,, command, ...args] = process.argv;

if (command === 'generate') {
  const name = args[0];
  const scope = args[1] || 'read';
  if (!name) {
    console.error('Usage: api-key.js generate <name> [read|admin]');
    process.exit(1);
  }
  if (scope !== 'read' && scope !== 'admin') {
    console.error('Scope must be "read" or "admin"');
    process.exit(1);
  }
  const db = openDb();
  const existing = db.prepare('SELECT 1 FROM api_keys WHERE name = ?').get(name);
  if (existing) {
    console.error(`API key "${name}" already exists. Revoke it first.`);
    db.close();
    process.exit(1);
  }
  const key = 'zylos_ak_' + crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO api_keys (name, key_hash, scope) VALUES (?, ?, ?)').run(name, hashApiKey(key), scope);
  db.close();
  console.log(`API key created: ${name} (scope: ${scope})`);
  console.log(`Key: ${key}`);
  console.log('Store this key securely — it cannot be retrieved later.');

} else if (command === 'revoke') {
  const name = args[0];
  if (!name) {
    console.error('Usage: api-key.js revoke <name>');
    process.exit(1);
  }
  const db = openDb();
  const result = db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE name = ? AND revoked_at IS NULL").run(name);
  db.close();
  if (result.changes === 0) {
    console.error(`No active API key found: "${name}"`);
    process.exit(1);
  }
  console.log(`API key revoked: ${name}`);

} else if (command === 'list') {
  const db = openDb();
  const keys = db.prepare('SELECT name, scope, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC').all();
  db.close();
  if (keys.length === 0) {
    console.log('No API keys.');
  } else {
    for (const k of keys) {
      const status = k.revoked_at ? `revoked ${k.revoked_at}` : 'active';
      const lastUsed = k.last_used_at || 'never';
      console.log(`  ${k.name}  scope=${k.scope}  status=${status}  last_used=${lastUsed}  created=${k.created_at}`);
    }
  }

} else {
  console.log('Usage: api-key.js <generate|revoke|list> [args]');
  console.log('  generate <name> [read|admin]  — Create a new API key');
  console.log('  revoke <name>                 — Revoke an API key');
  console.log('  list                          — List all API keys');
}
