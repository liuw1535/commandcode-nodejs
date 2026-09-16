// Format converter: Anthropic Messages API (/v1/messages) <-> Command Code
// /alpha/generate.
//
// Mirrors converter.js (Chat Completions) and responsesConverter.js
// (Responses): only the translation in and out of the commandcode-native
// primitives (ccMessages / system / cc tools) differs — assembleCcBody
// builds the shared upstream body. The Anthropic shapes converted here:
//
//   request : top-level `system` (string or text blocks), `messages` with
//             typed content blocks (text / image / thinking / tool_use /
//             tool_result), `tools` {name, description, input_schema}.
//   response: a Message object {type:"message", content:[...], stop_reason,
//             usage} for non-streaming, or the SSE lifecycle in
//             messagesStreamMapper.js for streaming.
import crypto from 'node:crypto';
import config from '../config.js';
import log from '../logger.js';
import { resolveModel } from './modelProvider.js';
import { assembleCcBody, debugCcBodyReasoning } from './ccBody.js';

const { randomUUID } = crypto;

// Anthropic-facing model name -> upstream model id (case-insensitive match
// against the cached upstream list; miss -> passthrough). resolveModel never
// returns a falsy value, so no fallback is needed.
export function mapModel(anthropicModel) {
  return resolveModel(anthropicModel);
}

function tooluId() {
  return 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

// --- request side: Anthropic Messages -> commandcode primitives ---

// Convert an Anthropic image block source into a commandcode image block.
// The upstream /alpha/generate content-block union accepts the Anthropic-
// native image shapes verbatim (probed against the live upstream):
//   {type:"image", source:{type:"base64", media_type, data}}  -> accepted
//   {type:"image", source:{type:"url", url}}                   -> accepted
//   {type:"image", mediaType, data} / {type:"image", url}      -> rejected
// so the source is passed through (normalized copy) rather than converted
// to a cc-native mediaType/data shape.
function imageSourceToCc(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && source.data) {
    return { type: 'image', source: { type: 'base64', media_type: source.media_type || 'image/png', data: source.data } };
  }
  if (source.type === 'url' && source.url) {
    return { type: 'image', source: { type: 'url', url: source.url } };
  }
  return null;
}

// Convert Anthropic tools to commandcode tools. The shapes are isomorphic
// ({name, description, input_schema}), so this is a straight filtered map.
// Non-standard entries (missing name) are dropped with a warn.
// `tool_choice` is not supported upstream and ignored.
function toCcTools(anthropicTools) {
  if (!Array.isArray(anthropicTools)) return undefined;
  const out = [];
  const dropped = [];
  for (const t of anthropicTools) {
    if (t && typeof t.name === 'string' && t.name) {
      out.push({
        name: t.name,
        description: t.description || '',
        input_schema: t.input_schema || { type: 'object', properties: {} },
      });
    } else {
      dropped.push(t?.type || 'unknown');
    }
  }
  if (dropped.length) {
    log.warn(`[messages] dropping invalid tool definition(s): ${dropped.join(', ')}`);
  }
  return out.length ? out : undefined;
}

// Convert a tool_result block's `content` (string or array of text blocks)
// into a plain output string.
function toolResultContentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p === 'string' ? p : (p?.type === 'text' ? (p.text || '') : '')))
      .filter(Boolean)
      .join('\n');
  }
  try { return JSON.stringify(content); } catch { return ''; }
}

// Extract the text of an Anthropic system field (string or array of
// {type:"text", text, cache_control} blocks) into a list of plain texts.
function anthropicSystemTexts(system) {
  const texts = [];
  if (typeof system === 'string' && system) {
    texts.push(system);
  } else if (Array.isArray(system)) {
    for (const b of system) {
      if (b?.type === 'text' && b.text) texts.push(b.text);
    }
  }
  return texts;
}

