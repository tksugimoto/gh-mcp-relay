// 中継の判定ロジック。Workers と Node（テスト）の両方で動くよう、Web 標準 API だけを使う。

export const KEY_ARG = 'gh_mcp_relay_key';
// 転送先。コネクタの URL は、公式 GitHub MCP の URL のホスト部分だけを中継のものに置き換えたもの。
export const UPSTREAM_ORIGIN = 'https://api.githubcopilot.com';

const KEY_PREFIX = 'gh-mcp-relay';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;
const METADATA_PREFIX = '/.well-known/oauth-protected-resource/';
// 転送してよいパス。既定のツールセット（`/mcp`）、ツールセットを 1 つ選ぶ `/mcp/x/<ツールセット>`（`all` を含む）と、
// それぞれの読み取り専用版。どのツールを使えるかは REPO_TOOLS で決めるので、ツールセットは選ばない。
// `readonly`・`insiders` はツールセット名にしない（`/insiders` は試験中のツールが出るので通さない）。
const UPSTREAM_PATH_RE = /^\/mcp(?:\/x\/(?!(?:readonly|insiders)(?:\/|$))[a-z_]+)?(\/readonly)?\/?$/;

// 使ってよいツール。owner と repo を取り、上流の API も repo のパスになる（key の repo の中に閉じる）と
// 確かめたものだけ（list_issue_types などは repo を省けるが、中継は repo を付けたときだけ通す）。
// 一覧に無いツールは、引数によらず使わせず、tools/list からも外す。owner/repo を取らないツールは、
// 使わない owner/repo を足されると引数の確認を通ってしまうので、一覧に入れない（search_*、Projects、
// create_repository、get_teams、gists、notifications、stargazers など）。上流がツールを足しても、
// ここに足すまでは使えない。
const REPO_TOOLS = new Set([
  // repos・git（fork_repository は本人のアカウントに fork を作るが、作った fork には key が無いので触れない）
  'create_branch',
  'create_or_update_file',
  'delete_file',
  'fork_repository',
  'get_commit',
  'get_file_contents',
  'get_latest_release',
  'get_release_by_tag',
  'get_repository_tree',
  'get_tag',
  'list_branches',
  'list_commits',
  'list_releases',
  'list_repository_collaborators',
  'list_tags',
  'push_files',
  // issues・labels
  'add_issue_comment',
  'get_label',
  'issue_read',
  'issue_write',
  'label_write',
  'list_issue_fields',
  'list_issue_types',
  'list_issues',
  'list_label',
  'sub_issue_write',
  'update_issue_comment',
  // pull_requests
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
  'create_pull_request',
  'list_pull_requests',
  'merge_pull_request',
  'pull_request_read',
  'pull_request_review_write',
  'request_copilot_review',
  'update_pull_request',
  'update_pull_request_branch',
  // actions
  'actions_get',
  'actions_list',
  'actions_run_trigger',
  'get_job_logs',
  // code_quality・code_security・dependabot・secret_protection・security_advisories
  // （run_secret_scanning は、渡した内容をその repo の設定で調べる）
  'get_code_quality_finding',
  'get_code_scanning_alert',
  'get_dependabot_alert',
  'get_secret_scanning_alert',
  'list_code_scanning_alerts',
  'list_dependabot_alerts',
  'list_repository_security_advisories',
  'list_secret_scanning_alerts',
  'run_secret_scanning',
  // discussions
  'discussion_comment_write',
  'get_discussion',
  'get_discussion_comments',
  'list_discussion_categories',
  'list_discussions',
]);
// OAuth App のコネクタのパス（oauthScope が scope を返すパス）では使わせないツール。OAuth App の token は repo の
// scope を持ち、個人のアカウントの repo のコラボレーターは必ず Write なので、GitHub 側ではマージを止められない。
// pull_requests のパスで PR を出せるようにしても、マージは中継で止める。
const OAUTH_DENIED_TOOLS = new Set(['merge_pull_request']);
// owner/repo を取らないが、どの repo にも届かないので許すツール。
const REPOLESS_TOOLS = new Set(['get_me']);
// method で動きを変えるツールの、使ってよい method。一覧に無い method（上流が足したものを含む）や、method の無い
// 呼び出しは使わせない。次の method は、repo を含まない ID だけで対象を決め、owner/repo を使わないので、owner/repo を
// 許した repo にしたまま別の repo のものを指せる。一覧に入れない。
// - pull_request_review_write の resolve_thread・unresolve_thread（threadId）
// - discussion_comment_write の update・delete・mark_answer・unmark_answer（commentNodeID）。reply は、上流が
//   コメントが owner/repo の Discussion のものかを確かめる（GitHub の API も、その Discussion に無い返信先は無視して
//   トップレベルのコメントにする）ので入れる
// - sub_issue_write の add（sub_issue_id）。GitHub は同じ owner の別の repo の Issue を sub-issue にできるので、その Issue を
//   子にして get_sub_issues で中身を読んだり、replace_parent で親を付け替えたりできる。remove・reprioritize は、許した
//   Issue の子にしか効かないので入れる（人が別の repo の Issue を子にしてあれば、remove でその Issue の親が外れる）
// ここに無いツールに method が付いていたら使わせない（上流が method を足したときの備え）。
export const TOOL_METHODS = new Map([
  ['issue_read', ['get', 'get_comments', 'get_sub_issues', 'get_parent', 'get_labels']],
  ['issue_write', ['create', 'update']],
  ['label_write', ['create', 'update', 'delete']],
  ['sub_issue_write', ['remove', 'reprioritize']],
  ['pull_request_read', ['get', 'get_diff', 'get_status', 'get_files', 'get_commits', 'get_review_comments', 'get_reviews', 'get_comments', 'get_check_runs']],
  ['pull_request_review_write', ['create', 'submit_pending', 'delete_pending']],
  ['actions_get', ['get_workflow', 'get_workflow_run', 'get_workflow_job', 'download_workflow_run_artifact', 'get_workflow_run_usage', 'get_workflow_run_logs_url']],
  ['actions_list', ['list_workflows', 'list_workflow_runs', 'list_workflow_jobs', 'list_workflow_run_artifacts']],
  ['actions_run_trigger', ['run_workflow', 'rerun_workflow_run', 'rerun_failed_jobs', 'cancel_workflow_run', 'delete_workflow_run_logs']],
  ['discussion_comment_write', ['add', 'reply']],
].map(([tool, methods]) => [tool, new Set(methods)]));
// owner/repo とは別に対象のアカウントや org を決める引数。中継は確かめられないので、付いていたら使わせない
// （fork_repository の organization で、許した repo を別の org に fork させない、など）。REPO_TOOLS のツールに
// こうした引数が足されたときの備えも兼ねる。
const TARGET_ARGS = new Set(['organization', 'org', 'enterprise', 'user', 'username', 'gist_id', 'notificationID']);
// 中継が通す JSON-RPC のメソッド。resources/read・prompts/get・completion/complete などは、
// owner/repo を引数ではなく URI などで渡すので確かめられない。通さない。
const ALLOWED_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);

