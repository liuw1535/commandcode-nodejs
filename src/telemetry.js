// OTel telemetry upload to axiom.co and ingestion.claicode.com.
// Mirrors the CLI's span emission:
//   - warmup: a session:cli + command:interactive span, then one api:METHOD:url
//     span per commandcode HTTP call.
//   - per generate: a single trace containing context:iteration (root),
//     chat <model> (child of iteration), and agent.run (child of iteration).
// Best-effort, never blocks.
import crypto from 'node:crypto';
import config from '../config.js';
import log from '../logger.js';

const randomHex = (b) => crypto.randomBytes(b).toString('hex');

function attr(key, value) {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { key, value: { intValue: value } }
    : { key, value: { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map(v => {
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'number') return { intValue: v };
    if (typeof v === 'boolean') return { boolValue: v };
    return { stringValue: String(v) };
  }) } } };
  return { key, value: { stringValue: String(value) } };
}

function nowNs() {
  return BigInt(Date.now()) * 1000000n;
}

// Derive the model "author" attribute the way the CLI does, e.g.
// "zai-org/GLM-5.2" -> "zai", "anthropic/claude-..." -> "anthropic".
function modelAuthor(model) {
  if (!model) return '';
  const prefix = model.includes('/') ? model.split('/')[0] : '';
  return prefix.replace(/-(org|ai|labs)$/, '');
}

function resource(session) {
  return {
    attributes: [
      attr('service.name', config.TELEMETRY.serviceName),
      attr('service.version', config.CLI_VERSION),
      attr('process.executable.name', config.TELEMETRY.processExecutableName),
      attr('process.runtime.name', 'node'),
      attr('process.runtime.version', session?.nodeVersion || process.version),
      attr('process.pid', session?.pid || process.pid),
    ],
    droppedAttributesCount: 0,
  };
}

function buildSpan({ traceId, spanId, parentSpanId, name, kind = 1, startNs, endNs, attributes, status = 1, flags = 257 }) {
  const o = {
    traceId, spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name, kind,
    startTimeUnixNano: String(startNs),
    endTimeUnixNano: String(endNs),
    attributes,
    droppedAttributesCount: 0, events: [], droppedEventsCount: 0,
    status: { code: status }, links: [], droppedLinksCount: 0, flags,
  };
  return o;
}

function userAttrs(user) {
  const out = [];
  if (user?.id) out.push(attr('user.id', user.id));
  const uname = user?.userName || user?.name;
  if (uname) out.push(attr('user.name', uname));
  return out;
}

// POST one OTel payload to both axiom and claicode (same body, mirrors CLI).
function postTelemetry(payload) {
  const body = JSON.stringify(payload);
  const targets = [
    { url: config.TELEMETRY.axiom.url, headers: {
      'Authorization': `Bearer ${config.TELEMETRY.axiom.token}`,
      'X-Axiom-Dataset': config.TELEMETRY.axiom.dataset,
      'Content-Type': 'application/json',
      'User-Agent': config.TELEMETRY.otelUserAgent,
    } },
    { url: config.TELEMETRY.claicode.url, headers: {
      'Authorization': `Bearer ${config.TELEMETRY.claicode.token}`,
      'Content-Type': 'application/json',
      'User-Agent': config.TELEMETRY.otelUserAgent,
    } },
  ];
  return Promise.allSettled(targets.map(t => fetch(t.url, {
    method: 'POST', headers: t.headers, body,
  }).then(r => r.status).catch(() => null)));
}

