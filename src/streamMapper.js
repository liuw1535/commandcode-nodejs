// Stream mapper: convert Command Code SSE (line-delimited JSON events) into
// OpenAI Chat Completions SSE (data: <json>\n\n, ending with data: [DONE]).
import crypto from 'node:crypto';

const { randomUUID } = crypto;

function sseData(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Map commandcode finishReason -> openai finish_reason.
function mapFinish(fr) {
  if (!fr) return 'stop';
  if (fr === 'tool-calls') return 'tool_calls';
  return fr; // stop, length, etc.
}

// Pipe an upstream text/event-stream (response.body reader) into the openai
// SSE response. Returns a promise resolving when the stream ends.
//   res: node http.ServerResponse (already writing SSE)
//   upstream: fetch Response (body is a ReadableStream)
//   openaiModel: model name to echo back
//   includeUsage: whether to emit a usage chunk at the end
export async function pipeStream({ res, upstream, openaiModel, includeUsage }) {
  const id = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const startMs = Date.now();
  let ttftMs = null; // time to first token delta (text/reasoning/tool)

  // first chunk: role delta
  sseData(res, {
    id, object: 'chat.completion.chunk', created, model: openaiModel,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // tool-call accumulation state: map toolCallId -> {index, id, name, args}
  // A single curTool slot cannot handle parallel tool calls: when the model
  // emits multiple tools at once, upstream interleaves tool-input-start /
  // tool-input-delta events for different ids, and a single slot would merge
  // every tool's arguments into one string. Key by id and assign each tool a
  // stable, incrementing OpenAI tool_calls index instead.
  const tools = new Map();
  let nextIndex = 0;
  let lastUsage = null;
  let finishReason = 'stop';

  function getTool(id, name) {
    if (!id) id = 'call_' + randomUUID().slice(0, 24);
    let t = tools.get(id);
    if (!t) {
      t = { index: nextIndex++, id, name: name || '', args: '' };
      tools.set(id, t);
    } else if (name && !t.name) {
      t.name = name;
    }
    return t;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Command Code sends one JSON object per line, blank line separated.
      // Process complete lines.
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        // strip any leading/trailing \r
        line = line.replace(/\r$/, '').trim();
        if (!line) continue;
        if (!line.startsWith('{')) continue; // ignore non-JSON lines
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        const maybeMarkTtft = () => {
          if (ttftMs === null) ttftMs = Date.now() - startMs;
        };
        switch (ev.type) {
          case 'reasoning-delta':
            maybeMarkTtft();
            sseData(res, {
              id, object: 'chat.completion.chunk', created, model: openaiModel,
              choices: [{ index: 0, delta: { reasoning_content: ev.text || '' }, finish_reason: null }],
            });
            break;
          case 'text-delta':
            maybeMarkTtft();
            sseData(res, {
              id, object: 'chat.completion.chunk', created, model: openaiModel,
              choices: [{ index: 0, delta: { content: ev.text || '' }, finish_reason: null }],
            });
            break;
          case 'tool-input-start':
            maybeMarkTtft();
            // Register the tool (assigns its stable index). Do not overwrite
            // any existing entry — a parallel tool may have started earlier.
            getTool(ev.id, ev.toolName);
            break;
          case 'tool-input-delta': {
            // Route the delta to the correct tool by id. Ignoring ev.id here
            // is what previously interleaved multiple tools' args together.
            const t = tools.get(ev.id);
            if (t) t.args += ev.delta || '';
            break;
          }
          case 'tool-input-end':
            // Argument streaming for this tool is complete; the final
            // tool-call event (with structured input) is emitted below.
            break;
          case 'tool-call': {
            // Prefer the final tool-call event's structured input if present;
            // otherwise fall back to the per-tool accumulated args string.
            const t = getTool(ev.toolCallId, ev.toolName);
            const args = (ev.input != null)
              ? JSON.stringify(ev.input)
              : (t.args || '');
            sseData(res, {
              id, object: 'chat.completion.chunk', created, model: openaiModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: t.index,
                    id: t.id,
                    type: 'function',
                    function: { name: t.name, arguments: args },
                  }],
                },
                finish_reason: null,
              }],
            });
            break;
          }
          case 'finish-step': {
            if (ev.finishReason) finishReason = mapFinish(ev.finishReason);
            if (ev.usage) lastUsage = ev.usage;
            break;
          }
          case 'finish': {
            if (ev.finishReason) finishReason = mapFinish(ev.finishReason);
            if (ev.totalUsage) lastUsage = ev.totalUsage;
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

  // final chunk with finish_reason
  sseData(res, {
    id, object: 'chat.completion.chunk', created, model: openaiModel,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });

  // optional usage chunk
  if (includeUsage && lastUsage) {
    sseData(res, {
      id, object: 'chat.completion.chunk', created, model: openaiModel,
      choices: [],
      usage: {
        prompt_tokens: lastUsage.inputTokens ?? 0,
        completion_tokens: lastUsage.outputTokens ?? 0,
        total_tokens: lastUsage.totalTokens ?? ((lastUsage.inputTokens ?? 0) + (lastUsage.outputTokens ?? 0)),
      },
    });
  }

  res.write('data: [DONE]\n\n');

  // Surface captured usage/finish so the caller can emit telemetry.
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

export default { pipeStream };
