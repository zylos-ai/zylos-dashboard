import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildPulseWallView, renderPulseWallHtml } from '../public/js/pulse-wall.js';

test('prompt source transient display is capped at 5 seconds', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /const PROMPT_TRANSIENT_SECONDS = 5;/);
  assert.match(app, /promptAge < PROMPT_TRANSIENT_SECONDS/);
  assert.doesNotMatch(app, /promptAge < 30/);
});

test('runtime info upgrade badges use semver-aware comparison', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  const runtimeInfo = fs.readFileSync(path.resolve('src/lib/runtime-info.js'), 'utf8');
  assert.match(runtimeInfo, /isNewerVersion\(latest\.cc, ccEffectiveVersion\)/);
  assert.match(runtimeInfo, /isNewerVersion\(latest\.zylos, zylosVersion\)/);
  assert.match(runtimeInfo, /isNewerVersion\(latest\.codex, codexInstalledVersion\)/);
  assert.match(index, /applyVersionUpdateFields\(info, latest,/);
  assert.doesNotMatch(index, /latest\.cc !== ccEffective/);
  assert.doesNotMatch(index, /latest\.zylos !== zylosVersion/);
});

test('Codex runtime renders CLI update badge in info bar and actions modal', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /const codexVersion = ri\.codex_running \|\| ri\.codex_version \|\| ri\.codex_installed;/);
  assert.match(app, /if \(ri\.codex_restart\) cv \+=/);
  assert.match(app, /else if \(ri\.codex_update\) cv \+=/);
  assert.match(app, /const cliUpdate = meta\.runtime_cli === 'codex' \? ri\?\.codex_restart \|\| ri\?\.codex_update : ri\?\.cc_update;/);
  assert.match(app, /ccVer\.classList\.toggle\('action-ver-dot', !!cliUpdate\)/);
});

test('Codex runtime info exposes running, installed, effective, and restart fields', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  assert.match(index, /const codexRunning = activeRuntime === 'codex' \? codexRuntimeInfo\?\.cli_version \|\| null : null;/);
  assert.match(index, /codex_version: codexRunning \|\| codexInstalledVersion \|\| null,/);
  assert.match(index, /codex_running: codexRunning,/);
  assert.match(index, /codex_installed: codexInstalledVersion \|\| null,/);
  assert.match(index, /info\.codex_restart = codexInstalledVersion;/);
  assert.match(index, /pending_restart: !!needsRestart,/);
});

test('upgrade-zylos writes a restart marker and uses double-fork spawning', () => {
  const actions = fs.readFileSync(path.resolve('src/lib/actions.js'), 'utf8');
  assert.match(actions, /upgrade-zylos-pending\.json/);
  assert.match(actions, /spawn\(process\.execPath, \['-e', script\]/);
  assert.match(actions, /spawn\('zylos', \['upgrade', '--self', '-y'\]/);
});

function fleetFixture() {
  const now = '2026-06-07T15:20:00.000Z';
  return {
    updated_at: now,
    agents: [
      {
        name: 'zylos02',
        color: '#2563eb',
        state: 'IDLE',
        activity: null,
        context_pct: 0.18,
        cost: 0.006,
        last_seen: now,
        pulse_rate: 1,
        health_reason: 'idle',
        sparkline: [0.001, 0.003, 0.006]
      },
      {
        name: 'zylos01',
        color: '#0d9488',
        state: 'BUSY',
        activity: 'exec_command npm test',
        context_pct: 72,
        cost: 0.12,
        last_seen: '2026-06-07T15:19:45.000Z',
        pulse_rate: 0.8,
        health_reason: 'ok',
        sparkline: [0.02, 0.08, 0.12]
      },
      {
        name: 'zylos0t',
        color: '#dc2626',
        state: 'POSSIBLY_STUCK',
        activity: 'no progress',
        context_pct: 0.91,
        cost: 0.03,
        last_seen: '2026-06-07T15:18:00.000Z',
        pulse_rate: 1.5,
        health_reason: 'stuck'
      },
      {
        name: 'eva',
        color: '#7c3aed',
        state: 'OFFLINE',
        activity: 'last message',
        context_pct: null,
        cost: 0,
        last_seen: '2026-06-07T14:20:00.000Z',
        pulse_rate: 0,
        health_reason: 'unreachable'
      }
    ]
  };
}

test('Pulse Wall fixture renders aggregate counts, tile states, reason, and drill-down links', () => {
  const view = buildPulseWallView(fleetFixture(), {
    nowMs: Date.parse('2026-06-07T15:20:00.000Z'),
    basePath: '/dash',
    mascotRoot: '/dash/_assets/img/mascot'
  });
  const html = renderPulseWallHtml(fleetFixture(), {
    nowMs: Date.parse('2026-06-07T15:20:00.000Z'),
    basePath: '/dash',
    mascotRoot: '/dash/_assets/img/mascot'
  });

  assert.equal(view.tiles.length, 4);
  assert.equal(view.counts.busy, 1);
  assert.equal(view.counts.idle, 1);
  assert.equal(view.counts.stuck, 1);
  assert.equal(view.counts.offline, 1);
  assert.equal(view.totalCostLabel, '$0.1560');

  assert.match(html, /class="pulse-tile pulse-tile-busy"/);
  assert.match(html, /class="pulse-tile pulse-tile-stuck"/);
  assert.match(html, /class="pulse-tile pulse-tile-offline is-offline"/);
  assert.match(html, /unreachable/);
  assert.match(html, /last seen 15s ago/);
  assert.match(html, /href="\/dash\/fleet\/zylos01\/"/);
  assert.match(html, /src="\/dash\/_assets\/img\/mascot\/busy\.png"/);
  assert.match(html, /<svg class="pulse-sparkline"/);
});

test('Pulse Wall preserves name color mapping when fleet response order changes', () => {
  const original = buildPulseWallView(fleetFixture(), {
    nowMs: Date.parse('2026-06-07T15:20:00.000Z')
  });
  const shuffledFixture = fleetFixture();
  shuffledFixture.agents = [...shuffledFixture.agents].reverse();
  const shuffled = buildPulseWallView(shuffledFixture, {
    nowMs: Date.parse('2026-06-07T15:20:00.000Z')
  });

  const originalColors = Object.fromEntries(original.tiles.map((tile) => [tile.name, tile.color]));
  const shuffledColors = Object.fromEntries(shuffled.tiles.map((tile) => [tile.name, tile.color]));
  assert.deepEqual(shuffledColors, originalColors);
  assert.deepEqual(shuffled.tiles.map((tile) => tile.name), original.tiles.map((tile) => tile.name));
});
