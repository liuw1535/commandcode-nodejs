// Tests for src/responsesConverter.js — OpenAI Responses API <-> Command Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapModel, responsesToCommandCode, commandCodeEventsToResponses } from '../src/responsesConverter.js';
import config from '../config.js';

function conv(req, session) {
  return responsesToCommandCode({ threadId: 'TID', ...req }, session);
}

// --- mapModel ---

test('mapModel: empty -> default; unknown passthrough', () => {
  assert.equal(mapModel(''), config.MODELS.defaultModel);
  assert.equal(mapModel('GLM-5.2'), 'GLM-5.2');
});

// --- instructions / system ---

test('responsesToCommandCode: top-level instructions -> system block', () => {
  const body = conv({
    model: 'm',
    instructions: 'be helpful',
    input: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(body.params.system, [
    { type: 'text', text: 'be helpful', cache_control: { type: 'ephemeral' } },
  ]);
});

test('responsesToCommandCode: system/developer input items appended to system', () => {
  const body = conv({
    model: 'm',
    instructions: 'top',
    input: [
      { role: 'system', content: 'inline sys' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.deepEqual(body.params.system.map(s => s.text), ['top', 'inline sys']);
});

// --- input shapes ---

test('responsesToCommandCode: bare string input -> single user message', () => {
  const body = conv({ model: 'm', input: 'hello' });
  assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
});

test('responsesToCommandCode: EasyInputMessage {role, content:string}', () => {
  const body = conv({ model: 'm', input: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

test('responsesToCommandCode: Message item with typed content parts', () => {
  const body = conv({
    model: 'm',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'a' }, { type: 'input_image', image_url: 'https://x/y.png' }],
    }],
  });
  assert.deepEqual(body.params.messages[0].content, [
    { type: 'text', text: 'a' },
    { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
  ]);
});

test('responsesToCommandCode: input_text data: image -> base64 source', () => {
  const body = conv({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUJD' }] }],
  });
  assert.deepEqual(body.params.messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
  ]);
});

// --- function_call / function_call_output ---

test('responsesToCommandCode: function_call -> assistant tool-call block with parsed arguments', () => {
  const body = conv({
    model: 'm',
    input: [
      { role: 'user', content: 'weather?' },
      { type: 'function_call', call_id: 'call_1', name: 'getWeather', arguments: '{"city":"SF"}' },
    ],
  });
  assert.deepEqual(body.params.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'getWeather', input: { city: 'SF' } }],
  });
});

test('responsesToCommandCode: function_call_output resolves name from prior function_call', () => {
  const body = conv({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'getWeather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ],
  });
  assert.deepEqual(body.params.messages[1], {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'getWeather', output: { type: 'text', value: 'sunny' } }],
  });
});

test('responsesToCommandCode: function_call_output with array output joins text', () => {
  const body = conv({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c', output: [{ text: 'a' }, { text: 'b' }] },
    ],
  });
  // array output: items have .text (not {type:'text',text}); map uses p?.text
  assert.equal(body.params.messages[1].content[0].output.value, 'a\nb');
});

// --- reasoning items ---

test('responsesToCommandCode: reasoning item reconstructed as assistant reasoning block', () => {
  const body = conv({
    model: 'm',
    input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'pondering' }] }],
  });
  assert.deepEqual(body.params.messages, [{ role: 'assistant', content: [{ type: 'reasoning', text: 'pondering' }] }]);
});

test('responsesToCommandCode: reasoning item falls back to encrypted_content', () => {
  const body = conv({
    model: 'm',
    input: [{ type: 'reasoning', summary: [], encrypted_content: 'enc' }],
  });
  assert.equal(body.params.messages[0].content[0].text, 'enc');
});

// --- tools ---

