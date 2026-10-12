// Tests for src/ccBody.js — assembleCcBody (the API-style-agnostic seam that
// builds the commandcode /alpha/generate body) and debugCcBodyReasoning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleCcBody, debugCcBodyReasoning } from '../src/ccBody.js';
import config from '../config.js';

// Strip the nondeterministic threadId / date so the rest can be compared exactly.
function snapshot(body) {
  const { threadId, ...rest } = body;
  const date = rest.config.date;
  return { threadId, date, rest };
}

test('assembleCcBody: minimal body uses defaults from config', () => {
  const body = assembleCcBody({
    ccMessages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    model: 'claude-sonnet-5',
    threadId: 'TID-1',
  });
  assert.equal(body.threadId, 'TID-1');
  assert.equal(body.memory, null);
  assert.equal(body.taste, null);
  assert.equal(body.skills, null);
  assert.equal(body.permissionMode, 'standard');
  assert.equal(body.params.model, 'claude-sonnet-5');
  assert.equal(body.params.stream, true, 'stream is always pinned true');
  assert.equal(body.params.max_tokens, config.MAX_TOKENS);
  assert.equal(body.params.reasoning_effort, config.REASONING_EFFORT);
  assert.equal(Array.isArray(body.params.messages), true);
  assert.equal(body.params.tools, undefined);
  assert.equal(body.params.system, undefined);
});

test('assembleCcBody: maxTokens and reasoningEffort override config defaults', () => {
  const body = assembleCcBody({
    ccMessages: [],
    model: 'm',
    threadId: 't',
    maxTokens: 123,
    reasoningEffort: 'low',
  });
  assert.equal(body.params.max_tokens, 123);
  assert.equal(body.params.reasoning_effort, 'low');
});

test('assembleCcBody: tools and system are forwarded when provided', () => {
  const tools = [{ name: 'foo', description: 'd', input_schema: { type: 'object' } }];
  const system = [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }];
  const body = assembleCcBody({
    ccMessages: [],
    model: 'm',
    threadId: 't',
    tools,
    system,
  });
  assert.deepEqual(body.params.tools, tools);
  assert.deepEqual(body.params.system, system);
});

test('assembleCcBody: generates a uuid threadId when none passed', () => {
  const body = assembleCcBody({ ccMessages: [], model: 'm' });
  assert.equal(typeof body.threadId, 'string');
  assert.ok(body.threadId.length > 10, 'threadId should be a generated uuid');
});

test('assembleCcBody: config block derives workingDir from session.projectSlug', () => {
  const session = { projectSlug: 'c-users-foo42-desktop' };
  const body = assembleCcBody({ ccMessages: [], model: 'm', threadId: 't', session });
  assert.equal(body.config.workingDir, 'C:\\Users\\foo42\\Desktop');
  assert.equal(body.config.isGitRepo, false);
  assert.equal(body.config.currentBranch, '');
  assert.equal(body.config.structure.length, 0);
  assert.equal(Array.isArray(body.config.recentCommits), true);
  assert.equal(body.config.recentCommits.length, 0);
  // date is today's ISO date (YYYY-MM-DD)
  assert.equal(body.config.date, new Date().toISOString().slice(0, 10));
  assert.equal(body.config.environment, session.components?.platform || config.FINGERPRINT.platform);
});

test('assembleCcBody: config block falls back to config.PROJECT_SLUG when no session', () => {
  const body = assembleCcBody({ ccMessages: [], model: 'm', threadId: 't' });
  // No session: projectSlug comes from config.PROJECT_SLUG (empty in config.json
  // -> defaults to the 'proxy' fallback in buildConfigBlock).
  assert.ok(body.config.workingDir.includes('Desktop'));
});

test('debugCcBodyReasoning: is a no-op when DEBUG_CC_BODY is off', () => {
  // Should not throw regardless of input; returns undefined.
  assert.equal(debugCcBodyReasoning(null, {}), undefined);
  assert.equal(debugCcBodyReasoning({ params: { messages: [] } }, {}), undefined);
});

test('debugCcBodyReasoning: handles a body with reasoning blocks without throwing', () => {
  const body = {
    threadId: 'abcdefgh1234',
    params: {
      reasoning_effort: 'high',
      messages: [
        { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking hard about this' }] },
      ],
    },
  };
  // Even if DEBUG_CC_BODY happens to be on in the env, it must not throw.
  assert.doesNotThrow(() => debugCcBodyReasoning(body, { reasoningEffort: 'high' }));
});
