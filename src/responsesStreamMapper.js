// Stream mapper: convert Command Code SSE (line-delimited JSON events) into
// OpenAI Responses API streaming events.
//
// The Responses API uses semantic SSE events (each a typed JSON object with a
// `type` discriminator) rather than Chat-Completions-style delta chunks. We
// emit the lifecycle the official client expects:
//
//   response.created
//   response.in_progress
//   [per output item]
//     response.output_item.added           (item: reasoning | message | function_call)
//       reasoning:  response.reasoning_summary_part.added
//                   response.reasoning_summary_text.delta*
//                   response.reasoning_summary_text.done
//                   response.reasoning_summary_part.done
//       message:    response.content_part.added
//                   response.output_text.delta*
//                   response.output_text.done
//                   response.content_part.done
//       function:   response.function_call_arguments.delta*
//                   response.function_call_arguments.done
//     response.output_item.done
//   response.completed
//
// Command Code gives no explicit per-item "end" signal, so we close an open
// item lazily when the stream moves to a different item type, on `finish-step`,
// and finally on `finish` (which also drives response.completed).
import crypto from 'node:crypto';
import config from '../config.js';

const { randomUUID } = crypto;

function shortId(prefix, n = 24) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, n);
}

function sseData(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function mapFinishToStatus(fr) {
  if (fr === 'length' || fr === 'max-tokens') return 'incomplete';
  return 'completed';
}

// Pipe an upstream text/event-stream (response.body reader) into a Responses
// SSE response. Returns a promise resolving when the stream ends.
//   res: node http.ServerResponse (already writing SSE)
//   upstream: fetch Response (body is a ReadableStream)
//   openaiModel: model name to echo back
//   responsesReq: original request (used for reasoning effort echo + status)
export async function pipeResponsesStream({ res, upstream, openaiModel, responsesReq }) {
  const respId = shortId('resp_', 48);
  const createdAt = Math.floor(Date.now() / 1000);
  const startMs = Date.now();
  let ttftMs = null;

  // Accumulators for the final response.completed payload + telemetry.
  let textBuf = '';
  let reasoningBuf = '';
  const toolCalls = []; // {id, callId, name, args, input}
  let finishReason = 'stop';
  let lastUsage = null;

  // output_index counter shared across all items (reasoning/message/function).
  let nextOutputIndex = 0;

  // Per-item open state. Only one reasoning item and one message item are
  // open at a time; function calls are keyed by toolCallId.
  const rsState = { open: false, id: null, outputIndex: 0, summaryIndex: 0 };
  const msgState = { open: false, id: null, outputIndex: 0, contentIndex: 0 };
  const toolState = new Map(); // callId -> {open, id, outputIndex, name, args, input}

  // Build the base Response object (without output) reused for created/completed.
  const baseResponse = () => ({
    id: respId,
    object: 'response',
    created_at: createdAt,
    model: openaiModel || config.MODELS.defaultModel,
  });

  const maybeTtft = () => { if (ttftMs === null) ttftMs = Date.now() - startMs; };

  // --- open/close helpers (emit the .added / .done events) ---

  function openReasoning() {
    if (rsState.open) return;
    rsState.open = true;
    rsState.id = shortId('rs_');
    rsState.outputIndex = nextOutputIndex++;
    rsState.summaryIndex = 0;
    sseData(res, {
      type: 'response.output_item.added',
      output_index: rsState.outputIndex,
      item: { type: 'reasoning', id: rsState.id, summary: [] },
    });
    sseData(res, {
      type: 'response.reasoning_summary_part.added',
      item_id: rsState.id,
      output_index: rsState.outputIndex,
      summary_index: rsState.summaryIndex,
      part: { type: 'summary_text', text: '' },
    });
  }

  function closeReasoning() {
    if (!rsState.open) return;
    rsState.open = false;
    sseData(res, {
      type: 'response.reasoning_summary_text.done',
      item_id: rsState.id,
      output_index: rsState.outputIndex,
      summary_index: rsState.summaryIndex,
      text: reasoningBuf,
    });
    sseData(res, {
      type: 'response.reasoning_summary_part.done',
      item_id: rsState.id,
      output_index: rsState.outputIndex,
      summary_index: rsState.summaryIndex,
      part: { type: 'summary_text', text: reasoningBuf },
    });
    sseData(res, {
      type: 'response.output_item.done',
      output_index: rsState.outputIndex,
      item: { type: 'reasoning', id: rsState.id, summary: [{ type: 'summary_text', text: reasoningBuf }] },
    });
  }

  function openMessage() {
    if (msgState.open) return;
    msgState.open = true;
    msgState.id = shortId('msg_');
    msgState.outputIndex = nextOutputIndex++;
    msgState.contentIndex = 0;
    sseData(res, {
      type: 'response.output_item.added',
      output_index: msgState.outputIndex,
      item: {
        type: 'message',
        id: msgState.id,
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    });
    sseData(res, {
      type: 'response.content_part.added',
      item_id: msgState.id,
      output_index: msgState.outputIndex,
      content_index: msgState.contentIndex,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  function closeMessage() {
    if (!msgState.open) return;
    msgState.open = false;
    sseData(res, {
      type: 'response.output_text.done',
      item_id: msgState.id,
      output_index: msgState.outputIndex,
      content_index: msgState.contentIndex,
      text: textBuf,
    });
    sseData(res, {
      type: 'response.content_part.done',
      item_id: msgState.id,
      output_index: msgState.outputIndex,
      content_index: msgState.contentIndex,
      part: { type: 'output_text', text: textBuf, annotations: [] },
    });
    sseData(res, {
      type: 'response.output_item.done',
      output_index: msgState.outputIndex,
      item: {
        type: 'message',
        id: msgState.id,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: textBuf, annotations: [] }],
      },
    });
  }

  function getTool(callId, name) {
    const key = callId || '__anon__';
    let t = toolState.get(key);
    if (!t) {
      t = {
        open: false,
        id: shortId('fc_'),
        callId: callId || shortId('call_'),
        outputIndex: nextOutputIndex++,
        name: name || '',
        args: '',
        input: null,
      };
      toolState.set(key, t);
    } else if (name && !t.name) {
      t.name = name;
    }
    return t;
  }

  function openTool(callId, name) {
    const t = getTool(callId, name);
    if (t.open) return t;
    t.open = true;
    sseData(res, {
      type: 'response.output_item.added',
      output_index: t.outputIndex,
      item: {
        type: 'function_call',
        id: t.id,
        call_id: t.callId,
        name: t.name,
        arguments: '',
      },
    });
    return t;
  }

  function closeTool(t) {
    if (!t.open) return;
    t.open = false;
    const args = (t.input != null) ? JSON.stringify(t.input) : (t.args || '');
    sseData(res, {
      type: 'response.function_call_arguments.done',
      item_id: t.id,
      output_index: t.outputIndex,
      arguments: args,
    });
    sseData(res, {
      type: 'response.output_item.done',
      output_index: t.outputIndex,
      item: {
        type: 'function_call',
        id: t.id,
        call_id: t.callId,
        name: t.name,
        arguments: args,
      },
    });
  }

  // Close every currently-open item (used at finish-step / finish).
  function closeAllOpen() {
    if (rsState.open) closeReasoning();
    if (msgState.open) closeMessage();
    for (const t of toolState.values()) if (t.open) closeTool(t);
  }

  // --- emit the opening lifecycle ---
  sseData(res, { type: 'response.created', response: baseResponse() });
  sseData(res, { type: 'response.in_progress', response: baseResponse() });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl).replace(/\r$/, '').trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('{')) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        switch (ev.type) {
          case 'reasoning-delta': {
            maybeTtft();
            // Moving from a different item type -> close it first.
            if (msgState.open) closeMessage();
            openReasoning();
            const delta = ev.text || '';
            if (delta) {
              reasoningBuf += delta;
              sseData(res, {
                type: 'response.reasoning_summary_text.delta',
                item_id: rsState.id,
                output_index: rsState.outputIndex,
                summary_index: rsState.summaryIndex,
                delta,
              });
            }
            break;
          }
          case 'text-delta': {
            maybeTtft();
            if (rsState.open) closeReasoning();
            openMessage();
            const delta = ev.text || '';
            if (delta) {
              textBuf += delta;
              sseData(res, {
                type: 'response.output_text.delta',
                item_id: msgState.id,
                output_index: msgState.outputIndex,
                content_index: msgState.contentIndex,
                delta,
              });
            }
            break;
          }
          case 'tool-input-start': {
            maybeTtft();
            if (rsState.open) closeReasoning();
            if (msgState.open) closeMessage();
            openTool(ev.id || ev.toolCallId, ev.toolName);
            break;
          }
          case 'tool-input-delta': {
            const t = toolState.get(ev.id || ev.toolCallId);
            if (t && ev.delta) t.args += ev.delta;
            if (t) {
              sseData(res, {
                type: 'response.function_call_arguments.delta',
                item_id: t.id,
                output_index: t.outputIndex,
                delta: ev.delta || '',
              });
            }
            break;
          }
          case 'tool-input-end':
            // Argument streaming for this tool is done; the final tool-call
            // event (with structured input) triggers closeTool below.
            break;
          case 'tool-call': {
            maybeTtft();
            if (rsState.open) closeReasoning();
            if (msgState.open) closeMessage();
            const callId = ev.toolCallId || ev.id;
            const t = openTool(callId, ev.toolName);
            if (ev.input != null) t.input = ev.input;
            // Record for the final response payload.
            toolCalls.push({
              id: t.id,
              callId: t.callId,
              name: t.name || ev.toolName || '',
              input: ev.input,
              args: t.args,
            });
            closeTool(t);
            break;
          }
          case 'finish-step': {
            if (ev.finishReason) finishReason = ev.finishReason === 'tool-calls' ? 'tool_calls' : ev.finishReason;
            if (ev.usage) lastUsage = ev.usage;
            // End of a step: close any item that is still open within it.
            closeAllOpen();
            break;
          }
          case 'finish': {
            if (ev.finishReason) finishReason = ev.finishReason === 'tool-calls' ? 'tool_calls' : ev.finishReason;
            if (ev.totalUsage) lastUsage = ev.totalUsage;
            closeAllOpen();
            break;
          }
          default:
            break;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // Safety net: close anything still open if the stream ended without a
  // finish-step/finish (e.g. upstream dropped).
  closeAllOpen();

  // --- assemble and emit response.completed ---
  const status = mapFinishToStatus(finishReason);

  const output = [];
  if (reasoningBuf) {
    output.push({
      type: 'reasoning',
      id: shortId('rs_'),
      summary: [{ type: 'summary_text', text: reasoningBuf }],
    });
  }
  if (textBuf || toolCalls.length === 0) {
    output.push({
      type: 'message',
      id: shortId('msg_'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: textBuf, annotations: [] }],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      type: 'function_call',
      id: tc.id,
      call_id: tc.callId,
      name: tc.name,
      arguments: tc.input != null ? JSON.stringify(tc.input) : (tc.args || ''),
    });
  }

  const completed = baseResponse();
  completed.status = status;
  completed.output = output;
  if (status === 'incomplete') completed.incomplete_details = { reason: 'max_output_tokens' };
  if (responsesReq?.reasoning?.effort) completed.reasoning = { effort: responsesReq.reasoning.effort };
  if (lastUsage) {
    completed.usage = {
      input_tokens: lastUsage.inputTokens ?? 0,
      output_tokens: lastUsage.outputTokens ?? 0,
      total_tokens: lastUsage.totalTokens ?? ((lastUsage.inputTokens ?? 0) + (lastUsage.outputTokens ?? 0)),
    };
    if (typeof lastUsage.cachedInputTokens === 'number') {
      completed.usage.input_tokens_details = { cached_tokens: lastUsage.cachedInputTokens };
    }
  }

  sseData(res, { type: 'response.completed', response: completed });

  // Surface captured usage/finish for telemetry (same shape pipeStream returns).
  return {
    inputTokens: lastUsage?.inputTokens ?? null,
    outputTokens: lastUsage?.outputTokens ?? null,
    totalTokens: lastUsage?.totalTokens ?? null,
    cachedInputTokens: lastUsage?.cachedInputTokens ?? null,
    finishReasons: [finishReason],
    ttftMs,
    durationMs: Date.now() - startMs,
  };
}

export default { pipeResponsesStream };
