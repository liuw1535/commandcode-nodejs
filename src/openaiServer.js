// OpenAI-compatible HTTP server. Routes, auth, body size limit, error handling.
import http from 'node:http';
import config from '../config.js';
import log from '../logger.js';
import { CredentialPool } from './credPool.js';
import { openaiToCommandCode, commandCodeEventsToOpenAI } from './converter.js';
import { pipeStream } from './streamMapper.js';
import { responsesToCommandCode, commandCodeEventsToResponses } from './responsesConverter.js';
import { pipeResponsesStream } from './responsesStreamMapper.js';
import { getModels } from './modelProvider.js';
import { sendGenerate, readAllEvents, emitTelemetry } from './upstream.js';

// OpenAI-shaped error JSON.
function openaiError(res, status, message, code, type) {
  const body = JSON.stringify({
    error: { message, type: type || 'invalid_request_error', code: code || null },
  });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const clen = Number(req.headers['content-length'] || 0);
    if (clen && clen > maxBytes) {
      const e = new Error('request body too large');
      e.code = 'PAYLOAD_TOO_LARGE';
      return reject(e);
    }
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const e = new Error('request body too large');
        e.code = 'PAYLOAD_TOO_LARGE';
        req.destroy();
        return reject(e);
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createServer(credPool) {
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const path = req.url.split('?')[0];
    const method = req.method;

    const done = (status) => log.request(method, path, status, Date.now() - t0);

    // CORS
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return done(204); }

    // Health (no auth)
    if (method === 'GET' && path === '/health') {
      const body = JSON.stringify({ ok: true, credentials: credPool.activeCount() + '/' + credPool.creds.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return done(200);
    }

    // Auth check for everything else (when AUTH_TOKEN configured).
    if (config.AUTH_TOKEN) {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== config.AUTH_TOKEN) {
        openaiError(res, 401, 'Invalid authentication credentials', 'invalid_api_key', 'invalid_request_error');
        return done(401);
      }
    }

    // Models list — served from the cached upstream /provider/v1/models
    // response (OpenAI-format model array, as-is).
    if (method === 'GET' && path === '/v1/models') {
      const body = JSON.stringify({ object: 'list', data: getModels() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return done(200);
    }

    // Credentials status (protected by auth above)
    if (method === 'GET' && path === '/v1/credentials/status') {
      const body = JSON.stringify({ credentials: credPool.status() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return done(200);
    }

    // Chat completions
    if (method === 'POST' && path === '/v1/chat/completions') {
      let raw;
      try {
        raw = await readBody(req, config.MAX_BODY_BYTES);
      } catch (e) {
        if (e?.code === 'PAYLOAD_TOO_LARGE') {
          openaiError(res, 413, 'Request body exceeds size limit', 'request_too_large', 'invalid_request_error');
          return done(413);
        }
        openaiError(res, 400, `Failed to read body: ${e.message}`);
        return done(400);
      }

      let openaiReq;
      try {
        openaiReq = JSON.parse(raw.toString('utf8'));
        //console.log(JSON.stringify(openaiReq, null, 2));
      } catch {
        openaiError(res, 400, 'Invalid JSON in request body');
        return done(400);
      }
      if (!openaiReq || !Array.isArray(openaiReq.messages)) {
        openaiError(res, 400, 'Missing or invalid "messages" field');
        return done(400);
      }

      const stream = openaiReq.stream === true;
      const includeUsage = !!(openaiReq.stream_options && openaiReq.stream_options.include_usage);
      const openaiModel = openaiReq.model || config.MODELS.defaultModel;
      const reqStartNs = BigInt(Date.now()) * 1000000n;

      // sendGenerate runs the OpenAI->commandcode conversion inside the
      // rotation callback so workingDir/x-project-slug always match the
      // credential that actually serves this request. Future API styles pass
      // their own buildBody here.
      let upstreamRes, captured;
      try {
        const result = await sendGenerate(credPool, (session) => openaiToCommandCode(openaiReq, session));
        upstreamRes = result.upstreamRes;
        captured = result.captured;
      } catch (e) {
        const status = e.statusCode || 502;
        openaiError(res, status, e.message || 'upstream error', null, 'invalid_request_error');
        return done(status);
      }

      // Upstream is text/event-stream regardless of client stream pref.
      if (!upstreamRes.ok && upstreamRes.status >= 400) {
        const text = await upstreamRes.text().catch(() => '');
        openaiError(res, upstreamRes.status, `upstream error: ${text || upstreamRes.statusText}`);
        return done(upstreamRes.status);
      }

      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        });
        let pipeResult = null;
        try {
          pipeResult = await pipeStream({
            res, upstream: upstreamRes, openaiModel, includeUsage,
          });
        } catch (e) {
          log.error(`[stream] pipe error: ${e?.message || e}`);
          try { res.write(`data: ${JSON.stringify({ error: { message: 'stream error: ' + (e?.message || e), type: 'server_error' } })}\n\n`); } catch { }
          try { res.write('data: [DONE]\n\n'); } catch { }
        }
        res.end();
        // Emit OTel telemetry span mirroring the served credential.
        // Silent on success, warns only on failure (see telemetry.js).
        if (captured && pipeResult) {
          emitTelemetry(captured, {
            inputTokens: pipeResult.inputTokens,
            outputTokens: pipeResult.outputTokens,
            cachedInputTokens: pipeResult.cachedInputTokens,
            finishReasons: pipeResult.finishReasons,
            ttftMs: pipeResult.ttftMs,
          }, reqStartNs, BigInt(Date.now()) * 1000000n);
        }
        return done(200);
      } else {
        // Aggregate upstream SSE into a single OpenAI completion object.
        try {
          const events = await readAllEvents(upstreamRes);
          const resp = commandCodeEventsToOpenAI(events, openaiModel);
          resp.model = openaiModel;
          // Extract usage for telemetry if present.
          let nsInput = null, nsOutput = null, nsFinish = [];
          let nsCached = null;
          if (resp.usage) {
            nsInput = resp.usage.prompt_tokens;
            nsOutput = resp.usage.completion_tokens;
            if (typeof resp.usage.cachedInputTokens === 'number') nsCached = resp.usage.cachedInputTokens;
          }
          if (resp.choices?.[0]?.finish_reason) nsFinish = [resp.choices[0].finish_reason];
          const body = JSON.stringify(resp);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
          emitTelemetry(captured, {
            inputTokens: nsInput,
            outputTokens: nsOutput,
            finishReasons: nsFinish,
            cachedInputTokens: nsCached,
          }, reqStartNs, BigInt(Date.now()) * 1000000n);
          return done(200);
        } catch (e) {
          log.error(`[nonstream] error: ${e?.message || e}`);
          openaiError(res, 502, `failed to read upstream: ${e?.message || e}`);
          return done(502);
        }
      }
    }

    // Responses API
    if (method === 'POST' && path === '/v1/responses') {
      let raw;
      try {
        raw = await readBody(req, config.MAX_BODY_BYTES);
      } catch (e) {
        if (e?.code === 'PAYLOAD_TOO_LARGE') {
          openaiError(res, 413, 'Request body exceeds size limit', 'request_too_large', 'invalid_request_error');
          return done(413);
        }
        openaiError(res, 400, `Failed to read body: ${e.message}`);
        return done(400);
      }

      let responsesReq;
      try {
        responsesReq = JSON.parse(raw.toString('utf8'));
      } catch {
        openaiError(res, 400, 'Invalid JSON in request body');
        return done(400);
      }
      // `input` is required (string or array); a missing model falls back to
      // the default at converter time, but input is mandatory.
      if (!responsesReq || (responsesReq.input == null)) {
        openaiError(res, 400, 'Missing or invalid "input" field');
        return done(400);
      }
      // We keep no response store, so `previous_response_id` cannot be
      // honored. Fail fast with a clear 400 instead of silently serving the
      // request with lost history (stateless clients resend full `input`).
      if (responsesReq.previous_response_id != null) {
        openaiError(res, 400,
          'previous_response_id is not supported: this proxy is stateless and stores no responses. Resend the full conversation in "input" (i.e. client-side store: false) instead.',
          'previous_response_id_not_supported', 'invalid_request_error');
        return done(400);
      }

      const stream = responsesReq.stream === true;
      const openaiModel = responsesReq.model || config.MODELS.defaultModel;
      const reqStartNs = BigInt(Date.now()) * 1000000n;

      let upstreamRes, captured;
      try {
        const result = await sendGenerate(credPool, (session) => responsesToCommandCode(responsesReq, session));
        upstreamRes = result.upstreamRes;
        captured = result.captured;
      } catch (e) {
        const status = e.statusCode || 502;
        openaiError(res, status, e.message || 'upstream error', null, 'invalid_request_error');
        return done(status);
      }

      if (!upstreamRes.ok && upstreamRes.status >= 400) {
        const text = await upstreamRes.text().catch(() => '');
        openaiError(res, upstreamRes.status, `upstream error: ${text || upstreamRes.statusText}`);
        return done(upstreamRes.status);
      }

      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        });
        let pipeResult = null;
        try {
          pipeResult = await pipeResponsesStream({
            res, upstream: upstreamRes, openaiModel, responsesReq,
          });
        } catch (e) {
          log.error(`[responses stream] pipe error: ${e?.message || e}`);
          try { res.write(`data: ${JSON.stringify({ type: 'error', message: 'stream error: ' + (e?.message || e) })}\n\n`); } catch { }
        }
        res.end();
        if (captured && pipeResult) {
          emitTelemetry(captured, {
            inputTokens: pipeResult.inputTokens,
            outputTokens: pipeResult.outputTokens,
            cachedInputTokens: pipeResult.cachedInputTokens,
            finishReasons: pipeResult.finishReasons,
            ttftMs: pipeResult.ttftMs,
          }, reqStartNs, BigInt(Date.now()) * 1000000n);
        }
        return done(200);
      } else {
        try {
          const events = await readAllEvents(upstreamRes);
          const resp = commandCodeEventsToResponses(events, openaiModel, responsesReq);
          resp.model = openaiModel;
          let nsInput = null, nsOutput = null, nsFinish = [];
          let nsCached = null;
          if (resp.usage) {
            nsInput = resp.usage.input_tokens;
            nsOutput = resp.usage.output_tokens;
            if (resp.usage.input_tokens_details?.cached_tokens != null) nsCached = resp.usage.input_tokens_details.cached_tokens;
          }
          if (resp.status) nsFinish = [resp.status === 'incomplete' ? 'length' : 'stop'];
          const body = JSON.stringify(resp);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
          emitTelemetry(captured, {
            inputTokens: nsInput,
            outputTokens: nsOutput,
            finishReasons: nsFinish,
            cachedInputTokens: nsCached,
          }, reqStartNs, BigInt(Date.now()) * 1000000n);
          return done(200);
        } catch (e) {
          log.error(`[responses nonstream] error: ${e?.message || e}`);
          openaiError(res, 502, `failed to read upstream: ${e?.message || e}`);
          return done(502);
        }
      }
    }

    // 404
    openaiError(res, 404, `Unknown route: ${method} ${path}`, 'not_found', 'invalid_request_error');
    return done(404);
  });
  return server;
}
