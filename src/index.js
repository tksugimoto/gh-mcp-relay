// GitHub MCP 用の薄い中継。
// - 認可（OAuth）は Claude のコネクタと GitHub に任せ、token は確かめずにそのまま転送する。保存もしない。
// - 確かめるのは、ツール呼び出しの gh_mcp_relay_key と、その key が許す repo だけ。
// - パスはそのまま公式 GitHub MCP（api.githubcopilot.com）に渡す。中継は設定ファイルを持たない。

import { checkCall, deniedMethod, hasMethod, injectKeyParam, matchRoute, oauthScope, resourceMetadata, stripKey, verifyKey } from './lib.js';

const FORWARD_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);
    if (!route) return text(404, 'not found');
    if (!env.KEY_SECRET) {
      console.error('KEY_SECRET is not set');
      return text(500, 'misconfigured');
    }

    if (route.kind === 'metadata') return json(200, resourceMetadata(url.origin, route.path));

    // token の中身は確かめない。無いときだけ、Claude に OAuth を始めさせるために 401 を返す。
    if (!/^Bearer\s+\S+$/i.test(request.headers.get('authorization') ?? '')) {
      return unauthorized(url.origin, route.path);
    }

    let body;
    let isToolsList = false;
    if (request.method === 'POST') {
      let message;
      try {
        message = JSON.parse(await request.text());
      } catch {
        return json(400, rpcError(null, -32700, 'parse error'));
      }
      const denied = deniedMethod(message);
      if (denied) {
        log(route.path, denied.method, 'denied');
        return json(200, rpcError(denied.id ?? null, -32601, `${denied.method} は使えません`));
      }
      const { message: stripped, calls } = stripKey(message);
      for (const call of calls) {
        const key = await verifyKey(env.KEY_SECRET, call.key, Date.now());
        const reason = key ? checkCall(call, key.repos, route.path) : 'gh_mcp_relay_key が無いか、正しくありません';
        if (reason) {
          log(route.path, call.tool, 'denied');
          return json(200, rpcError(call.id, -32001, reason));
        }
      }
      for (const call of calls) log(route.path, call.tool, 'forward');
      isToolsList = hasMethod(message, 'tools/list');
      body = JSON.stringify(stripped);
    }

    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(route.upstream, { method: request.method, headers, body });

    if (!upstream.ok) {
      // 上流が断った理由を後から追えるように残す。本文は上流が返すエラーの文なので、使い切る前に複製して読む。
      logUpstreamError(route.path, upstream.status, upstream.headers.get('www-authenticate'), await upstream.clone().text());
    }
    if (upstream.status === 401) return unauthorized(url.origin, route.path);

    const responseHeaders = new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    if (isToolsList && upstream.ok) {
      const patched = injectKeyParam(await upstream.text(), upstream.headers.get('content-type'), route.path);
      return new Response(patched, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};

function unauthorized(origin, path) {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource${path}`;
  const scope = oauthScope(path);
  return new Response('unauthorized', {
    status: 401,
    headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"${scope ? `, scope="${scope}"` : ''}` },
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function text(status, value) {
  return new Response(value, { status });
}

// token・ヘッダー・key は残さない。
function log(path, tool, result) {
  console.log(JSON.stringify({ path, tool, result }));
}

// 上流のエラーの応答。WWW-Authenticate（足りない scope など。token は含まない）と、本文の先頭だけを残す。
const UPSTREAM_ERROR_BODY_MAX = 500;
function logUpstreamError(path, status, wwwAuthenticate, body) {
  console.log(JSON.stringify({ path, upstreamStatus: status, wwwAuthenticate, body: body.slice(0, UPSTREAM_ERROR_BODY_MAX) }));
}
