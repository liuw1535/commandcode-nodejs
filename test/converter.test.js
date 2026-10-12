// Tests for src/converter.js — OpenAI Chat Completions <-> Command Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapModel, openaiToCommandCode, commandCodeEventsToOpenAI } from '../src/converter.js';
import config from '../config.js';

// Helper: run a conversion with a pinned threadId so the body is deterministic
// aside from uuids we don't assert on.
function conv(req, session) {
  return openaiToCommandCode({ threadId: 'TID', ...req }, session);
}

// --- mapModel (resolveModel with empty upstream cache: default / passthrough) ---

test('mapModel: empty -> configured default model', () => {
  assert.equal(mapModel(''), config.MODELS.defaultModel);
  assert.equal(mapModel(undefined), config.MODELS.defaultModel);
  assert.equal(mapModel(null), config.MODELS.defaultModel);
});

test('mapModel: unknown name passes through verbatim (case preserved)', () => {
  // Cache is empty in tests, so any non-empty name is a miss -> passthrough.
  assert.equal(mapModel('GLM-5.2'), 'GLM-5.2');
  assert.equal(mapModel('zai-org/GLM-5.3'), 'zai-org/GLM-5.3');
});

// --- system message handling ---

test('openaiToCommandCode: leading system messages are hoisted into system[]', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'system', content: 'You are a bot' },
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.deepEqual(body.params.system, [
    { type: 'text', text: 'You are a bot', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Be concise', cache_control: { type: 'ephemeral' } },
  ]);
  // user message remains in messages, no system role message remains.
  assert.equal(body.params.messages.length, 1);
  assert.equal(body.params.messages[0].role, 'user');
  assert.equal(body.params.messages[0].content[0].text, 'hi');
});

test('openaiToCommandCode: system messages after the first non-system are demoted to user', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'system', content: 'mid-sys' },
      { role: 'assistant', content: 'a1' },
    ],
  });
  assert.deepEqual(body.params.system, [
    { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
  ]);
  // Order preserved: user, demoted-system(as user), assistant
  assert.deepEqual(
    body.params.messages.map(m => m.role),
    ['user', 'user', 'assistant'],
  );
  assert.equal(body.params.messages[1].content[0].text, 'mid-sys');
});

test('openaiToCommandCode: no system messages -> params.system undefined', () => {
  const body = conv({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.params.system, undefined);
});

// --- content types ---

test('openaiToCommandCode: string content -> text block', () => {
  const body = conv({ model: 'm', messages: [{ role: 'user', content: 'hello' }] });
  assert.deepEqual(body.params.messages[0].content, [{ type: 'text', text: 'hello' }]);
});

test('openaiToCommandCode: array content with text parts', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, 'b'] }],
  });
  assert.deepEqual(body.params.messages[0].content, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]);
});

test('openaiToCommandCode: data: image_url normalized to base64 source block', () => {
  const body = conv({
    model: 'm',
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
    }],
  });
  assert.deepEqual(body.params.messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
  ]);
});

test('openaiToCommandCode: http image_url -> url source block', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://x/y.png' }] }],
  });
  assert.deepEqual(body.params.messages[0].content, [
    { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
  ]);
});

test('openaiToCommandCode: empty string content -> empty content array', () => {
  const body = conv({ model: 'm', messages: [{ role: 'user', content: '' }] });
  assert.deepEqual(body.params.messages[0].content, []);
});

// --- tools ---

test('openaiToCommandCode: OpenAI tools converted to cc tools', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'getWeather', description: 'weather', parameters: { type: 'object' } } },
    ],
  });
  assert.deepEqual(body.params.tools, [
    { name: 'getWeather', description: 'weather', input_schema: { type: 'object' } },
  ]);
});

test('openaiToCommandCode: empty tools array -> undefined (not forwarded)', () => {
  const body = conv({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(body.params.tools, undefined);
});

// --- tool_calls + tool results ---

test('openaiToCommandCode: assistant tool_calls become tool-call blocks with parsed input', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'getWeather', arguments: '{"city":"SF"}' } }] },
    ],
  });
  const asst = body.params.messages[1];
  assert.equal(asst.role, 'assistant');
  assert.deepEqual(asst.content, [{
    type: 'tool-call',
    toolCallId: 'call_1',
    toolName: 'getWeather',
    input: { city: 'SF' },
  }]);
});

test('openaiToCommandCode: assistant tool_calls with invalid JSON arguments -> empty input', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f', arguments: 'not-json' } }] },
    ],
  });
  assert.deepEqual(body.params.messages[0].content[0].input, {});
});

test('openaiToCommandCode: tool result resolves toolName from prior assistant tool_call', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', tool_calls: [{ id: 'call_9', function: { name: 'getWeather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: 'sunny' },
    ],
  });
  const toolMsg = body.params.messages[2];
  assert.equal(toolMsg.role, 'tool');
  assert.deepEqual(toolMsg.content, [{
    type: 'tool-result',
    toolCallId: 'call_9',
    toolName: 'getWeather',
    output: { type: 'text', value: 'sunny' },
  }]);
});

