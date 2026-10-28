# 設計: fork から本流への Issue・PR

この中継がなぜこの形なのかをまとめます。使い方は [README.md](../README.md) を見てください。

## 背景

- AI 用アカウント `tksugimoto-ai` で、fork から本流（upstream）へ Issue と PR を出す。cloud でもローカルでも同じ仕組みで動かす。
- AI が本流の `main` を変えられない仕組みにする。

## 解決したい課題

本流には、自分で追加した GitHub コネクタで届かせる必要がある（公式の GitHub 連携はセッションに追加した repo にしか届かず、本流は fork と同名でセッションに入れられないため）。ところが、自分で追加したコネクタは claude.ai のアカウント単位なので、1つのセッションから全部見え、それらが届く全部の repo を操作できる。これを、セッションごとに決めた本流の repo だけに絞る（将来 Claude 側が環境ごとのコネクタ管理を提供すれば、この中継は不要になるかもしれない）。

### 要件

- Issue・PR・コメントは `tksugimoto-ai` の名前で出す。
- Claude GitHub App は本流に入れない（public も private も）。fork だけに入れる。
- `tksugimoto-ai` は本流の `main` を変えられない（public なら権限なし、org の private なら Triage）。
- 1つのセッション（環境）で操作できる本流の repo は、基本は1つにする。private と public の間だけでなく、public の repo どうしも混ぜない。
- submodule の編集などのために、1つのセッションに複数の repo を許すこともできる。
- 認可の仕組みは Claude と GitHub に任せ、token を自分で管理しない。
- 新しい repo は、何も設定しなくても本流に届かない状態になる。

## 前提と制約

Claude Code の cloud 環境と claude.ai のコネクタには次の制約があり、設計はこれを前提にしています。

| 制約 | 内容 |
| --- | --- |
| 同名 repo | 持ち主が違う同名の repo を、1つのセッションに入れられない（checkout 先が衝突する） |
| GitHub 専用 proxy | セッションから GitHub への通信は専用 proxy を通り、セッションに入っていない repo への API は 403 になる（public の読み取りも） |
| GraphQL | proxy で拒否される。`gh pr` / `gh issue` は動かず、REST（`gh api`）のみ |
| ネットワークシークレット | GitHub 宛ての通信には付かない |
| コネクタの範囲 | 自分で追加したコネクタは claude.ai のアカウント単位。どのセッションからも全部見え、セッションの repo 範囲に縛られない（公式の GitHub 連携は、セッションに追加した repo に絞られる） |
| コネクタの重複 | 同じ URL のコネクタは2つ目を登録できない |
| MCP の通信経路 | コネクタの呼び出しは Anthropic 側の MCP proxy から出る。セッションの環境変数やネットワークシークレットは乗らない |
| 公式 GitHub MCP | URL で絞れるのはツールセットと読み取り専用だけ。repo の範囲は絞れない |
| GitHub App の install 先 | private 設定の App は、App 所有者のアカウントにしか install できない |

cloud セッションでも、`~/.claude/settings.json` の `deniedMcpServers` で claude.ai のコネクタを止められることを確かめました。ただし、表示名と UUID 名の両方を書く必要があります（表示名だけだと、UUID 名の同じコネクタがすり抜けます）。コネクタを登録し直すと UUID 名が変わるので、そのたびに確認し直します。

## 検討した方式

| 方式 | 採用 | 理由 |
| --- | --- | --- |
| fork と本流を1つのセッションに入れる | 不可 | 同名 repo の制約で入らない |
| collaborator（Write）＋本流に Claude GitHub App | 不採用 | merge できるので `main` への push と実質同じ。Actions の secrets にも届く |
| 独自コネクタ1つで全本流を扱う（中継なし） | 不採用 | 全セッションから全部の repo に届き、prompt injection による漏洩の経路ができる |
| repo の数だけコネクタを登録し、deny で出し分ける | 不採用 | deny は許可リストではないので、コネクタを足すたびに全環境の設定を直す必要がある。設定漏れで開いてしまう |
| repo ごとにコネクタを登録し、パスの先頭で repo と key を対応させる | 不採用 | 下の「repo ごとのコネクタとの比較」を参照 |
| PAT を環境変数 `GH_TOKEN` に入れる | 不可 | GitHub 専用 proxy の repo 範囲で 403 になる見込み。token がセッションから見える |
| 自作 proxy ＋ネットワークシークレットに PAT | 次点 | token が見えず隔離が強い。ただし PAT を自分で管理し、repo の制限は proxy だけが担う。ローカルでは使えない |
| ネットワークシークレットでコネクタの利用を絞る | 不可 | MCP の通信は agent proxy を通らないので、シークレットが付かない |
| 入力済みリンク（compare の URL、`issues/new`） | 代替案 | 混ざらず、本流の設定も要らない。ただし PR の編集やコメントのたびに手作業が要る |
| 薄い自作 proxy ＋ repo を書いた署名つき key | **採用** | 認可は Claude と GitHub に任せられる。key を置かないセッションは何もできず、新しい repo は閉じたまま。中継は状態を持たない。cloud とローカルで共通 |

