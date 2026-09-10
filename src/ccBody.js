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

export default { assembleCcBody };
