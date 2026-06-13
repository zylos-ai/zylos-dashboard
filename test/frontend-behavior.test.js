import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildAgentFleetView, liveStateMood, renderAgentFleetHtml } from '../public/js/agent-fleet.js';
import { agentColor } from '../src/lib/agent-color.js';

test('prompt source transient display is capped at 5 seconds', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /const PROMPT_TRANSIENT_SECONDS = 5;/);
  assert.match(app, /promptAge < PROMPT_TRANSIENT_SECONDS/);
  assert.doesNotMatch(app, /promptAge < 30/);
});

test('single-agent mascot uses the octopus PNGs shared with Agent Fleet and tinted by agent hue', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  // Reuses the Agent Fleet mood logic + mascot file map (single source of truth).
  assert.match(app, /import \{ renderAgentFleet, liveStateMood, MASCOT_BY_MOOD \} from '\.\/agent-fleet\.js'/);
  // Renders an <img> from the shared mascot set, not the legacy inline SVG.
  assert.match(app, /img class="mascot-img" src="\$\{ASSET_ROOT\}\/img\/mascot\//);
  assert.match(app, /hue-rotate\(\$\{hue\}deg\)/);
  // Legacy pixel-art SVG mascot generator is gone.
  assert.doesNotMatch(app, /function mascotSvg\(/);
  // /api/state exposes the agent's identity color/hue for the tint.
  assert.match(index, /stateData\.agent = \{ \.\.\.config\.agent, \.\.\.agentColor\(config\.agent\?\.name\) \}/);
});

test('SSE state updates preserve the agent identity color so the mascot stays tinted', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // The SSE state_change payload omits the agent color (added only by
  // /api/state). The client must carry it over, the same way it already does
  // for runtime_info, so the single-agent mascot doesn't flicker back to the
  // untinted base art on every live update.
  assert.match(app, /const prevAgent = state\.dashboardState\?\.agent;/);
  assert.match(app, /if \(!data\.agent && prevAgent\) state\.dashboardState\.agent = prevAgent;/);
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
        session_cost: 0.006,
        daily_cost: 0.04,
        weekly_cost: 0.2,
        model: 'Opus 4.6',
        effort: 'high',
        new_session_threshold: 70,
        cpu_pct: 12,
        mem_pct: 34,
        disk_pct: 56,
        has_upgrade: false,
        has_subagent: false,
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
        session_cost: 0.12,
        daily_cost: 0.4,
        weekly_cost: 1.8,
        model: 'GPT-5',
        effort: 'medium',
        new_session_threshold: 70,
        cpu_pct: 21,
        mem_pct: 43,
        disk_pct: 65,
        has_upgrade: true,
        has_subagent: true,
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
        session_cost: 0.03,
        daily_cost: 0.09,
        weekly_cost: 0.7,
        model: 'Sonnet',
        effort: 'low',
        new_session_threshold: 80,
        cpu_pct: 82,
        mem_pct: 71,
        disk_pct: 44,
        has_upgrade: false,
        has_subagent: false,
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
        session_cost: 0,
        daily_cost: null,
        weekly_cost: null,
        model: null,
        effort: null,
        new_session_threshold: null,
        cpu_pct: null,
        mem_pct: null,
        disk_pct: null,
        has_upgrade: false,
        has_subagent: false,
        cost: 0,
        last_seen: '2026-06-07T14:20:00.000Z',
        pulse_rate: 0,
        health_reason: 'unreachable'
      }
    ]
  };
}

