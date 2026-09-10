// Format converter: OpenAI Responses API (/v1/responses) <-> Command Code
// /alpha/generate.
//
// This mirrors converter.js (Chat Completions) but speaks the Responses API
// shape: `input` (string or array of typed Items) + top-level `instructions`
// on the request side, and a typed `output` array of Items on the response
// side. The commandcode-native primitives (ccMessages / system / cc tools)
// are the same, so we reuse assembleCcBody for the upstream body — only the
// translation in and out differs.
import crypto from 'node:crypto';
import config from '../config.js';
import { resolveModel } from './modelProvider.js';
import { assembleCcBody } from './ccBody.js';

const { randomUUID } = crypto;

// Short id helper: "resp_", "msg_", "rs_", "fc_", "call_" prefixes.
function shortId(prefix, n = 24) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, n);
}

// OpenAI-facing model name -> upstream model id (case-insensitive match
// against the cached upstream list; miss -> passthrough).
export function mapModel(openaiModel) {
  return resolveModel(openaiModel);
}

// --- request side: Responses input -> commandcode primitives ---

// Convert a Responses content part into commandcode content blocks.
// Input parts: {type:"input_text",text}, {type:"output_text",text},
// {type:"input_image",image_url|file_id,detail}, {type:"input_file",...}.
// Plain strings are accepted too.
function partToCcBlock(part) {
  if (part == null) return null;
  if (typeof part === 'string') {
    return part ? { type: 'text', text: part } : null;
  }
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'text':
      return part.text ? { type: 'text', text: part.text } : null;
    case 'input_image': {
      const url = part.image_url || part.url;
      if (!url && !part.file_id) return null;
      if (url && url.startsWith('data:')) {
        const [meta, data] = url.split(',', 2);
        const media = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
        return { type: 'image', mediaType: media, data: data || '' };
      }
      if (url) return { type: 'image', url };
      // file_id without a URL — best-effort passthrough so upstream can reject.
      return { type: 'image', url: part.file_id };
    }
    case 'input_file':
      // Best-effort passthrough; commandcode has no first-class file block.
      if (part.file_data) {
        return { type: 'text', text: `[file: ${part.filename || part.file_id || 'unknown'}]` };
      }
      if (part.file_url) return { type: 'image', url: part.file_url };
      return null;
    default:
      return null;
  }
}

function contentPartsToCcBlocks(content) {
  const out = [];
  if (content == null) return out;
  if (typeof content === 'string') {
    if (content) out.push({ type: 'text', text: content });
    return out;
  }
  if (Array.isArray(content)) {
    for (const p of content) {
      const b = partToCcBlock(p);
      if (b) out.push(b);
    }
  }
  return out;
}

// Convert Responses tools to commandcode tools.
// Responses tool: {type:"function", name, description, parameters, strict}.
// Also tolerate Chat-style {type:"function", function:{name,description,parameters}}.
function toCcTools(responsesTools) {
  if (!Array.isArray(responsesTools)) return undefined;
  const out = [];
  for (const t of responsesTools) {
    if (!t) continue;
    if (t.type === 'function' && t.function) {
      const fn = t.function;
      out.push({
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
      });
    } else if (t.name || (t.type === 'function' && t.type)) {
      out.push({
        name: t.name,
        description: t.description || '',
        input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} },
      });
    }
  }
  return out.length ? out : undefined;
}

// Build a toolCallId -> toolName lookup from prior function_call input items,
// mirroring the Chat converter's lookup from assistant tool_calls. Responses
// FunctionCallOutput items carry only `call_id` (no name), so we resolve the
// name from the preceding function_call item.
function buildCallIdNameMap(inputItems) {
  const map = new Map();
  if (!Array.isArray(inputItems)) return map;
  for (const it of inputItems) {
    if (it && it.type === 'function_call' && it.call_id && it.name) {
      map.set(it.call_id, it.name);
    }
  }
  return map;
}

// Convert the Responses `input` (string or item array) + `instructions` into
// commandcode messages + system blocks. Returns { ccMessages, system }.
function inputToCcMessages(responsesReq) {
  const input = responsesReq.input;
  const instructions = responsesReq.instructions;

  // System blocks: top-level `instructions` first, then system/developer input
  // items encountered in order. (Responses treats all system/developer items
  // as instructions regardless of position.)
  const systemTexts = [];
  if (typeof instructions === 'string' && instructions) {
    systemTexts.push(instructions);
  }

  // Normalize input into an item list. A bare string is a single user message.
  let items = [];
  if (typeof input === 'string') {
    items = [{ role: 'user', content: input }];
  } else if (Array.isArray(input)) {
    items = input;
  }

  const callIdNames = buildCallIdNameMap(items);
  const ccMessages = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role;
    const type = item.type;

    // EasyInputMessage: {role, content:string} (no `type`).
    // Message: {type:"message", role, content:[parts] | string}.
    if ((!type || type === 'message') && role) {
      if (role === 'system' || role === 'developer') {
        const txt = typeof item.content === 'string'
          ? item.content
          : (Array.isArray(item.content)
            ? item.content.filter(p => p && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text' || typeof p === 'string'))
              .map(p => (typeof p === 'string' ? p : p.text || ''))
              .join('\n')
            : '');
        if (txt) systemTexts.push(txt);
      } else if (role === 'user' || role === 'assistant') {
        const blocks = contentPartsToCcBlocks(item.content);
        ccMessages.push({ role, content: blocks });
      }
      continue;
    }

    // FunctionCall: {type:"function_call", call_id, name, arguments}.
    // Maps to an assistant message carrying a tool-call block.
    if (type === 'function_call') {
      let parsed = {};
      try { parsed = item.arguments ? JSON.parse(item.arguments) : {}; } catch { parsed = {}; }
      ccMessages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: item.call_id || item.id || '',
          toolName: item.name || '',
          input: parsed,
        }],
      });
      continue;
    }

    // FunctionCallOutput: {type:"function_call_output", call_id, output}.
    // Maps to a tool-role message with a tool-result block.
    if (type === 'function_call_output') {
      const outText = typeof item.output === 'string'
        ? item.output
        : (Array.isArray(item.output)
          ? item.output.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n')
          : JSON.stringify(item.output ?? ''));
      const toolName = callIdNames.get(item.call_id) || '';
      ccMessages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: item.call_id || '',
          toolName,
          output: { type: 'text', value: outText },
        }],
      });
      continue;
    }

    // Reasoning: {type:"reasoning", summary:[{type:"summary_text",text}], encrypted_content}.
    // Reconstruct as an assistant reasoning block so multi-turn history keeps it.
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? item.summary.map(s => (s && (s.text || s.content)) || '').filter(Boolean).join('\n')
        : '';
      const text = summary || item.encrypted_content || '';
      if (text) {
        ccMessages.push({ role: 'assistant', content: [{ type: 'reasoning', text }] });
      }
      continue;
    }

    // item_reference / other built-in tool call items: skip (we have no stored
    // state to resolve them against — the client must inline the full history).
  }

  const system = systemTexts.length
    ? systemTexts.map(txt => ({ type: 'text', text: txt, cache_control: { type: 'ephemeral' } }))
    : undefined;

  return { ccMessages, system };
}