// Emit the startup session:cli + command:interactive spans (one POST).
// Mirrors the CLI's first telemetry burst at session start.
export async function emitStartupSpans({ session, projectSlug }) {
  try {
    const t = nowNs();
    const sessionId = session?.sessionId || '';
    const installId = session?.installId || '';
    const projHash = projectSlug
      ? crypto.createHash('sha256').update(projectSlug).digest('hex').slice(0, 12)
      : '';

    const sessionSpan = buildSpan({
      traceId: randomHex(16), spanId: randomHex(8),
      name: 'session:cli', kind: 1, startNs: t, endNs: t, status: 0,
      attributes: [
        attr('session.id', sessionId),
        attr('session.start_time', new Date().toISOString()),
        attr('cmd.session.project_hash', projHash),
        attr('cmd.session.branch_hash', 'unknown'),
        attr('session.cli_version', config.CLI_VERSION),
        attr('session.platform', config.FINGERPRINT.os),
        attr('session.node_version', session?.nodeVersion || process.version),
        attr('cmd.install.id', installId),
      ],
    });
    const cmdSpan = buildSpan({
      traceId: randomHex(16), spanId: randomHex(8),
      name: 'command:interactive', kind: 1, startNs: t, endNs: t, status: 1,
      attributes: [
        attr('cmd.command.name', 'interactive'),
        attr('cmd.command.args', ''),
        attr('cmd.install.id', installId),
        attr('session.id', sessionId),
      ],
    });

    const payload = {
      resourceSpans: [{
        resource: resource(session),
        scopeSpans: [{
          scope: { name: config.TELEMETRY.serviceName },
          spans: [sessionSpan, cmdSpan],
        }],
      }],
    };
    await postTelemetry(payload);
  } catch (e) {
    log.warn(`[telemetry] startup emit error: ${e?.message || e}`);
  }
}

// Emit one api:METHOD:url span per commandcode HTTP call made during warmup
// (one batched POST). Each span is its own root trace, matching the CLI.
export async function emitWarmupApiSpans({ session, user, apiCalls }) {
  try {
    const installId = session?.installId || '';
    const sessionId = session?.sessionId || '';
    const spans = (apiCalls || [])
      .filter(c => c && c.method && c.url)
      .map(c => buildSpan({
        traceId: randomHex(16), spanId: randomHex(8),
        name: `api:${c.method}:${c.url}`, kind: 1,
        startNs: c.startNs, endNs: c.endNs, status: 1,
        attributes: [
          attr('http.method', c.method),
          attr('http.url', c.url),
          attr('cli.version', config.CLI_VERSION),
          attr('cmd.install.id', installId),
          attr('session.id', sessionId),
          ...(typeof c.status === 'number' ? [attr('http.status_code', c.status)] : []),
          ...userAttrs(user),
        ],
      }));
    if (!spans.length) return;
    const payload = {
      resourceSpans: [{
        resource: resource(session),
        scopeSpans: [{ scope: { name: config.TELEMETRY.serviceName }, spans }],
      }],
    };
    await postTelemetry(payload);
  } catch (e) {
    log.warn(`[telemetry] warmup api emit error: ${e?.message || e}`);
  }
}

