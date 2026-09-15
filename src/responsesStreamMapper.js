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
// Every event carries a monotonically increasing `sequence_number`, matching
// the official stream contract (clients use it for ordering/gap detection).
//
// Command Code gives no explicit per-item "end" signal, so we close an open
// item lazily when the stream moves to a different item type, on `finish-step`,
// and finally on `finish` (which also drives response.completed).
//
// Text buffers are PER ITEM (rsState.text / msgState.text, reset when the item
// opens): in a multi-step flow (reasoning -> tool call -> reasoning -> answer)
// the upstream interleaves several reasoning/text segments, and each item's
// .done events / completed output entry must carry only that segment's text,
// not the cumulative stream text.
import crypto from 'node:crypto';
import config from '../config.js';

const { randomUUID } = crypto;

function shortId(prefix, n = 24) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, n);
}

// Map commandcode finishReason -> Responses status.
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

  // sequence_number: monotonically increasing per-event counter, attached to
  // every emitted event (official Responses stream contract).
  let seq = 0;
  const sseData = (obj) => {
    obj.sequence_number = seq++;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Accumulators for the final response.completed payload + telemetry.
  let finishReason = 'stop';
  let lastUsage = null;

  // output_index counter shared across all items (reasoning/message/function).
  let nextOutputIndex = 0;

  // Completed output items keyed by their output_index (assigned at open).
  // Building the final `output` array from this keeps both the per-item ids
  // and the item order consistent with what was already streamed via
  // output_item.added / output_item.done.
  const itemByIndex = [];

  // Per-item open state. Only one reasoning item and one message item are
  // open at a time; function calls are keyed by toolCallId. `text` is the
  // item-local buffer (reset on open).
  const rsState = { open: false, id: null, outputIndex: 0, summaryIndex: 0, text: '' };
  const msgState = { open: false, id: null, outputIndex: 0, contentIndex: 0, text: '' };
  const toolState = new Map(); // callId -> {open, id, outputIndex, name, args, input}

  // Build the base Response object reused for created/in_progress/completed.
  // created/in_progress carry status:"in_progress" + an empty output array so
  // strict clients reading event.response.status don't see undefined.
  const baseResponse = (status = 'in_progress') => {
    const r = {
      id: respId,
      object: 'response',
      created_at: createdAt,
      model: openaiModel || config.MODELS.defaultModel,
      status,
    };
    if (status === 'in_progress') r.output = [];
    return r;
  };

  const maybeTtft = () => { if (ttftMs === null) ttftMs = Date.now() - startMs; };

  // --- open/close helpers (emit the .added / .done events) ---

  function openReasoning() {
    if (rsState.open) return;
    rsState.open = true;
    rsState.id = shortId('rs_');
    rsState.outputIndex = nextOutputIndex++;
    rsState.summaryIndex = 0;
    rsState.text = ''; // per-item buffer: only this segment's reasoning
    sseData({
      type: 'response.output_item.added',
      output_index: rsState.outputIndex,
      item: { type: 'reasoning', id: rsState.id, summary: [] },
    });
    sseData({
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
    sseData({
      type: 'response.reasoning_summary_text.done',
      item_id: rsState.id,
      output_index: rsState.outputIndex,
      summary_index: rsState.summaryIndex,
      text: rsState.text,
    });
    sseData({
      type: 'response.reasoning_summary_part.done',
      item_id: rsState.id,
      output_index: rsState.outputIndex,
      summary_index: rsState.summaryIndex,
      part: { type: 'summary_text', text: rsState.text },
    });
    const item = {
      type: 'reasoning',
      id: rsState.id,
      summary: [{ type: 'summary_text', text: rsState.text }],
    };
    sseData({
      type: 'response.output_item.done',
      output_index: rsState.outputIndex,
      item,
    });
    itemByIndex[rsState.outputIndex] = item;
  }

  function openMessage() {
    if (msgState.open) return;
    msgState.open = true;
    msgState.id = shortId('msg_');
    msgState.outputIndex = nextOutputIndex++;
    msgState.contentIndex = 0;
    msgState.text = ''; // per-item buffer: only this segment's text
    sseData({
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
    sseData({
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
    sseData({
      type: 'response.output_text.done',
      item_id: msgState.id,
      output_index: msgState.outputIndex,
      content_index: msgState.contentIndex,
      text: msgState.text,
    });
    sseData({
      type: 'response.content_part.done',
      item_id: msgState.id,
      output_index: msgState.outputIndex,
      content_index: msgState.contentIndex,
      part: { type: 'output_text', text: msgState.text, annotations: [] },
    });
    const item = {
      type: 'message',
      id: msgState.id,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: msgState.text, annotations: [] }],
    };
    sseData({
      type: 'response.output_item.done',
      output_index: msgState.outputIndex,
      item,
    });
    itemByIndex[msgState.outputIndex] = item;
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
    sseData({
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
    sseData({
      type: 'response.function_call_arguments.done',
      item_id: t.id,
      output_index: t.outputIndex,
      arguments: args,
    });
    const item = {
      type: 'function_call',
      id: t.id,
      call_id: t.callId,
      name: t.name,
      arguments: args,
    };
    sseData({
      type: 'response.output_item.done',
      output_index: t.outputIndex,
      item,
    });
    itemByIndex[t.outputIndex] = item;
  }

  // Close every currently-open item (used at finish-step / finish).
  function closeAllOpen() {
    if (rsState.open) closeReasoning();
    if (msgState.open) closeMessage();
    for (const t of toolState.values()) if (t.open) closeTool(t);
  }

  // --- emit the opening lifecycle ---
  sseData({ type: 'response.created', response: baseResponse() });
  sseData({ type: 'response.in_progress', response: baseResponse() });

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
              rsState.text += delta;
              sseData({
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
              msgState.text += delta;
              sseData({
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
              sseData({
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
            const t = openTool(ev.toolCallId || ev.id, ev.toolName);
            if (ev.input != null) t.input = ev.input;
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

  // Items in output_index order, same ids as streamed via output_item.done.
  const output = itemByIndex.filter(Boolean);
  // A plain text answer with no text/tools still yields an (empty) message
  // item — matching the real Responses API behavior.
  if (!output.some(i => i.type === 'message') && !output.some(i => i.type === 'function_call')) {
    output.push({
      type: 'message',
      id: shortId('msg_'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const completed = baseResponse(status);
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

  sseData({ type: 'response.completed', response: completed });

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
