import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, publicConfig } from '../src/shared.js';

test('LibreTranslate normalizes local HTTP, HTTPS and proxy paths without changing AI settings', () => {
  assert.equal(DEFAULT_SETTINGS.libreEndpoint, '');
  for (const [input, expected] of [
    ['http://localhost:5000', 'http://localhost:5000/translate'],
    ['http://127.0.0.1:5000/translate/', 'http://127.0.0.1:5000/translate'],
    ['http://[::1]:5000', 'http://[::1]:5000/translate'],
    ['https://example.test/proxy/', 'https://example.test/proxy/translate'],
    ['https://example.test/translate', 'https://example.test/translate'],
  ]) {
    const config = normalizeSettings({ provider: 'libretranslate', libreEndpoint: input, libreApiKey: 'instance-key', endpoint: 'https://my-ai.test/v1', apiKey: 'ai-secret' });
    assert.equal(config.libreEndpoint, expected);
    assert.equal(config.endpoint, 'https://my-ai.test/v1');
    assert.equal(config.apiKey, 'ai-secret');
    assert.equal(config.libreApiKey, 'instance-key');
    assert.equal(publicConfig(config).configured, true);
  }
});

test('missing LibreTranslate address is unconfigured even with a key and public state is secret-free', () => {
  const config = normalizeSettings({ provider: 'libretranslate', libreApiKey: 'private-instance-key', apiKey: 'private-ai-key' });
  assert.deepEqual(publicConfig(config, 'r1'), { configured: false, provider: 'libretranslate', targetLanguage: 'zh-CN', revision: 'r1' });
  const configured = publicConfig(normalizeSettings({ ...config, libreEndpoint: 'http://localhost:5000' }), 'r2');
  assert.equal(configured.configured, true);
  assert.doesNotMatch(JSON.stringify(configured), /private-|localhost/);
});

test('only the selected engine validates its own URL and credentials, preserving all drafts', () => {
  const bad = { libreEndpoint: 'file:///private', libreApiKey: 'bad\n' + 'x'.repeat(2050) };
  assert.doesNotThrow(() => normalizeSettings({ provider: 'microsoft', ...bad }));
  assert.doesNotThrow(() => normalizeSettings({ provider: 'ai', ...bad }));
  for (const libreEndpoint of ['file:///private', 'javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/?key=secret', 'https://example.test/#secret']) {
    assert.throws(() => normalizeSettings({ provider: 'libretranslate', libreEndpoint }), { code: 'CONFIG' });
  }
  assert.throws(() => normalizeSettings({ provider: 'libretranslate', libreEndpoint: 'http://localhost:5000', libreApiKey: 'key\nvalue' }), { code: 'CONFIG' });
  assert.doesNotThrow(() => normalizeSettings({ provider: 'libretranslate', libreEndpoint: 'http://localhost:5000', endpoint: '', model: '', apiKey: 'bad\nai-key' }));
});

test('legacy settings keep their previous provider and gain independent empty LibreTranslate defaults', () => {
  for (const existing of [
    { endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'legacy-key' },
    { provider: 'google' },
    { provider: 'microsoft' },
  ]) {
    const config = normalizeSettings(existing);
    assert.equal(config.provider, existing.provider || 'ai');
    assert.equal(config.libreEndpoint, '');
    assert.equal(config.libreApiKey, '');
  }
});
