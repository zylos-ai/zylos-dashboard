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
  assert.match(app, /document\.addEventListener\('visibilitychange', syncFleetSubscription\)/);
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
  // multiAgent is true when the fleet (self + at least one external) has >= 2 agents.
  assert.match(app, /state\.multiAgent = \(fleet\?\.agents\?\.length \|\| 0\) >= 2;/);
  // Multi-agent mode lands on Agent Fleet; single mode shows the agent dashboard.
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
  // And single mode must actually set the hidden attribute.
  assert.match(app, /if \(!state\.multiAgent\)[\s\S]*?backBtn\.hidden = true/);
});

test('Agent Fleet is the top-level fleet view and pulse is gone from UI', () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.doesNotMatch(html, /data-tab="pulse"/);
  assert.doesNotMatch(html, /id="tab-pulse"/);
  assert.doesNotMatch(html, /Pulse Wall/);
  assert.match(html, /data-tab="overview"/);
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
    agents: [{ name: 'a', state: 'IDLE', context_pct: 0.6 }]
  });
  assert.equal(view.tiles[0].contextLevel, 'warning');
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
  // All fleet payload applications go through the hover gate...
  assert.match(app, /function setFleet\(payload\) \{\n  if \(state\.fleetHoverPaused\) \{/);
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
