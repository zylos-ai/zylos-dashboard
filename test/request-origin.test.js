import assert from 'node:assert/strict';
import test from 'node:test';
import { hasMatchingRequestAuthority } from '../src/lib/request-origin.js';

const check = (host, origin, extras = {}, options) => hasMatchingRequestAuthority({
  headers: { host, origin, ...extras }, socket: { encrypted: false },
}, options);

test('source authority ignores internal transport and forwarded protocol', () => {
  for (const forwarded of [undefined, 'http', 'https', 'http, https', 'garbage']) {
    assert.equal(check('luna.example.com', 'https://luna.example.com', { 'x-forwarded-proto': forwarded }), true);
    assert.equal(check('luna.example.com', 'https://sibling.example.com', { 'x-forwarded-proto': forwarded }), false);
  }
});

test('authority compares the entire hostname and effective port, including IPv6', () => {
  for (const [host, origin] of [
    ['luna.example.com', 'https://luna.example.com'],
    ['LUNA.example.com:443', 'https://luna.example.com'],
    ['luna.example.com:80', 'http://luna.example.com'],
    ['luna.example.com:8443', 'https://luna.example.com:8443'],
    ['localhost:3470', 'http://localhost:3470'],
    ['127.0.0.1:3470', 'http://127.0.0.1:3470'],
    ['[::1]:443', 'https://[::1]'],
    ['[::1]:3470', 'https://[::1]:3470'],
  ]) assert.equal(check(host, origin), true, `${host} / ${origin}`);
  for (const [host, origin] of [
    ['luna.example.com:80', 'https://luna.example.com'],
    ['luna.example.com:443', 'http://luna.example.com'],
    ['luna.example.com', 'https://luna.example.com:8443'],
    ['luna.example.com:8443', 'https://luna.example.com'],
    ['luna.example.com', 'https://luna.example.com.evil.test'],
    ['luna.example.com', 'https://sibling.example.com'],
    ['[::1]:3470', 'https://[::1]:3471'],
  ]) assert.equal(check(host, origin), false, `${host} / ${origin}`);
});

test('malformed or non-serialized Origin and Host fail closed', () => {
  for (const origin of [
    undefined, null, '', 'null', ['https://luna.example.com'],
    'https://luna.example.com/', 'https://luna.example.com/path',
    'https://luna.example.com?', 'https://luna.example.com#',
    'https://user@luna.example.com', 'https://luna.example.com:443',
    'https://luna.example.com:99999', 'https://luna.example.com:',
    'https://luna.example.com https://evil.test',
    'https://luna.example.com,https://evil.test',
    ' https://luna.example.com', 'https://luna.example.com\n',
    'https://luna.exa\tmple.com', 'https://luna.example.com\\',
    'https://%6cuna.example.com', 'ftp://luna.example.com',
    'file://luna.example.com', 'blob:https://luna.example.com/id',
  ]) assert.equal(check('luna.example.com', origin), false, String(origin));
  for (const host of [
    undefined, null, '', ['luna.example.com'], 'luna.example.com,evil.test',
    'luna.example.com/', 'user@luna.example.com', 'luna.example.com?',
    'luna.example.com#', ' luna.example.com', 'luna.example.com\n',
    'luna.example.com\\', '%6cuna.example.com', 'luna.example.com:',
    'luna.example.com:99999',
  ]) assert.equal(check(host, 'https://luna.example.com'), false, String(host));
});

test('only logout can opt into Referer fallback, and invalid Origin never falls back', () => {
  const extras = { referer: 'https://luna.example.com/dashboard/?tab=observer' };
  assert.equal(check('luna.example.com:443', undefined, extras), false);
  assert.equal(check('luna.example.com:443', undefined, extras, { allowReferer: true }), true);
  for (const origin of ['', 'null', 'https://evil.test', 'https://luna.example.com/']) {
    assert.equal(check('luna.example.com', origin, extras, { allowReferer: true }), false);
  }
  for (const referer of ['ftp://luna.example.com/path', 'https://user@luna.example.com/path', 'https://evil.test/path']) {
    assert.equal(check('luna.example.com', undefined, { referer }, { allowReferer: true }), false);
  }
});
