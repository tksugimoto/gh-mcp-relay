import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KEY_ARG,
  checkCall,
  createKey,
  deniedMethod,
  injectKeyParam,
  isAllowedTool,
  matchRoute,
  oauthScope,
  reposInArgs,
  resourceMetadata,
  stripKey,
  TOOL_METHODS,
  verifyKey,
} from '../src/lib.js';

const SECRET = 'test-secret';
const NOW = Date.parse('2026-10-18T00:00:00Z');

test('matchRoute: パスをそのまま公式 GitHub MCP に渡す', () => {
  assert.deepEqual(matchRoute('/mcp'), {
    kind: 'endpoint',
    path: '/mcp',
    upstream: 'https://api.githubcopilot.com/mcp',
  });
  assert.equal(matchRoute('/mcp/').upstream, 'https://api.githubcopilot.com/mcp/');
  assert.equal(matchRoute('/mcp/readonly').upstream, 'https://api.githubcopilot.com/mcp/readonly');
  assert.deepEqual(matchRoute('/.well-known/oauth-protected-resource/mcp/readonly'), {
    kind: 'metadata',
    path: '/mcp/readonly',
    upstream: 'https://api.githubcopilot.com/mcp/readonly',
  });
  // ツールセットを 1 つ選ぶパスと、その読み取り専用版。
  for (const path of ['/mcp/x/actions', '/mcp/x/actions/readonly/', '/mcp/x/all', '/mcp/x/all/readonly', '/mcp/x/pull_requests']) {
    assert.equal(matchRoute(path)?.upstream, `https://api.githubcopilot.com${path}`, path);
  }
  assert.equal(matchRoute('/.well-known/oauth-protected-resource/mcp/x/actions/readonly').path, '/mcp/x/actions/readonly');
});

test('matchRoute: 決めた形以外や怪しいパスは拒否する', () => {
  // ツールセット名に見える readonly・insiders も通さない。insiders は試験中のツールが出る。カンマ区切りは上流が受け付けない。
  assert.equal(matchRoute('/mcp/x/readonly'), null);
  assert.equal(matchRoute('/mcp/x/readonly/readonly'), null);
  assert.equal(matchRoute('/mcp/x/insiders'), null);
  assert.equal(matchRoute('/mcp/x/insiders/readonly'), null);
  assert.equal(matchRoute('/mcp/x/readonly_x')?.path, '/mcp/x/readonly_x', '名前全体が一致するときだけ断る');
  assert.equal(matchRoute('/mcp/insiders'), null);
  assert.equal(matchRoute('/mcp/x/all/insiders'), null);
  assert.equal(matchRoute('/mcp/x/all/readonly/insiders'), null);
  assert.equal(matchRoute('/mcp/x/issues,pull_requests'), null);
  assert.equal(matchRoute('/mcp/x/'), null);
  assert.equal(matchRoute('/mcp/x/a/b'), null);
  assert.equal(matchRoute('/mcp/readonly/x/all'), null);
  assert.equal(matchRoute('/'), null);
  assert.equal(matchRoute('/user'), null);
  assert.equal(matchRoute('/mcpx'), null);
  assert.equal(matchRoute('/mcp/../user'), null);
  assert.equal(matchRoute('/mcp/x?y'), null);
  assert.equal(matchRoute('/.well-known/oauth-protected-resource/user'), null);
});

test('resourceMetadata: GitHub を認可サーバーとして返す', () => {
  assert.deepEqual(resourceMetadata('https://relay.example.com', '/mcp/'), {
    resource: 'https://relay.example.com/mcp/',
    authorization_servers: ['https://github.com/login/oauth'],
    bearer_methods_supported: ['header'],
  });
  // OAuth App のコネクタを登録する readonly のパスでは、private の repo を読むための scope を返す。
  assert.deepEqual(resourceMetadata('https://relay.example.com', '/mcp/readonly').scopes_supported, ['repo']);
  assert.deepEqual(resourceMetadata('https://relay.example.com', '/mcp/x/actions/readonly/').scopes_supported, ['repo']);
  assert.equal(resourceMetadata('https://relay.example.com', '/mcp/x/actions').scopes_supported, undefined);
  // Issue とコメントだけを書く OAuth App のコネクタのパスでも返す。
  assert.equal(oauthScope('/mcp/x/issues'), 'repo');
  assert.equal(oauthScope('/mcp/x/issues/'), 'repo');
  // PR を出す OAuth App のコネクタのパスでも返す。
  assert.equal(oauthScope('/mcp/x/pull_requests'), 'repo');
  assert.equal(oauthScope('/mcp/x/pull_requests/'), 'repo');
  // repo の scope を求めるのは、パスの末尾が /readonly のときと、issues・pull_requests のパスだけ。
  assert.equal(oauthScope('/mcp/readonly/x'), null);
  assert.equal(oauthScope('/mcp/x/issues_x'), null);
  assert.equal(oauthScope('/mcp/x/pull_requests_x'), null);
  assert.equal(oauthScope('/mcp/x/repos'), null);
  assert.equal(oauthScope('/mcp/x/all'), null);
  assert.equal(oauthScope('/mcp'), null);
});

