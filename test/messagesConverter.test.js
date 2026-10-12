// Tests for src/messagesConverter.js — Anthropic Messages <-> Command Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapModel,
  anthropicToCommandCode,
  commandCodeEventsToAnthropic,
  estimateInputTokens,
  mapStopReason,
  stopReasonToFinishReason,
} from '../src/messagesConverter.js';
import config from '../config.js';

function conv(req, session) {
  return anthropicToCommandCode({ threadId: 'TID', ...req }, session);
}

// --- mapModel ---

test('mapModel: empty -> default; unknown passthrough', () => {
  assert.equal(mapModel(''), config.MODELS.defaultModel);
  assert.equal(mapModel('Claude-Sonnet-5'), 'Claude-Sonnet-5');
});

// --- system handling ---

test('anthropicToCommandCode: top-level system string -> system block', () => {
  const body = conv({
    model: 'm',
    system: 'You are helpful',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(body.params.system, [
    { type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral' } },
  ]);
});

test('anthropicToCommandCode: top-level system as text blocks -> multiple segments', () => {
  const body = conv({
    model: 'm',
    system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(body.params.system.length, 2);
  assert.equal(body.params.system[0].text, 'a');
  assert.equal(body.params.system[1].text, 'b');
});

test('anthropicToCommandCode: role:system messages hoisted then demoted (mirrors Chat converter)', () => {
  const body = conv({
    model: 'm',
    system: 'top',
    messages: [
      { role: 'system', content: 'inline sys' },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'late sys' },
    ],
  });
  // top-level 'top' first, then the leading contiguous run 'inline sys'.
  assert.deepEqual(body.params.system.map(s => s.text), ['top', 'inline sys']);
  // 'late sys' demoted to user, order preserved.
  assert.deepEqual(body.params.messages.map(m => m.role), ['user', 'user']);
  assert.equal(body.params.messages[1].content[0].text, 'late sys');
});

// --- content blocks: user ---

test('anthropicToCommandCode: user text block -> text', () => {
  const body = conv({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
  assert.deepEqual(body.params.messages[0].content, [{ type: 'text', text: 'hello' }]);
});

test('anthropicToCommandCode: user string content -> text block', () => {
  const body = conv({ model: 'm', messages: [{ role: 'user', content: 'hello' }] });
  assert.deepEqual(body.params.messages[0].content, [{ type: 'text', text: 'hello' }]);
});

test('anthropicToCommandCode: base64 image source passes through normalized', () => {
  const body = conv({
    model: 'm',
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }],
    }],
  });
  assert.deepEqual(body.params.messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
  ]);
});

test('anthropicToCommandCode: url image source passes through', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
  });
  assert.deepEqual(body.params.messages[0].content, [
    { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
  ]);
});

// --- thinking / tool_use / tool_result ---

test('anthropicToCommandCode: assistant thinking becomes reasoning block ahead of text', () => {
  const body = conv({
    model: 'm',
    messages: [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'pondering' }, { type: 'text', text: 'answer' }],
    }],
  });
  const c = body.params.messages[0].content;
  assert.equal(c[0].type, 'reasoning');
  assert.equal(c[0].text, 'pondering');
  assert.equal(c[1].type, 'text');
  assert.equal(c[1].text, 'answer');
});

test('anthropicToCommandCode: assistant tool_use -> tool-call block', () => {
  const body = conv({
    model: 'm',
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'getWeather', input: { city: 'SF' } }],
    }],
  });
  assert.deepEqual(body.params.messages[0].content, [{
    type: 'tool-call',
    toolCallId: 'toolu_1',
    toolName: 'getWeather',
    input: { city: 'SF' },
  }]);
});

test('anthropicToCommandCode: user tool_result resolves toolName from prior tool_use', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'getWeather', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }] },
    ],
  });
  // tool results emit as tool-role messages, before user content.
  const toolMsg = body.params.messages[1];
  assert.equal(toolMsg.role, 'tool');
  assert.deepEqual(toolMsg.content, [{
    type: 'tool-result',
    toolCallId: 'toolu_1',
    toolName: 'getWeather',
    output: { type: 'text', value: 'sunny' },
  }]);
});

test('anthropicToCommandCode: tool_result with array content joins text blocks', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
    ],
  });
  assert.equal(body.params.messages[1].content[0].output.value, 'a\nb');
});

// --- tools ---

test('anthropicToCommandCode: tools are isomorphic (filtered map)', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
  });
  assert.deepEqual(body.params.tools, [{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
});

test('anthropicToCommandCode: tools missing name are dropped', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'ok', input_schema: {} }, { description: 'no name' }],
  });
  assert.equal(body.params.tools.length, 1);
  assert.equal(body.params.tools[0].name, 'ok');
});

// --- thinking enabled -> reasoning_effort ---

test('anthropicToCommandCode: thinking.enabled sets reasoning_effort to config default', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 5000 },
  });
  assert.equal(body.params.reasoning_effort, config.REASONING_EFFORT);
});

test('anthropicToCommandCode: thinking disabled leaves reasoning_effort at default anyway', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'disabled' },
  });
  // reasoningEffort undefined -> assembleCcBody falls back to config default.
  assert.equal(body.params.reasoning_effort, config.REASONING_EFFORT);
});

// --- commandCodeEventsToAnthropic (non-streaming) ---