// Build the commandcode messages array from Anthropic `messages`.
//   assistant text/thinking/tool_use blocks -> one cc assistant message
//     (thinking promoted to a reasoning block ahead of text/tool-call,
//     signature dropped — upstream does not validate it)
//   user text/image blocks -> one cc user message
//   user tool_result blocks -> individual cc tool-role messages (toolName
//     resolved from prior assistant tool_use ids, like the other converters)
//
// Non-standard system-role messages are NOT handled here — they are hoisted
// or demoted in anthropicToCommandCode before this runs (Anthropic puts the
// system prompt in the top-level `system` field, but some clients also send
// role:"system" entries in `messages` — see anthropicToCommandCode).
function anthropicMessagesToCc(messages) {
  // tool_use id -> name lookup for tool_result resolution.
  const toolUseNames = new Map();
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_use' && b.id && b.name) toolUseNames.set(b.id, b.name);
      }
    }
  }

  const ccMessages = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const blocks = typeof m.content === 'string'
      ? (m.content ? [{ type: 'text', text: m.content }] : [])
      : (Array.isArray(m.content) ? m.content : []);

    if (m.role === 'assistant') {
      const content = [];
      // thinking blocks first (commandcode ordering: reasoning precedes the
      // answer / tool calls). redacted_thinking and signature are dropped.
      for (const b of blocks) {
        if (b?.type === 'thinking' && b.thinking) {
          content.push({ type: 'reasoning', text: b.thinking });
        }
      }
      for (const b of blocks) {
        if (!b || typeof b !== 'object') {
          if (typeof b === 'string') content.push({ type: 'text', text: b });
          continue;
        }
        if (b.type === 'text' && b.text) {
          content.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          content.push({
            type: 'tool-call',
            toolCallId: typeof b.id === 'string' ? b.id : '',
            toolName: typeof b.name === 'string' ? b.name : '',
            input: b.input ?? {},
          });
        } else if (b.type === 'thinking') {
          // handled above
        } else {
          log.warn(`[messages] skipping unsupported assistant block type: ${b.type}`);
        }
      }
      if (content.length) ccMessages.push({ role: 'assistant', content });
      continue;
    }

    if (m.role === 'user') {
      const userContent = [];
      const toolResults = [];
      for (const b of blocks) {
        if (typeof b === 'string') {
          if (b) userContent.push({ type: 'text', text: b });
          continue;
        }
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) {
          userContent.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          const img = imageSourceToCc(b.source);
          if (img) userContent.push(img);
        } else if (b.type === 'tool_result') {
          // Anthropic tool_result content: string or array of text blocks.
          toolResults.push({
            type: 'tool-result',
            toolCallId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
            toolName: toolUseNames.get(b.tool_use_id) || '',
            output: { type: 'text', value: toolResultContentToText(b.content) },
          });
        } else {
          log.warn(`[messages] skipping unsupported user block type: ${b.type}`);
        }
      }
      // tool results first (they answer the preceding assistant tool-call
      // message), then the remaining user text/image content.
      for (const tr of toolResults) ccMessages.push({ role: 'tool', content: [tr] });
      if (userContent.length) ccMessages.push({ role: 'user', content: userContent });
      continue;
    }

    // Unknown role (system is handled above; role:"system" messages reaching
    // here were already demoted to user): passthrough as user text so
    // conversation order survives.
    log.warn(`[messages] unknown message role "${m.role}", passthrough as user`);
    const txt = typeof m.content === 'string' ? m.content : '';
    if (txt) ccMessages.push({ role: 'user', content: [{ type: 'text', text: txt }] });
  }
  return ccMessages;
}