test('createKey / verifyKey: 読める形で、署名を確かめる', async () => {
  const key = await createKey(SECRET, { repos: ['tksugimoto/pocket-ssh-agent', 'tksugimoto/Sub'] });
  assert.match(key, /^gh-mcp-relay:tksugimoto\/pocket-ssh-agent,tksugimoto\/sub:[A-Za-z0-9_-]+$/);
  assert.deepEqual((await verifyKey(SECRET, key, NOW)).repos, ['tksugimoto/pocket-ssh-agent', 'tksugimoto/sub']);
  assert.equal(await verifyKey('other-secret', key, NOW), null);
});

test('verifyKey: 書き換えた key と期限切れを拒否する', async () => {
  const key = await createKey(SECRET, { repos: ['tksugimoto/a'], expires: '2026-10-19' });
  assert.ok(await verifyKey(SECRET, key, NOW));
  assert.equal(await verifyKey(SECRET, key, Date.parse('2026-10-19T00:00:00Z')), null);
  assert.equal(await verifyKey(SECRET, key.replace('tksugimoto/a', 'tksugimoto/b'), NOW), null);
  assert.equal(await verifyKey(SECRET, key.replace('2026-10-19', '2099-01-01'), NOW), null);
  assert.equal(await verifyKey(SECRET, undefined, NOW), null);
  assert.equal(await verifyKey(SECRET, 'gh-mcp-relay:x/y:!!', NOW), null);
});

test('createKey: 不正な入力を拒否する', async () => {
  await assert.rejects(createKey(SECRET, { repos: [] }));
  await assert.rejects(createKey(SECRET, { repos: ['no-slash'] }));
  await assert.rejects(createKey(SECRET, { repos: ['a/b:c'] }));
  await assert.rejects(createKey(SECRET, { repos: ['a/b'], expires: 'tomorrow' }));
});

