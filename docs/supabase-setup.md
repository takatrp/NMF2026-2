# NMF2026-2 Supabaseセットアップ

この文書は、NMF2026-2のクラウド保存に必要なSupabaseデータベース設定をまとめたものです。通常URLの公開最新版はログインなしで閲覧できます。編集、設計一覧、権限付き共有リンクの利用にはSupabase Authへのログインが必要です。

## 1. 接続情報

画面側で使用する値は次の2つです。

```text
Project URL: https://gqlnxaolwdzkgoyrpdpt.supabase.co
Publishable key: sb_publishable_IaqE-VquX157gYoTwj1ysQ_kSWb-T4E
```

Publishable keyは公開ブラウザで使うことを前提としたキーです。データ保護はキーを隠すことではなく、Supabase AuthとRLSで行います。

次の値は、GitHub Pages、JavaScript、JSON、共有URL、画面表示、リポジトリへ絶対に入れないでください。

- Secret key（`sb_secret_...`）
- `service_role`キー
- Database Password
- JWT Secret

`service_role`はRLSを迂回します。この構成のブラウザ実装には不要です。

参考:

- [Supabase: Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

## 2. 認証URL

Supabase Dashboardで対象プロジェクトを開き、`Authentication` → `URL Configuration`に次を設定します。

```text
Site URL:
https://takatrp.github.io/NMF2026-2/

Redirect URLs:
https://takatrp.github.io/NMF2026-2/
```

本番環境ではワイルドカードではなく、上記の完全なURLを登録します。画面側で`redirectTo`を指定する場合も同じURLを使用してください。

参考:

- [Supabase: Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

## 3. SQLの適用

1. Supabase Dashboardで対象プロジェクトを開きます。
2. 左メニューから`SQL Editor`を開きます。
3. `New query`を押します。
4. [`supabase/schema.sql`](../supabase/schema.sql)の全文を貼り付けます。
5. `Run`を押し、エラーなく完了することを確認します。

SQLは同じ内容を再実行できるように、テーブル・索引・関数は再作成しやすくし、RLSポリシーは一度削除してから定義し直しています。

SQL Editorは管理者権限で実行されるため、SQL Editor上の通常の`select`結果だけではRLSの動作確認になりません。RLSは、Publishable keyとSupabase Authの一般利用者セッションを使って確認してください。

## 4. 保存データ

`public.seminar_plans`の主要列は次のとおりです。

| 列 | 型 | 用途 |
| --- | --- | --- |
| `id` | `uuid` | 設計ID |
| `owner_id` | `uuid` | Supabase Authの所有者 |
| `title` | `text` | 設計タイトル |
| `payload` | `jsonb` | 画面状態全体 |
| `revision` | `bigint` | 楽観ロック用の版番号 |
| `view_token` | `uuid` | 閲覧共有リンク用トークン |
| `edit_token` | `uuid` | 編集共有リンク用トークン |
| `updated_at` | `timestamptz` | 最終更新日時 |

`payload`には、現在JSON保存している次のような画面状態をそのまま渡せます。

```json
{
  "segments": [],
  "selectedId": null,
  "view": "agenda",
  "candidateDeckVersion": 1
}
```

保存のたびに`public.seminar_plan_history`へスナップショットを追加します。履歴には`view_token`と`edit_token`を保存しません。したがって、共有トークン再発行後に旧トークンが履歴から復元されることはありません。

`public.seminar_publications`には、通常URLで公開する設計を1件だけ保持します。`schema.sql`を初めて適用した時点で既存設計がある場合は、最終更新日時が最も新しい設計を公開対象にします。

## 5. RPC契約

通常URL用の`load_public_seminar_plan()`だけは未ログインの`anon`から実行できます。戻り値には所有者IDと共有トークンを含めません。それ以外のRPCはSupabase Authでログイン済みの`authenticated`利用者だけが実行できます。

### 所有者による新規作成

```javascript
const { data, error } = await supabase.rpc("save_owned_seminar_plan", {
  p_plan_id: null,
  p_title: "第2分科会 145分設計",
  p_payload: statePayload,
  p_expected_revision: null
});
```

戻り値:

```text
id, title, payload, revision, view_token, edit_token, updated_at
```

初回の`revision`は`1`です。

### 所有者による更新

```javascript
const { data, error } = await supabase.rpc("save_owned_seminar_plan", {
  p_plan_id: planId,
  p_title: title,
  p_payload: statePayload,
  p_expected_revision: currentRevision
});
```

所有者以外の設計IDは更新できません。成功すると`revision`が1増えます。

### 共有リンクによる読込

```javascript
const { data, error } = await supabase.rpc("load_shared_seminar_plan", {
  p_token: shareToken
});
```

戻り値:

```text
id, title, payload, revision, updated_at, can_edit
```

`view_token`で読み込むと`can_edit=false`、`edit_token`で読み込むと`can_edit=true`です。どちらで読み込んでも、戻り値に共有トークンは含まれません。

### 編集共有リンクによる保存

```javascript
const { data, error } = await supabase.rpc("save_shared_seminar_plan", {
  p_token: editToken,
  p_title: title,
  p_payload: statePayload,
  p_expected_revision: currentRevision
});
```

戻り値:

```text
id, title, payload, revision, updated_at, can_edit
```

`view_token`では保存できません。戻り値に`view_token`と`edit_token`は含まれません。

### 共有トークンの再発行

```javascript
const { data, error } = await supabase.rpc("rotate_seminar_plan_share_tokens", {
  p_plan_id: planId
});
```

戻り値:

```text
id, title, payload, revision, view_token, edit_token, updated_at
```

所有者だけが実行できます。閲覧用と編集用の両方を同時に再発行し、以前の共有リンクは直ちに無効になります。内容は変わらないため`revision`は増えません。

## 6. 一覧・履歴・削除

所有者自身の行だけがRLSで取得できます。

```javascript
const { data: plans, error } = await supabase
  .from("seminar_plans")
  .select("id,title,payload,revision,view_token,edit_token,updated_at")
  .order("updated_at", { ascending: false });
```

履歴も所有者だけが取得できます。

```javascript
const { data: history, error } = await supabase
  .from("seminar_plan_history")
  .select("plan_id,title,payload,revision,changed_by,change_source,saved_at")
  .eq("plan_id", planId)
  .order("revision", { ascending: false });
```

削除も所有者だけが実行できます。設計を削除すると、その設計の履歴も削除されます。

```javascript
const { error } = await supabase
  .from("seminar_plans")
  .delete()
  .eq("id", planId);
```

所有者以外には一覧・履歴の行が返らず、削除も行われません。

## 7. 楽観ロック

更新時は、画面が最後に読み込んだ`revision`を`p_expected_revision`へ必ず渡します。DB上の版番号と一致した場合だけ保存し、成功時に1増やします。

別の利用者が先に保存済みの場合、RPCは次のエラーを返します。

```text
code: 40001
message: REVISION_CONFLICT
```

画面側では上書きを続けず、最新データを再読込して利用者へ競合を通知してください。

## 8. 共有リンク

画面側では、同じパラメーター名に異なるトークンを入れる形で共有できます。

```text
閲覧リンク:
https://takatrp.github.io/NMF2026-2/?share=<view_token>

編集リンク:
https://takatrp.github.io/NMF2026-2/?share=<edit_token>
```

トークンはUUIDとして十分な乱数から生成され、閲覧用と編集用を別々に保持します。ただし共有URLを知るログイン利用者は、そのリンクの権限を利用できます。URLをメール転送、画面共有、アクセスログなどで漏らさないよう、権限付きリンクとして扱ってください。漏えいが疑われる場合は、所有者が`rotate_seminar_plan_share_tokens`を実行します。

## 9. セキュリティ判断

- 匿名実行できるRPCは、指定された公開設計を読む`load_public_seminar_plan()`だけです。
- RLSにより、通常の一覧・履歴参照・削除は所有者の行だけに限定します。
- `seminar_plans`への直接INSERT／UPDATEは許可せず、保存はRPCに集約します。
- `security definer`関数は`search_path=pg_catalog`に固定し、テーブルを完全修飾しています。
- 公開読込以外のRPC実行権限は`PUBLIC`と`anon`から剥奪し、`authenticated`だけへ付与します。
- 共有読込／共有保存は、所有者IDと共有トークンを返しません。
- 閲覧トークンは読込専用で、保存には編集トークンが必要です。
- `revision`不一致時は保存せず、後勝ちの無言上書きを防止します。
- 保存履歴には共有トークンを残しません。
- 公開ブラウザはProject URLとPublishable keyだけで動作し、秘密鍵や`service_role`を必要としません。

## 10. 最新版の読込と編集確定

所有者が「設計一覧」から設計を開くと、URLは次の形式になります。

```text
https://takatrp.github.io/NMF2026-2/?plan=<plan_id>
```

通常URL（`https://takatrp.github.io/NMF2026-2/`）を開くと、ログインなしで公開対象に指定された設計の最新版を読み込みます。公開閲覧中の「最新版に更新」を押すと、Supabaseからその時点の最新版を再取得します。編集する場合はログインし、所有する設計を開きます。所有者は「通常URLに公開」で公開対象を切り替えられます。

特定の設計URLにある`?plan=<id>`と、権限付き共有URLの`?share=<token>`はログインが必要で、それぞれ指定された設計の最新版を読み込みます。

ログインして編集している画面は15秒ごと、およびタブへ戻った時に最新版を確認します。ただし、次の場合は利用者の作業を守るため自動反映しません。ログインなしの公開閲覧では自動反映せず、「最新版に更新」で再取得します。

- カード編集モーダルを開いている
- 「編集を完了」後の変更がまだクラウド保存されていない
- クラウド保存中
- 版競合が発生している

カードの入力内容はモーダル内の下書きです。「編集を完了」を押した時だけ本体へ反映され、その後にローカル保存とクラウド自動保存が動きます。変更がある状態で「閉じる」、Esc、背景クリックを行うと、破棄前に確認メッセージを表示します。カード選択と表示タブは端末内だけに保存し、クラウドの版数には含めません。
