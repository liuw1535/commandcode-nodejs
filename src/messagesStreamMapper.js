// Stream mapper: convert Command Code SSE (line-delimited JSON events) into
// Anthropic Messages API streaming SSE.
//
// Unlike the two OpenAI mappers (plain `data:` lines), the Anthropic stream
// uses named events (`event: <type>\ndata: <json>\n\n`). The lifecycle we
// emit mirrors the official API:
//
//   message_start
//   ping
//   [per content block, index global + increasing]
//     content_block_start     (thinking | text | tool_use)
//     content_block_delta*    (thinking_delta | text_delta | input_json_delta)
//     content_block_stop
//   message_delta             (stop_reason + usage)
//   message_stop
//
// Command Code gives no explicit per-block end signal, so blocks are closed
// lazily when the stream switches to a different block type, on
// finish-step/finish, and in a safety net after the stream ends (an
// interrupted stream still yields closed blocks + message_delta +
// message_stop, so the client receives a legal if incomplete stream).
//
// Text/thinking buffers are PER BLOCK (reset when the block opens): in a
// multi-step flow (reasoning -> tool call -> reasoning -> answer) the
// upstream interleaves several reasoning/text segments, and each block must
// carry only its own segment. Tool argument slots are keyed by tool id so
// parallel tool calls interleave correctly (per-id partial_json routing).
import crypto from 'node:crypto';
import config from '../config.js';
import { mapStopReason, stopReasonToFinishReason } from './messagesConverter.js';

const { randomUUID } = crypto;