### repo ごとのコネクタとの比較

コネクタの URL のパス（先頭など）に repo を入れ、repo の数だけコネクタを登録する案も検討した。

この案でも key は要る。claude.ai のコネクタはどのセッションにも全部見えるので、「このセッションは repo A のコネクタを使ってよい」と中継に示すものが必要になる。cloud ではその値をヘッダーで渡せないので、結局 Claude が引数で渡すことになる。さらに、repo A のコネクタ経由でも引数に repo B を書かれうるので、引数の `owner`/`repo` も確かめる必要がある。中継がやることは、採用した方式とほぼ同じになる。

| | repo ごとのコネクタ | 採用した方式（key に repo を書く） |
| --- | --- | --- |
| 安全性 | 同じ（key と引数の確認が必須） | 同じ |
| repo を足す手間 | コネクタの登録と OAuth の認可を repo ごとに行う | key を発行するだけ |
| セッションへの影響 | 全セッションに「repo 数 × ツール数」のツールが並び、Claude が使うコネクタを取り違えやすい | コネクタは1つ |
| 中継の状態 | パスと key の対応を持つ（設定か署名） | 何も持たない |
| 複数 repo（submodule など） | 複数のコネクタを使い分ける | key に並べるだけ |
| URL のルール | 公式 URL にない repo の部分が入る | 公式 URL のホストだけ置き換える |

repo ごとのコネクタの利点は、Claude から見てどのコネクタがどの repo 用かが名前でわかることくらいで、採用した方式でも key の中身を読めば同じことがわかる。

## 採用した設計

GitHub App とコネクタは1つだけ作り、どのセッションからも見えるままにします。そのかわり、セッションに置いた key で、操作できる repo を中継が絞ります。fork への push は、これとは別に fork だけに入れた Claude GitHub App が行います。

GitHub App を入れられない repo（ほかの人の private の repo など）は、OAuth App で認可する読み取り専用のコネクタを別に足して読みます（URL は `/mcp/readonly`）。OAuth App の token は GitHub 側で repo を絞れないので、境界は key と readonly のパスだけになります。手順と弱くなる点は [README.md](../README.md) にまとめています。

Issue とコメントを書くときは `/mcp/x/issues`、PR を出すときは `/mcp/x/pull_requests` のコネクタを、同じ OAuth App で足します。OAuth App の token は `repo` の scope を持ち、個人の repo の collaborator は必ず Write なので、そのままでは `merge_pull_request` が通ってしまいます。中継は OAuth App のコネクタのパス（`repo` の scope を求めるパス）で `merge_pull_request` を常に拒否します（URL の query で指定する案より、決め打ちのほうが書き忘れが無い）。claude.ai のコネクタの設定でのツールの拒否は補助で、どの対策も token が漏れたときは効きません。持ち主に GitHub App を install してもらい、`/mcp` で PR を出す方法もあります（未確認）。詳しくは [README.md](../README.md) にまとめています。

| 守るもの | 強制するもの | 仕組み |
| --- | --- | --- |
| セッションごとの repo の範囲 | 中継 | key に書いた `owner/repo` と、ツール引数の `owner`/`repo` を照らし合わせる |
| App が届く repo の範囲 | GitHub | GitHub App の install 先 |
| 操作の範囲（merge、push） | GitHub | `tksugimoto-ai` の本流での権限 |
| 誰の名前で動くか・token の管理 | Claude と GitHub | コネクタの OAuth。中継は token を確かめも保存もしない |

