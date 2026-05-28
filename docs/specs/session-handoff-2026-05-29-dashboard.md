# Session Handoff — 2026-05-29 — Dashboard / CodeCommit Web Embedded

## 1. このファイルの読み方

- 前提セッション: 2026-05-28 〜 2026-05-29 にかけて dashboard 機能を develop
  ブランチに追加。
- 設計仕様:
  [codecommit-web-embedded-auto-setup.md](./codecommit-web-embedded-auto-setup.md)
  を併読すること。**役割分担: 設計仕様 = WHAT、本書 = HOW NOW**
  (現状スナップショット + 実行可能なプラン + dispatch テンプレ + 検証チェック)。
- 本書は「次セッションで何を、どの順で、どう subagent に振るか」の操作手順書。
  次セッションを開いた Claude が、`CLAUDE.md` + 設計仕様 + 本ファイルだけ読めば
  そのまま subagent dispatch して実装に入れる状態を目指す。

## 2. 現状スナップショット

### 2.1 ブランチ

- 作業ブランチ: `develop`
- リモート同期: `develop` が `origin/develop` から **5 コミット ahead、未 push**
- working tree: 本書執筆時点では `docs/roadmap.md` と
  `docs/specs/review-agent-spec.md` が並走 subagent によって変更中、
  `docs/specs/codecommit-web-embedded-auto-setup.md` が untracked で生成中。
  実装フェーズ突入前に `git status` で再確認すること。
- 直近 5 コミット (新しい順):
  - `309b5d9` chore(makefile,docs): integrate docker-compose.dev.yml into
    local-dev workflow
  - `aeb20ad` chore(server): add Makefile + server dev entry for local
    development
  - `f942f16` feat(web): add Brutalist Editorial dashboard SPA (packages/web)
  - `bc68d75` feat(server): add /api REST namespace with bearer-token auth
  - `c574331` feat(core,db): add repos table for dashboard registry

### 2.2 完了済み機能

- `packages/web` (新規) — React + Vite SPA、Brutalist Editorial デザイン、
  8 ページ + tests 52 pass。
- `packages/server/src/api/` — `/api` REST + bearer token auth + 全エンドポイント、
  tests 353 pass、branches 90.37%。
- `packages/core/src/db/schema/repos.ts` — repos テーブル schema
  (drizzle-kit migration は **未生成**)。
- `Makefile` + `docker-compose.dev.yml` + dev workflow。

### 2.3 検証状況

- `pnpm typecheck` / `pnpm lint` / `pnpm test:coverage` / `pnpm build`:
  全 green (前回セッション末で確認済)。
- 全 pnpm パッケージで coverage threshold 90% branches 維持。

## 3. このセッションで合意した実装計画 (未着手)

### 3.1 Scope

「CodeCommit を web から連携 → PR 作成時にフルレビュー、追加 push で差分
レビュー」を実現する。詳細は併読資料
[codecommit-web-embedded-auto-setup.md](./codecommit-web-embedded-auto-setup.md)
を参照。

### 3.2 確定した設計判断 (brainstorming 済、次セッションで relitigate 不要)

1. **Option 1+: web embedded auto-setup**
   (CodeCommit polling は不採用、AssumeRole は不採用)。
2. **server runtime role に直接 `codecommit:*` / `sns:*` / `events:*` を付与**
   (cross-account は将来 issue へ分離)。
3. **per-repo EventBridge rule** (共通 rule ではなく)。
4. **SNS topic ARN allowlist は DB lookup へ移行**
   (env CSV は段階移行用に併用)。
5. **`repos` テーブルに追加カラム** (別表でなく)。
6. **PR 作成時 = source vs destination 全 diff レビュー**
   (GitHub Action と同じモデル)。
7. **追加 push 時 = `lastReviewedSha` と現在の `sourceCommit` の差分**、
   rebase 検知ならフル fallback。

### 3.3 Phase A 調査で発覚した blocker (必須対処)

**server worker JobHandler 本体が未実装**。
`packages/server/src/lambda-worker.ts:22-43` の `JobHandler` 型は定義されて
いるが、SQS から取り出した job を実行する path が存在しない。

→ CodeCommit web embedded auto-setup を入れる前に、**全 platform 共通基盤**
として実装する必要がある (Phase C0)。

## 4. 実装フェーズと推定工数

設計仕様 §14 と同じ表を、dispatch 単位で再分割した版を以下に掲載する。

