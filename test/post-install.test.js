import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SCRYPT_KEYLEN = 64;

function verifyScrypt(plaintext, stored) {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(expected, actual);
}

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-test-'));
}

function runPostInstall(zylosDir) {
  const scriptPath = path.resolve('hooks/post-install.js');
  return execFileSync('node', [scriptPath], {
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    encoding: 'utf8'
  });
}

function configPath(tmpDir) {
  return path.join(tmpDir, 'components', 'dashboard', 'config.json');
}

test('post-install — fresh install generates secure config', () => {
  const tmpDir = freshTmpDir();
  const stdout = runPostInstall(tmpDir);
  const config = JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8'));

  assert.equal(config.auth.enabled, true);
  assert.ok(config.auth.password.startsWith('scrypt:'), 'password must be scrypt hash');

  const parts = config.auth.password.split(':');
  assert.equal(parts.length, 3);
  assert.equal(Buffer.from(parts[1], 'hex').length, 32, 'salt must be 32 bytes');
  assert.equal(Buffer.from(parts[2], 'hex').length, SCRYPT_KEYLEN, 'hash must be 64 bytes');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-install — prints plaintext password that verifies against hash', () => {
  const tmpDir = freshTmpDir();
  const stdout = runPostInstall(tmpDir);

  const match = stdout.match(/Dashboard password:\s+([a-f0-9]{32})/);
  assert.ok(match, 'stdout must contain plaintext password');

  const config = JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8'));
  assert.ok(verifyScrypt(match[1], config.auth.password), 'printed password must verify against stored hash');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-install — config has no unused fields', () => {
  const tmpDir = freshTmpDir();
  runPostInstall(tmpDir);
  const config = JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8'));

  assert.equal(config.theme, undefined, 'theme must not be present');
  assert.equal(config.refreshMs, undefined, 'refreshMs must not be present');
  assert.equal(config.retention, undefined, 'retention must not be present');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-install — does not overwrite existing config', () => {
  const tmpDir = freshTmpDir();
  runPostInstall(tmpDir);
  const before = fs.readFileSync(configPath(tmpDir), 'utf8');
  runPostInstall(tmpDir);
  const after = fs.readFileSync(configPath(tmpDir), 'utf8');
  assert.equal(before, after, 'existing config must not be overwritten');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
