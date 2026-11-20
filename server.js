'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const domain = require('./src/domain');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = 3000;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_ID: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  BAD_JSON: 400,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, {
    ok: false,
    error: { code, message, details: details || null },
  });
}

function statusForError(error) {
  return ERROR_STATUS[error && error.code] || 400;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求体过大');
        error.code = 'PAYLOAD_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const error = new Error('请求体必须是 JSON 对象');
          error.code = 'BAD_JSON';
          reject(error);
          return;
        }
        resolve(parsed);
      } catch {
        const error = new Error('请求体不是有效 JSON');
        error.code = 'BAD_JSON';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendDomainResult(
  res,
  result,
  { includeBoard = true, state, created = false } = {},
) {
  if (!result.ok) {
    const status = statusForError(result.error);
    return sendJson(res, status, {
      ok: false,
      error: result.error,
      evidence: result.evidence,
    });
  }
  const payload = { ok: true, ...result };
  if (includeBoard) payload.board = domain.getBoard(state);
  return sendJson(res, created && !result.deduped ? 201 : 200, payload);
}

function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  const decode = decodeURIComponent(relative);
  if (decode.includes('\u0000')) {
    return sendError(res, 400, 'VALIDATION_ERROR', '非法路径');
  }
  const resolved = path.resolve(PUBLIC_DIR, `.${decode}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    return sendError(res, 403, 'FORBIDDEN', '禁止访问该路径');
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!MIME_TYPES[ext]) {
    return sendError(res, 404, 'NOT_FOUND', '资源不存在');
  }
  fs.readFile(resolved, (error, content) => {
    if (error) {
      return sendError(res, 404, 'NOT_FOUND', '资源不存在');
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext],
      'content-length': content.length,
      'cache-control': 'no-store',
    });
    res.end(content);
  });
}

function createApp({ state = domain.createDemoState(), seed = domain.createDemoState } = {}) {
  const appState = state;

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}`);
    } catch {
      return sendError(res, 400, 'VALIDATION_ERROR', '非法 URL');
    }
    const pathname = url.pathname;

    try {
      if (pathname === '/api/board') {
        if (req.method !== 'GET') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET');
        }
        return sendJson(res, 200, { ok: true, board: domain.getBoard(appState) });
      }

      if (pathname === '/api/reconciliation') {
        if (req.method !== 'GET') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET');
        }
        const factory = url.searchParams.get('factory') || null;
        const before = domain.countState(appState);
        const reconciliation = domain.reconciliationFor(appState, { factory });
        const after = domain.countState(appState);
        return sendJson(res, 200, {
          ok: true,
          reconciliation,
          evidence: {
            action: 'VIEW_RECONCILIATION',
            ok: true,
            summary: factory
              ? `已按工厂「${factory}」查看抽样对单，共 ${reconciliation.totals.samples} 个样本、${reconciliation.totals.matchedSamples} 份已对单`
              : `已查看抽样对单，共 ${reconciliation.totals.samples} 个样本、${reconciliation.totals.matchedSamples} 份已对单`,
            deduped: false,
            changes: [],
            before,
            after,
            entities: { reconciliation },
            at: new Date().toISOString(),
          },
        });
      }

      if (pathname === '/api/reset') {
        if (req.method !== 'POST') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
        }
        const fresh = seed();
        appState.registrations = fresh.registrations;
        appState.reports = fresh.reports;
        appState.events = fresh.events;
        appState.counters.registration = fresh.counters.registration;
        appState.counters.report = fresh.counters.report;
        appState.counters.event = fresh.counters.event;
        appState.seededAt = fresh.seededAt;
        const board = domain.getBoard(appState);
        return sendJson(res, 200, {
          ok: true,
          board,
          evidence: {
            action: 'RESET_DEMO',
            ok: true,
            summary: '已恢复本地演示数据',
            deduped: false,
            changes: [],
            before: board.counts,
            after: board.counts,
            entities: {},
            at: new Date().toISOString(),
          },
        });
      }

      if (pathname === '/api/reports' || pathname === '/api/registrations') {
        if (req.method !== 'POST') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
        }
        const body = await readJsonBody(req);
        const result =
          pathname === '/api/reports'
            ? domain.receiveLabReport(appState, body)
            : domain.registerSample(appState, body);
        return sendDomainResult(res, result, { state: appState, created: true });
      }

      const actionMatch = pathname.match(
        /^\/api\/(reports|registrations)\/([^/]+)\/(backfill|return|revoke|restore)$/,
      );
      if (actionMatch) {
        if (req.method !== 'POST') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
        }
        const [, resource, rawId, action] = actionMatch;
        const id = decodeURIComponent(rawId);
        const body = await readJsonBody(req);
        let result;
        if (resource === 'reports' && action === 'backfill') {
          result = domain.requestBackfill(appState, id, body);
        } else if (resource === 'reports' && action === 'return') {
          result = domain.returnReport(appState, id, body);
        } else if (resource === 'registrations' && action === 'revoke') {
          result = domain.revokeRegistration(appState, id, body);
        } else if (resource === 'registrations' && action === 'restore') {
          result = domain.restoreRegistration(appState, id);
        } else {
          return sendError(res, 404, 'NOT_FOUND', '接口不存在');
        }
        return sendDomainResult(res, result, { state: appState, created: true });
      }

      if (pathname.startsWith('/api/')) {
        return sendError(res, 404, 'NOT_FOUND', '接口不存在');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', '页面仅支持 GET');
      }
      return serveStatic(req, res, pathname);
    } catch (error) {
      if (error && error.code && ERROR_STATUS[error.code]) {
        return sendError(res, statusForError(error), error.code, error.message);
      }
      console.error('[server] 未处理错误:', error);
      return sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
    }
  };
}

function createServer(options = {}) {
  const handler = createApp(options);
  return http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      console.error('[server] 请求处理失败:', error);
      if (!res.headersSent) {
        sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
      } else {
        res.end();
      }
    });
  });
}

function resolvePort(env = process.env) {
  const raw = env.PORT === undefined || env.PORT === '' ? String(DEFAULT_PORT) : env.PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT 必须是 0-65535 之间的整数，收到：${raw}`);
  }
  return port;
}

function startServer({ port = resolvePort(), host = HOST } = {}) {
  const server = createServer();
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`实验室回执对单服务已启动：http://${host}:${address.port}`);
    console.log('按 Ctrl+C 停止。');
  });
  server.on('error', (error) => {
    console.error(`服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  createServer,
  createApp,
  startServer,
  resolvePort,
  HOST,
  DEFAULT_PORT,
};