// URL のパスから、転送先を決める。パスはそのまま公式 GitHub MCP に渡す。
export function matchRoute(pathname) {
  let kind = 'endpoint';
  let path = pathname;
  if (pathname.startsWith(METADATA_PREFIX)) {
    kind = 'metadata';
    path = pathname.slice(METADATA_PREFIX.length - 1);
  }
  if (!UPSTREAM_PATH_RE.test(path)) return null;
  return { kind, path, upstream: `${UPSTREAM_ORIGIN}${path}` };
}

// OAuth App で認可するときに求める scope。OAuth App の token は求めた scope しか持たないので、
// private の repo に届くには repo が要る。OAuth App のコネクタは readonly のパスと、Issue とコメントだけを
// 書く issues のパス、PR を出す pull_requests のパスで登録する（同じ URL のコネクタは 2 つ登録できない）ので、
// そのパスでだけ返す。GitHub App は scope を見ない。
const OAUTH_PATH_RE = /^(?:.*\/readonly|\/mcp\/x\/(?:issues|pull_requests))\/?$/;
export function oauthScope(path) {
  return OAUTH_PATH_RE.test(path) ? 'repo' : null;
}

export function resourceMetadata(origin, path) {
  const scope = oauthScope(path);
  return {
    resource: `${origin}${path}`,
    authorization_servers: ['https://github.com/login/oauth'],
    bearer_methods_supported: ['header'],
    ...(scope ? { scopes_supported: [scope] } : {}),
  };
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

// key を作る。形は `gh-mcp-relay:<owner/repo>[,<owner/repo>...][:<期限>]:<署名>`。
// 中身は読めるままにして、末尾の署名（HMAC-SHA256）で改ざんを防ぐ。
export async function createKey(secret, { repos, expires }) {
  if (!Array.isArray(repos) || repos.length === 0) throw new Error('repos が空');
  for (const repo of repos) {
    if (!REPO_RE.test(repo)) throw new Error(`repo の形が不正: ${repo}`);
  }
  if (expires && !EXPIRES_RE.test(expires)) throw new Error(`expires は YYYY-MM-DD: ${expires}`);
  const fields = [KEY_PREFIX, repos.map((r) => r.toLowerCase()).join(','), ...(expires ? [expires] : [])];
  const signed = fields.join(':');
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(signed));
  return `${signed}:${base64url(new Uint8Array(signature))}`;
}

// key の署名と期限を確かめ、許可する repo の一覧を返す。不正なら null。
export async function verifyKey(secret, key, now) {
  if (typeof key !== 'string') return null;
  const fields = key.split(':');
  if (fields[0] !== KEY_PREFIX || (fields.length !== 3 && fields.length !== 4)) return null;
  const signature = fields.pop();
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      fromBase64url(signature),
      new TextEncoder().encode(fields.join(':')),
    );
    if (!ok) return null;
  } catch {
    return null;
  }
  const [, repos, expires] = fields;
  if (expires && !(now < Date.parse(`${expires}T00:00:00Z`))) return null;
  return { repos: repos.split(','), expires };
}

