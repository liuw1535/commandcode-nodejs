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
import log from '../logger.js';
import { resolveModel } from './modelProvider.js';
import { assembleCcBody, debugCcBodyReasoning } from './ccBody.js';

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
      // Upstream only accepts the nested source shapes (see
      // messagesConverter.js imageSourceToCc): {type:"image", source:{...}}.
      const url = part.image_url || part.url;
      if (!url && !part.file_id) return null;
      if (url && url.startsWith('data:')) {
        const [meta, data] = url.split(',', 2);
        const media = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
        return { type: 'image', source: { type: 'base64', media_type: media, data: data || '' } };
      }
      if (url) return { type: 'image', source: { type: 'url', url } };
      // file_id without a URL — best-effort passthrough so upstream can reject.
      return { type: 'image', source: { type: 'url', url: part.file_id } };
    }
    case 'input_file':
      // commandcode has no first-class file input block, so we cannot carry
      // file content faithfully. Rather than silently turning a file into a
      // fake image (file_url) or a lossy `[file: name]` text placeholder
      // (file_data), we log a warning and drop the part entirely. Sending
      // mangled content upstream would only corrupt the model's context.
      // Clients that need files should inline the content as text instead.
      log.warn(`[responses] input_file is not supported upstream and was dropped (filename=${part.filename || part.file_id || part.file_url || 'unknown'})`);
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
// Built-in tool types (web_search / file_search / local_shell / mcp /
// custom / ...) are unsupported upstream and dropped by default (warn log);
// passing them through would only produce upstream 400s.
function toCcTools(responsesTools) {
  if (!Array.isArray(responsesTools)) return undefined;
  const out = [];
  const dropped = [];
  for (const t of responsesTools) {
    if (!t) continue;
    if (t.type === 'function') {
      const fn = t.function || t; // Chat-nested or Responses-flat
      if (fn.name) {
        out.push({
          name: fn.name,
          description: fn.description || '',
          input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
        });
        continue;
      }
    }
    dropped.push(t.type || 'unknown');
  }
  if (dropped.length) {
    log.warn(`[responses] dropping unsupported non-function tool type(s): ${dropped.join(', ')} (built-in tools are not supported upstream)`);
  }
  return out.length ? out : undefined;
}