// Extract the text of a non-standard system-role message's content
// (string or array of text blocks) for hoisting into the system array.
function systemRoleText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p === 'string' ? p : (p?.type === 'text' ? (p.text || '') : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Build a commandcode /alpha/generate body from an Anthropic Messages
// request. session (optional): per-credential session carrying the fake
// machine identity.
//
// Field mapping notes:
//   system                  -> params.system (per-segment cache_control)
//   messages                -> params.messages
//   tools                   -> params.tools (isomorphic)
//   tool_choice             -> ignored (unsupported upstream)
//   model                   -> resolveModel (case-insensitive, miss passthrough)
//   max_tokens              -> max_tokens (falls back to config.MAX_TOKENS)
//   thinking:{type:enabled}-> reasoning_effort config default (budget_tokens ignored)
//   stream / temperature / top_p / stop_sequences / metadata -> not forwarded
//
// Non-standard system-role messages: the Anthropic spec puts the system
// prompt in the top-level `system` field only, but some clients (proxies,
// SDKs, some Claude Code setups) also emit role:"system" entries inside
// `messages`. Like converter.js, the leading contiguous run of system
// messages is hoisted into the system[] array (appended after the top-level
// `system` texts); system messages after that run are demoted to user
// in-place so conversation order is preserved instead of being hoisted.
export function anthropicToCommandCode(anthropicReq, session) {
  const rawMessages = Array.isArray(anthropicReq.messages) ? anthropicReq.messages : [];

  const systemTexts = anthropicSystemTexts(anthropicReq.system);
  const normalized = [];
  let phase = 0; // 0 = before first system message, 1 = collecting run, 2 = run ended
  for (const m of rawMessages) {
    if (m?.role === 'system') {
      if (phase === 2) {
        normalized.push({ ...m, role: 'user' });
      } else {
        phase = 1;
        const txt = systemRoleText(m.content);
        if (txt) systemTexts.push(txt);
      }
    } else {
      if (phase === 1) phase = 2;
      normalized.push(m);
    }
  }
  // Keep each system segment as its own block with its own cache_control,
  // matching the per-segment caching the other converters use.
  const system = systemTexts.length
    ? systemTexts.map(txt => ({ type: 'text', text: txt, cache_control: { type: 'ephemeral' } }))
    : undefined;

  const ccMessages = anthropicMessagesToCc(normalized);
  const tools = toCcTools(anthropicReq.tools);

  // thinking enabled -> reasoning_effort; we always use the configured
  // default (budget_tokens has no upstream equivalent and is ignored).
  const reasoningEffort = anthropicReq.thinking?.type === 'enabled'
    ? config.REASONING_EFFORT
    : undefined;

  const threadId = anthropicReq.threadId || session?.threadId || randomUUID();

  const ccBody = assembleCcBody({
    ccMessages,
    system,
    tools,
    model: mapModel(anthropicReq.model),
    maxTokens: anthropicReq.max_tokens,
    reasoningEffort,
    threadId,
    session,
  });
  debugCcBodyReasoning(ccBody, { reasoningEffort });
  return ccBody;
}

// --- response side: commandcode events -> Anthropic Message (non-streaming) ---

// commandcode finishReason -> Anthropic stop_reason.
export function mapStopReason(fr) {
  if (fr === 'tool-calls' || fr === 'tool_calls') return 'tool_use';
  if (fr === 'length' || fr === 'max-tokens') return 'max_tokens';
  return 'end_turn';
}

// Anthropic stop_reason -> the finishReason vocabulary telemetry expects
// (openai-style: stop / tool_calls / length).
export function stopReasonToFinishReason(sr) {
  if (sr === 'tool_use') return 'tool_calls';
  if (sr === 'max_tokens') return 'length';
  return 'stop';
}

// Aggregate commandcode SSE events into a non-streaming Anthropic Message
// object. events: array of parsed JSON event objects (readAllEvents shape).
//
// Like the Responses converter, reasoning/text arrive as interleaved
// segments in multi-step flows (reasoning -> tool call -> reasoning ->
// answer), so content is segmented on every kind switch: each contiguous
// run of reasoning/text deltas becomes its own thinking/text block, in
// event order. thinking blocks carry an empty signature placeholder.
export function commandCodeEventsToAnthropic(events, anthropicModel) {
  const content = [];
  let stopReason = 'end_turn';
  let usage = null;

  // Current open reasoning/text segment: {kind:'text'|'thinking', text}.
  let seg = null;
  const closeSeg = () => {
    if (!seg) return;
    if (seg.kind === 'thinking') {
      if (seg.text) content.push({ type: 'thinking', thinking: seg.text, signature: '' });
    } else {
      content.push({ type: 'text', text: seg.text });
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
        if (seg?.kind !== 'thinking') { closeSeg(); seg = { kind: 'thinking', text: '' }; }
        seg.text += ev.text || '';
        break;
      case 'tool-call':
        closeSeg();
        content.push({
          type: 'tool_use',
          id: typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : tooluId(),
          name: ev.toolName || '',
          input: ev.input ?? {},
        });
        break;
      case 'finish-step':
      case 'finish': {
        closeSeg();
        const fr = ev.finishReason || ev.rawFinishReason;
        if (fr) stopReason = mapStopReason(fr);
        if (ev.usage) usage = ev.usage;
        if (ev.totalUsage && !usage) usage = ev.totalUsage;
        break;
      }
      default: break;
    }
  }
  closeSeg();

  // Empty output -> a single empty text block so the message shape stays valid.
  if (!content.length) content.push({ type: 'text', text: '' });

  const resp = {
    id: 'msg_' + randomUUID().replace(/-/g, ''),
    type: 'message',
    role: 'assistant',
    model: anthropicModel || config.MODELS.defaultModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
    },
  };
  if (typeof usage?.cachedInputTokens === 'number') {
    resp.usage.cache_read_input_tokens = usage.cachedInputTokens;
  }
  return resp;
}

// --- count_tokens rough estimator ---
// Anthropic's /v1/messages/count_tokens normally hits the real tokenizer;
// this proxy estimates locally (total text chars / 4) without calling
// upstream. Counts system + every text-bearing block in messages.
export function estimateInputTokens(anthropicReq) {
  let chars = 0;
  const add = (t) => { if (typeof t === 'string') chars += t.length; };

  add(typeof anthropicReq?.system === 'string' ? anthropicReq.system : '');
  if (Array.isArray(anthropicReq?.system)) {
    for (const b of anthropicReq.system) if (b?.type === 'text') add(b.text);
  }

  if (Array.isArray(anthropicReq?.messages)) {
    for (const m of anthropicReq.messages) {
      if (typeof m?.content === 'string') {
        add(m.content);
        continue;
      }
      if (!Array.isArray(m?.content)) continue;
      for (const b of m.content) {
        if (b?.type === 'text') add(b.text);
        else if (b?.type === 'thinking') add(b.thinking);
        else if (b?.type === 'tool_result') {
          if (typeof b.content === 'string') add(b.content);
          else if (Array.isArray(b.content)) {
            for (const p of b.content) if (p?.type === 'text') add(p.text);
          }
        } else if (b?.type === 'tool_use') {
          try { add(JSON.stringify(b.input ?? {})); } catch { /* ignore */ }
        }
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export default { mapModel, anthropicToCommandCode, commandCodeEventsToAnthropic, estimateInputTokens, mapStopReason, stopReasonToFinishReason };
