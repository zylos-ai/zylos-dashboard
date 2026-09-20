import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OBSERVER_ARTIFACTS } from '../src/lib/observer-artifacts.js';
import { createObserverContainment } from '../src/lib/observer-containment.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Inspect every shipped target without executing foreign-architecture binaries.
// This catches an enabled catalog entry whose normal runtime bundle is missing.
for (const target of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
  test(`${target} enabled product ships source-bound native helpers`, async () => {
    assert.equal(OBSERVER_ARTIFACTS[target]?.platform, target);
    const [platform, arch] = target.split('-');
    const adapter = createObserverContainment({ dataDir: os.tmpdir(), platform, arch });
    const helpers = await adapter.verifyHelpers();
    assert.equal(adapter.helperDir, path.join(root, 'assets', 'observer', target));
    const manifest = JSON.parse(fs.readFileSync(path.join(adapter.helperDir, 'manifest.json')));
    assert.equal(manifest.platform, target);
    assert.equal(manifest.buildScriptSha256,
      digest(fs.readFileSync(path.join(root, 'src/native/observer/build.py'))));
    for (const file of Object.values(helpers)) {
      const entry = manifest.binaries[path.basename(file)];
      assert.ok(entry);
      assert.match(entry.source, /^src\/native\/observer\/[a-z-]+\.c$/);
      assert.equal(entry.sourceSha256, digest(fs.readFileSync(path.join(root, entry.source))));
      const bytes = fs.readFileSync(file);
      if (platform === 'linux') {
        assert.deepEqual(bytes.subarray(0, 6), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
        assert.equal(bytes.readUInt16LE(18), arch === 'x64' ? 62 : 183);
      } else {
        assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
        assert.equal(bytes.readUInt32LE(4), 0x0100000c);
      }
    }
  });
}
