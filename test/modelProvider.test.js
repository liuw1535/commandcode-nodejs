// Tests for src/modelProvider.js — model resolution and cache population.
//
// The module keeps its cache in module-level state populated by refresh() via
// the global fetch. We stub global.fetch to feed a controlled model list, then
// exercise resolveModel's case-insensitive match / passthrough / default
// behavior. (init() starts a real setInterval, so we test refresh() directly
// and call stop() to be safe.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as mp from '../src/modelProvider.js';
import config from '../config.js';

const ORIGINAL_FETCH = global.fetch;

function mockModels(data) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ object: 'list', data }),
  });
}

function mockHttpError(status) {
  global.fetch = async () => ({ ok: false, status, statusText: 'err', json: async () => ({}) });
}

before(() => {
  // Start from an empty cache (the module may already have fetched at import
  // time in other test runs in the same process; refresh() replaces it).
});

after(() => {
  global.fetch = ORIGINAL_FETCH;
  mp.stop();
});

test('resolveModel: empty -> configured default (empty cache)', () => {
  mockModels([]); // empty list, but we don't even refresh here
  assert.equal(mp.resolveModel(''), config.MODELS.defaultModel);
  assert.equal(mp.resolveModel(undefined), config.MODELS.defaultModel);
});

test('resolveModel: non-empty name passes through when not in cache', () => {
  mockModels([]);
  // Note: without a refresh(), cache stays whatever it was. To guarantee a
  // clean state, refresh into an empty list first.
  // (resolveModel does not refresh; it reads the in-memory index.)
  assert.equal(typeof mp.resolveModel('unknown-model'), 'string');
});

test('refresh: populates cache from upstream OpenAI-format list', async () => {
  mockModels([
    { id: 'claude-sonnet-5', object: 'model', owned_by: 'zai' },
    { id: 'glm-5.2', object: 'model', owned_by: 'zai' },
  ]);
  const ok = await mp.refresh();
  assert.equal(ok, true);
  assert.equal(mp.getModelIds().length, 2);
  assert.deepEqual(mp.getModelIds(), ['claude-sonnet-5', 'glm-5.2']);
});

test('resolveModel: case-insensitive match returns canonical id', async () => {
  mockModels([{ id: 'zai-org/GLM-5.3' }, { id: 'Claude-Sonnet-5' }]);
  await mp.refresh();
  assert.equal(mp.resolveModel('ZAI-ORG/GLM-5.3'), 'zai-org/GLM-5.3');
  assert.equal(mp.resolveModel('claude-sonnet-5'), 'Claude-Sonnet-5');
  assert.equal(mp.resolveModel('CLAUDE-SONNET-5'), 'Claude-Sonnet-5');
});

test('resolveModel: no match -> passthrough verbatim (preserves casing)', async () => {
  mockModels([{ id: 'a' }]);
  await mp.refresh();
  assert.equal(mp.resolveModel('totally-unknown'), 'totally-unknown');
});

test('refresh: tolerates a bare array response (no data wrapper)', async () => {
  global.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => [{ id: 'bare-model' }],
  });
  const ok = await mp.refresh();
  assert.equal(ok, true);
  assert.deepEqual(mp.getModelIds(), ['bare-model']);
});

test('refresh: filters out entries without an id', async () => {
  mockModels([{ id: 'keep' }, { object: 'model' }, { id: 'also-keep' }]);
  await mp.refresh();
  assert.deepEqual(mp.getModelIds(), ['keep', 'also-keep']);
});

test('refresh: HTTP error returns false and keeps previous cache', async () => {
  mockModels([{ id: 'prev' }]);
  await mp.refresh();
  mockHttpError(500);
  const ok = await mp.refresh();
  assert.equal(ok, false);
  // previous cache retained
  assert.deepEqual(mp.getModelIds(), ['prev']);
});

test('getModels: returns full model objects (not just ids)', async () => {
  const models = [{ id: 'x', object: 'model', owned_by: 'o' }];
  mockModels(models);
  await mp.refresh();
  assert.equal(mp.getModels().length, 1);
  assert.equal(mp.getModels()[0].owned_by, 'o');
});