// Build a commandcode /alpha/generate body from an OpenAI Responses request.
// session (optional): per-credential session carrying the fake machine identity.
export function responsesToCommandCode(responsesReq, session) {
  const { ccMessages, system } = inputToCcMessages(responsesReq);

  // reasoning: {effort} -> reasoning_effort (string). Tolerate a bare string too.
  let reasoningEffort = config.REASONING_EFFORT;
  if (responsesReq.reasoning) {
    reasoningEffort = responsesReq.reasoning.effort || responsesReq.reasoning.summary || reasoningEffort;
  }

  const threadId = responsesReq.threadId || session?.threadId || randomUUID();
  const tools = toCcTools(responsesReq.tools);

  return assembleCcBody({
    ccMessages,
    system,
    tools,
    model: mapModel(responsesReq.model),
    maxTokens: responsesReq.max_output_tokens,
    reasoningEffort,
    threadId,
    session,
  });
}

// --- response side: commandcode events -> Responses object (non-streaming) ---

// Aggregate commandcode SSE events into a non-streaming OpenAI Responses
// object. events: array of parsed JSON event objects (same shape readAllEvents
// returns). responsesReq is the original request (used for reasoning effort).
export function commandCodeEventsToResponses(events, openaiModel, responsesReq) {
  let text = '';
  let reasoning = '';
  const toolCalls = []; // {id, callId, name, input}
  let finishReason = 'stop';
  let usage = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'text-delta': text += ev.text || ''; break;
      case 'reasoning-delta': reasoning += ev.text || ''; break;
      case 'tool-call':
        toolCalls.push({
          callId: ev.toolCallId,
          name: ev.toolName,
          input: ev.input,
        });
        break;
      case 'finish-step':
      case 'finish': {
        const fr = ev.finishReason || ev.rawFinishReason;
        if (fr) finishReason = fr === 'tool-calls' ? 'tool_calls' : fr;
        if (ev.usage) usage = ev.usage;
        if (ev.totalUsage && !usage) usage = ev.totalUsage;
        break;
      }
      default: break;
    }
  }

  // Assemble the typed `output` array. Order: reasoning (if any) -> message ->
  // function_call items. Each gets a stable id.
  const output = [];

  if (reasoning) {
    output.push({
      type: 'reasoning',
      id: shortId('rs_'),
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }

  // The assistant message is emitted whenever there is text OR there were no
  // tool calls (so a plain text answer still yields a message item). When the
  // model only emitted tool calls, the message item is omitted — matching the
  // real Responses API behavior.
  if (text || toolCalls.length === 0) {
    output.push({
      type: 'message',
      id: shortId('msg_'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const tc of toolCalls) {
    output.push({
      type: 'function_call',
      id: shortId('fc_'),
      call_id: tc.callId || shortId('call_'),
      name: tc.name || '',
      arguments: JSON.stringify(tc.input ?? {}),
    });
  }

  // status: "length"/"max-tokens" => incomplete; otherwise completed.
  let status = 'completed';
  let incompleteDetails = undefined;
  if (finishReason === 'length' || finishReason === 'max-tokens') {
    status = 'incomplete';
    incompleteDetails = { reason: 'max_output_tokens' };
  }

  const resp = {
    id: shortId('resp_', 48),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: openaiModel || config.MODELS.defaultModel,
    output,
  };
  if (incompleteDetails) resp.incomplete_details = incompleteDetails;

  // Reasoning effort echo (only if the client requested reasoning).
  if (responsesReq?.reasoning?.effort) {
    resp.reasoning = { effort: responsesReq.reasoning.effort };
  }

  if (usage) {
    resp.usage = {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
    };
    if (typeof usage.cachedInputTokens === 'number') {
      resp.usage.input_tokens_details = { cached_tokens: usage.cachedInputTokens };
    }
  }

  return resp;
}

export default { mapModel, responsesToCommandCode, commandCodeEventsToResponses };