// Extract plain text from a system/developer `instructions`-style value,
// which the Responses API allows as either a string or an array of input
// items (each a {role/content} message or a typed part). Used for the
// top-level `instructions` field and for system/developer input items so
// both forms share one extraction path.
function extractItemText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const texts = [];
  for (const el of value) {
    if (el == null) continue;
    if (typeof el === 'string') { texts.push(el); continue; }
    // EasyInputMessage / Message item: {role, content:string|[parts]}.
    if (el.role && el.content != null) {
      if (typeof el.content === 'string') { texts.push(el.content); continue; }
      if (Array.isArray(el.content)) {
        for (const p of el.content) {
          const t = typeof p === 'string' ? p : (p && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') ? p.text : '');
          if (t) texts.push(t);
        }
      }
      continue;
    }
    // Bare typed part: {type:'input_text'|'output_text'|'text', text}.
    if (el.type === 'input_text' || el.type === 'output_text' || el.type === 'text') {
      if (el.text) texts.push(el.text);
    }
  }
  return texts.join('\n');
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
  // instructions may be a plain string or an array of input items (the
  // Responses API allows both). Reuse the shared text extractor so the array
  // form is no longer silently dropped.
  const instrText = extractItemText(instructions);
  if (instrText) systemTexts.push(instrText);

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
        const txt = extractItemText(item.content);
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
      let outText = '';
      if (typeof item.output === 'string') {
        outText = item.output;
      } else if (Array.isArray(item.output)) {
        // output may be a string or an array of input_text/input_image/
        // input_file parts. Text parts are joined; non-text parts cannot be
        // represented in a tool-result and are dropped with a warning.
        const texts = [];
        let droppedNonText = false;
        for (const p of item.output) {
          if (typeof p === 'string') { texts.push(p); continue; }
          if (!p) continue;
          if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
            if (p.text) texts.push(p.text);
          } else if (p.type === 'input_image' || p.type === 'input_file') {
            droppedNonText = true;
          } else if (p.text) {
            // Unknown part that still carries text — best effort.
            texts.push(p.text);
          }
        }
        if (droppedNonText) {
          log.warn(`[responses] function_call_output for ${item.call_id || 'unknown'} had non-text parts (input_image/input_file) that were dropped; commandcode tool results are text-only`);
        }
        outText = texts.join('\n');
      } else {
        outText = JSON.stringify(item.output ?? '');
      }
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
    // Only the human-readable summary text is reconstructed as an assistant
    // reasoning block. encrypted_content is an opaque OpenAI payload (not
    // readable chain-of-thought) and must NOT be sent as reasoning text —
    // doing so would pollute the model context. A reasoning item with no
    // summary is dropped entirely rather than synthesized from encrypted data.
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? item.summary.map(s => (s && (s.text || s.content)) || '').filter(Boolean).join('\n')
        : '';
      if (summary) {
        ccMessages.push({ role: 'assistant', content: [{ type: 'reasoning', text: summary }] });
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

  // reasoning: {effort} -> reasoning_effort (string). Only `effort` (low/medium/
  // high) maps; `summary` (auto/concise/detailed) is a different dimension and
  // must not be passed through as the effort. Tolerate a bare string too.
  let reasoningEffort = config.REASONING_EFFORT;
  if (responsesReq.reasoning) {
    if (typeof responsesReq.reasoning.effort === 'string') {
      reasoningEffort = responsesReq.reasoning.effort;
    } else if (typeof responsesReq.reasoning === 'string') {
      reasoningEffort = responsesReq.reasoning;
    }
  }

  const threadId = responsesReq.threadId || session?.threadId || randomUUID();
  const tools = toCcTools(responsesReq.tools);

  const ccBody = assembleCcBody({
    ccMessages,
    system,
    tools,
    model: mapModel(responsesReq.model),
    maxTokens: responsesReq.max_output_tokens,
    reasoningEffort,
    threadId,
    session,
  });

  debugCcBodyReasoning(ccBody, { reasoningEffort });
  return ccBody;
}

// --- response side: shared helpers ---

// Map commandcode usage (from finish/finish-step events) into the official
// Responses usage object. Shared by both the non-streaming aggregator and
// the streaming response.completed tail so the fields never drift apart.
//
//   input_tokens / output_tokens / total_tokens        — always present
//   input_tokens_details.cached_tokens                 — when upstream reports cacheReadTokens
//   input_tokens_details.cache_write_tokens             — when upstream reports cacheWriteTokens
//   output_tokens_details.reasoning_tokens             — when upstream reports reasoningTokens
export function mapUsage(usage) {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? (inputTokens + outputTokens);
  const out = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: total,
  };
  const cached = usage.cachedInputTokens ?? usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens;
  if (typeof cached === 'number' || typeof cacheWrite === 'number') {
    out.input_tokens_details = {};
    if (typeof cached === 'number') out.input_tokens_details.cached_tokens = cached;
    if (typeof cacheWrite === 'number') out.input_tokens_details.cache_write_tokens = cacheWrite;
  }
  if (typeof usage.reasoningTokens === 'number') {
    out.output_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return out;
}

// Build a Response object with the fields the real Responses API returns.
// Core fields (id/object/created_at/status/model/output) are always present;
// optional echo fields are filled only when the client supplied them or when
// we have the data (usage, reasoning effort). This keeps the non-streaming
// aggregator and the streaming response.completed payload in lockstep.
export function buildResponseObject({
  id, createdAt, status, incompleteDetails, model, output, usage, responsesReq,
}) {
  const resp = {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output,
  };
  if (incompleteDetails) resp.incomplete_details = incompleteDetails;

  const req = responsesReq || {};
  // Echo back request fields the real Response object carries.
  if (req.instructions != null) resp.instructions = req.instructions;
  if (req.max_output_tokens != null) resp.max_output_tokens = req.max_output_tokens;
  if (typeof req.temperature === 'number') resp.temperature = req.temperature;
  if (typeof req.top_p === 'number') resp.top_p = req.top_p;
  if (typeof req.parallel_tool_calls === 'boolean') resp.parallel_tool_calls = req.parallel_tool_calls;
  if (req.tool_choice != null) resp.tool_choice = req.tool_choice;
  if (Array.isArray(req.tools)) resp.tools = req.tools;
  if (req.text != null) resp.text = req.text;
  if (typeof req.truncation === 'string') resp.truncation = req.truncation;
  if (typeof req.store === 'boolean') resp.store = req.store;
  if (req.user != null) resp.user = req.user;
  if (req.metadata != null) resp.metadata = req.metadata;

  // Reasoning effort echo (only if the client requested reasoning).
  if (req.reasoning?.effort) {
    resp.reasoning = { effort: req.reasoning.effort };
  }

  const usageObj = mapUsage(usage);
  if (usageObj) resp.usage = usageObj;

  return resp;
}