test('reposInArgs / checkCall: 引数の owner/repo を key の範囲で確かめる', () => {
  assert.deepEqual(reposInArgs({ owner: 'A', repo: 'B', parent_owner: 'c', parent_repo: 'd', title: 'x' }), ['a/b', 'c/d']);
  const allowed = ['tksugimoto/a'];
  assert.equal(checkCall({ tool: 'issue_write', args: { method: 'create', owner: 'tksugimoto', repo: 'a' } }, allowed), null);
  assert.match(checkCall({ tool: 'issue_write', args: { method: 'create', owner: 'tksugimoto', repo: 'b' } }, allowed), /tksugimoto\/b/);
  assert.ok(checkCall({ tool: 'issue_write', args: { owner: 'tksugimoto', repo: 'a', parent_owner: 'x', parent_repo: 'y' } }, allowed));
  assert.ok(checkCall({ tool: 'search_issues', args: { query: 'repo:x/y' } }, allowed));
  assert.ok(checkCall({ tool: 'search_issues', args: { owner: 'tksugimoto', repo: 'a', query: 'x' } }, allowed));
  assert.ok(checkCall({ tool: 'list_issue_types', args: { owner: 'tksugimoto' } }, allowed));
  // owner/repo 以外で対象を決める引数や、repo の外に効くツールは、使わない owner/repo を足しても通さない。
  assert.match(checkCall({ tool: 'fork_repository', args: { owner: 'tksugimoto', repo: 'a', organization: 'other' } }, allowed), /organization/);
  assert.equal(checkCall({ tool: 'fork_repository', args: { owner: 'tksugimoto', repo: 'a' } }, allowed), null);
  assert.match(checkCall({ tool: 'issue_read', args: { method: 'get', owner: 'tksugimoto', repo: 'a', enterprise: 'e' } }, allowed), /enterprise/);
  // method で動きを変えるツールは、一覧の method だけ通す。repo を含まない ID だけで対象を決める method や、
  // 上流が足した method、method の無い呼び出しは断る。
  const deniedMethods = [
    ['pull_request_review_write', { method: 'resolve_thread', threadId: 'PRRT_x' }],
    ['sub_issue_write', { method: 'add', issue_number: 1, sub_issue_id: 2 }],
    ['issue_write', { method: 'a_new_upstream_method' }],
    ['issue_write', {}],
    ['list_issues', { method: 'a_new_upstream_method' }],
    ['discussion_comment_write', { method: 'update', commentNodeID: 'DC_x', body: 'b' }],
    ['discussion_comment_write', { method: 'delete', commentNodeID: 'DC_x' }],
  ];
  for (const [tool, args] of deniedMethods) {
    assert.match(checkCall({ tool, args: { owner: 'tksugimoto', repo: 'a', ...args } }, allowed), /method/, `${tool} ${args.method}`);
  }
  const allowedMethods = [
    ['pull_request_review_write', { method: 'create', pullNumber: 1 }],
    ['discussion_comment_write', { method: 'reply', discussionNumber: 1, commentNodeID: 'DC_x', body: 'b' }],
    ['sub_issue_write', { method: 'remove', issue_number: 1, sub_issue_id: 2 }],
    ['sub_issue_write', { method: 'reprioritize', issue_number: 1, sub_issue_id: 2, after_id: 3 }],
  ];
  for (const [tool, args] of allowedMethods) {
    assert.equal(checkCall({ tool, args: { owner: 'tksugimoto', repo: 'a', ...args } }, allowed), null, `${tool} ${args.method}`);
  }
  // actions のツールも owner/repo で確かめる。
  assert.equal(checkCall({ tool: 'actions_list', args: { owner: 'tksugimoto', repo: 'a', method: 'list_workflow_runs' } }, allowed), null);
  assert.ok(checkCall({ tool: 'get_job_logs', args: { owner: 'tksugimoto', repo: 'b', run_id: 1 } }, allowed));
  // owner だけで repo の無い呼び出しは断る（list_issue_types などは repo を省ける）。
  assert.match(checkCall({ tool: 'list_issue_types', args: { owner: 'tksugimoto' } }, allowed), /owner には repo も要ります/);
  assert.equal(checkCall({ tool: 'list_issue_types', args: { owner: 'tksugimoto', repo: 'a' } }, allowed), null);
  assert.equal(checkCall({ tool: 'run_secret_scanning', args: { owner: 'tksugimoto', repo: 'a', files: 'x' } }, allowed), null);
  // TOOL_METHODS のツールは、すべて使ってよいツールの一覧にある。
  for (const tool of TOOL_METHODS.keys()) assert.ok(isAllowedTool(tool), tool);
  // 一覧に無いツールは、使わない owner/repo を足しても通さない（上流は使わない引数を無視するため）。
  for (const tool of [
    'create_gist',
    'list_gists',
    'list_starred_repositories',
    'get_copilot_space',
    'dismiss_notification',
    'list_global_security_advisories',
    'repository_ruleset_read',
    'star_repository',
    'a_new_upstream_tool',
  ]) {
    assert.match(checkCall({ tool, args: { owner: 'tksugimoto', repo: 'a', name: 'x' } }, allowed), /使えません/, tool);
  }
  for (const tool of ['create_gist', 'list_notifications', 'list_global_security_advisories']) {
    assert.ok(checkCall({ tool, args: {} }, allowed), tool);
  }
  for (const tool of ['create_repository', 'get_teams', 'get_team_members']) {
    assert.ok(checkCall({ tool, args: { owner: 'tksugimoto', repo: 'a', name: 'x' } }, allowed), tool);
  }
  // repo を取らない Projects のツールは、使わない repo を足しても通さない。
  for (const tool of ['projects_list', 'projects_write', 'list_project_items']) {
    assert.ok(checkCall({ tool, args: { owner: 'tksugimoto', repo: 'a', project_number: 1 } }, allowed), tool);
  }
  assert.equal(checkCall({ tool: 'get_me', args: {} }, allowed), null);
});