| Phase | 内容                                                                                                  | 推定        | 依存                  |
| ----- | ----------------------------------------------------------------------------------------------------- | ----------- | --------------------- |
| C0    | server core: DB schema + JobHandler 本体 + 差分配線 + tests                                           | 4-5 人日    | 単独先行              |
| C1a   | server aws: AWS SDK (SNS/EB) + `POST/DELETE /api/repos` 拡張 + webhook DB allowlist                   | 3 人日      | C0                    |
| C1b   | web UI: `repos-new` フォーム + `integrations` 拡張 + `repo-detail` teardown ボタン                    | 3 人日      | C0 (型契約)           |
| C1c   | docs: IAM policy + setup guide + spec 更新                                                            | 0.5 人日    | C0                    |
| C2    | 統合 verify + 型整合 + 必要なら追加 tests                                                             | 1 人日      | C1a/b/c 完了          |

## 5. 次セッションでの dispatch テンプレ

### 5.1 Phase C0 (sequential 必須・最初に投入)

**主要 prompt 要点**:

- 担当ファイル:
  - `packages/server/src/job-handler.ts` (新規)
  - `packages/core/src/db/schema/repos.ts` (列追加)
  - `packages/server/src/lambda-worker.ts` 又は `serverless.ts`
    (JobHandler 接続)
- 事前 Read 必須:
  - `packages/runner/src/agent.ts` (`runReview` signature)
  - `packages/action/src/run.ts:105-179` (差分レビュー実装の参考)
  - `packages/core/src/db/schema/review-state.ts`
- 振る舞いマトリクス:

  | `review_state`        | `baseCommit`     | 挙動            |
  | --------------------- | ---------------- | --------------- |
  | 無し                  | —                | フル            |
  | あり                  | 同じ             | 差分            |
  | あり                  | 変わった         | フル fallback   |
  | repo deleted/disabled | —                | no-op           |

- 検証:
  `pnpm --filter @review-agent/server typecheck/lint/test:coverage/build`
  全 green、branches >= 90%。

### 5.2 Phase C1a/b/c (C0 完了後、並列で投入)

#### C1a server-aws の prompt 要点

- 担当:
  - `packages/server/src/api/repos.ts` (POST/DELETE 拡張)
  - `packages/server/src/api/aws-setup.ts` (新規・SNS/EB SDK ラップ)
  - `packages/server/src/handlers/codecommit-webhook.ts`
    (allowlist DB lookup)
- POST `/api/repos { platform: 'codecommit', name, awsRegion }` の同期フロー:
  SNS create → EB rule create → SNS subscribe →
  server 自身が SubscriptionConfirmation を確認。
- DELETE `/api/repos/:id` の teardown
  (EB → subscription → topic → DB soft-delete)。
- env allowlist と DB allowlist の **OR 評価**。
- 失敗時の part teardown (best-effort)。

#### C1b web-ui の prompt 要点

- 担当:
  - `packages/web/src/pages/repos-new.tsx` (CodeCommit フォーム拡張)
  - `packages/web/src/pages/integrations.tsx` (状態カード拡張)
  - `packages/web/src/pages/repo-detail.tsx`
    (AWS リソース表示 + teardown ボタン)
  - `packages/web/src/api/{client,types,mocks}.ts` (新規エンドポイント追加)
- 型契約は C0 で確定した `RepoDetail` に `awsRegion` / `snsTopicArn` /
  `eventBridgeRuleArn` / `setupStatus` / `setupError` を追加。
- 各ページに smoke test 追加。

#### C1c docs の prompt 要点

- 担当:
  - `docs/operations/codecommit-web-setup.md` (新規)
  - `docs/security/iam-policy.md` (新規 or 既存に追記)
  - `docs/specs/review-agent-spec.md` (該当 § 更新)
- IAM policy JSON サンプル (最小権限)。
- operator 向け setup ガイド。

## 6. 未解決の 6 件 (本機能とは別の課題、issue 化候補)

1. **`queueDepth` ハードコード 0** —
   SQS `GetQueueAttributes` を `/api/dashboard/overview` に配線。
2. **`installationCount` ハードコード 0** —
   GitHub App installations を DB 列に保存 or キャッシュ。
3. **`systemPromptAtReview` スナップショット** —
   `review_eval_event` に `system_prompt` 列を追加して、review 実行時に書き込み。
4. **`/api/reviews` total platform フィルタ未適用** —
   `COUNT` クエリに `platform` join を加える。
