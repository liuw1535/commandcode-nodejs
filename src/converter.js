// Format converter: OpenAI Chat Completions <-> Command Code /alpha/generate.
// Handles messages, system prompts, tools, tool_calls, and reasoning blocks.
import crypto from 'node:crypto';
import config from '../config.js';
import { getSessionForToken } from './fingerprint.js';
import { resolveModel } from './modelProvider.js';

const { randomUUID } = crypto;

// OpenAI-facing model name -> upstream model id.
// resolveModel never returns a falsy value (empty -> default, miss ->
// passthrough), so no fallback is needed here.
export function mapModel(openaiModel) {
  return resolveModel(openaiModel);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Convert an OpenAI message's content to commandcode content blocks array.
// openaiContent may be string, array of parts, or undefined.
function toCcContent(openaiContent) {
  if (openaiContent == null) return [];
  if (typeof openaiContent === 'string') {
    return openaiContent === '' ? [] : [{ type: 'text', text: openaiContent }];
  }
  if (Array.isArray(openaiContent)) {
    const out = [];
    for (const part of openaiContent) {
      if (typeof part === 'string') {
        if (part) out.push({ type: 'text', text: part });
      } else if (part.type === 'text') {
        if (part.text) out.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        // Command Code supports image blocks as {type:"image", ...}; best-effort passthrough.
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) {
          if (url.startsWith('data:')) {
            const [meta, data] = url.split(',', 2);
            const media = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
            out.push({ type: 'image', mediaType: media, data: data || '' });
          } else {
            out.push({ type: 'image', url });
          }
        }
      }
    }
    return out;
  }
  return [];
}

// Convert OpenAI tools to commandcode tools.
function toCcTools(openaiTools) {
  if (!Array.isArray(openaiTools)) return undefined;
  const out = openaiTools
    .filter(t => t && (t.function || t))
    .map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
      };
    });
  return out.length ? out : undefined;
}

