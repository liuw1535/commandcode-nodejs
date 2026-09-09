// OTel telemetry upload to axiom.co and ingestion.claicode.com.
// Mirrors the CLI's post-request span emission. Best-effort, never blocks.
import crypto from 'node:crypto';
import config from '../config.js';
import log from '../logger.js';

const randomHex = (b) => crypto.randomBytes(b).toString('hex');

function attr(key, value) {
  // Build an OTel attribute value object based on JS type.
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { key, value: { intValue: value } }
    : { key, value: { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map(v => {
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'number') return { intValue: v };
    return { stringValue: String(v) };
  }) } } };
  return { key, value: { stringValue: String(value) } };
}

// Emit a single gen_ai chat span + an enclosing agent.run span.
// All params optional; never throws.
export async function emitApiSpan({
  token, session, threadId, model, inputTokens, outputTokens,
  finishReasons, ttftMs, installId,
} = {}) {
  try {
    const traceId = randomHex(16);
    const parentSpanId = randomHex(8);
    const chatSpanId = randomHex(8);
    const agentSpanId = randomHex(8);
    const t0 = BigInt(Date.now()) * 1000000n;
    const t1 = t0 + 2000000n;
    const t2 = t0 + 3000000n;

    const resource = {
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

    const chatSpan = {
      traceId, spanId: chatSpanId, parentSpanId,
      name: `chat ${model || 'unknown'}`, kind: 1,
      startTimeUnixNano: String(t0), endTimeUnixNano: String(t1),
      attributes: [
        attr('gen_ai.operation.name', 'chat'),
        attr('gen_ai.request.model', model || ''),
        attr('gen_ai.response.model', model || ''),
        attr('gen_ai.conversation.id', session?.sessionId || ''),
        attr('cmd.install.id', installId || session?.installId || ''),
        attr('session.id', session?.sessionId || ''),
        ...(typeof inputTokens === 'number' ? [attr('gen_ai.usage.input_tokens', inputTokens)] : []),
        ...(typeof outputTokens === 'number' ? [attr('gen_ai.usage.output_tokens', outputTokens)] : []),
        ...(typeof ttftMs === 'number' ? [attr('gen_ai.response.ttft_ms', ttftMs)] : []),
        ...(Array.isArray(finishReasons) ? [attr('gen_ai.response.finish_reasons', finishReasons)] : []),
      ],
      droppedAttributesCount: 0, events: [], droppedEventsCount: 0,
      status: { code: 1 }, links: [], droppedLinksCount: 0, flags: 257,
    };
    const agentSpan = {
      traceId, spanId: agentSpanId,
      name: 'agent.run', kind: 1,
      startTimeUnixNano: String(t0), endTimeUnixNano: String(t2),
      attributes: [
        attr('gen_ai.conversation.id', threadId || ''),
        attr('cmd.install.id', installId || session?.installId || ''),
        attr('session.id', session?.sessionId || ''),
        ...(typeof inputTokens === 'number' ? [attr('gen_ai.usage.input_tokens', inputTokens)] : []),
        ...(typeof outputTokens === 'number' ? [attr('gen_ai.usage.output_tokens', outputTokens)] : []),
      ],
      droppedAttributesCount: 0, events: [], droppedEventsCount: 0,
      status: { code: 1 }, links: [], droppedLinksCount: 0, flags: 257,
    };

    const payload = {
      resourceSpans: [{
        resource,
        scopeSpans: [{ scope: { name: config.TELEMETRY.serviceName }, spans: [chatSpan, agentSpan] }],
      }],
    };

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

    await Promise.allSettled(targets.map(t => fetch(t.url, {
      method: 'POST', headers: t.headers, body,
    }).then(r => r.status).catch(() => null)));
  } catch (e) {
    // never let telemetry break the request
    log.warn(`[telemetry] emit error: ${e?.message || e}`);
  }
}

export default { emitApiSpan };