// Pipe an upstream text/event-stream (response.body reader) into an
// Anthropic Messages SSE response. Returns telemetry-shaped stats.
//   res: node http.ServerResponse (already writing SSE)
//   upstream: fetch Response (body is a ReadableStream)
//   anthropicModel: model name to echo back
export async function pipeMessagesStream({ res, upstream, anthropicModel }) {
  const msgId = 'msg_' + randomUUID().replace(/-/g, '');
  const model = anthropicModel || config.MODELS.defaultModel;
  const startMs = Date.now();
  let ttftMs = null;

  // Accumulators for the final message_delta + telemetry.
  let stopReason = 'end_turn';
  let lastUsage = null;

  // Global content block index counter.
  let nextIndex = 0;

  // Named-event SSE writer (Anthropic format: event line + data line).
  const sse = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // --- open block state ---
  // One thinking and one text block may be open at a time; tool blocks are
  // keyed by tool id (parallel tool calls stream interleaved).
  let thinkingBlock = null; // {index}
  let textBlock = null;     // {index}
  const toolState = new Map(); // id -> {open, index, id, name, args}

  const maybeTtft = () => { if (ttftMs === null) ttftMs = Date.now() - startMs; };

  function openThinking() {
    if (thinkingBlock) return;
    thinkingBlock = { index: nextIndex++ };
    sse('content_block_start', {
      type: 'content_block_start',
      index: thinkingBlock.index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
  }
  function closeThinking() {
    if (!thinkingBlock) return;
    sse('content_block_stop', { type: 'content_block_stop', index: thinkingBlock.index });
    thinkingBlock = null;
  }

  function openText() {
    if (textBlock) return;
    textBlock = { index: nextIndex++ };
    sse('content_block_start', {
      type: 'content_block_start',
      index: textBlock.index,
      content_block: { type: 'text', text: '' },
    });
  }
  function closeText() {
    if (!textBlock) return;
    sse('content_block_stop', { type: 'content_block_stop', index: textBlock.index });
    textBlock = null;
  }

  function getTool(id, name) {
    const key = id || '__anon__';
    let t = toolState.get(key);
    if (!t) {
      t = {
        open: false,
        index: nextIndex++,
        id: id || ('toolu_' + randomUUID().replace(/-/g, '').slice(0, 24)),
        name: name || '',
        args: '',
      };
      toolState.set(key, t);
    } else if (name && !t.name) {
      t.name = name;
    }
    return t;
  }
  function openTool(id, name) {
    const t = getTool(id, name);
    if (t.open) return t;
    t.open = true;
    sse('content_block_start', {
      type: 'content_block_start',
      index: t.index,
      content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} },
    });
    return t;
  }
  function closeTool(t) {
    if (!t?.open) return;
    t.open = false;
    sse('content_block_stop', { type: 'content_block_stop', index: t.index });
  }

  // Close non-tool blocks (on any block-type switch).
  const closeNonTool = () => { closeThinking(); closeText(); };
  // Close every open block (finish-step / finish / safety net).
  const closeAllOpen = () => {
    closeThinking();
    closeText();
    for (const t of toolState.values()) closeTool(t);
  };

  // --- opening lifecycle ---
  sse('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  sse('ping', { type: 'ping' });

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
            // Switching away from text -> close it, then open thinking.
            closeText();
            openThinking();
            const delta = ev.text || '';
            if (delta) {
              sse('content_block_delta', {
                type: 'content_block_delta',
                index: thinkingBlock.index,
                delta: { type: 'thinking_delta', thinking: delta },
              });
            }
            break;
          }
          case 'text-delta': {
            maybeTtft();
            closeThinking();
            openText();
            const delta = ev.text || '';
            if (delta) {
              sse('content_block_delta', {
                type: 'content_block_delta',
                index: textBlock.index,
                delta: { type: 'text_delta', text: delta },
              });
            }
            break;
          }
          case 'tool-input-start': {
            maybeTtft();
            closeNonTool();
            openTool(ev.id || ev.toolCallId, ev.toolName);
            break;
          }
          case 'tool-input-delta': {
            maybeTtft();
            // Route by id so parallel tool calls' partial_json streams stay
            // in their own blocks. A delta without a preceding
            // tool-input-start defensively opens the block (name best-effort
            // from the delta) instead of dropping the args.
            const key = ev.id || ev.toolCallId;
            let t = toolState.get(key);
            if (!t) {
              closeNonTool();
              t = openTool(key, ev.toolName);
            }
            if (ev.delta) t.args += ev.delta;
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: t.index,
              delta: { type: 'input_json_delta', partial_json: ev.delta || '' },
            });
            break;
          }
          case 'tool-input-end':
            // Argument streaming for this tool is done; the final tool-call
            // event (with structured input) closes the block below.
            break;
          case 'tool-call': {
            maybeTtft();
            closeNonTool();
            const t = openTool(ev.toolCallId || ev.id, ev.toolName);
            // Prefer the structured input; if args were already streamed
            // via tool-input-delta (t.args non-empty) they are already on
            // the wire as partial_json and must not be re-emitted.
            if (ev.input != null && !t.args) {
              const json = JSON.stringify(ev.input);
              if (json !== '{}') {
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: t.index,
                  delta: { type: 'input_json_delta', partial_json: json },
                });
              }
              t.args = json;
            }
            closeTool(t);
            break;
          }
          case 'finish-step': {
            if (ev.finishReason) stopReason = mapStopReason(ev.finishReason);
            if (ev.usage) lastUsage = ev.usage;
            closeAllOpen();
            break;
          }
          case 'finish': {
            if (ev.finishReason) stopReason = mapStopReason(ev.finishReason);
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

  // Safety net: the stream ended without (or after) finish — close anything
  // still open, then always emit message_delta + message_stop so the client
  // gets a legal stream end.
  closeAllOpen();

  const usageOut = {
    input_tokens: lastUsage?.inputTokens ?? 0,
    output_tokens: lastUsage?.outputTokens ?? 0,
  };
  if (typeof lastUsage?.cachedInputTokens === 'number') {
    usageOut.cache_read_input_tokens = lastUsage.cachedInputTokens;
  }
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usageOut,
  });
  sse('message_stop', { type: 'message_stop' });

  // Surface captured usage/finish for telemetry (same shape pipeStream returns;
  // finishReasons in the openai-style vocabulary telemetry expects).
  return {
    inputTokens: lastUsage?.inputTokens ?? null,
    outputTokens: lastUsage?.outputTokens ?? null,
    totalTokens: lastUsage?.totalTokens ?? null,
    cachedInputTokens: lastUsage?.cachedInputTokens ?? null,
    finishReasons: [stopReasonToFinishReason(stopReason)],
    ttftMs,
    durationMs: Date.now() - startMs,
  };
}

export default { pipeMessagesStream };
