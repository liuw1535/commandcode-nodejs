// Upstream request lifecycle — the API-style-agnostic middle of the pipeline.
//
//   client request ──▶ [style-specific converter] ──▶ ccBody (commandcode)
//        ccBody ──▶ sendGenerate() ──▶ upstream SSE
//        upstream SSE ──▶ [style-specific stream mapper / aggregator] ──▶ client
//
// sendGenerate encapsulates everything between "we have a commandcode body" and
// "we have an upstream fetch Response": credential rotation, lazy warmup,
// per-credential header build, the actual fetch, and capturing the telemetry
// context of whichever credential actually served the request. A future
// /v1/responses route reuses this verbatim — only its converter + stream
// mapper differ.
import config from '../config.js';
import log from '../logger.js';
import { ensureWarmed, maybeRotateOnIdle, getSessionForToken, buildGenerateHeaders } from './fingerprint.js';
import { labelOf } from './credPool.js';
import { emitApiSpan } from './telemetry.js';

// Send a commandcode /alpha/generate request with full credential rotation +
// retry policy. `buildBody(session, token)` is invoked inside the rotation
// callback so the body (workingDir / x-project-slug / fingerprint-derived
// fields) is assembled against the credential that will actually serve the
// request. It must return a commandcode /alpha/generate body carrying a
// `threadId` (used as the x-session-id header) and a `params.model`.
//
// Returns { upstreamRes, captured } where `captured` holds the telemetry
// context (session/threadId/model/trace/toolCount) of the credential that
// actually served the request, for the caller to feed into emitTelemetry.
export async function sendGenerate(credPool, buildBody, signal) {
  let captured = null;

  const { res: upstreamRes, cred, attempts } = await credPool.requestWithRotation(async (token) => {
    const credForToken = credPool.find(token);
    // If this credential has been idle past the configured threshold, rotate
    // its ephemeral session identity + emit a fresh startup burst BEFORE this
    // request goes out (simulating a CLI restart). No-op when disabled.
    await maybeRotateOnIdle(token, credForToken?.name);
    await ensureWarmed(token, credForToken?.name, config.WARMUP_MODE);
    const session = getSessionForToken(token, credForToken?.name);
    // Quota pre-check: the fingerprint warmup already reads
    // /alpha/billing/credits. If that (or an earlier 429) says a window is
    // exhausted, do NOT spend a guaranteed-429 generate call on this
    // credential — surface it to the pool, which disables it until reset and
    // rotates to the next one.
    if (session?.quota) {
      if (session.quota.resetAt > Date.now()) {
        const e = new Error(`quota exhausted (${session.quota.window || 'window'} limit) detected during warmup`);
        e.code = 'QUOTA_EXHAUSTED';
        e.quota = session.quota;
        throw e;
      }
      // The window has reset since that finding — forget it and carry on.
      session.quota = null;
    }
    const ccBody = buildBody(session, token);
    //console.log(JSON.stringify(ccBody, null, 2))
    const headers = buildGenerateHeaders(token, session.sessionId, ccBody.threadId, credForToken?.name);
    // buildGenerateHeaders tucks {traceId, spanId} under a non-HTTP _trace key
    // so the caller can reuse them in the OTel span; strip it before sending.
    const trace = headers._trace;
    delete headers._trace;
    captured = {
      token,
      session,
      threadId: ccBody.threadId,
      model: ccBody.params.model,
      trace,
      toolCount: Array.isArray(ccBody.params.tools) ? ccBody.params.tools.length : 0,
    };
    return fetch(config.COMMANDCODE_BASE + config.COMMANDCODE_ENDPOINTS.generate, {
      method: 'POST',
      headers,
      body: JSON.stringify(ccBody),
      ...(signal ? { signal } : {}),
    });
  });

  // When rotation happened, name the credential that actually served this
  // request *and* the fingerprint identity it used. Without this the logs only
  // showed the credential that was rejected, which made it look like failed
  // credentials were still serving traffic.
  if (attempts > 1 && captured) {
    log.info(`[upstream] served by ${labelOf(cred)} (attempt ${attempts}) threadId=${captured.threadId} projectSlug=${captured.session?.projectSlug} thumbmark=${String(captured.session?.thumbmark || '').slice(0, 8)}...`);
  }

  return { upstreamRes, captured };
}

// Read all line-delimited JSON events from an upstream fetch Response.
// Generic SSE reader — works regardless of the client-facing API style.
export async function readAllEvents(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl).replace(/\r$/, '').trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith('{')) continue;
      try { events.push(JSON.parse(line)); } catch { }
    }
  }
  return events;
}

// Emit the OTel api span mirroring the credential that served the request.
// `captured` is what sendGenerate returned; `usage` carries the token counts
// + finish reasons extracted by the style-specific mapper/aggregator.
// Silent on success, warns only on failure (see telemetry.js).
export function emitTelemetry(captured, usage, startNs, endNs) {
  if (!captured?.token) return;
  const finishReasons = usage.finishReasons || [];
  emitApiSpan({
    session: captured.session,
    threadId: captured.threadId,
    model: captured.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    finishReasons,
    ttftMs: usage.ttftMs,
    toolCount: captured.toolCount,
    hadToolCalls: usage.hadToolCalls ?? finishReasons.some(r => r === 'tool_calls'),
    startNs,
    endNs,
    traceId: captured.trace?.traceId,
    chatSpanId: captured.trace?.spanId,
    user: captured.session?.user,
  }).catch(() => { });
}

export default { sendGenerate, readAllEvents, emitTelemetry };