5. **401 専用 UI** —
   global `QueryCache.onError` で 401 検出 → sticky banner。
6. **drizzle-kit migration 生成** —
   `repos` テーブル (本セッションで schema 追加した) + 上記 #3 の
   `system_prompt` 列が追加されたら一括 generate。

各 issue の Acceptance Criteria は次セッションで `gh issue create` するときに
記述する。

## 7. 次セッションの推奨フロー

1. `git status` で working tree clean を確認 (前回セッション分のコミットが済
   んでいることも併せて確認)。
2. 本ファイル + `codecommit-web-embedded-auto-setup.md` を読む。
3. Phase C0 を 1 subagent で起動 (本書 §5.1 のテンプレ)。
4. 完了通知を待つ (実時間 30-60 分見込み)。
5. 報告内容を確認、検証コマンドが全 green か確かめる。
6. Phase C1a/b/c を 3 subagent 並列起動 (本書 §5.2 のテンプレ)。
7. 全完了後に統合 verify subagent を起動。
8. ユーザにコミット分割 plan を提示
   (`feat(core,db,server): ...` / `feat(web): ...` / `docs: ...` 等)。
9. 承認後コミット。
10. push はユーザ明示承認後。

## 8. オープン質問 (次セッションで決める)

- subscription endpoint は HTTPS (server URL) 固定でよいか、Lambda invocation
  にする選択肢を operator に提供するか。
- AWS リソース命名規則: `review-agent-<repo-slug>-sns` 系。長さ制限
  (SNS 256 文字、EB rule 64 文字) で repo 名衝突時の suffix 戦略。
- `setup_status` の retry: 失敗時に web から「Retry setup」ボタンを押せる
  ようにするか、operator が DELETE → POST しなおすか。
- env CSV 廃止のタイミング (マイナーバージョン跨ぎ?)。

## 9. 関連ファイル参照 (file:line)

Phase A subagent が見つけた重要 file path を再掲。次セッションがすぐに該当
箇所を見られるように。

- `packages/server/src/lambda-worker.ts:22-43` —
  `JobHandler` 型 (実装未)
- `packages/server/src/handlers/codecommit-webhook.ts:106-307` —
  SNS イベントハンドラ既存実装
- `packages/server/src/handlers/codecommit-webhook.ts:231-245` —
  `SubscriptionConfirmation` 自動 confirm
- `packages/server/src/app.ts:89, 232` —
  SNS topic allowlist env 参照
- `packages/platform-codecommit/src/adapter.ts:127` —
  `CodeCommitClient` instantiation (AssumeRole 不要設計)
- `packages/platform-codecommit/src/adapter.ts:170-189` —
  `getDiff` with `sinceSha` support
- `packages/core/src/db/schema/repos.ts` —
  本セッションで追加
- `packages/core/src/db/schema/review-state.ts:14-36` —
  `lastReviewedSha` / `baseSha`
- `packages/runner/src/agent.ts:150-155` —
  `incrementalContext` / `incrementalSinceSha`
- `packages/action/src/run.ts:105-179` —
  GitHub Action 差分レビュー実装 (参考)
- `packages/server/src/api/repos.ts` —
  POST/PATCH/DELETE 拡張先
- `packages/web/src/pages/repos-new.tsx` —
  フォーム拡張先
- `packages/web/src/pages/repo-detail.tsx` —
  teardown UI 追加先

## 10. 検証チェックリスト (全実装完了時)

- [ ] `pnpm typecheck` 全パッケージ green
- [ ] `pnpm lint` 全パッケージ green
- [ ] `pnpm test:coverage` で branches 90% 維持 (server / web)
- [ ] `pnpm build` green
- [ ] `docker-compose.dev.yml` + `make db-up` で Postgres 起動可能 (既存)
- [ ] `make db-migrate` で `repos` テーブル + 拡張カラム +
      `system_prompt` 列 (任意) が作成される
- [ ] POST `/api/repos { platform: 'codecommit', name, awsRegion }` で
      AWS リソース 3 種が作成される (SNS topic / EB rule / subscription)
- [ ] DELETE `/api/repos/:id` で AWS リソース 3 種が削除される
- [ ] CodeCommit に PR を作成 → 30 秒以内に dashboard `/history` に新規 entry
- [ ] 同 PR に push → 差分レビューが走り、`lastReviewedSha` が更新される
- [ ] 同 PR を rebase → フルレビューに fallback
- [ ] `/api/integrations` の CodeCommit カードに `status: ready`
