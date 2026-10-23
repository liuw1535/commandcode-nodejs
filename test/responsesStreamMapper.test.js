// Tests for src/responsesStreamMapper.js — Command Code SSE -> Responses SSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipeResponsesStream } from '../src/responsesStreamMapper.js';

// Build a fake fetch Response whose body is a ReadableStream of line-delimited
// JSON events (the commandcode /alpha/generate streaming format).
function fakeUpstream(events) {
  const payload = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return { body: stream };
}

// Collect everything written to the mock res into a string.
function mockRes() {
  const chunks = [];
  return {
    writableEnded: false,
    destroyed: false,
    write(s) { chunks.push(s); },
    end() { this.writableEnded = true; },
    chunks,
    text() { return chunks.join(''); },
  };
}

// Parse a captured SSE text into a list of {event, data} pairs.
function parseSse(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    out.push({ event, data: data ? JSON.parse(data) : null });
  }
  return out;
}

test('pipeResponsesStream: emits event: line matching data.type', async () => {
  const res = mockRes();
  await pipeResponsesStream({
    res,
    upstream: fakeUpstream([{ type: 'text-delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }]),
    openaiModel: 'm',
    responsesReq: {},
  });
  const sse = parseSse(res.text());
  // Every emitted block has an event: line equal to its data.type.
  for (const { event, data } of sse) {
    assert.equal(event, data.type);
  }
  // The opening lifecycle is present.
  assert.ok(sse.some(s => s.event === 'response.created'));
  assert.ok(sse.some(s => s.event === 'response.in_progress'));
  assert.ok(sse.some(s => s.event === 'response.completed'));
});

test('pipeResponsesStream: output_text part.done carries logprobs: []', async () => {
  const res = mockRes();
  await pipeResponsesStream({
    res,
    upstream: fakeUpstream([{ type: 'text-delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }]),
    openaiModel: 'm',
    responsesReq: {},
  });
  const sse = parseSse(res.text());
  const partDone = sse.find(s => s.event === 'response.content_part.done');
  assert.deepEqual(partDone.data.part.logprobs, []);
  const itemDone = sse.find(s => s.event === 'response.output_item.done');
  assert.deepEqual(itemDone.data.item.content[0].logprobs, []);
});

test('pipeResponsesStream: tool-call with no args emits "{}" not empty string', async () => {
  const res = mockRes();
  await pipeResponsesStream({
    res,
    upstream: fakeUpstream([{ type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: {} }, { type: 'finish', finishReason: 'tool-calls' }]),
    openaiModel: 'm',
    responsesReq: {},
  });
  const sse = parseSse(res.text());
  const argsDone = sse.find(s => s.event === 'response.function_call_arguments.done');
  assert.equal(argsDone.data.arguments, '{}');
  const itemDone = sse.find(s => s.event === 'response.output_item.done');
  assert.equal(itemDone.data.item.arguments, '{}');
});

test('pipeResponsesStream: tool-call streamed with only deltas (no structured input) falls back to "{}"', async () => {
  const res = mockRes();
  await pipeResponsesStream({
    res,
    upstream: fakeUpstream([
      { type: 'tool-input-start', id: 'c1', toolName: 'f' },
      // no deltas, no structured input -> empty args buffer
      { type: 'tool-input-end', id: 'c1' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]),
    openaiModel: 'm',
    responsesReq: {},
  });
  const sse = parseSse(res.text());
  const itemDone = sse.find(s => s.event === 'response.output_item.done');
  assert.equal(itemDone.data.item.arguments, '{}');
});

test('pipeResponsesStream: response.completed usage includes reasoning_tokens and cache_write_tokens', async () => {
  const res = mockRes();
  await pipeResponsesStream({
    res,
    upstream: fakeUpstream([{ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cacheWriteTokens: 4 } }]),
    openaiModel: 'm',
    responsesReq: {},
  });
  const sse = parseSse(res.text());
  const completed = sse.find(s => s.event === 'response.completed');
  assert.deepEqual(completed.data.response.usage.output_tokens_details, { reasoning_tokens: 3 });
  assert.deepEqual(completed.data.response.usage.input_tokens_details, { cache_write_tokens: 4 });
});

test('pipeResponsesStream: response.completed echoes request fields', async () => {
  const res = mockRes();
  const req = {
    instructions: 'be brief', max_output_tokens: 512, temperature: 0.3, top_p: 0.9,
    parallel_tool_calls: false, tool_choice: 'auto',
    tools: [{ type: 'function', name: 'f', parameters: {} }],
    text: { format: { type: 'json_object' } }, truncation: 'auto', store: false, user: 'u1',
  };
  await pipeResponsesStream({
    res,
    upstream: fakeUpstream([{ type: 'finish', finishReason: 'stop' }]),
    openaiModel: 'm',
    responsesReq: req,
  });
  const sse = parseSse(res.text());
  const completed = sse.find(s => s.event === 'response.completed').data.response;
  assert.equal(completed.instructions, 'be brief');
  assert.equal(completed.max_output_tokens, 512);
  assert.equal(completed.temperature, 0.3);
  assert.equal(completed.tool_choice, 'auto');
  assert.equal(completed.store, false);
  assert.equal(completed.user, 'u1');
});

test('pipeResponsesStream: sequence_number is monotonically increasing', async () => {
  const res = mockRes();
  await pipeResponsesStream({
    res,
    upstream: fakeUpstream([{ type: 'text-delta', text: 'hi' }, { type: 'finish', finishReason: 'stop' }]),
    openaiModel: 'm',
    responsesReq: {},
  });
  const sse = parseSse(res.text());
  let prev = -1;
  for (const { data } of sse) {
    assert.ok(data.sequence_number > prev);
    prev = data.sequence_number;
  }
});
