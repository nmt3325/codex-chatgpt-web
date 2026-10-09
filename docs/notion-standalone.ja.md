# Notion AI 単独起動版

このforkは、元のChatGPT Web/Electron機能を残し、**Notionクライアントをアプリ内へ直接組み込んだ専用コマンド**を追加しています。別の `notion-ai-mcp` サーバーを起動する必要はありません。

```text
Codex CLI ↔ 同一アプリ内のResponses API／ツールブローカー ↔ 組み込みNotionクライアント
                                      ↑                         ↓
                              同じプロセスのMCPコールバック ← HTTPS
```

NotionからのMCP呼び出しを保留し、Codexが返したツール結果を**同じ呼び出し**へ返します。別のユーザーメッセージで擬似的に続きを作る方式ではありません。

## 起動

ソース実行にはBun 1.4.0、実際の操作にはCodex CLIが必要です。`--tunnel` はインストール済みのcloudflaredをアプリが起動・終了します。独自のHTTPSプロキシがある場合は `--public-url` で代替できます。

```sh
git clone https://github.com/nmt3325/codex-chatgpt-web.git
cd codex-chatgpt-web
bun install --frozen-lockfile

bun run notion setup --cookie-file /private/path/notion-cookies.txt --workspace YOUR-WORKSPACE-UUID
bun run notion doctor
bun run notion run --tunnel -- exec --sandbox read-only "このリポジトリを確認して"
```

Cookieは自分のブラウザからローカルファイルに書き出してください。Netscape形式、ブラウザCookie JSON、Playwright storage stateに対応します。Cookieや秘密鍵をチャット・Gitに貼らないでください。既存のアカウントJSONもサーバーを起動せず一度だけ移行できます。

```sh
bun run notion setup --account-file /private/path/account.json --workspace YOUR-WORKSPACE-UUID
```

保存先は原則 `~/.codex-notion-web`。Unixではディレクトリ700／秘密ファイル600です。`--home PATH` で分離でき、元のChatGPT用設定やCodexの全体設定を変更しません。

## 承認と必要な接続

**単独化してもNotionのログイン・AI利用権限・インターネット接続は必要です。** Codexのネイティブツールを使う場合は、Notionから到達できるHTTPSコールバックも必要です。`--tunnel` がその起動・専用コネクタの登録・終了時の削除をまとめて管理します。

汎用ツールには書き込みやシェル操作もあるため、読み取り専用と偽って登録しません。Notion側の自動承認は**初期状態で無効**です。Notionの確認で止まった場合は、その原因を明示します。

無人実行が必要な場合のみ、新しく作る専用接続に明示的に許可できます。

```sh
bun run notion run --tunnel --allow-automatic-tools -- exec --sandbox read-only "このリポジトリを確認して"
```

この指定でもCodex側のサンドボックス・承認は維持されます。ファイル編集が必要なら、利用者がCodexの `workspace-write` を明示してください。既存の別コネクタの設定は変更しません。

## テキストだけならトンネル不要

```sh
bun run notion serve --no-tools
bun run notion run --no-tools -- exec --sandbox read-only "ツールを使わず説明して"
```

このモードではNotionを読み取り専用で実行し、コネクタを作成しません。通常のResponses APIは `127.0.0.1:17842/v1`、ネイティブツールのコールバックは `127.0.0.1:17843/mcp` です。公開する場合は認証付きコールバック側だけにしてください。

## 一つの実行ファイルにビルド

```sh
bun run build:notion
./dist/codex-notion-web --help
./dist/codex-notion-web run --tunnel -- exec --sandbox read-only "タスク"
```

コンパイル版はBunとNotionクライアントを内包し、別のBun／Node／Notion MCPサービスは不要です。Codex本体と、必要な場合のcloudflaredは外部実行ファイルです。元のElectron画面はChatGPT用のままです。今回のNotion対応は専用コマンドで使い、元プロジェクトの配布版にNotion機能が入っているとは案内しません。

## 安全な停止・復旧

ワークスペースは明示したUUIDに固定し、別ワークスペースへの切り替え・自動Continue・keep-awake・自動Web承認は行いません。終了時にはツール権限を失効させ、自分が作った接続だけを削除し、自分が起動したトンネルだけを終了します。

異常終了後は、実行プロセスが終了したことを確かめて次を使います。

```sh
bun run notion cleanup --stale-lock
```

生存中のPID、所有情報が変わった接続、別の接続には手を出しません。通信障害時の所有情報は再試行のため残します。

画像・添付・上流の全マルチエージェント機能を対応済みとはしていません。非対応入力は拒否します。非公式Notion Web APIのため、API変更・Cookie失効・クレジット・確認画面などで停止し得る実験版です。

検証範囲は [notion-validation.md](notion-validation.md)、詳細な設定・コマンドは [英語ガイド](notion-standalone.md) を参照してください。