- GitHub App は public 設定（どのアカウントにも install できる）にする。private 設定だと作ったアカウントにしか install できず、個人と org で App とコネクタを分ける必要が出るため。public にしても、ほかの人が自分の repo に install できるだけで、こちらの repo には届かない。
- 以前は「個人と org の境界を GitHub に守らせる」ために App を分ける案だったが、repo の範囲を key で絞るようにしたので分けない。

### key

key は `gh-mcp-relay:<owner/repo>[,<owner/repo>...][:<期限>]:<署名>` の形で、署名は `KEY_SECRET` を鍵にした HMAC-SHA256 です。

- 中身が読めるので、どの repo 用の key か人にも Claude にもわかる。書き換えると署名が合わなくなる。
- 中継は key を記録しない（状態を持たない）。設定ファイルも KV も要らない。そのかわり key を1つずつ取り消せないので、期限を付けて発行し、全部を無効にしたいときは `KEY_SECRET` を入れ替える。
- 発行は、`KEY_SECRET` を持つ人が手元の CLI で行う。発行用の Web ページは作らない（作るなら、そのページの認証が別に要る）。

### 転送先の URL

コネクタの URL は、公式 GitHub MCP の URL（`https://api.githubcopilot.com/mcp/...`）のホスト部分だけを中継のものに置き換えたものにします。登録する人にとってルールがわかりやすく、中継はパスをそのまま転送するだけで済みます。

- この中継は GitHub 専用で、汎用の MCP 中継にはしない。転送先は `api.githubcopilot.com` に固定し、パスも `/mcp`、`/mcp/x/<ツールセット>`（`all` を含む）と、それぞれの `/readonly` 版だけを受け付ける（token をほかの API に流さないため）。`/insiders` は試験中のツールが出るので通さない。
- ツールセットでは絞らず、使えるツールは下の「ツールの扱い」の一覧で決める。`/mcp/x/all` のコネクタ 1 つで、既定のツールも actions なども使える。
- 何ができるかは App の権限で決まる。actions の再実行などを使わせたくないときは、App にその権限を付けない。複数のツールセットを組み合わせる `X-MCP-Toolsets` ヘッダーは転送しない（中継がリクエストを書き換える所を増やさないため）。

### ツールの扱い

