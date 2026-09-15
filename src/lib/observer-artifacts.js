export const OBSERVER_ZELLIJ_VERSION = '0.45.1';

export const OBSERVER_ARTIFACTS = Object.freeze({
  'darwin-arm64': Object.freeze({
    platform: 'darwin-arm64',
    version: OBSERVER_ZELLIJ_VERSION,
    url: 'https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-aarch64-apple-darwin.tar.gz',
    archiveSha256: 'c029ba4fe1927b79ad9f0cdd59155c4dff80777863c85857d4d09b88b56f9891',
    binarySha256: 'ca5f9333735bdbc59a621f1d8ed8e24798845302a28ff175d253d4793d5a4a2c',
    archiveEntry: 'zellij',
  }),
});

export function observerPlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function observerArtifactFor(platform = process.platform, arch = process.arch) {
  return OBSERVER_ARTIFACTS[observerPlatformKey(platform, arch)] || null;
}
