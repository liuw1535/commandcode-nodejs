// OpenAI-compatible HTTP server. Routes, auth, body size limit, error handling.
import http from 'node:http';
import config from '../config.js';
import log from '../logger.js';
import { CredentialPool } from './credPool.js';
import { openaiToCommandCode, commandCodeEventsToOpenAI } from './converter.js';
import { buildGenerateHeaders, getSessionForToken } from './fingerprint.js';
import { emitApiSpan } from './telemetry.js';
import { pipeStream } from './streamMapper.js';
import { getModels } from './modelProvider.js';

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

      // Captured inside the rotation callback so telemetry can mirror the
      // credential that actually served the request.
      let usedToken = null, usedSession = null, usedThreadId = null, usedModel = null;

      let upstreamRes;
      try {
        upstreamRes = await credPool.requestWithRotation(async (token) => {
          const session = getSessionForToken(token);
          // Convert inside the rotation callback so workingDir/x-project-slug
          // always match the credential that actually serves this request.
          const ccBody = openaiToCommandCode(openaiReq, session);
          //console.log(JSON.stringify(ccBody, null, 2));
          const headers = buildGenerateHeaders(token, session.sessionId, ccBody.threadId);
          usedToken = token;
          usedSession = session;
          usedThreadId = ccBody.threadId;
          usedModel = ccBody.params.model;
          return fetch(config.COMMANDCODE_BASE + config.COMMANDCODE_ENDPOINTS.generate, {
            method: 'POST',
            headers,
            body: JSON.stringify(ccBody),
          });
        });
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
        if (usedToken && pipeResult) {
          emitApiSpan({
            token: usedToken,
            session: usedSession,
            threadId: usedThreadId,
            model: usedModel,
            inputTokens: pipeResult.inputTokens,
            outputTokens: pipeResult.outputTokens,
            finishReasons: pipeResult.finishReasons,
          }).catch(() => { });
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
          if (resp.usage) {
            nsInput = resp.usage.prompt_tokens;
            nsOutput = resp.usage.completion_tokens;
          }
          if (resp.choices?.[0]?.finish_reason) nsFinish = [resp.choices[0].finish_reason];
          const body = JSON.stringify(resp);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
          if (usedToken) {
            emitApiSpan({
              token: usedToken,
              session: usedSession,
              threadId: usedThreadId,
              model: usedModel,
              inputTokens: nsInput,
              outputTokens: nsOutput,
              finishReasons: nsFinish,
            }).catch(() => { });
          }
          return done(200);
        } catch (e) {
          log.error(`[nonstream] error: ${e?.message || e}`);
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

// Read all line-delimited JSON events from an upstream fetch Response.
async function readAllEvents(upstream) {
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