test('commandCodeEventsToAnthropic: text deltas -> single text block', () => {
  const resp = commandCodeEventsToAnthropic(
    [{ type: 'text-delta', text: 'He' }, { type: 'text-delta', text: 'llo' }, { type: 'finish', finishReason: 'stop' }],
    'm',
  );
  assert.equal(resp.type, 'message');
  assert.equal(resp.role, 'assistant');
  assert.equal(resp.stop_reason, 'end_turn');
  assert.deepEqual(resp.content, [{ type: 'text', text: 'Hello' }]);
});

test('commandCodeEventsToAnthropic: reasoning then text segmented into separate blocks', () => {
  const resp = commandCodeEventsToAnthropic(
    [
      { type: 'reasoning-delta', text: 'think' },
      { type: 'text-delta', text: 'ans' },
      { type: 'finish' },
    ],
    'm',
  );
  assert.deepEqual(resp.content, [
    { type: 'thinking', thinking: 'think', signature: '' },
    { type: 'text', text: 'ans' },
  ]);
});

test('commandCodeEventsToAnthropic: interleaved reasoning/text segments each get their own block', () => {
  const resp = commandCodeEventsToAnthropic(
    [
      { type: 'reasoning-delta', text: 'r1' },
      { type: 'text-delta', text: 't1' },
      { type: 'reasoning-delta', text: 'r2' },
      { type: 'text-delta', text: 't2' },
      { type: 'finish' },
    ],
    'm',
  );
  assert.deepEqual(resp.content, [
    { type: 'thinking', thinking: 'r1', signature: '' },
    { type: 'text', text: 't1' },
    { type: 'thinking', thinking: 'r2', signature: '' },
    { type: 'text', text: 't2' },
  ]);
});

test('commandCodeEventsToAnthropic: tool-call -> tool_use block', () => {
  const resp = commandCodeEventsToAnthropic(
    [{ type: 'tool-call', toolCallId: 'toolu_x', toolName: 'f', input: { a: 1 } }, { type: 'finish', finishReason: 'tool-calls' }],
    'm',
  );
  assert.equal(resp.stop_reason, 'tool_use');
  assert.deepEqual(resp.content, [{ type: 'tool_use', id: 'toolu_x', name: 'f', input: { a: 1 } }]);
});

test('commandCodeEventsToAnthropic: tool-call without id gets a generated toolu_ id', () => {
  const resp = commandCodeEventsToAnthropic(
    [{ type: 'tool-call', toolName: 'f', input: {} }, { type: 'finish' }],
    'm',
  );
  assert.ok(resp.content[0].id.startsWith('toolu_'));
});

test('commandCodeEventsToAnthropic: empty output -> single empty text block', () => {
  const resp = commandCodeEventsToAnthropic([], 'm');
  assert.deepEqual(resp.content, [{ type: 'text', text: '' }]);
});

test('commandCodeEventsToAnthropic: usage mapped to anthropic token fields incl cache_read', () => {
  const resp = commandCodeEventsToAnthropic(
    [{ type: 'finish', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 } }],
    'm',
  );
  assert.deepEqual(resp.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 4,
  });
});

test('commandCodeEventsToAnthropic: max-tokens finishReason -> stop_reason max_tokens', () => {
  const resp = commandCodeEventsToAnthropic([{ type: 'finish', finishReason: 'max-tokens' }], 'm');
  assert.equal(resp.stop_reason, 'max_tokens');
});

// --- mapStopReason / stopReasonToFinishReason ---

test('mapStopReason: vocabulary mapping', () => {
  assert.equal(mapStopReason('tool-calls'), 'tool_use');
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
  assert.equal(mapStopReason('length'), 'max_tokens');
  assert.equal(mapStopReason('max-tokens'), 'max_tokens');
  assert.equal(mapStopReason('stop'), 'end_turn');
  assert.equal(mapStopReason(undefined), 'end_turn');
});

test('stopReasonToFinishReason: reverse mapping', () => {
  assert.equal(stopReasonToFinishReason('tool_use'), 'tool_calls');
  assert.equal(stopReasonToFinishReason('max_tokens'), 'length');
  assert.equal(stopReasonToFinishReason('end_turn'), 'stop');
});

// --- estimateInputTokens ---

test('estimateInputTokens: counts chars across system + text blocks (ceil / 4)', () => {
  // 8 chars system + 4 chars user text = 12 chars -> ceil(12/4)=3
  const n = estimateInputTokens({
    system: '12345678',
    messages: [{ role: 'user', content: 'abcd' }],
  });
  assert.equal(n, 3);
});

test('estimateInputTokens: minimum 1 even for empty input', () => {
  assert.equal(estimateInputTokens({}), 1);
  assert.equal(estimateInputTokens({ system: '', messages: [] }), 1);
});

test('estimateInputTokens: counts thinking + tool_use input + tool_result content', () => {
  const n = estimateInputTokens({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'abcd' }, // 4
        { type: 'tool_use', input: { x: 'abcd' } }, // JSON.stringify -> 13 chars
      ],
    }, {
      role: 'user',
      content: [{ type: 'tool_result', content: 'efgh' }], // 4
    }],
  });
  // JSON.stringify({x:'abcd'}) = '{"x":"abcd"}' (12 chars); total = 4 + 12 + 4 = 20 -> ceil(20/4) = 5
  assert.equal(n, 5);
});