test('responsesToCommandCode: function tools (flat Responses shape) converted', () => {
  const body = conv({
    model: 'm',
    input: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
  });
  assert.deepEqual(body.params.tools, [{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
});

test('responsesToCommandCode: Chat-nested function tools tolerated', () => {
  const body = conv({
    model: 'm',
    input: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
  });
  assert.equal(body.params.tools[0].name, 'f');
});

test('responsesToCommandCode: built-in tool types dropped', () => {
  const body = conv({
    model: 'm',
    input: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', name: 'keep', parameters: {} },
      { type: 'web_search' },
      { type: 'file_search' },
    ],
  });
  assert.equal(body.params.tools.length, 1);
  assert.equal(body.params.tools[0].name, 'keep');
});

// --- reasoning effort ---

test('responsesToCommandCode: reasoning.effort overrides config default', () => {
  const body = conv({ model: 'm', input: 'hi', reasoning: { effort: 'low' } });
  assert.equal(body.params.reasoning_effort, 'low');
});

test('responsesToCommandCode: reasoning as bare string', () => {
  const body = conv({ model: 'm', input: 'hi', reasoning: 'medium' });
  assert.equal(body.params.reasoning_effort, 'medium');
});

test('responsesToCommandCode: no reasoning -> config default effort', () => {
  const body = conv({ model: 'm', input: 'hi' });
  assert.equal(body.params.reasoning_effort, config.REASONING_EFFORT);
});

// --- commandCodeEventsToResponses (non-streaming) ---

test('commandCodeEventsToResponses: text deltas -> message item with output_text', () => {
  const resp = commandCodeEventsToResponses(
    [{ type: 'text-delta', text: 'He' }, { type: 'text-delta', text: 'llo' }, { type: 'finish', finishReason: 'stop' }],
    'm',
    {},
  );
  assert.equal(resp.object, 'response');
  assert.equal(resp.status, 'completed');
  assert.equal(resp.output.length, 1);
  assert.equal(resp.output[0].type, 'message');
  assert.equal(resp.output[0].role, 'assistant');
  assert.equal(resp.output[0].status, 'completed');
  assert.deepEqual(resp.output[0].content, [{ type: 'output_text', text: 'Hello', annotations: [] }]);
});

test('commandCodeEventsToResponses: reasoning + text segmented into separate items', () => {
  const resp = commandCodeEventsToResponses(
    [{ type: 'reasoning-delta', text: 'r' }, { type: 'text-delta', text: 't' }, { type: 'finish' }],
    'm',
    {},
  );
  assert.equal(resp.output.length, 2);
  assert.equal(resp.output[0].type, 'reasoning');
  assert.deepEqual(resp.output[0].summary, [{ type: 'summary_text', text: 'r' }]);
  assert.equal(resp.output[1].type, 'message');
});

test('commandCodeEventsToResponses: interleaved segments produce multiple items in order', () => {
  const resp = commandCodeEventsToResponses(
    [
      { type: 'reasoning-delta', text: 'r1' },
      { type: 'text-delta', text: 't1' },
      { type: 'reasoning-delta', text: 'r2' },
      { type: 'text-delta', text: 't2' },
      { type: 'finish' },
    ],
    'm',
    {},
  );
  assert.deepEqual(resp.output.map(i => i.type), ['reasoning', 'message', 'reasoning', 'message']);
});

test('commandCodeEventsToResponses: tool-call -> function_call item, no empty message added', () => {
  const resp = commandCodeEventsToResponses(
    [{ type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: { a: 1 } }, { type: 'finish', finishReason: 'tool-calls' }],
    'm',
    {},
  );
  assert.equal(resp.output.length, 1);
  assert.equal(resp.output[0].type, 'function_call');
  assert.equal(resp.output[0].call_id, 'c1');
  assert.equal(resp.output[0].name, 'f');
  assert.equal(resp.output[0].arguments, '{"a":1}');
});

test('commandCodeEventsToResponses: empty output -> single empty message item', () => {
  const resp = commandCodeEventsToResponses([], 'm', {});
  assert.equal(resp.output.length, 1);
  assert.equal(resp.output[0].type, 'message');
  assert.equal(resp.output[0].content[0].text, '');
});

test('commandCodeEventsToResponses: length finishReason -> status incomplete', () => {
  const resp = commandCodeEventsToResponses(
    [{ type: 'text-delta', text: 'x' }, { type: 'finish', finishReason: 'length' }],
    'm',
    {},
  );
  assert.equal(resp.status, 'incomplete');
  assert.deepEqual(resp.incomplete_details, { reason: 'max_output_tokens' });
});

test('commandCodeEventsToResponses: usage mapped incl cached_tokens', () => {
  const resp = commandCodeEventsToResponses(
    [{ type: 'finish', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } }],
    'm',
    {},
  );
  assert.deepEqual(resp.usage, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 2 },
  });
});

test('commandCodeEventsToResponses: reasoning effort echoed only when requested', () => {
  const withReasoning = commandCodeEventsToResponses([{ type: 'finish' }], 'm', { reasoning: { effort: 'high' } });
  assert.deepEqual(withReasoning.reasoning, { effort: 'high' });

  const withoutReasoning = commandCodeEventsToResponses([{ type: 'finish' }], 'm', {});
  assert.equal(withoutReasoning.reasoning, undefined);
});