test('openaiToCommandCode: tool result without matching prior call -> empty toolName', () => {
  const body = conv({
    model: 'm',
    messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'x' }],
  });
  assert.equal(body.params.messages[0].content[0].toolName, '');
});

// --- reasoning_content ---

test('openaiToCommandCode: assistant reasoning_content promoted to a reasoning block ahead of text', () => {
  const body = conv({
    model: 'm',
    messages: [
      { role: 'assistant', content: 'answer', reasoning_content: 'thought process' },
    ],
  });
  const c = body.params.messages[0].content;
  assert.equal(c[0].type, 'reasoning');
  assert.equal(c[0].text, 'thought process');
  assert.equal(c[1].type, 'text');
  assert.equal(c[1].text, 'answer');
});

// --- threadId / session ---

test('openaiToCommandCode: session.threadId is used when request omits threadId', () => {
  const body = openaiToCommandCode(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { threadId: 'session-tid' },
  );
  assert.equal(body.threadId, 'session-tid');
});

test('openaiToCommandCode: request.threadId wins over session.threadId', () => {
  const body = openaiToCommandCode(
    { threadId: 'req-tid', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { threadId: 'session-tid' },
  );
  assert.equal(body.threadId, 'req-tid');
});

test('openaiToCommandCode: missing messages array -> empty messages', () => {
  const body = conv({ model: 'm' });
  assert.deepEqual(body.params.messages, []);
});

// --- commandCodeEventsToOpenAI (non-streaming aggregation) ---

test('commandCodeEventsToOpenAI: text deltas aggregate into message.content', () => {
  const resp = commandCodeEventsToOpenAI(
    [{ type: 'text-delta', text: 'Hel' }, { type: 'text-delta', text: 'lo' }, { type: 'finish', finishReason: 'stop' }],
    'glm',
  );
  assert.equal(resp.object, 'chat.completion');
  assert.equal(resp.model, 'glm');
  assert.equal(resp.choices[0].message.content, 'Hello');
  assert.equal(resp.choices[0].finish_reason, 'stop');
  assert.equal(resp.choices[0].message.tool_calls, undefined);
});

test('commandCodeEventsToOpenAI: reasoning-delta -> reasoning_content', () => {
  const resp = commandCodeEventsToOpenAI(
    [{ type: 'reasoning-delta', text: 'think' }, { type: 'text-delta', text: 'ans' }, { type: 'finish' }],
    'm',
  );
  assert.equal(resp.choices[0].message.reasoning_content, 'think');
  assert.equal(resp.choices[0].message.content, 'ans');
});

test('commandCodeEventsToOpenAI: tool-call -> tool_calls with stringified arguments', () => {
  const resp = commandCodeEventsToOpenAI(
    [{ type: 'tool-call', toolCallId: 'c1', toolName: 'getWeather', input: { city: 'SF' } }, { type: 'finish', finishReason: 'tool-calls' }],
    'm',
  );
  assert.equal(resp.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(resp.choices[0].message.tool_calls, [{
    index: 0,
    id: 'c1',
    type: 'function',
    function: { name: 'getWeather', arguments: '{"city":"SF"}' },
  }]);
  // content omitted when there is text-less tool-call output
  assert.equal(resp.choices[0].message.content, undefined);
});

test('commandCodeEventsToOpenAI: empty output -> content "" and stop', () => {
  const resp = commandCodeEventsToOpenAI([], 'm');
  assert.equal(resp.choices[0].message.content, '');
  assert.equal(resp.choices[0].finish_reason, 'stop');
});

test('commandCodeEventsToOpenAI: usage mapped to openai token fields', () => {
  const resp = commandCodeEventsToOpenAI(
    [{ type: 'text-delta', text: 'x' }, { type: 'finish', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 } }],
    'm',
  );
  assert.deepEqual(resp.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cachedInputTokens: 3,
  });
});

test('commandCodeEventsToOpenAI: totalUsage used when usage absent', () => {
  const resp = commandCodeEventsToOpenAI(
    [{ type: 'finish', totalUsage: { inputTokens: 7, outputTokens: 2 } }],
    'm',
  );
  assert.equal(resp.usage.prompt_tokens, 7);
  assert.equal(resp.usage.completion_tokens, 2);
});

test('commandCodeEventsToOpenAI: length finishReason maps to length', () => {
  const resp = commandCodeEventsToOpenAI([{ type: 'finish', finishReason: 'length' }], 'm');
  assert.equal(resp.choices[0].finish_reason, 'length');
});

test('commandCodeEventsToOpenAI: model defaults when not provided', () => {
  const resp = commandCodeEventsToOpenAI([{ type: 'finish' }]);
  assert.equal(resp.model, config.MODELS.defaultModel);
});