test('Agent Fleet fixture renders operational fields and removes deprecated Pulse Wall elements', () => {
  const view = buildAgentFleetView(fleetFixture(), {
    basePath: '/dash',
    mascotRoot: '/dash/_assets/img/mascot'
  });
  const html = renderAgentFleetHtml(fleetFixture(), {
    basePath: '/dash',
    mascotRoot: '/dash/_assets/img/mascot'
  });

  assert.equal(view.tiles.length, 4);
  assert.equal(view.counts.busy, 1);
  assert.equal(view.counts.idle, 1);
  assert.equal(view.counts.stuck, 1);
  assert.equal(view.counts.offline, 1);
  assert.match(html, /class="agent-tile agent-tile-busy/);
  assert.match(html, /class="agent-tile agent-tile-stuck/);
  assert.match(html, /class="agent-tile agent-tile-offline is-offline/);
  assert.match(html, /Unreachable/);
  assert.match(html, /agent-state mood-idle/);
  assert.match(html, /agent-state mood-busy/);
  assert.match(html, /agent-state mood-stuck/);
  assert.match(html, /agent-state mood-offline/);
  assert.match(html, /ring-warning/);
  assert.doesNotMatch(html, /ring-critical/);
  assert.equal((html.match(/class="agent-fleet-reason"/g) || []).length, 2);
  assert.match(html, /href="\/dash\/fleet\/zylos01\/"/);
  assert.match(html, /src="\/dash\/_assets\/img\/mascot\/busy\.png"/);
  assert.match(html, new RegExp(`data-agent="zylos01"[^>]+--agent-hue:${agentColor('zylos01').hue}deg;`));
  assert.match(html, /GPT-5 \/ medium/);
  assert.doesNotMatch(html, /agent-upgrade-badge/);
  assert.doesNotMatch(html, /Upgrade available/);
  assert.match(html, /Session/);
  assert.match(html, /Today/);
  assert.match(html, /7 days/);
  assert.match(html, /CPU/);
  assert.match(html, /Memory/);
  assert.match(html, /Disk/);
  assert.match(html, /subagent-light is-on/);
  assert.doesNotMatch(html, /pulse-sparkline/);
  assert.doesNotMatch(html, /last seen/);
  assert.doesNotMatch(html, /--pulse-rate/);
  assert.doesNotMatch(html, /pulse-self-badge/);
});

test('Agent Fleet preserves self first and stable name color mapping when response order changes', () => {
  const fixture = fleetFixture();
  fixture.agents[1].self = true;
  const original = buildAgentFleetView(fixture);
  const shuffledFixture = fleetFixture();
  shuffledFixture.agents[1].self = true;
  shuffledFixture.agents = [...shuffledFixture.agents].reverse();
  const shuffled = buildAgentFleetView(shuffledFixture);

  const originalColors = Object.fromEntries(original.tiles.map((tile) => [tile.name, tile.color]));
  const shuffledColors = Object.fromEntries(shuffled.tiles.map((tile) => [tile.name, tile.color]));
  const originalHues = Object.fromEntries(original.tiles.map((tile) => [tile.name, tile.hue]));
  const shuffledHues = Object.fromEntries(shuffled.tiles.map((tile) => [tile.name, tile.hue]));
  assert.deepEqual(shuffledColors, originalColors);
  assert.deepEqual(shuffledHues, originalHues);
  assert.ok(Object.values(originalHues).some((hue) => hue !== 0));
  assert.equal(shuffled.tiles[0].name, 'zylos01');
  assert.equal(shuffled.tiles[0].isSelf, true);
});

test('Agent Fleet uses SSE fleet events with one-shot fetch fallback', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /function clearFleetFallback\(\)/);
  assert.match(app, /function shouldReceiveFleetEvents\(\)/);
  assert.match(app, /function isSseOpen\(\)/);
  assert.match(app, /!!window\.EventSource && state\.eventSource\?\.readyState === window\.EventSource\.OPEN/);
  assert.match(app, /state\.fleetViewActive && document\.visibilityState !== 'hidden'/);
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{/);
  // #247: returning to the foreground refetches immediately instead of
  // waiting out the 10s fleet fallback / 30s poll timers.
  assert.match(app, /if \(document\.visibilityState === 'visible'\) refreshAll\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(app, /state\.eventSource\.addEventListener\(ev,/);
  assert.match(app, /'fleet'/);
  assert.match(app, /setTimeout\(\(\) => \{[\s\S]*?refreshFleet\(\)\.catch\(\(\) => \{\}\);[\s\S]*?\}, 10_000\)/);
  assert.match(app, /refreshFleet\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(app, /state\.fleetTimer = setInterval\(refreshFleet, 3_000\)/);
  assert.doesNotMatch(app, /setInterval\(\(\) => \{\s*refreshFleet/);
  assert.doesNotMatch(app, /[^.]EventSource\.OPEN/);
});

test('multi-agent vs single mode landing view is gated on fleet size', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // multiAgent is true when the fleet (self + at least one external) has >= 2
  // agents — but never in remote-proxy context, where the remote's own fleet
  // config must not hijack the landing view.
  assert.match(app, /function hasFleetWall\(fleet\)/);
  assert.match(app, /return !REMOTE_AGENT && \(fleet\?\.agents\?\.length \|\| 0\) >= 2;/);
  assert.match(app, /function syncLiveFleetMode\(fleet\)/);
  assert.match(app, /const modeChanged = state\.fleetModeInitialized \? syncLiveFleetMode\(payload\) : false;/);
  // Remote context is derived from the proxy-injected base path.
  assert.match(app, /BASE_PATH\.match\(/);
  // Multi-agent mode lands on Agent Fleet; single mode shows the agent dashboard,
  // including live 0<->1 remote transitions after boot.
  assert.match(app, /if \(!state\.multiAgent\)/);
  assert.match(app, /showFleetView\(\{ animate: !prefersReducedMotion\(\) \}\)/);
  assert.match(app, /showAgentDetail\(\{ animate: !prefersReducedMotion\(\) \}\)/);
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
  const view = buildAgentFleetView(selfFleet, {
    basePath: '/dash'
  });
  const byName = Object.fromEntries(view.tiles.map((tile) => [tile.name, tile]));
  assert.equal(byName.local.isSelf, true);
  assert.equal(byName.local.href, '/dash/');
  assert.equal(byName.remote.isSelf, false);
  assert.equal(byName.remote.href, '/dash/fleet/remote/');

  const html = renderAgentFleetHtml(selfFleet, {
    basePath: '/dash'
  });
  assert.match(html, /class="agent-tile agent-tile-idle is-self context-ok"/);
  assert.match(html, /data-self="true"/);
  assert.match(html, /href="\/dash\/"/);
  assert.match(html, /href="\/dash\/fleet\/remote\/"/);
});

test('back-to-fleet control is hidden via [hidden] in single-agent mode (no CSS specificity leak)', () => {
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // The class sets display:inline-flex, so a [hidden] guard is required or the
  // UA hidden rule is overridden and the button leaks into single-agent mode.
  assert.match(css, /\.back-to-fleet\[hidden\]\s*\{\s*display:\s*none/);
  // And single mode must actually set the hidden attribute — except in remote
  // context, where the back control survives to return to the parent wall.
  assert.match(app, /if \(!state\.multiAgent\)[\s\S]*?backBtn\.hidden = !REMOTE_AGENT/);
  // The remote-context back control leaves the page for the parent dashboard.
  assert.match(app, /if \(REMOTE_AGENT\)[\s\S]*?window\.location\.href = PARENT_DASHBOARD_PATH/);
});

test('Agent Fleet is the top-level fleet view and pulse is gone from UI', () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.doesNotMatch(html, /data-tab="pulse"/);
  assert.doesNotMatch(html, /id="tab-pulse"/);
  assert.doesNotMatch(html, /Pulse Wall/);
  assert.match(html, /data-tab="overview"/);
  assert.match(html, /data-tab="memory"/);
  assert.match(html, /data-tab="trends"/);
  assert.match(html, /id="fleet-view"/);
  assert.match(html, /id="back-to-fleet"/);
  assert.match(html, /id="agent-fleet-root"/);
});

// --- Fleet tile iteration 2 rendering ---

test('fleet tile renders mini ring with centered value and label below', () => {
  const html = renderAgentFleetHtml({ agents: [{ name: 'a', state: 'IDLE', cpu_pct: 8 }] });
  assert.match(html, /class="fleet-mini-ring-dial"><span>8%<\/span><\/span>\s*<small>CPU<\/small>/);
});

test('fleet tile renders link quality chips and granular failure reasons', () => {
  const html = renderAgentFleetHtml({
    agents: [
      {
        name: 'slow',
        state: 'IDLE',
        link: { quality: 'slow', latency_ms: 1840, latency_p95_ms: 1900, sampled_at: '2026-06-12T00:00:00.000Z', reason: null }
      },
      {
        name: 'degraded',
        state: 'IDLE',
        link: { quality: 'degraded', latency_ms: null, latency_p95_ms: null, sampled_at: null, reason: 'timeout' }
      },
      {
        name: 'bad',
        state: 'OFFLINE',
        pulse_rate: 0,
        health_reason: 'bad_payload',
        link: { quality: 'down', latency_ms: null, latency_p95_ms: null, sampled_at: null, reason: 'bad_payload' }
      }
    ]
  });

  assert.match(html, /agent-link-chip link-slow[^>]*>1\.8s</);
  assert.match(html, /agent-link-chip link-degraded[^>]*>Link warning</);
  assert.match(html, /title="Link latency · Degraded: Timeout"/);
  assert.match(html, /class="agent-fleet-reason">Bad payload<\/span>/);
  assert.doesNotMatch(html, /agent-link-chip link-ok/);
});

test('fleet tile always renders 5h/7d rate rows, with -- when unreported', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', rate_limit_pct: 13, rate_limit_7d_pct: null }]
  });
  assert.match(html, /class="fleet-rate-row rate-ok" aria-label="5h 13%"/);
  assert.match(html, /aria-label="7d --"/);
  assert.match(html, /width:13\.0%/);
});

test('fleet tile activity feed mirrors running tools with single-line rows', () => {
  const html = renderAgentFleetHtml({
    agents: [{
      name: 'a',
      state: 'BUSY',
      activity_feed: [
        { kind: 'tool', label: 'Bash: npm test', started_at: new Date(Date.now() - 5000).toISOString() },
        { kind: 'tool', label: 'Read: foo.js', started_at: null }
      ]
    }]
  });
  assert.match(html, /class="fleet-feed"/);
  assert.match(html, /Bash: npm test/);
  assert.match(html, /class="fleet-feed-age">\d+s</);
});

test('legacy activity line-clamp does not break the last feed row flex layout (#233)', () => {
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  // The clamp rule must target only the legacy direct-child activity span.
  // The descendant form also matched the last .fleet-feed-row and replaced
  // its display:flex with -webkit-box, un-aligning the elapsed-time label.
  assert.match(css, /\.agent-activity > span:last-child \{/);
  assert.doesNotMatch(css, /\.agent-activity span:last-child \{/);
});

test('fleet tile activity feed falls back to legacy single-line activity', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', activity: 'Prompt from lark', activity_feed: [] }]
  });
  assert.doesNotMatch(html, /class="fleet-feed"/);
  assert.match(html, /Prompt from lark/);
});

test('fleet tile renders thinking feed entry from kind, not label', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'BUSY', activity_feed: [{ kind: 'thinking', label: null, started_at: null }] }]
  });
  assert.match(html, /fleet-feed-row is-thinking/);
  assert.match(html, /Thinking…/);
});