// --- response side: commandcode events -> Responses object (non-streaming) ---

// Aggregate commandcode SSE events into a non-streaming OpenAI Responses
// object. events: array of parsed JSON event objects (same shape readAllEvents
// returns). responsesReq is the original request (used for reasoning effort).
//
// Reasoning/text arrive as interleaved segments in multi-step flows (reasoning
// -> tool call -> reasoning -> answer), so items are segmented on every kind
// switch: each contiguous run of reasoning/text deltas becomes its own
// reasoning/message item, in event order, instead of being merged into one
// cumulative blob.
export function commandCodeEventsToResponses(events, openaiModel, responsesReq) {
  const items = []; // output items, in event order
  let finishReason = 'stop';
  let usage = null;

  // Current open reasoning/text segment: {kind: 'reasoning'|'text', text}.
  let seg = null;
  const closeSeg = () => {
    if (!seg) return;
    if (seg.kind === 'reasoning') {
      if (seg.text) {
        items.push({
          type: 'reasoning',
          id: shortId('rs_'),
          summary: [{ type: 'summary_text', text: seg.text }],
        });
      }
    } else {
      items.push({
        type: 'message',
        id: shortId('msg_'),
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: seg.text, annotations: [], logprobs: [] }],
      });
    }
    seg = null;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'text-delta':
        if (seg?.kind !== 'text') { closeSeg(); seg = { kind: 'text', text: '' }; }
        seg.text += ev.text || '';
        break;
      case 'reasoning-delta':
        if (seg?.kind !== 'reasoning') { closeSeg(); seg = { kind: 'reasoning', text: '' }; }
        seg.text += ev.text || '';
        break;
      case 'tool-call':
        closeSeg();
        items.push({
          type: 'function_call',
          id: shortId('fc_'),
          call_id: ev.toolCallId || shortId('call_'),
          name: ev.toolName || '',
          arguments: JSON.stringify(ev.input ?? {}),
        });
        break;
      case 'finish-step':
      case 'finish': {
        closeSeg();
        const fr = ev.finishReason || ev.rawFinishReason;
        if (fr) finishReason = fr === 'tool-calls' ? 'tool_calls' : fr;
        if (ev.usage) usage = ev.usage;
        if (ev.totalUsage && !usage) usage = ev.totalUsage;
        break;
      }
      default: break;
    }
  }
  closeSeg();

  // The assistant message item is emitted whenever there is text OR there
  // were no tool calls (so a plain text answer still yields a message item).
  // When the model only emitted tool calls, the message item is omitted —
  // matching the real Responses API behavior.
  if (!items.some(i => i.type === 'message') && !items.some(i => i.type === 'function_call')) {
    items.push({
      type: 'message',
      id: shortId('msg_'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }],
    });
  }

  const output = items;

  // status: "length"/"max-tokens" => incomplete; otherwise completed.
  let status = 'completed';
  let incompleteDetails = undefined;
  if (finishReason === 'length' || finishReason === 'max-tokens') {
    status = 'incomplete';
    incompleteDetails = { reason: 'max_output_tokens' };
  }

  const resp = buildResponseObject({
    id: shortId('resp_', 48),
    createdAt: Math.floor(Date.now() / 1000),
    status,
    incompleteDetails,
    model: openaiModel || config.MODELS.defaultModel,
    output,
    usage,
    responsesReq,
  });

  return resp;
}

export default { mapModel, responsesToCommandCode, commandCodeEventsToResponses, mapUsage, buildResponseObject };
