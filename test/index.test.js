import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';

import worker from '../src/index.js';
import { KEY_ARG, createKey } from '../src/lib.js';

const SECRET = 'test-secret';
const UPSTREAM = 'https://api.githubcopilot.com/mcp';
const ENDPOINT = 'https://relay.example.com/mcp';
const env = { KEY_SECRET: SECRET };
let KEY;
before(async () => {
  KEY = await createKey(SECRET, { repos: ['tksugimoto/pocket-ssh-agent'] });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// 転送先を差し替える。転送されたリクエストは forwarded に残す。
function stubFetch({ upstream } = {}) {
  const forwarded = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url !== UPSTREAM) throw new Error(`unexpected fetch ${url}`);
    forwarded.push({ method: init.method, headers: init.headers, body: init.body });
    return upstream ? upstream(init) : Response.json({ jsonrpc: '2.0', id: 1, result: {} });
  };
  return forwarded;
}

const call = (body) =>
  new Request(ENDPOINT, {
    method: 'POST',
    headers: { authorization: 'Bearer gho_test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const toolCall = (args) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'issue_write', arguments: args } });
const repoArgs = { method: 'create', owner: 'tksugimoto', repo: 'pocket-ssh-agent' };

test('メタデータは token なしで返す', async () => {
  stubFetch();
  const res = await worker.fetch(
    new Request('https://relay.example.com/.well-known/oauth-protected-resource/mcp'),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resource, ENDPOINT);
  assert.deepEqual(body.authorization_servers, ['https://github.com/login/oauth']);
});

test('token なしは 401 とメタデータの場所', async () => {
  stubFetch();
  const res = await worker.fetch(new Request(ENDPOINT, { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://relay.example.com/.well-known/oauth-protected-resource/mcp"',
  );
});

test('readonly のパスの 401 は scope も伝える', async () => {
  stubFetch();
  const res = await worker.fetch(new Request('https://relay.example.com/mcp/readonly', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /, scope="repo"$/);
});

test('issues のパスの 401 も scope を伝える', async () => {
  stubFetch();
  const res = await worker.fetch(new Request('https://relay.example.com/mcp/x/issues', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /, scope="repo"$/);
});

test('pull_requests のパスの 401 も scope を伝える', async () => {
  stubFetch();
  const res = await worker.fetch(new Request('https://relay.example.com/mcp/x/pull_requests', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /, scope="repo"$/);
});

test('pull_requests のパスでは merge_pull_request を転送しない', async () => {
  const forwarded = stubFetch();
  const message = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'merge_pull_request', arguments: { [KEY_ARG]: KEY, owner: repoArgs.owner, repo: repoArgs.repo, pullNumber: 1 } },
  };
  const res = await worker.fetch(
    new Request('https://relay.example.com/mcp/x/pull_requests', {
      method: 'POST',
      headers: { authorization: 'Bearer gho_test', 'content-type': 'application/json' },
      body: JSON.stringify(message),
    }),
    env,
  );
  assert.match((await res.json()).error.message, /merge_pull_request は中継で使えません/);
  assert.equal(forwarded.length, 0);
});

test('上流のエラーは、理由をログに残してそのまま返す', async () => {
  stubFetch({
    upstream: () =>
      new Response('insufficient scopes', {
        status: 403,
        headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="repo"' },
      }),
  });
  const logged = [];
  const realLog = console.log;
  console.log = (line) => logged.push(JSON.parse(line));
  try {
    const res = await worker.fetch(call(toolCall({ [KEY_ARG]: KEY, ...repoArgs })), env);
    assert.equal(res.status, 403);
    assert.equal(await res.text(), 'insufficient scopes');
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(logged.at(-1), {
    path: '/mcp',
    upstreamStatus: 403,
    wwwAuthenticate: 'Bearer error="insufficient_scope", scope="repo"',
    body: 'insufficient scopes',
  });
  assert.ok(!JSON.stringify(logged).includes('gho_test'), 'token は残さない');
});

test('/mcp 以外のパスは 404', async () => {
  stubFetch();
  const res = await worker.fetch(new Request('https://relay.example.com/user', { method: 'POST' }), env);
  assert.equal(res.status, 404);
});

test('KEY_SECRET が無ければ 500', async () => {
  stubFetch();
  const res = await worker.fetch(call(toolCall({ [KEY_ARG]: KEY, ...repoArgs })), {});
  assert.equal(res.status, 500);
});

test('key が違う tools/call は転送しない', async () => {
  const forwarded = stubFetch();
  const wrong = await createKey('other-secret', { repos: ['tksugimoto/pocket-ssh-agent'] });
  const res = await worker.fetch(call(toolCall({ [KEY_ARG]: wrong, ...repoArgs })), env);
  assert.equal((await res.json()).error.code, -32001);
  assert.equal(forwarded.length, 0);
});

test('key が許していない repo は転送しない', async () => {
  const forwarded = stubFetch();
  const res = await worker.fetch(call(toolCall({ [KEY_ARG]: KEY, method: 'create', owner: 'tksugimoto', repo: 'other' })), env);
  assert.match((await res.json()).error.message, /tksugimoto\/other/);
  assert.equal(forwarded.length, 0);
});

test('resources/read などは key があっても転送しない', async () => {
  const forwarded = stubFetch();
  const read = { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'repo://other/private/contents/README.md' } };
  const res = await worker.fetch(call([read]), env);
  const body = await res.json();
  assert.equal(body.id, 3);
  assert.equal(body.error.code, -32601);
  assert.equal(forwarded.length, 0);
});

test('正しい key と repo なら key を消して転送する', async () => {
  const forwarded = stubFetch();
  const res = await worker.fetch(call(toolCall({ [KEY_ARG]: KEY, ...repoArgs, title: 'x' })), env);
  assert.equal(res.status, 200);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(JSON.parse(forwarded[0].body).params.arguments, { ...repoArgs, title: 'x' });
  assert.equal(forwarded[0].headers.get('authorization'), 'Bearer gho_test');
});

test('tools/list の結果に gh_mcp_relay_key を足す', async () => {
  stubFetch({
    upstream: () => Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_me', inputSchema: { type: 'object' } }] } }),
  });
  const res = await worker.fetch(call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), env);
  const tool = (await res.json()).result.tools[0];
  assert.deepEqual(tool.inputSchema.required, [KEY_ARG]);
});
