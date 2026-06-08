import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'postupgrade-test-'));
}

test('post-upgrade — refreshes installed Claude and Codex hooks', () => {
  const tmpDir = freshTmpDir();
  const homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });

  const stdout = execFileSync('node', [path.resolve('hooks/post-upgrade.js')], {
    env: { ...process.env, HOME: homeDir, ZYLOS_DIR: tmpDir, ZYLOS_RUNTIME: 'codex' },
    encoding: 'utf8'
  });

  assert.match(stdout, /claude hooks: 7 added/);
  assert.match(stdout, /codex hooks: 6 added/);
  assert.match(stdout, /\[post-upgrade\] complete/);

  const claudePath = path.join(tmpDir, '.claude', 'settings.json');
  const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8'));
  assert.ok(claude.hooks.PreToolUse[0].hooks[0].command.includes('hook-ingest.cjs'));

  const codexPath = path.join(tmpDir, '.codex', 'hooks.json');
  const codex = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
  const command = codex.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(command.includes(`ZYLOS_DIR=${tmpDir}`));
  assert.ok(command.includes('hooks/post-upgrade.js') === false);
  assert.ok(command.includes('src/lib/hook-ingest.cjs'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
