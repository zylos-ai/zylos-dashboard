import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildPulseWallView, renderPulseWallHtml } from '../public/js/pulse-wall.js';
import { agentColor } from '../src/lib/agent-color.js';

test('prompt source transient display is capped at 5 seconds', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /const PROMPT_TRANSIENT_SECONDS = 5;/);
  assert.match(app, /promptAge < PROMPT_TRANSIENT_SECONDS/);
  assert.doesNotMatch(app, /promptAge < 30/);
});

test('single-agent mascot uses the new octopus PNGs (shared with the Pulse Wall) tinted by agent hue', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  // Reuses the Pulse Wall mood logic + mascot file map (single source of truth).
  assert.match(app, /import \{ renderPulseWall, stateMood, MASCOT_BY_MOOD \} from '\.\/pulse-wall\.js'/);
  // Renders an <img> from the shared mascot set, not the legacy inline SVG.
  assert.match(app, /img class="mascot-img" src="\$\{ASSET_ROOT\}\/img\/mascot\//);
  assert.match(app, /hue-rotate\(\$\{hue\}deg\)/);
  // Legacy pixel-art SVG mascot generator is gone.
  assert.doesNotMatch(app, /function mascotSvg\(/);
  // /api/state exposes the agent's identity color/hue for the tint.
  assert.match(index, /stateData\.agent = \{ \.\.\.config\.agent, \.\.\.agentColor\(config\.agent\?\.name\) \}/);
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
        color: agentColor('zylos02').color,
        hue: agentColor('zylos02').hue,
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
        color: agentColor('zylos01').color,
        hue: agentColor('zylos01').hue,
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
        color: agentColor('zylos0t').color,
        hue: agentColor('zylos0t').hue,
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
        color: agentColor('eva').color,
        hue: agentColor('eva').hue,
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
  assert.match(html, new RegExp(`data-agent="zylos01"[^>]+--agent-hue:${agentColor('zylos01').hue}deg;`));
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
  const originalHues = Object.fromEntries(original.tiles.map((tile) => [tile.name, tile.hue]));
  const shuffledHues = Object.fromEntries(shuffled.tiles.map((tile) => [tile.name, tile.hue]));
  assert.deepEqual(shuffledColors, originalColors);
  assert.deepEqual(shuffledHues, originalHues);
  assert.ok(Object.values(originalHues).some((hue) => hue !== 0));
  assert.deepEqual(shuffled.tiles.map((tile) => tile.name), original.tiles.map((tile) => tile.name));
});

test('Pulse Wall fast polling is scoped to the active fleet view and catches interval errors', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /function stopFleetPolling\(\)/);
  assert.match(app, /function shouldPollFleetFast\(\)/);
  assert.match(app, /state\.fleetViewActive && document\.visibilityState !== 'hidden'/);
  assert.match(app, /document\.addEventListener\('visibilitychange', syncFleetPolling\)/);
  assert.match(app, /refreshFleet\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(app, /state\.fleetTimer = setInterval\(refreshFleet, 3_000\)/);
  // Fast polling must no longer key on a "pulse" tab being active.
  assert.doesNotMatch(app, /activeTabName\(\) === 'pulse'/);
});

test('multi-agent vs single mode landing view is gated on fleet size', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // multiAgent is true when the fleet (self + at least one external) has >= 2 agents.
  assert.match(app, /state\.multiAgent = \(fleet\?\.agents\?\.length \|\| 0\) >= 2;/);
  // Multi-agent mode lands on the Pulse Wall; single mode shows the agent dashboard.
  assert.match(app, /if \(!state\.multiAgent\)/);
  assert.match(app, /showFleetView\(\)/);
  assert.match(app, /showAgentDetail\(\)/);
  // Early fetch drives the landing-view decision.
  assert.match(app, /applyFleetMode\(fleet\)/);
});

test('fleet ↔ agent view transition is wired with a graceful fallback', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const index = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  // Both top-level views live in a shared grid stack and carry the app-view class.
  assert.match(index, /id="view-stack"/);
  assert.match(index, /id="fleet-view"[^>]*class="[^"]*app-view|class="[^"]*app-view[^"]*"[^>]*id="fleet-view"/);
  assert.match(index, /id="agent-detail"[^>]*class="[^"]*app-view|class="[^"]*app-view[^"]*"[^>]*id="agent-detail"/);
  // The animated transition helper exists and is used by both directions.
  assert.match(app, /function transitionView\(target/);
  assert.match(app, /transitionView\('fleet'/);
  assert.match(app, /transitionView\('agent'/);
  // Graceful fallback: reduced motion / missing stack / already-active → instant swap.
  assert.match(app, /prefersReducedMotion\(\)/);
  // First-load deliberately dwells on the single-agent page, then zooms to the wall.
  assert.match(app, /setTimeout\(\(\) => showFleetView\(\{ animate: true \}\), \d+\)/);
  // CSS defines the stack and the zoom enter/leave states.
  assert.match(css, /\.view-stack\s*\{\s*display:\s*grid/);
  assert.match(css, /\.app-view\.v-enter/);
  assert.match(css, /\.app-view\.v-leave-to-fleet/);
  assert.match(css, /\.app-view\.v-leave-to-agent/);
});

test('self tile drills to local root and external tiles drill to /fleet/<name>/', () => {
  const selfFleet = {
    updated_at: '2026-06-07T15:20:00.000Z',
    agents: [
      { name: 'local', color: agentColor('local').color, hue: agentColor('local').hue, state: 'IDLE', context_pct: 0.2, cost: 0.01, last_seen: '2026-06-07T15:20:00.000Z', pulse_rate: 1, health_reason: 'idle', self: true },
      { name: 'remote', color: agentColor('remote').color, hue: agentColor('remote').hue, state: 'BUSY', activity: 'work', context_pct: 0.5, cost: 0.02, last_seen: '2026-06-07T15:20:00.000Z', pulse_rate: 1, health_reason: 'ok', self: false }
    ]
  };
  const view = buildPulseWallView(selfFleet, {
    nowMs: Date.parse('2026-06-07T15:20:00.000Z'),
    basePath: '/dash'
  });
  const byName = Object.fromEntries(view.tiles.map((tile) => [tile.name, tile]));
  assert.equal(byName.local.isSelf, true);
  assert.equal(byName.local.href, '/dash/');
  assert.equal(byName.remote.isSelf, false);
  assert.equal(byName.remote.href, '/dash/fleet/remote/');

  const html = renderPulseWallHtml(selfFleet, {
    nowMs: Date.parse('2026-06-07T15:20:00.000Z'),
    basePath: '/dash'
  });
  assert.match(html, /class="pulse-tile pulse-tile-idle is-self"/);
  assert.match(html, /data-self="true"/);
  assert.match(html, /href="\/dash\/"/);
  assert.match(html, /href="\/dash\/fleet\/remote\/"/);
});

test('pulse is no longer a peer tab in the tab bar', () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.doesNotMatch(html, /data-tab="pulse"/);
  assert.doesNotMatch(html, /id="tab-pulse"/);
  assert.match(html, /data-tab="overview"/);
  assert.match(html, /data-tab="trends"/);
  // The Pulse Wall is now a top-level fleet view with a back-to-fleet control.
  assert.match(html, /id="fleet-view"/);
  assert.match(html, /id="back-to-fleet"/);
  assert.match(html, /id="pulse-wall-root"/);
});