test('deniedMethod: owner/repo を確かめられないメソッドを通さない', () => {
  for (const method of ['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized']) {
    assert.equal(deniedMethod({ jsonrpc: '2.0', id: 1, method }), undefined, method);
  }
  assert.equal(deniedMethod({ jsonrpc: '2.0', id: 1, result: {} }), undefined, 'サーバーへの応答');
  for (const method of ['resources/read', 'resources/templates/list', 'prompts/get', 'completion/complete']) {
    assert.equal(deniedMethod({ jsonrpc: '2.0', id: 1, method })?.method, method);
  }
  const batch = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'resources/read' }];
  assert.equal(deniedMethod(batch).id, 2);
});

test('stripKey: tools/call の key を取り出して引数から消す', () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me', arguments: { [KEY_ARG]: 'k', a: 1 } } };
  const { message, calls } = stripKey(msg);
  assert.deepEqual(message.params.arguments, { a: 1 });
  assert.deepEqual(calls, [{ id: 1, tool: 'get_me', key: 'k', args: { a: 1 } }]);
  assert.equal(msg.params.arguments[KEY_ARG], 'k', '元のメッセージは変えない');
});

test('stripKey: tools/call 以外と配列', () => {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
  ];
  const { message, calls } = stripKey(batch);
  assert.deepEqual(message[0], batch[0]);
  assert.deepEqual(message[1].params.arguments, {});
  assert.deepEqual(calls, [{ id: 2, tool: 'x', key: undefined, args: {} }]);
});

test('injectKeyParam: JSON と SSE の両方で引数を足す', () => {
  const result = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_me', inputSchema: { type: 'object', required: ['a'] } }] } };
  const fromJson = JSON.parse(injectKeyParam(JSON.stringify(result), 'application/json'));
  assert.deepEqual(fromJson.result.tools[0].inputSchema.required, ['a', KEY_ARG]);
  assert.ok(fromJson.result.tools[0].inputSchema.properties[KEY_ARG]);

  const sse = `event: message\ndata: ${JSON.stringify(result)}\n\n`;
  const line = injectKeyParam(sse, 'text/event-stream').split('\n')[1];
  assert.ok(JSON.parse(line.slice(5)).result.tools[0].inputSchema.properties[KEY_ARG]);
});

test('checkCall: OAuth App のコネクタのパスでは merge_pull_request を使わせない', () => {
  const allowed = ['tksugimoto/a'];
  const merge = { tool: 'merge_pull_request', args: { owner: 'tksugimoto', repo: 'a', pullNumber: 1 } };
  assert.match(checkCall(merge, allowed, '/mcp/x/pull_requests'), /merge_pull_request は中継で使えません/);
  assert.match(checkCall(merge, allowed, '/mcp/x/pull_requests/'), /使えません/);
  // GitHub App のコネクタのパスでは、今までどおり使える。
  assert.equal(checkCall(merge, allowed, '/mcp/x/all'), null);
  assert.equal(checkCall(merge, allowed, '/mcp'), null);
  assert.equal(checkCall(merge, allowed), null);
  // PR を出すツールは使える。
  const create = { tool: 'create_pull_request', args: { owner: 'tksugimoto', repo: 'a', head: 'other:branch', base: 'main', title: 'x' } };
  assert.equal(checkCall(create, allowed, '/mcp/x/pull_requests'), null);
});

test('injectKeyParam: OAuth App のコネクタのパスでは merge_pull_request を tools/list から外す', () => {
  const names = ['create_pull_request', 'merge_pull_request', 'update_pull_request'];
  const result = { jsonrpc: '2.0', id: 1, result: { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) } };
  const listed = (path) => JSON.parse(injectKeyParam(JSON.stringify(result), 'application/json', path)).result.tools.map((tool) => tool.name);
  assert.deepEqual(listed('/mcp/x/pull_requests'), ['create_pull_request', 'update_pull_request']);
  assert.deepEqual(listed('/mcp/x/all'), names);
  assert.deepEqual(listed(undefined), names);
});

test('injectKeyParam: 使えないツールを tools/list から外す', () => {
  const names = ['get_me', 'issue_write', 'actions_list', 'search_code', 'create_gist', 'projects_list', 'a_new_upstream_tool'];
  const result = { jsonrpc: '2.0', id: 1, result: { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) } };
  const patched = JSON.parse(injectKeyParam(JSON.stringify(result), 'application/json'));
  assert.deepEqual(
    patched.result.tools.map((tool) => tool.name),
    ['get_me', 'issue_write', 'actions_list'],
  );
});