// Emit a per-generate trace: context:iteration (root) + chat <model> (child) +
// agent.run (child). traceId + chatSpanId are shared with the request's
// `traceparent` header so the two stay consistent (the CLI does the same).
export async function emitApiSpan({
  session, threadId, model, inputTokens, outputTokens,
  cachedInputTokens, cacheCreationInputTokens,
  finishReasons, ttftMs, toolCount, turnCount = 1, stopReason,
  hadToolCalls, iterationNumber = 1, stepName = 'iteration_1', iterationOutcome = 'completed',
  startNs, endNs, traceId, chatSpanId, user,
} = {}) {
  try {
    if (!traceId) traceId = randomHex(16);
    if (!chatSpanId) chatSpanId = randomHex(8);
    const iterSpanId = randomHex(8);
    const agentSpanId = randomHex(8);
    const t0 = startNs || nowNs();
    const t1 = endNs || t0;
    const sessionId = session?.sessionId || '';
    const installId = session?.installId || '';
    const convId = threadId || sessionId;
    const uAttrs = userAttrs(user);
    // Derive the CLI's cmd.stopReason from the finish reason when not supplied:
    // stop -> end_turn, tool_calls -> tool_use.
    const fr = Array.isArray(finishReasons) ? finishReasons[0] : '';
    const derivedStopReason = stopReason || (fr === 'tool_calls' ? 'tool_use' : fr === 'stop' ? 'end_turn' : '');

    const chatSpan = buildSpan({
      traceId, spanId: chatSpanId, parentSpanId: iterSpanId,
      name: `chat ${model || 'unknown'}`, kind: 1, startNs: t0, endNs: t1, status: 1,
      attributes: [
        attr('gen_ai.operation.name', 'chat'),
        attr('gen_ai.request.model', model || ''),
        attr('gen_ai.response.model', model || ''),
        attr('gen_ai.conversation.id', sessionId),
        attr('cmd.model.author', modelAuthor(model)),
        ...(typeof toolCount === 'number' ? [attr('cmd.tool_count', toolCount)] : []),
        ...uAttrs,
        attr('cmd.install.id', installId),
        attr('session.id', sessionId),
        ...(typeof ttftMs === 'number' ? [attr('gen_ai.response.ttft_ms', ttftMs)] : []),
        ...(typeof inputTokens === 'number' ? [attr('gen_ai.usage.input_tokens', inputTokens)] : []),
        ...(typeof outputTokens === 'number' ? [attr('gen_ai.usage.output_tokens', outputTokens)] : []),
        ...(Array.isArray(finishReasons) && finishReasons.length ? [attr('gen_ai.response.finish_reasons', finishReasons)] : []),
      ],
    });

    const iterSpan = buildSpan({
      traceId, spanId: iterSpanId,
      name: 'context:iteration', kind: 1, startNs: t0, endNs: t1, status: 1,
      attributes: [
        attr('cmd.iteration.number', iterationNumber),
        attr('gen_ai.request.model', model || ''),
        attr('cmd.step.name', stepName),
        attr('session.id', sessionId),
        attr('gen_ai.conversation.id', sessionId),
        ...uAttrs,
        attr('cmd.install.id', installId),
        ...(typeof hadToolCalls === 'boolean' ? [attr('cmd.turn.had_tool_calls', hadToolCalls)] : []),
        ...(typeof inputTokens === 'number' ? [attr('gen_ai.usage.input_tokens', inputTokens)] : []),
        ...(typeof outputTokens === 'number' ? [attr('gen_ai.usage.output_tokens', outputTokens)] : []),
        ...(typeof cachedInputTokens === 'number' ? [attr('gen_ai.usage.cached_input_tokens', cachedInputTokens)] : [attr('gen_ai.usage.cached_input_tokens', 0)]),
        ...(typeof cacheCreationInputTokens === 'number' ? [attr('gen_ai.usage.cache_creation_input_tokens', cacheCreationInputTokens)] : [attr('gen_ai.usage.cache_creation_input_tokens', 0)]),
        attr('cmd.iteration.outcome', iterationOutcome),
      ],
    });

    const agentSpan = buildSpan({
      traceId, spanId: agentSpanId, parentSpanId: iterSpanId,
      name: 'agent.run', kind: 1, startNs: t0, endNs: t1, status: 1,
      attributes: [
        attr('gen_ai.conversation.id', convId),
        ...(derivedStopReason ? [attr('cmd.stopReason', derivedStopReason)] : []),
        attr('cmd.turnCount', turnCount),
        ...(typeof inputTokens === 'number' ? [attr('gen_ai.usage.input_tokens', inputTokens)] : []),
        ...(typeof outputTokens === 'number' ? [attr('gen_ai.usage.output_tokens', outputTokens)] : []),
        ...(typeof cachedInputTokens === 'number' ? [attr('gen_ai.usage.cached_input_tokens', cachedInputTokens)] : [attr('gen_ai.usage.cached_input_tokens', 0)]),
        ...(typeof cacheCreationInputTokens === 'number' ? [attr('gen_ai.usage.cache_creation_input_tokens', cacheCreationInputTokens)] : [attr('gen_ai.usage.cache_creation_input_tokens', 0)]),
        ...uAttrs,
        attr('cmd.install.id', installId),
        attr('session.id', sessionId),
      ],
    });

    // Span order in the payload mirrors the captured CLI: chat, iteration, agent.run.
    const payload = {
      resourceSpans: [{
        resource: resource(session),
        scopeSpans: [{ scope: { name: config.TELEMETRY.serviceName }, spans: [chatSpan, iterSpan, agentSpan] }],
      }],
    };
    await postTelemetry(payload);
  } catch (e) {
    log.warn(`[telemetry] emit error: ${e?.message || e}`);
  }
}

export default { emitApiSpan, emitStartupSpans, emitWarmupApiSpans };