- 通す JSON-RPC のメソッドは、`initialize`・`ping`・`tools/list`・`tools/call`・`notifications/*` だけにする。公式 GitHub MCP は repo の中身をリソース（`repo://{owner}/{repo}/contents{/path*}` など）としても出していて、`resources/read` などは repo を URI で渡すので、引数の `owner`/`repo` では確かめられないため。
- 使ってよいツールを一覧（`REPO_TOOLS`）で持ち、一覧に無いツールは引数によらず拒否し、`tools/list` からも外す。一覧に入れるのは、`owner` と `repo` を必ず取り、上流の API も repo のパスになる（key の repo の中に閉じる）と確かめたツールだけ。上流は使わない引数を無視するので、`owner`/`repo` を取らないツールに使わない `owner`/`repo` を足されると、引数の確認を通ってしまう（Projects、`create_repository` など）。名前で拒否する方式では、上流がそうしたツールを足すたびに穴になるので、通すものを並べる方式にする。上流が足したツールは、一覧に足すまで使えない（method は下の項目）。
- 一覧に入れないもの: `search_*`（クエリでほかの repo にも届きうる）、Projects、`create_repository`・`get_teams`・`get_team_members`、gists・notifications・stargazers・orgs・users・copilot_spaces のツール、`list_global_security_advisories` など repo を取らないもの。copilot（Copilot の agent を動かす）と governance（org・enterprise の level がある）、`delete_repository` も、要るまで入れない。
- 引数の `owner`/`repo`（`parent_owner`/`parent_repo` なども）がすべて key の範囲にあるときだけ転送する。`list_issue_types` のように `repo` を省略できるツールは、`repo` を付けたときだけ通り、そのときはその repo に絞られる。`owner` だけで `repo` が無い呼び出しは拒否する。
- owner/repo とは別に対象のアカウントや org を決める引数（`organization`、`org`、`enterprise`、`user`、`username`、`gist_id`、`notificationID`）が付いた呼び出しは拒否する。たとえば `fork_repository` の `organization` で、許した repo を別の org に fork させない。一覧のツールにこうした引数が別の名前で足されると通ってしまう。
- method で動きを変えるツール（`issue_write`・`pull_request_review_write`・`actions_run_trigger` など）は、使ってよい method も一覧（`TOOL_METHODS`）で持ち、一覧に無い method や method の無い呼び出しは拒否する。上流が method を足しても、一覧に足すまで使えない。一覧に無いツールに method が付いた呼び出しも拒否する（上流がそのツールに method を足したときの備え）。
- repo を含まない ID だけで対象を決め、owner/repo を使わない method は一覧に入れない。owner/repo を許した repo にしたまま、ID で別の repo のものを指せるため（github-mcp-server のソースで確かめた）。
  - `pull_request_review_write` の `resolve_thread`・`unresolve_thread`（GraphQL の node ID の `threadId`）
  - `discussion_comment_write` の `update`・`delete`・`mark_answer`・`unmark_answer`（`commentNodeID`）。`reply` は、上流がコメントが owner/repo の Discussion のものかを確かめてから返信するので入れる。GitHub の API も、その Discussion に無い返信先は無視してトップレベルのコメントにするので、最悪でも許した repo にコメントが付くだけ
  - `sub_issue_write` の `add`（Issue の数値の ID の `sub_issue_id`）。GitHub は同じ owner の別の repo の Issue を sub-issue にできる（REST API の説明に「The sub-issue must belong to the same repository owner as the parent issue」とある）ので、key に書いていない同じ owner の repo（private のものも）の Issue を子にして `issue_read` の `get_sub_issues` でタイトルや本文を読んだり、`replace_parent` で親を付け替えたりできる。`remove`・`reprioritize` は許した Issue の子にしか効かないので入れる（人が別の repo の Issue を子にしてあれば、`remove` でその Issue の親が外れる）。新しい Issue を sub-issue として作るのは、`issue_write` の `create` の `parent_issue_number` でできる（親の repo も key で確かめる）
- このため、中継経由ではレビューのスレッドの解決・未解決、Discussion のコメントの編集・削除・回答の印付け、既存の Issue を sub-issue にすることはできない。
- 人が GitHub の画面で別の repo の Issue を sub-issue にしてあると、`issue_read` の `get_sub_issues`・`get_parent` でその Issue の中身が読める。中継は返事の中身を見ないので、これは防げない。
- `fork_repository` は本人のアカウントに fork を作るので、厳密には key の repo の中に閉じない。作った fork には key が無いので、それ以上は触れない。fork から PR を出す使い方のために残す。
- 中継は通信の中身をこれ以上は解析しない。ツールごとに細かく制限したくなったら、公式サーバーへの転送をやめて、少数の自前ツールを実装する。

## cloud の環境構成

本流ごとに環境を作り、key はその環境にだけ置きます。Default 環境には key を置かないので、新しい repo は初期状態で本流に届きません。

| 環境 | 使う repo（fork） | 環境変数 | セットアップスクリプト |
| --- | --- | --- | --- |
| Default | 専用環境のない repo すべて | なし | なし |
| 本流ごとの環境 | その本流の fork | `GH_MCP_RELAY_KEY=<その repo 用の key>` | `~/.claude/CLAUDE.md` に使い方、SessionStart の hook で key を文脈に入れる |

- 環境変数はその環境を使う人とセッションから読めるので、key は認証情報ではなく「利用許可の合言葉」として扱います。
- 使い方の説明は本流の repo に入れず、セットアップスクリプトで `~/.claude/CLAUDE.md` に書き出します。key の値は書き出さず、SessionStart の hook がセッションの開始時に環境変数から読んで、Claude の文脈に入れます。セットアップスクリプトの実行時には環境変数が空のことがあり（結果はキャッシュされる）、Claude がコマンドで環境変数を読むと自動の権限チェックで止められたためです。

### repo を1つ足す手順

1. 本流で `tksugimoto-ai` に権限を付ける（private なら Triage、public なら不要）。
2. 本流を `tksugimoto-ai` に fork する。
3. GitHub App の install 先に本流を足す（Only select repositories）。private の本流では fork も足す。fork に入れないと、PR を作るときに head を読めず失敗する。public の本流と fork なら、fork には要らない（確かめた）。fork に入れても、中継が key に書いた本流だけに絞るので、境界は変わらない。
4. その repo 用の key を発行する（`npm run new-key`）。
5. 専用の環境を作り、`GH_MCP_RELAY_KEY` とセットアップスクリプトを設定する。