test('fleet tile shows thinking mascot when feed has a thinking entry, counted as working', () => {
  const fleet = {
    agents: [{
      name: 'a', state: 'BUSY',
      activity: 'Prompt from lark',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  };
  const view = buildAgentFleetView(fleet);
  assert.equal(view.tiles[0].mood, 'thinking');
  const html = renderAgentFleetHtml(fleet);
  assert.match(html, /data-state="thinking"/);
  assert.match(html, /thinking\.png/);
  assert.match(html, /1 Working/);
});

test('fleet tile visible state badge follows the feed-upgraded mood', () => {
  const view = buildAgentFleetView({
    agents: [{
      name: 'a', state: 'BUSY',
      activity: 'Prompt from lark',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  });
  assert.equal(view.tiles[0].stateLabel, 'Thinking');
  const html = renderAgentFleetHtml({
    agents: [{
      name: 'a', state: 'BUSY',
      activity: 'Prompt from lark',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  });
  assert.match(html, /<span class="agent-state mood-thinking">Thinking<\/span>/);
});

test('fleet tile thinking feed never overrides stuck/offline moods', () => {
  const view = buildAgentFleetView({
    agents: [{
      name: 'a', state: 'POSSIBLY_STUCK',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  });
  assert.equal(view.tiles[0].mood, 'stuck');
});

test('fleet tile context level mirrors the single-agent bar thresholds, not new_session_threshold', () => {
  const tile = (pct) => renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: pct, new_session_threshold: 30 }]
  });
  assert.match(tile(42), / context-ok"/);
  assert.match(tile(50), / context-warning"/);
  assert.match(tile(75), / context-warning"/);
  assert.match(tile(76), / context-danger"/);
  assert.match(tile(null), / context-ok"/);
  // Threshold no longer drives the ring color (it stays a tick marker only):
  // 42% over a threshold of 30 must NOT mark the tile.
  assert.doesNotMatch(tile(42), /is-over-threshold/);

  const view = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 60 }]
  });
  assert.equal(view.tiles[0].contextLevel, 'warning');

  // #251: values are 0-100 percentages — never fraction-inferred. A genuine
  // 1% weekly usage must render 1%, not a full red bar.
  const tiny = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 0.6, rate_limit_7d_pct: 1 }]
  });
  assert.equal(tiny.tiles[0].contextLevel, 'ok');
  assert.equal(tiny.tiles[0].rate7dPct, 1);

  // Static guard: the fraction heuristic must not creep back into any
  // percent-typed frontend file (cache_rate ratio sites scale via an
  // explicit unconditional * 100 instead).
  for (const f of ['public/js/app.js', 'public/js/agent-fleet.js', 'public/js/gauge-utils.js']) {
    const src = fs.readFileSync(path.resolve(f), 'utf8');
    assert.doesNotMatch(src, /<=? ?1 \? [\w.]+ \* 100/, `${f} reintroduced the fraction heuristic`);
  }
});

test('liveStateMood upgrades busy-with-no-tools to thinking (detail page parity with #186)', () => {
  assert.equal(liveStateMood({ state: 'BUSY', activity: 'Prompt from lark', running_tools: [] }), 'thinking');
  assert.equal(liveStateMood({ state: 'BUSY', running_tools: [{ tool_name: 'Bash' }] }), 'busy');
  assert.equal(liveStateMood({ state: 'IDLE', running_tools: [] }), 'idle');
  assert.equal(liveStateMood({ state: 'POSSIBLY_STUCK', running_tools: [] }), 'stuck');
  assert.equal(liveStateMood(null), 'idle');
});

test('fleet tile renders context chip with usage and threshold, no tick line', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 42, new_session_threshold: 70 }]
  });
  assert.match(html, /<span class="context-chip"[^>]*>42% <small>\/ 70%<\/small><\/span>/);
  assert.doesNotMatch(html, /context-threshold/);

  const over = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 79, new_session_threshold: 70 }]
  });
  assert.match(over, /context-chip is-over/);

  const empty = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: null, new_session_threshold: null }]
  });
  assert.match(empty, /-- <small>\/ --<\/small>/);
  assert.doesNotMatch(empty, /is-over/);
});