// ツール引数に出てくる owner/repo の組をすべて取り出す（owner と repo、parent_owner と parent_repo など）。
export function reposInArgs(args) {
  const found = [];
  for (const [name, owner] of Object.entries(args ?? {})) {
    if (!name.endsWith('owner')) continue;
    const repo = args[`${name.slice(0, -'owner'.length)}repo`];
    found.push(`${owner}/${repo}`.toLowerCase());
  }
  return found;
}

// path は、そのパスでだけ使わせないツールを決めるのに使う（省くと、パスによらない一覧だけで決める）。
export function isAllowedTool(name, path) {
  if (path !== undefined && oauthScope(path) && OAUTH_DENIED_TOOLS.has(name)) return false;
  return REPO_TOOLS.has(name) || REPOLESS_TOOLS.has(name);
}

// tools/call を key の範囲で許すか。許さないときは理由を返す。
export function checkCall(call, allowedRepos, path) {
  if (!isAllowedTool(call.tool, path)) return `${call.tool} は中継で使えません`;
  const methods = TOOL_METHODS.get(call.tool);
  const method = call.args?.method;
  if (methods ? !methods.has(method) : method !== undefined) return `${call.tool} の method ${method} は中継で使えません`;
  const targetArg = Object.keys(call.args ?? {}).find((name) => TARGET_ARGS.has(name));
  if (targetArg) return `引数 ${targetArg} は使えません`;
  const ownerOnly = Object.keys(call.args ?? {}).find(
    (name) => name.endsWith('owner') && call.args[`${name.slice(0, -'owner'.length)}repo`] === undefined,
  );
  if (ownerOnly) return `${ownerOnly} には repo も要ります`;
  const repos = reposInArgs(call.args);
  if (repos.length === 0) {
    return REPOLESS_TOOLS.has(call.tool) ? null : 'owner と repo が要ります';
  }
  const denied = repos.find((r) => !allowedRepos.includes(r));
  return denied ? `${denied} はこの key で許可されていません` : null;
}

// 通さないメソッドを含むなら、その最初のメッセージを返す。method の無いもの（サーバーへの応答）は通す。
export function deniedMethod(message) {
  const list = Array.isArray(message) ? message : [message];
  return list.find((msg) => {
    const method = msg?.method;
    if (method === undefined) return false;
    return !(ALLOWED_METHODS.has(method) || String(method).startsWith('notifications/'));
  });
}

// JSON-RPC のメッセージ（単体または配列）から tools/call の gh_mcp_relay_key を取り出し、
// 転送前に引数から消す。
export function stripKey(message) {
  const list = Array.isArray(message) ? message : [message];
  const calls = [];
  const out = list.map((msg) => {
    if (!msg || msg.method !== 'tools/call') return msg;
    const args = { ...(msg.params?.arguments ?? {}) };
    const key = args[KEY_ARG];
    delete args[KEY_ARG];
    calls.push({ id: msg.id, tool: msg.params?.name, key, args });
    return { ...msg, params: { ...msg.params, arguments: args } };
  });
  return { message: Array.isArray(message) ? out : out[0], calls };
}

export function hasMethod(message, method) {
  const list = Array.isArray(message) ? message : [message];
  return list.some((msg) => msg && msg.method === method);
}

const KEY_PROPERTY = {
  type: 'string',
  description: 'セッションの開始時に示された gh-mcp-relay の key（GH_MCP_RELAY_KEY）。どのツールでも必須。',
};

// tools/list の結果から使えないツールを外し、残りの各ツールに gh_mcp_relay_key 引数を足す。
// Claude が使えないツールを呼んだり、引数を渡し忘れたりしないようにするため。
function injectIntoResult(msg, path) {
  const tools = msg?.result?.tools;
  if (!Array.isArray(tools)) return msg;
  const patched = tools.filter((tool) => isAllowedTool(tool.name, path)).map((tool) => {
    const schema = tool.inputSchema ?? { type: 'object' };
    const required = new Set(schema.required ?? []);
    required.add(KEY_ARG);
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: { ...(schema.properties ?? {}), [KEY_ARG]: KEY_PROPERTY },
        required: [...required],
      },
    };
  });
  return { ...msg, result: { ...msg.result, tools: patched } };
}

export function injectKeyParam(bodyText, contentType, path) {
  if ((contentType ?? '').includes('text/event-stream')) {
    return bodyText
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line;
        try {
          return `data: ${JSON.stringify(injectIntoResult(JSON.parse(line.slice(5)), path))}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  }
  const parsed = JSON.parse(bodyText);
  const patched = Array.isArray(parsed) ? parsed.map((msg) => injectIntoResult(msg, path)) : injectIntoResult(parsed, path);
  return JSON.stringify(patched);
}
