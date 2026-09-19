import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBSERVER_ARTIFACT_CATALOG,
  OBSERVER_ARTIFACTS,
  observerArtifactFor,
  observerCatalogFor,
} from '../src/lib/observer-artifacts.js';

test('catalog pins every upstream v0.45.1 full-Web binary target', () => {
  assert.deepEqual(Object.keys(OBSERVER_ARTIFACT_CATALOG).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  for (const artifact of Object.values(OBSERVER_ARTIFACT_CATALOG)) {
    assert.equal(artifact.version, '0.45.1');
    assert.match(artifact.url, /\/releases\/download\/v0\.45\.1\//);
    assert.match(artifact.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(artifact.binarySha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(artifact.url, /no-web|latest/i);
  }
  assert.equal(OBSERVER_ARTIFACT_CATALOG['win32-x64'].alternatives[0].format, 'msi');
});

test('runtime selection opens installation only for natively validated platforms', () => {
  assert.equal(observerArtifactFor('darwin', 'arm64'), OBSERVER_ARTIFACTS['darwin-arm64']);
  assert.equal(observerArtifactFor('linux', 'x64'), null);
  assert.equal(observerCatalogFor('linux', 'x64'), OBSERVER_ARTIFACT_CATALOG['linux-x64']);
  assert.equal(observerCatalogFor('win32', 'arm64'), null);
});