## リスク

この設計が防ぐのは、1つのセッションから key で許していない repo を操作することです（repo をまたぐ prompt injection を含む）。許した repo の中での悪用は防げません。また、同じ claude.ai アカウントのほかのセッションが key を入手することは防げないので、主に防げるのは prompt injection による取り違えや誤操作です。

| リスク | 内容 | 対策 |
| --- | --- | --- |
| key がセッションから読める | 別のセッションに key を書き写されると、その repo を使われる | 期限つきで発行する。必要なら `KEY_SECRET` を入れ替える |
| ほかのセッションから key を入手される | 同じ claude.ai アカウントのセッションは、ほかのセッションの会話記録を読める（確かめた）。key はツールの引数に入るので、記録に残る。ほかのセッションにメッセージを送って key を聞き出すこともできると考えられる（推論で、試していない）。このため、同じアカウントの中では key は強い境界にならない | 強い境界が要る repo（org の private など）は、claude.ai のアカウントを分ける。key を置かない環境では、ほかのセッションを読む・送るツールを deny する（効くかは未確認） |
| OAuth App のコネクタ | GitHub App を入れられない repo を読むための OAuth App の token は、`repo` の scope で `tksugimoto-ai` が触れる全 repo に読み書きでき、期限も無い | readonly のパス（と、書き込みを Issue・PR に絞る `/mcp/x/issues`・`/mcp/x/pull_requests`）でだけ登録し、ほかの書き込みのツールを出さない。PR のパスでもマージは中継が拒否する（token そのものは書き込めるので、token が漏れたときには効かない。被害の上限は `tksugimoto-ai` の権限の全体なので、その権限を小さく保つ）。強い境界が要る repo は claude.ai のアカウントを分ける。要らなくなったら token を取り消す |
| key を1つずつ取り消せない | 中継が key を記録しないため | 期限を短めにする。全部を無効にするときは `KEY_SECRET` を入れ替える |
| fork への git push | 組み込みの GitHub 連携（Claude GitHub App）で行うので、中継の key の確認は効かない | 組み込みの連携は、そのセッションに追加した repo にしか届かない。Claude GitHub App は fork にだけ入れ、本流には入れない。本流に入るのは、人がマージした PR だけになる |
| 中継を通る通信 | token と PR 本文が中継を通過する | ヘッダーをログに残さない。信頼できるホスティング先に置く |
| 組み込みの PR 監視 | 本流の PR には効かない | コネクタ経由で PR の状態を読みに行く |

## 未確認のこと

- [x] GitHub を認可サーバーにした OAuth で、claude.ai のコネクタ登録が通るか。GitHub は `https://github.com/.well-known/oauth-authorization-server/login/oauth` でメタデータを公開している（PKCE S256、refresh token 対応、DCR なし）。Client ID と secret はコネクタ登録画面の Advanced settings に入れる。
- [x] 公式 GitHub MCP への転送で、届いた OAuth の token がそのまま使えるか。使えた（本流に Issue とドラフト PR を作れた）。
- [ ] 同じユーザーと App の組み合わせで、発行できる user token の数に上限があるか。
- [x] cloud で `~/.claude/CLAUDE.md` が読まれるか。読まれた。
- [x] public の本流でも、GitHub App を fork に install しないと PR を作れないか。要らない。public の fork から public の本流への PR は、App を fork に入れずに作れた。private の本流では要る。
- [x] OAuth App のコネクタで、App を入れていない private の repo を読めるか。読めた。App を入れていない private の repo を読めたので、中継が伝える `repo` の scope で認可されたと判断した（GitHub の Authorized OAuth Apps の画面ではまだ確かめていない）。org の repo では、org の owner が OAuth App を承認するまで 403 になる。
- [x] cloud セッションで、`~/.claude/settings.json` の SessionStart の hook が動き、環境変数 `GH_MCP_RELAY_KEY` を読めるか。動いた（hook の出力がセッションの開始時に文脈に入り、その key で本流を読めた）。