// Build commandcode /alpha/generate request body from an OpenAI chat request.
// session (optional): per-credential session carrying the fake machine identity;
// used to derive workingDir so it matches the x-project-slug header.
export function openaiToCommandCode(openaiReq, session) {
  const projectSlug = session?.projectSlug || config.PROJECT_SLUG || 'c-users-proxy-desktop';
  const messages = Array.isArray(openaiReq.messages) ? openaiReq.messages : [];

  // Extract the leading contiguous run of system messages into commandcode's
  // system[] array. Scan from the start: skip leading non-system messages until
  // the first system message, then collect the contiguous block of system
  // messages that follows. Once that block ends (first non-system message after
  // it), any later system messages are demoted to user messages in-place so the
  // conversation order is preserved instead of being hoisted to the top.
  const systemTexts = [];
  const normalized = [];
  let phase = 0; // 0 = before first system, 1 = collecting run, 2 = run ended
  for (const m of messages) {
    if (m.role === 'system') {
      if (phase === 2) {
        normalized.push({ ...m, role: 'user' });
      } else {
        phase = 1;
        const txt = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '');
        if (txt) systemTexts.push(txt);
      }
    } else {
      if (phase === 1) phase = 2;
      normalized.push(m);
    }
  }
  // Keep each system message as its own array element with its own cache_control,
  // matching the real CLI's per-segment caching (x-system-prompt-breakdown counts
  // segments separately). Joining them into one block breaks prompt-cache boundaries.
  const system = systemTexts.length
    ? systemTexts.map(txt => ({ type: 'text', text: txt, cache_control: { type: 'ephemeral' } }))
    : undefined;

  // Build a toolCallId -> toolName lookup from prior assistant tool_calls.
  // OpenAI's `tool` role messages carry only role/content/tool_call_id — no
  // `name` field — so to populate commandcode's toolName we must look up the
  // name from the assistant message that issued the call. Walk the messages
  // in order and index every assistant tool_call by id.
  const toolCallNames = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        const id = tc.id;
        const name = fn.name || tc.name;
        if (id && name) toolCallNames.set(id, name);
      }
    }
  }

  // Convert normalized messages to commandcode format.
  const ccMessages = [];
  for (const m of normalized) {
    if (m.role === 'user' || m.role === 'assistant') {
      const content = toCcContent(m.content);
      // OpenAI carries assistant thinking as a top-level `reasoning_content`
      // string (sibling of `content`), while commandcode expects it as a
      // {type:"reasoning"} block inside the content array. Promote it so
      // multi-turn history preserves the reasoning. Place it before text to
      // match commandcode's ordering (reasoning precedes the answer).
      if (m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content) {
        content.unshift({ type: 'reasoning', text: m.reasoning_content });
      }
      // assistant tool_calls -> tool-call blocks
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          let input = {};
          try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { input = {}; }
          content.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: fn.name || tc.name || '',
            input,
          });
        }
      }
      ccMessages.push({ role: m.role, content });
    } else if (m.role === 'tool') {
      // OpenAI tool result -> commandcode tool-role message.
      // OpenAI's spec has no `name` on tool messages, so resolve the toolName
      // from the originating assistant tool_call (or fall back to m.name).
      const toolName = m.name || (m.tool_call_id && toolCallNames.get(m.tool_call_id)) || '';
      ccMessages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: m.tool_call_id,
          toolName,
          output: { type: 'text', value: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') },
        }],
      });
    } else {
      // Unknown role: passthrough as user text.
      ccMessages.push({ role: 'user', content: toCcContent(m.content) });
    }
  }

  // threadId doubles as the x-session-id header. The real CLI keeps one
  // threadId for the whole session; we pin it per credential (stable) unless
  // the caller passes one explicitly. Rotating it per request is a tell.
  const threadId = openaiReq.threadId || session?.threadId || randomUUID();
  const tools = toCcTools(openaiReq.tools);

  const params = {
    model: mapModel(openaiReq.model),
    messages: ccMessages,
    max_tokens: openaiReq.max_tokens ?? config.MAX_TOKENS,
    stream: true, // always stream upstream; we aggregate if client wants non-stream
    reasoning_effort: openaiReq.reasoning_effort || config.REASONING_EFFORT,
  };
  if (tools) params.tools = tools;
  if (system) params.system = system;

  // Derive workingDir from the per-credential slug: "c-users-foo42-desktop"
  // -> "C:\Users\foo42\Desktop" (matches what the real CLI reports).
  const userPart = projectSlug.replace(/^c-users-/, '').replace(/-desktop$/, '') || 'proxy';
  return {
    config: {
      workingDir: `C:\\Users\\${userPart}\\Desktop`,
      date: today(),
      environment: session?.components?.platform || config.FINGERPRINT.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    threadId,
    params,
  };
}

// Aggregate commandcode SSE events into a non-streaming OpenAI response.
// events: array of parsed JSON event objects.
export function commandCodeEventsToOpenAI(events, openaiModel) {
  let text = '';
  let reasoning = '';
  const toolCalls = []; // {id, name, input}
  let finishReason = 'stop';
  let usage = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'text-delta': text += ev.text || ''; break;
      case 'reasoning-delta': reasoning += ev.text || ''; break;
      case 'tool-call':
        toolCalls.push({
          id: ev.toolCallId,
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

  const tcOut = toolCalls.map((tc, i) => ({
    index: i,
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input ?? {}),
    },
  }));

  const message = { role: 'assistant' };
  if (text) message.content = text;
  if (reasoning) message.reasoning_content = reasoning;
  if (tcOut.length) message.tool_calls = tcOut;
  if (!message.content && !tcOut.length) message.content = '';

  const usageOut = usage ? {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
    ...(typeof usage.cachedInputTokens === 'number' ? { cachedInputTokens: usage.cachedInputTokens } : {}),
  } : undefined;

  const resp = {
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: openaiModel || config.MODELS.defaultModel,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
  };
  if (usageOut) resp.usage = usageOut;
  return resp;
}

export default { mapModel, openaiToCommandCode, commandCodeEventsToOpenAI };