test('fleet wall pauses re-render on hover so native tooltips can appear', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // Fleet payload applications still go through the hover gate after the sound
  // tracker and live view-mode reconciliation; a 0<->1 remote transition is
  // allowed to pierce hover pause so the page changes mode immediately.
  assert.match(app, /function setFleet\(payload\) \{\n(.*\n)*?  fleetSounds\?\.handleFleet\(payload\);\n  state\.fleet = payload;\n  const modeChanged = state\.fleetModeInitialized \? syncLiveFleetMode\(payload\) : false;\n  if \(state\.fleetHoverPaused && !modeChanged\) \{/);
  assert.doesNotMatch(app, /state\.fleet = data;\n\s*renderFleet\(\)/);
  // ...armed by pointer enter/leave on the grid root, flushing pending data on leave.
  assert.match(app, /addEventListener\('mouseenter', \(\) => \{ state\.fleetHoverPaused = true; \}\)/);
  assert.match(app, /addEventListener\('mouseleave'/);
  assert.match(app, /if \(pending\) setFleet\(pending\)/);
});

test('fleet tile mascots animate per mood with a phase-locked delay across rebuilds', () => {
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  assert.match(css, /\.agent-tile-busy \.agent-mascot \{ animation: mascot-bob 0\.8s/);
  assert.match(css, /\.agent-tile-thinking \.agent-mascot \{ animation: mascot-tilt 3s/);
  assert.match(css, /\.agent-tile-idle \.agent-mascot \{ animation: mascot-breathe 3s/);
  assert.match(css, /\.agent-tile-stuck \.agent-mascot \{ animation: mascot-pulse 2s/);

  const html = renderAgentFleetHtml({ agents: [{ name: 'a', state: 'BUSY' }] });
  // Negative wall-clock-derived delay so a rebuilt tile resumes mid-cycle.
  assert.match(html, /class="agent-mascot"[^>]*style="animation-delay:-\d+ms"/);
});

test('fleet rate rows mirror the single-agent bar thresholds, not the system ring levels', () => {
  const row = (pct) => renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', rate_limit_pct: pct, rate_limit_7d_pct: null }]
  });
  assert.match(row(42), /fleet-rate-row rate-ok/);
  assert.match(row(50), /fleet-rate-row rate-warning/);
  assert.match(row(75), /fleet-rate-row rate-warning/);
  assert.match(row(76), /fleet-rate-row rate-danger/);
  // 70 was 'warning' under the old ringLevel thresholds — still warning here,
  // but 60 must now be warning too (was ok under ringLevel):
  assert.match(row(60), /fleet-rate-row rate-warning/);
  assert.match(row(null), /fleet-rate-row rate-ok/);
});

test('fleet summary shows state dots with dimmed zeros and aggregated cost tiers', () => {
  const html = renderAgentFleetHtml({
    agents: [
      { name: 'a', state: 'BUSY', session_cost: 111.62, daily_cost: 63.03, weekly_cost: 1299.31 },
      { name: 'b', state: 'IDLE', session_cost: 1.71, daily_cost: 142.55, weekly_cost: 687.24 }
    ]
  });
  assert.match(html, /<span class="sum-seg"><i class="sum-dot dot-busy"><\/i>1 Working<\/span>/);
  assert.match(html, /<span class="sum-seg"><i class="sum-dot dot-idle"><\/i>1 Idle<\/span>/);
  assert.match(html, /<span class="sum-seg is-zero"><i class="sum-dot dot-stuck"><\/i>0 Possible Stuck<\/span>/);
  assert.match(html, /<small>Session<\/small><strong>\$113\.33<\/strong>/);
  assert.match(html, /<small>Today<\/small><strong>\$205\.58<\/strong>/);
  assert.match(html, /<small>7 days<\/small><strong>\$1986\.55<\/strong>/);
});

test('fleet summary cost totals render -- when no agent reports a tier', () => {
  const view = buildAgentFleetView({ agents: [{ name: 'a', state: 'IDLE' }] });
  assert.deepEqual(view.costTotals, { session: '--', daily: '--', weekly: '--' });
  // Partial fleet: one agent reporting still produces a total, not '--'.
  const partial = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', session_cost: 2 }, { name: 'b', state: 'IDLE' }]
  });
  assert.equal(partial.costTotals.session, '$2.00');
});

test('fleet summary cost totals treat explicit null as unreported, but 0 as a real report', () => {
  // Production payloads send explicit nulls (getCostTiers without data,
  // offline default fleet records) — these must not sum as 0.
  const nulls = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', session_cost: null, daily_cost: null, weekly_cost: null }]
  });
  assert.deepEqual(nulls.costTotals, { session: '--', daily: '--', weekly: '--' });

  const zero = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', session_cost: 0, daily_cost: null, weekly_cost: null }]
  });
  assert.equal(zero.costTotals.session, '$0.0000');
  assert.equal(zero.costTotals.daily, '--');
});

test('in-page remote viewing rewrites agent data paths through the fleet proxy', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // Single choke point: every JSON fetch goes through agentPath().
  assert.match(app, /const r = await fetch\(api\(agentPath\(path\)\), \{ cache: 'no-store' \}\);/);
  // Only /api/* paths are re-rooted; /api/fleet (our own wall) and non-API
  // paths like /login always stay on the local dashboard root.
  assert.match(app, /if \(!path\.startsWith\('\/api\/'\) \|\| path === '\/api\/fleet'\) return path;/);
  assert.match(app, /return `\$\{remotePrefix\(\)\}\$\{path\}`;/);
  // Remote prefix URL-encodes the agent name.
  assert.match(app, /`\/fleet\/\$\{encodeURIComponent\(state\.remoteAgent\)\}`/);
});

test('SSE stream follows the viewed agent and remote fleet events never clobber the local wall', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /new EventSource\(api\(agentPath\('\/api\/stream'\)\)\)/);
  // Reconnect probe targets the same agent the stream does.
  assert.match(app, /await fetch\(api\(agentPath\('\/api\/state'\)\), \{ cache: 'no-store' \}\);/);
  // A remote agent's stream describes its own fleet — drop those events.
  assert.match(app, /if \(name === 'fleet' && state\.remoteAgent\) return;/);
});

