// Command Code /alpha/generate request-body assembly.
//
// This module is the API-style-agnostic seam: it builds the commandcode
// request body from already-converted commandcode-native primitives
// (ccMessages in content-block form, system blocks, cc tools). Every
// upstream-facing API style (OpenAI Chat Completions now; OpenAI Responses
// later) only needs to translate its own request shape into these primitives
// and then call assembleCcBody — the outer body + config block + params tail
// never change.
import crypto from 'node:crypto';
import config from '../config.js';
import log from '../logger.js';

const { randomUUID } = crypto;

function today() {
  return new Date().toISOString().slice(0, 10);
}

// The static "editor context" config block. workingDir / environment are
// derived from the per-credential session (machine identity), matching what
// the real CLI reports. The rest is intentionally empty/false — we are not a
// real git repo and the upstream does not require it.
function buildConfigBlock(session) {
  const projectSlug = session?.projectSlug || config.PROJECT_SLUG || 'c-users-proxy-desktop';
  // "c-users-foo42-desktop" -> "C:\Users\foo42\Desktop"
  const userPart = projectSlug.replace(/^c-users-/, '').replace(/-desktop$/, '') || 'proxy';
  return {
    workingDir: `C:\\Users\\${userPart}\\Desktop`,
    date: today(),
    environment: session?.components?.platform || config.FINGERPRINT.platform,
    structure: [],
    isGitRepo: false,
    currentBranch: '',
    mainBranch: '',
    gitStatus: '',
    recentCommits: [],
  };
}

// Assemble the full commandcode /alpha/generate body from commandcode-native
// primitives. All params are optional except ccMessages + threadId + model.
//
//   ccMessages     : array of {role, content: [...]} in commandcode block form
//   system         : array of commandcode text blocks (or undefined)
//   tools          : array of commandcode {name, description, input_schema} (or undefined)
//   model          : upstream model id (already resolved)
//   maxTokens      : OpenAI max_tokens (falls back to config.MAX_TOKENS)
//   reasoningEffort: OpenAI reasoning_effort (falls back to config.REASONING_EFFORT)
//   threadId       : conversation/thread id (doubles as x-session-id header)
//   session        : per-credential session (for workingDir/environment)
//
// `stream` is pinned to true: we always stream upstream and aggregate on our
// side if the client asked for a non-streaming response.
export function assembleCcBody({ ccMessages, system, tools, model, maxTokens, reasoningEffort, threadId, session }) {
  const params = {
    model,
    messages: ccMessages,
    max_tokens: maxTokens ?? config.MAX_TOKENS,
    stream: true,
    reasoning_effort: reasoningEffort || config.REASONING_EFFORT,
  };
  if (tools) params.tools = tools;
  if (system) params.system = system;

  return {
    config: buildConfigBlock(session),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    threadId: threadId || randomUUID(),
    params,
  };
}


// Debug helper: inspect an assembled commandcode /alpha/generate body and log
// whether it injected the model's thinking/reasoning content. Two injection
// vectors are checked:
//
//   1. params.reasoning_effort — controls how much the upstream model "thinks"
//      for THIS turn (set from config.REASONING_EFFORT or the request's
//      reasoning.effort).
//   2. reasoning-type content blocks inside ccMessages — reconstructed from
//      prior-turn reasoning history so multi-turn context preserves the
//      chain-of-thought (see the style-specific converters' input mapping).
//
// Gated behind config.DEBUG_CC_BODY so it stays silent in production. Set
// DEBUG_CC_BODY=1 to enable. Shared by both Chat Completions and Responses
// converters via assembleCcBody — hence lives here on the API-style-agnostic
// seam, not inside either converter.
export function debugCcBodyReasoning(ccBody, { reasoningEffort } = {}) {
  if (!config.DEBUG_CC_BODY) return;

  const params = ccBody?.params || {};
  const messages = params.messages || [];

  // Vector 1: reasoning_effort param (turn-level thinking directive).
  const effort = params.reasoning_effort;
  const effortInjected = typeof effort === 'string' && effort.length > 0;
  const effortSource = effort === reasoningEffort
    ? (effort === config.REASONING_EFFORT ? 'config default' : 'request override')
    : 'unknown';

  // Vector 2: reasoning content blocks in ccMessages (history-level thinking).
  const reasoningBlocks = [];
  messages.forEach((msg, mi) => {
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    blocks.forEach((blk, bi) => {
      if (blk?.type === 'reasoning' && blk.text) {
        reasoningBlocks.push({
          msgIndex: mi,
          blockIndex: bi,
          role: msg.role,
          preview: blk.text.slice(0, 60) + (blk.text.length > 60 ? '…' : ''),
        });
      }
    });
  });

  const summary = reasoningBlocks.length > 0
    ? reasoningBlocks.map(r => `  · msg[${r.msgIndex}].content[${r.blockIndex}] (${r.role}): "${r.preview}"`).join('\n')
    : '  · (none)';

  log.info(
    `[debug:ccBody] reasoning injection check for threadId=${ccBody?.threadId?.slice(0, 12)}…\n` +
    `  reasoning_effort param: ${effortInjected ? 'INJECTED' : 'absent'} (value="${effort ?? ''}", source=${effortSource})\n` +
    `  reasoning message blocks: ${reasoningBlocks.length} found\n${summary}`
  );
}

export default { assembleCcBody, debugCcBodyReasoning };