test('entering and exiting a remote agent resets per-agent state and resubscribes SSE', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const enter = app.slice(app.indexOf('function enterRemoteAgent('), app.indexOf('function exitRemoteAgent('));
  const exit = app.slice(app.indexOf('function exitRemoteAgent('), app.indexOf('function initFleetMode('));
  for (const fn of [enter, exit]) {
    assert.match(fn, /resetAgentData\(\);/);
    assert.match(fn, /connectSse\(\);/);
    assert.match(fn, /refreshAll\(\)\.catch/);
  }
  assert.match(enter, /showAgentDetail\(\);/);
  assert.match(exit, /showFleetView\(\);/);
  // resetAgentData clears incremental DOM, not just state, so panels from two
  // agents never mix.
  const reset = app.slice(app.indexOf('function resetAgentData('), app.indexOf('function enterRemoteAgent('));
  assert.match(reset, /prevSubagentIds\.clear\(\);/);
  assert.match(reset, /#tool-feed/);
  assert.match(reset, /#subagent-list/);
  assert.match(reset, /renderAll\(\);/);
});

test('single-agent dashboards never activate in-page remote viewing', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const enter = app.slice(app.indexOf('function enterRemoteAgent('), app.indexOf('function exitRemoteAgent('));
  // Guard sits at the function entry so both the tile-click path and a stale
  // popstate /fleet/<name> match are bypassed when there is no fleet wall.
  assert.match(enter, /if \(!state\.multiAgent\) return;/);
  assert.ok(enter.indexOf('if (!state.multiAgent) return;') < enter.indexOf('state.remoteAgent = name;'));
});

test('back button resolves in-page remote first, standalone remote second, fleet wall last', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // Anchor inside initFleetMode — applyFleetMode also references #back-to-fleet.
  const fleetMode = app.indexOf('function initFleetMode(');
  const start = app.indexOf("const backBtn = $('#back-to-fleet');", fleetMode);
  const handler = app.slice(start, app.indexOf('initLocaleToggle', start));
  const inPage = handler.indexOf('if (state.remoteAgent) {');
  const standalone = handler.indexOf('if (REMOTE_AGENT) {');
  const wall = handler.indexOf('showFleetView();');
  assert.ok(inPage > -1 && standalone > inPage && wall > standalone);
  assert.match(handler, /exitRemoteAgent\(\);/);
  assert.match(handler, /window\.location\.href = PARENT_DASHBOARD_PATH;/);
});

test('popstate routes /fleet/<name> paths into remote view only on the parent document', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // The standalone remote document (REMOTE_AGENT) keeps plain tab routing.
  assert.match(app, /if \(!REMOTE_AGENT\) \{\s*\n\s*const m = path\.match\(\/\\\/fleet\\\/\(\[\^\/\]\+\)\\\/\?\(\?::?trends\|memory\)\?\$\/\);?/);
  assert.match(app, /enterRemoteAgent\(decodeURIComponent\(m\[1\]\), \{ push: false \}\);/);
  assert.match(app, /else if \(state\.remoteAgent\) \{\s*\n\s*exitRemoteAgent\(\{ push: false \}\);/);
  // Tab pushState carries the remote prefix so deep links stay consistent.
  assert.match(app, /const path = name === 'overview' \? `\$\{prefix\}\/` : `\$\{prefix\}\/\$\{name\}`;/);
});

test('fleet wall tiles enter remote agents in-page instead of full navigation', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const fleetMode = app.indexOf('function initFleetMode(');
  const block = app.slice(fleetMode, app.indexOf("const backBtn = $('#back-to-fleet');", fleetMode));
  assert.match(block, /if \(tile\.dataset\.agent\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*enterRemoteAgent\(tile\.dataset\.agent\);/);
});

test('remote Actions/Settings are gated by access and routed through the viewed agent', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /function remoteAccess\(\)/);
  assert.match(app, /agent\?\.access === 'admin' \? 'admin' : 'read'/);
  assert.match(app, /const REMOTE_ACCESS = document\.documentElement\.dataset\.remoteAccess === 'admin' \? 'admin' : 'read';/);
  assert.match(app, /id="actions-btn"[^`]+disabled/);
  assert.match(app, /remote\.actions_read_only_tooltip/);
  assert.match(app, /remote\.settings_read_only_tooltip/);

  // Settings stays viewable under read access, but writes and action modals are gated.
  const handler = app.slice(app.indexOf('function initInfoBarButtons('), app.indexOf('function startTimers('));
  assert.match(handler, /closest\('#settings-btn'\)[\s\S]+openSettingsModal\(\)/);
  assert.match(handler, /if \(!remoteIsReadOnly\(\)\) openActionsModal\(\);/);

  assert.match(app, /const resp = await fetch\(api\(agentPath\('\/api\/settings'\)\)\);/);
  assert.match(app, /const resp = await fetch\(api\(agentPath\('\/api\/settings'\)\), \{/);
  assert.match(app, /const actionPath = agentPath\(`\/api\/actions\/\$\{action\}`\);/);
  assert.match(app, /const healthPath = agentPath\('\/api\/health'\);/);
  assert.match(app, /startCountdownAndReload\(15, statusEl, healthPath\);/);

  // An already-open modal cannot survive entering/exiting a remote view
  // (browser-back with the Actions modal open).
  const reset = app.slice(app.indexOf('function resetAgentData('), app.indexOf('function enterRemoteAgent('));
  assert.match(reset, /closeActionsModal\(\);/);
  assert.match(reset, /closeSettingsModal\(\);/);
});

test('memory browser is admin-scoped, agent-routed, and cache-busted', () => {
  const index = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.resolve('public/i18n/en.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.resolve('public/i18n/zh.json'), 'utf8'));

  assert.match(index, /data-tab="memory"/);
  assert.match(index, /id="tab-memory"/);
  assert.match(index, /id="memory-tree"/);
  assert.match(index, /id="memory-content"/);
  assert.match(index, /app\.js\?v=56/);
  assert.match(index, /style\.css\?v=44/);

  assert.match(app, /fetchAgentJson\('\/api\/memory\/tree'\)/);
  assert.match(app, /fetchAgentJson\(`\/api\/memory\/file\?path=\$\{encoded\}`\)/);
  assert.match(app, /fetchAgentJson\(`\/api\/memory\/git\?path=\$\{encoded\}`\)/);
  assert.match(app, /requestAgentJson\(`\/api\/memory\/file\?path=\$\{encodeURIComponent\(file\.path\)\}`/);
  assert.match(app, /method: 'PUT'/);
  assert.match(app, /JSON\.stringify\(\{ text, sha256 \}\)/);
  assert.match(app, /zylos\.memoryDraft\.\$\{memoryAgentKey\(\)\}\.\$\{filePath\}/);
  assert.match(app, /state\.memory\.draftTimer = setTimeout\(\(\) => \{/);
  assert.match(app, /\}, 500\);/);
  assert.match(app, /flushMemoryDraftSave\(\);[\s\S]+state\.memory\.selectedPath = filePath;/);
  assert.match(app, /setInterval\(\(\) => \{\s*\n\s*checkMemoryLiveSha\(\)\.catch\(\(\) => \{\}\);\s*\n\s*\}, 20_000\)/);
  assert.match(app, /state\.memory\.saving \|\| document\.hidden/);
  assert.match(app, /buildMemoryConflict\(latest, state\.memory\.draft, state\.memory\.draft\)/);
  assert.match(app, /isCompleteMemoryFile\(latest\)/);
  assert.doesNotMatch(app, /catch\(\(\) => err\.current \|\| null\)/);
  assert.match(app, /state\.memory\.error = 'memory_conflict_latest_failed'/);
  assert.match(app, /data-memory-retry-conflict/);
  assert.match(app, /if \(!isCompleteMemoryFile\(conflict\?\.theirs\)\) return;/);
  assert.match(app, /state\.memory\.file = conflict\.theirs;/);
  assert.doesNotMatch(app, /saveMemoryDraftToServer\(\{ text: conflict\.theirs\.text \|\| '', sha256: conflict\.theirs\.sha256 \}\)/);
  assert.match(app, /leftMid\.length \* rightMid\.length > 1_000_000/);
  assert.match(app, /memory\.diff_degraded/);
  assert.match(app, /memory\.diff_truncated/);
  assert.match(app, /data-memory-conflict="mine"/);
  assert.match(app, /data-memory-conflict="theirs"/);
  assert.match(app, /data-memory-conflict="manual"/);
  assert.match(app, /if \(name === 'memory' && remoteIsReadOnly\(\)\) name = 'overview';/);
  assert.match(app, /tab\.disabled = readOnly;/);
  assert.match(app, /memory\.remote_read_only/);
  assert.match(app, /resetMemoryState\(\);/);
  assert.match(app, /memory_file_too_large/);
  assert.match(app, /unsupported_memory_file/);
  assert.match(app, /memory_conflict/);

  assert.match(css, /\.memory-layout/);
  assert.match(css, /\.memory-markdown/);
  assert.match(css, /\.memory-raw/);
  assert.match(css, /\.memory-editor/);
  assert.match(css, /\.memory-conflict/);

  for (const pack of [en, zh]) {
    assert.equal(typeof pack['tab.memory'], 'string');
    assert.equal(typeof pack['memory.edit'], 'string');
    assert.equal(typeof pack['memory.save'], 'string');
    assert.equal(typeof pack['memory.error_scope'], 'string');
    assert.equal(typeof pack['memory.error_too_large'], 'string');
    assert.equal(typeof pack['memory.error_unsupported'], 'string');
    assert.equal(typeof pack['memory.error_conflict'], 'string');
    assert.equal(typeof pack['memory.error_conflict_latest_failed'], 'string');
    assert.equal(typeof pack['memory.remote_read_only'], 'string');
    assert.equal(typeof pack['memory.retry'], 'string');
    assert.equal(typeof pack['memory.diff_degraded'], 'string');
    assert.equal(typeof pack['memory.diff_truncated'], 'string');
  }
});

test('fleet management entry is local-only and modal is extensible for future management sections', () => {
  const index = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.resolve('public/i18n/en.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.resolve('public/i18n/zh.json'), 'utf8'));

  assert.match(index, /id="fleet-manage-btn"/);
  assert.match(index, /data-i18n-title="fleet_manage\.open"/);
  assert.match(index, /app\.js\?v=56/);
  assert.match(index, /<path d="M12 8V4H8"/);
  assert.match(index, /<rect width="16" height="12" x="4" y="8" rx="2"/);
  assert.match(app, /function initFleetManageButton\(\)[\s\S]*btn\.hidden = !!REMOTE_AGENT/);
  assert.match(app, /if \(e\.target\.closest\('#fleet-manage-btn'\)\) \{ e\.preventDefault\(\); openFleetManageModal\(\); return; \}/);

  // Fleet management configures the local consumer even while viewing a remote
  // agent in-page, so these calls intentionally avoid agentPath().
  assert.match(app, /fetch\(api\('\/api\/fleet\/agents'\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/fleet\/agents\/test'\), \{/);
  assert.match(app, /fetch\(api\('\/api\/agent\/name'\), \{/);
  assert.match(app, /fetch\(api\('\/api\/keys'\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/keys'\), \{/);
  assert.match(app, /fetch\(api\(`\/api\/keys\/\$\{encodeURIComponent\(name\)\}`\), \{ method: 'DELETE' \}\)/);
  assert.match(app, /fetch\(api\(`\/api\/keys\/\$\{encodeURIComponent\(name\)\}\/rotate`\), \{ method: 'POST' \}\)/);
  assert.match(app, /fetch\(api\(`\/api\/keys\/\$\{encodeURIComponent\(name\)\}\?permanent=1`\), \{ method: 'DELETE' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/keys\/purge-revoked'\), \{ method: 'POST' \}\)/);
  assert.doesNotMatch(app, /agentPath\('\/api\/fleet\/agents/);
  assert.doesNotMatch(app, /agentPath\('\/api\/agent\/name/);
  assert.doesNotMatch(app, /agentPath\('\/api\/keys/);
  assert.match(app, /function fleetManageError\(code, fallback\)/);
  assert.match(app, /fleetManageStatus\(fleetManageError\(data\.error \|\| 'unreachable'/);
  assert.match(app, /readKey: fleetManageModal\.querySelector\('#fleet-add-key'\)\?\.value \|\| ''/);
  assert.match(app, /createdKey: fleetManageModal\._createdKey \|\| null/);
  assert.match(app, /if \(wasOpen\) openFleetManageModal\(draft\);/);
  assert.match(app, /function renderFleetManage\(data, draft = null\)/);
  assert.match(app, /if \(!draft\) selfInput\.value = data\?\.self\?\.name \|\| viewedAgentName\(\);/);
  assert.match(app, /renderFleetManage\(data, draft\);/);
  assert.match(app, /function setFleetAddBusy\(isBusy\)/);
  assert.match(app, /fleetManageModal\?\.querySelector\('#fleet-test'\)\?\.toggleAttribute\('disabled', isBusy\);/);
  assert.match(app, /function setApiKeyBusy\(isBusy\)/);
  assert.match(app, /function renderCreatedApiKey\(createdKey\)/);
  assert.match(app, /renderCreatedApiKey\(draft\.createdKey \|\| null\);/);
  assert.match(app, /function rotateApiKey\(name\)/);
  assert.match(app, /function hardDeleteApiKey\(name\)/);
  assert.match(app, /function purgeRevokedApiKeys\(\)/);
  assert.match(app, /class="action-btn api-key-icon-btn api-key-rotate" type="button" title="\$\{rotateLabel\}" aria-label="\$\{rotateLabel\}"/);
  assert.match(app, /class="action-btn api-key-icon-btn api-key-revoke" type="button" title="\$\{revokeLabel\}" aria-label="\$\{revokeLabel\}"/);
  assert.match(app, /class="action-btn api-key-icon-btn api-key-delete" type="button" title="\$\{deleteLabel\}" aria-label="\$\{deleteLabel\}"/);
  assert.match(app, /API_KEY_ROTATE_ICON/);
  assert.match(app, /API_KEY_REVOKE_ICON/);
  assert.match(app, /API_KEY_DELETE_ICON/);
  assert.match(app, /replace_created_key_confirm/);
  assert.match(app, /if \(pendingKeyName && !window\.confirm/);
  assert.match(app, /if \(fleetManageModal\?\._createdKey\?\.name === name\) renderCreatedApiKey\(null\);/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /navigator\.clipboard\.writeText\(key\)/);
  assert.match(app, /id="api-key-admin-warning" hidden/);
  assert.match(app, /finally \{\s*setFleetAddBusy\(false\);\s*\}/);

  assert.match(app, /class="modal-tabs" role="tablist"/);
  assert.match(app, /data-tab="keys"/);
  assert.match(app, /data-panel="keys" hidden/);
  assert.match(app, /class="manage-section"/);
  assert.match(app, /id="fleet-add-key" type="password"/);
  assert.match(app, /id="api-key-scope"/);
  assert.match(css, /\.manage-modal/);
  assert.match(css, /\.modal-tabs/);
  assert.match(css, /\.fleet-help\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.api-key-created/);
  assert.match(css, /\.api-key-actions/);
  assert.match(css, /\.action-btn\.api-key-icon-btn/);
  assert.match(css, /\.action-btn\.api-key-icon-btn svg/);
  assert.match(css, /\.api-key-admin-warning/);

  for (const pack of [en, zh]) {
    assert.equal(typeof pack['fleet_manage.open'], 'string');
    assert.equal(typeof pack['fleet_manage.title'], 'string');
    assert.equal(typeof pack['fleet_manage.tab_fleet'], 'string');
    assert.equal(typeof pack['fleet_manage.tab_keys'], 'string');
    assert.equal(typeof pack['fleet_manage.key_created_once'], 'string');
    assert.equal(typeof pack['fleet_manage.rotate_key'], 'string');
    assert.equal(typeof pack['fleet_manage.revoke_key'], 'string');
    assert.equal(typeof pack['fleet_manage.delete_key'], 'string');
    assert.equal(typeof pack['fleet_manage.purge_revoked'], 'string');
    assert.equal(typeof pack['fleet_manage.replace_created_key_confirm'], 'string');
    assert.equal(typeof pack['fleet_manage.admin_key_warning'], 'string');
    assert.equal(typeof pack['fleet_manage.reserved_name'], 'string');
    assert.equal(typeof pack['fleet_manage.auth_failed'], 'string');
    assert.equal(typeof pack['fleet_manage.invalid_scope'], 'string');
  }

  // #238: the add-agent key field accepts any-scope API key — copy must not say "read key"
  assert.equal(en['fleet_manage.read_key'], 'API key');
  assert.equal(en['fleet_manage.missing_read_api_key'], 'API key is required.');
  assert.doesNotMatch(en['fleet_manage.keys_hint'], /read key/i);
  assert.doesNotMatch(en['fleet_manage.add_key_hint'], /read key/i);

  // #239: copyable Base URL for key handoff in the API Keys tab
  assert.match(app, /function dashboardBaseUrl\(\)/);
  assert.match(app, /\$\{window\.location\.origin\}\$\{BASE_PATH\}/);
  assert.match(app, /id="api-base-url" type="text" readonly/);
  assert.match(app, /id="api-base-url-copy"/);
  assert.match(app, /addEventListener\('click', copyDashboardBaseUrl\)/);
  for (const pack of [en, zh]) {
    assert.equal(typeof pack['fleet_manage.base_url_hint'], 'string');
    assert.equal(typeof pack['fleet_manage.base_url_copied'], 'string');
  }

  // #241: the back-to-fleet button must not stretch when a flex parent
  // (memory-tab-active pinned layout) applies align-items: stretch.
  const backToFleetRule = css.match(/\.back-to-fleet \{[^}]*\}/)[0];
  assert.match(backToFleetRule, /align-self:\s*flex-start/);

  // #242: success statuses auto-dismiss; closing the modal clears the status.
  assert.match(app, /clearTimeout\(fleetManageStatusTimer\)/);
  assert.match(app, /fleetManageStatusTimer = setTimeout\(\(\) => fleetManageStatus\(''\), 5000\);/);
  assert.match(app, /function closeFleetManageModal\(\) \{\s*if \(!fleetManageModal\) return;\s*fleetManageModal\.hidden = true;[\s\S]{0,80}fleetManageStatus\(''\);/);
});

test('i18n loader survives flaky pack fetches (#208)', async () => {
  const { isValidPack } = await import('../public/js/i18n.js');

  // Sentinel-key validation rejects proxy/captive-portal JSON and non-packs.
  assert.equal(isValidPack({ 'btn.actions': 'Actions' }), true);
  assert.equal(isValidPack({ error: 'bad gateway' }), false);
  assert.equal(isValidPack(['btn.actions']), false);
  assert.equal(isValidPack(null), false);
  assert.equal(isValidPack('btn.actions'), false);

  const i18n = fs.readFileSync(path.resolve('public/js/i18n.js'), 'utf8');
  // HTTP failures are detected, retried with backoff, and never thrown out of
  // initI18n (a top-level await rejection would kill the whole app).
  assert.match(i18n, /if \(!resp\.ok\) throw/);
  assert.match(i18n, /for \(let i = 0; i < FETCH_ATTEMPTS; i\+\+\)/);
  assert.match(i18n, /translations = readCachedPack\(targetLocale\) \|\| \{\};/);
  // Last good pack is cached per locale and used as the offline fallback.
  assert.match(i18n, /localStorage\.setItem\(PACK_CACHE_PREFIX \+ locale, JSON\.stringify\(pack\)\)/);
  // Background self-heal re-renders static labels once a late fetch succeeds,
  // and a stale heal loop stops after a locale switch.
  assert.match(i18n, /scheduleHeal\(targetLocale, seq\);/);
  assert.match(i18n, /if \(seq !== requestSeq\) return;/);
  assert.match(i18n, /renderI18n\(\);[\s\S]*?\} catch \{/);

  // The module itself is cache-busted: a stale i18n.js would reintroduce the
  // bug class even with a fresh app.js.
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /from '\.\/i18n\.js\?v=2'/);
});

test('overlapping initI18n calls: stale slow request cannot overwrite the newer locale (#211 review)', async () => {
  const store = new Map();
  const savedGlobals = {
    localStorage: globalThis.localStorage,
    document: globalThis.document,
    fetch: globalThis.fetch
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' }, configurable: true
  });
  globalThis.document = { documentElement: { lang: '' }, querySelectorAll: () => [] };
  const pending = {};
  globalThis.fetch = (url) => new Promise((resolve) => {
    const locale = String(url).includes('/zh.json') ? 'zh' : 'en';
    pending[locale] = (pack) => resolve({ ok: true, json: async () => pack });
  });

  try {
    // Fresh module instance so stubs apply and state is isolated.
    const { initI18n, t } = await import('../public/js/i18n.js?test=race');

    const slowEn = initI18n('en');          // captured first, resolves last
    const fastZh = initI18n('zh');          // newer call supersedes
    pending.zh({ 'btn.actions': '操作', 'race.marker': 'zh-pack' });
    await fastZh;
    assert.equal(t('race.marker'), 'zh-pack');

    pending.en({ 'btn.actions': 'Actions', 'race.marker': 'en-pack' });
    await slowEn;
    // The stale English response must not overwrite translations…
    assert.equal(t('race.marker'), 'zh-pack');
    // …nor pollute any locale's cache (zh cache intact, en cache never written).
    assert.match(store.get('zylos-dashboard-i18n-zh'), /zh-pack/);
    assert.equal(store.has('zylos-dashboard-i18n-en'), false);
  } finally {
    globalThis.localStorage = savedGlobals.localStorage;
    globalThis.document = savedGlobals.document;
    globalThis.fetch = savedGlobals.fetch;
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
  }
});

test('memory tab pins the page frame and panes scroll independently (#222)', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  // The pin is class-driven and must drop when the fleet wall takes over.
  assert.match(app, /function syncMemoryPinned\(\)/);
  assert.match(app, /classList\.toggle\('memory-tab-active', memoryTabActive && !state\.fleetViewActive\)/);
  // Pinned frame: fixed-height body, no page scroll, panes scroll internally.
  assert.match(css, /body\.memory-tab-active \{[^}]*height: 100dvh;[^}]*overflow: hidden;/s);
  assert.match(css, /body\.memory-tab-active \.memory-tree \{ flex: 1; min-height: 0; max-height: none; \}/);
});

test('memory tree directories collapse and expand (#222)', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  // Directory rows are buttons carrying their path and expansion state.
  assert.match(app, /<button class="memory-dir" type="button" data-dir="\$\{esc\(node\.path\)\}" aria-expanded="\$\{!collapsed\}"/);
  // #226: caret is an SVG chevron rotated by class, large enough to read.
  assert.match(app, /memory-dir-caret\$\{collapsed \? '' : ' expanded'\}/);
  assert.match(app, /MEMORY_CARET_ICON/);
  // Collapsed directories render no children.
  assert.match(app, /state\.memory\.collapsed\.has\(node\.path\)/);
  // Toggling flips membership in the collapsed set and re-renders.
  assert.match(app, /state\.memory\.collapsed\.delete\(dir\)/);
  assert.match(app, /state\.memory\.collapsed\.add\(dir\)/);
});

test('fleet sound cues use the marimba strike timbre Howard picked (#223)', () => {
  const sounds = fs.readFileSync(path.resolve('public/js/fleet-sounds.js'), 'utf8');
  // Fixed-pitch percussive strike with a 4th-harmonic partial — no glide.
  assert.match(sounds, /function strike\(ctx, \{ freq, at, decay = 0\.28, peak = 0\.34 \}\)/);
  assert.match(sounds, /freq \* 4/);
  assert.doesNotMatch(sounds, /'triangle'/);
  assert.doesNotMatch(sounds, /exponentialRampToValueAtTime\(to,/);
  // Approved phrases: start E5->A5, finish A5->E5->B4 with a longer last decay.
  assert.match(sounds, /strike\(ctx, \{ freq: 659, at \}\)/);
  assert.match(sounds, /strike\(ctx, \{ freq: 880, at: at \+ 0\.13 \}\)/);
  assert.match(sounds, /strike\(ctx, \{ freq: 494, at: at \+ 0\.24, decay: 0\.4 \}\)/);
});

test('stale rate-limit windows stop painting after resets_at passes (#224)', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  // Single-agent bars null out expired readings instead of showing the last value.
  assert.match(app, /function rateWindowExpired\(resetsAt\)/);
  assert.match(app, /const r5 = r5Expired \? null :/);
  assert.match(app, /const r7 = r7Expired \? null :/);
  // Producer payload (self tile + remote polling) applies the same rule.
  assert.match(index, /rateLimitWindowExpired\(resolved\.dimensions, metricName\)/);
});

test('memory tree has a collapse-all/expand-all toggle (#226)', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const i18nEn = fs.readFileSync(path.resolve('public/i18n/en.json'), 'utf8');
  const i18nZh = fs.readFileSync(path.resolve('public/i18n/zh.json'), 'utf8');
  assert.match(html, /id="memory-fold"/);
  // Toggle folds every directory at once, or expands everything back.
  assert.match(app, /state\.memory\.collapsed = allCollapsed \? new Set\(\) : new Set\(dirs\)/);
  // Button label/icon track whether everything is already collapsed.
  assert.match(app, /allCollapsed \? MEMORY_UNFOLD_ICON : MEMORY_FOLD_ICON/);
  assert.match(app, /allCollapsed \? t\('memory\.expand_all'\) : t\('memory\.collapse_all'\)/);
  assert.match(i18nEn, /memory\.collapse_all/);
  assert.match(i18nZh, /memory\.collapse_all/);
});

test('subagent list is height-capped with internal scroll (#259)', () => {
  const css = fs.readFileSync(path.resolve('public/css/style.css'), 'utf8');
  const block = css.match(/#subagent-list\s*\{[^}]*\}/);
  assert.ok(block, '#subagent-list rule must exist');
  assert.match(block[0], /max-height:\s*\d+px/);
  assert.match(block[0], /overflow-y:\s*auto/);
});
