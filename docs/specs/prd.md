# review-agent — プロダクト仕様書 (PRD)

> セルフホスト型・マルチプロバイダ対応のAIコードレビューエージェント。OSS、Apache 2.0。
>
> **本書はプロダクトが「何であり、誰のためのものか」を定義する。**
> 実装仕様は `review-agent-spec.md` を参照。
>
> Version: 1.0.0 (2026-04-30、Status 行を 2026-05-15 に更新)
> Status: **v1.0 出荷済み（2026-05-15）**。v0.1〜v0.3 と v1.0 マイルストーンの 46 issue がすべて closed。`docs/roadmap.md` 参照。本書の野心的目標（OSS 採用、コミュニティ形成、外部コントリビュータ、ガバナンス体制等）は **v1.x+ 以降の将来構想** として位置付け、現フェーズでは外部コントリビューションを受け付けない個人プロジェクトとして運用する（`README.md` 参照）。
> Owner: 未定（§10 参照）

---

## 1. エグゼクティブサマリ

`review-agent` は、利用者自身のインフラで動作するOSSのAIコードレビューエージェントである。プルリクエストごとにインラインレビューコメントとサマリを投稿し、「skill」と呼ばれる合成可能なルールセットでチーム独自の規約を反映できる。LLM プロバイダは Claude / OpenAI / Gemini / Azure OpenAI / Bedrock / Vertex / OpenAI 互換ローカルモデル（Ollama・vLLM・OpenRouter 等）から**リポジトリ単位で選択可能**。

このプロジェクトは AI コードレビュー市場の空白を埋めることを目指す：**セルフホスト前提でプロバイダを選べ、深くカスタマイズできる**プロジェクト。既存ツールはこの組み合わせを完全には満たしていない（CodeRabbit Pro / GitHub Copilot Workspace は SaaS のみ、PR-Agent OSS は Python のみで skill エコシステムなし、英語のみ）。

**ワンライナー**：「自分の LLM、自分のインフラ、自分のルール」。

---

## 2. ビジョンと戦略目標

### 2.1 ビジョン（将来構想）

> **注**: 本セクションは v1.0+ 以降の将来構想。現フェーズ（v0.1〜v1.0）は個人プロジェクトとして開発し、外部コミュニティ形成は v1.0 以降に判断する。

2 年後、`review-agent` は「ベンダーホスト型 SaaS を使えない / 使いたくない組織」にとっての OSS コードレビュー標準となっている。プロジェクトの評価は次の3つで築かれる：

1. **透明性による信頼** — コードは監査可能、脅威モデルは公開、prompt injection 対策は red-team でテスト済み
2. **現実のチームに合うカスタマイズ性** — skill による組織固有ルール、言語別デフォルト、母国語での出力
3. **プロバイダ中立性** — Claude でも OpenAI でも Gemini でも Llama でも同じ動作。ベンダーロックインなし

### 2.2 戦略目標（v1.0+ 将来構想 / 12ヶ月）

> **注**: 採用・コミュニティ系の指標は OSS 公開を前提とした将来目標。現フェーズで達成すべき指標は §16 リリース基準を参照。

| 目標 | 計測可能な指標 | フェーズ |
|---|---|---|
| 品質 | golden PR セットでコメント受容率 75% 以上、false positive 率 15% 未満 | v0.1〜 |
| コスト | デフォルトモデルで PR 中央値 $0.50 未満 | v0.1〜 |
| セキュリティ | CVSS 7.0 以上の脆弱性ゼロ | v0.1〜 |
| ドキュメント | 全 3 クラウドのデプロイガイドで 30 分以内のオンボーディング | v0.3〜 |
| 採用 | GitHub Action と Server モード合計でアクティブ install 1,000+ | v1.0+ 将来 |
| 国際展開 | 日本企業ユーザ 5+（競合がカバーしきれていない層） | v1.0+ 将来 |
| コミュニティ | 外部コントリビュータ 50 名以上、メンテナ 5 名以上 | v1.0+ 将来 |

### 2.3 Non-goals（明示的に取らない方針）

- **SaaS 提供はしない**。利用者は各自の LLM API キーで自分のインスタンスを動かす。`review-agent.com` の運営はしない
- **コードは書き換えない**。ソースは読み取り、コメント投稿のみ。commit / push / ファイル編集 / PR 作成はしない
- **モデル学習はしない**。学習データは収集しない。推論のみ
- **特定ベンダーとの排他的提携はしない**。プロバイダ中立性は譲らない
- **ベンダー専用機能の侵食は許さない**。機能は「全プロバイダで動く」か「コアに入らない」のいずれか。プロバイダ最適化は opt-in でモジュール分離
- **GitLab / Bitbucket アダプタは v1.x では対応しない**。Post-v1.0 で着手
- **IDE 統合は v1.x では対応しない**。Web / PR コメント面のみ

---

## 3. 課題の定義

### 3.1 市場のギャップ

エンジニアリング組織は AI コードレビューを欲している。しかし既存の選択肢はトレードオフを強いる：

| ツール | セルフホスト可? | プロバイダ選択可? | Skill レベルのカスタマイズ可? | 日本語品質 |
|---|---|---|---|---|
| CodeRabbit Pro (SaaS) | ✗ | ✗（ベンダー固定） | 部分的 | 弱い |
| GitHub Copilot Workspace | ✗ | ✗ | ✗ | 弱い |
| Sourcegraph Cody | 部分的 | 部分的 | 弱い | 弱い |
| Qodo Merge (商用) | ✗ | 部分的 | 部分的 | 弱い |
| PR-Agent OSS | ✓ (Python) | ✓ via LiteLLM | 弱い（skill 形式なし） | 弱い |
| coderabbitai/ai-pr-reviewer | ✓ (TS、放棄) | ✗ (OpenAI のみ) | なし | なし |
| **review-agent (本プロジェクト)** | **✓** | **✓** | **✓ (skills)** | **✓** |

**ギャップ**：セルフホスト × プロバイダ柔軟 × skill カスタマイズ × 多言語対応。この4つすべてを満たすツールは存在しない。

### 3.2 解決する顧客の課題

**データレジデンシー / コンプライアンス**：
> 「弊社の PR 差分は社内インフラから出せない。AWS / GCP / Azure 上で、リージョン内 LLM エンドポイント (Bedrock / Vertex / Azure OpenAI) と通信する形でエージェントを動かしたい」

**ベンダーリスク**：
> 「CI フィードバックループ全体を一つの LLM ベンダーに依存させない。価格や可用性が変わったら数分でプロバイダを切り替えたい」

**カスタマイズ**：
> 「弊社のコーディング規約には、公開 LLM が知り得ないルールが含まれる — 内部パターン、セキュリティ方針、命名規約。フォークせずにこれらを注入したい」

**言語**：
> 「チームは日本語で仕事をしている。コードレビューが英語だと、議論の往復コストが高すぎて使い物にならない」

**コストの予測可能性**：
> 「LLM 利用料金が暴走するリスクのあるツールは導入しない。PR 単位 / 日次の上限が advisory でなく hard enforcement されている必要がある」

---

## 4. ターゲットユーザ

> **注**: P1〜P3 は v0.1〜 の現フェーズから想定するユーザ（オーナー本人を含むセルフホスト利用者）。P4〜P7 は v1.0+ 以降の OSS 公開後を見据えた将来想定ペルソナ。

### 4.1 主要ペルソナ

**P1：中規模企業のプラットフォームエンジニア (50〜500人規模)**

- 環境：GitHub Enterprise Cloud、AWS or GCP、Terraform、Datadog/Grafana
- 課題：承認済み AI ツールが限られ、データポリシーで PR 差分を第三者 SaaS に送るのは禁止。エンジニア組織から AI レビュー導入の要望
- 成功条件：社内 AWS に review-agent をデプロイ、Bedrock Claude を指す、30 リポに GitHub App をインストールして 2 週間で本番化

**P2：日本のスタートアップのシニアエンジニア / テックリード (10〜80人規模)**

- 環境：GitHub、GCP or AWS、TypeScript / Go / Python のモノレポ
- 課題：既存 AI レビューアは英語で返信、議論の往復で生産性が落ちる。社内コーディングルール（エラーは wrap、TS で any 禁止 等）が一貫して enforced されない
- 成功条件：GitHub Action 追加 → チームルールを日本語 skill で 3 本書く → 日本語で自社トーンのレビューが返ってくる

**P3：セキュリティ / コンプライアンスエンジニア**

- 環境：Splunk / SIEM、監査ログ、セキュリティスキャナ
- 課題：AI ツール採用には脅威モデル・データフロー開示・インシデント対応計画が必要。SaaS ベンダーはこれらの提供が遅い
- 成功条件：SECURITY.md を読む → eval suite から red-team テスト実行 → 自信を持って導入承認

**P4：OSS メンテナー（小規模プロジェクト）**

- 環境：GitHub 無料枠、インフラ予算なし
- 課題：PR レビュー待ちがボトルネック、初参加コントリビュータが離脱
- 成功条件：GitHub Action 追加、`ANTHROPIC_API_KEY` 設定、月 $10 程度で全 PR に妥当なレビュー

### 4.2 二次ペルソナ

- **P5：エンジニアリングマネージャ** — チーム導入の評価
- **P6：外部コードレビューア** — コンサル / 監査でクライアントリポに転用
- **P7：研究者** — AI コードレビュー効果を研究、再現性と eval ハーネスを重視

### 4.3 アンチペルソナ（対象外のユーザ）

- 個人 IDE での AI 利用が目的の趣味エンジニア（Cursor / Copilot を使うべき）
- ベンダー SLA 付き SaaS を望むエンジニアリング組織（CodeRabbit Pro を使うべき）
- レビュアにコード修正までさせたいチーム（本プロジェクトは設計上 read-only）

---

## 5. ユーザストーリー

### 5.1 コアストーリー (v0.1)

**US-1**：**メンテナー**として、3 行のワークフローファイルと `ANTHROPIC_API_KEY` シークレットだけで GitHub Action として review-agent をリポにインストールしたい。これにより、インフラ運用なしですべての PR に AI レビューが付く。

**US-2**：**テックリード**として、`.review-agent.yml` をリポにコミットして LLM プロバイダ（`anthropic`、`openai` 等）とモデルを指定したい。これによりチームが「何の AI が我々のコードをレビューするか」をコントロールできる。

**US-3**：**PR 作成者**として、severity（重要度）と具体的な提案を含む見やすいインラインコメントを受け取りたい。フォローアップなしで対処できる。

**US-4**：**PR 作成者**として、`@review-agent pause` コメントで自 PR のレビューを止め、`@review-agent resume` で再開したい（イテレーション中はノイズが邪魔）。

**US-5**：**日本語エンジニア**として、コメント本文は日本語、コード識別子・ファイルパスはそのまま英語で受け取りたい。

**US-6**：**セキュリティエンジニア**として、脅威モデル・prompt injection 対策・24 時間 SLA の脆弱性報告窓口が記載された SECURITY.md を読みたい。導入承認の根拠になる。

### 5.2 Server / セルフホストストーリー (v0.2)

**US-7**：**プラットフォームエンジニア**として、AWS Lambda + SQS + RDS の webhook サーバを `terraform apply` 一発でデプロイしたい。組織内全リポを 1 インストールで処理できる。

**US-8**：**CISO**として、PR 差分を AWS アカウント外に出したくない。他ワークロードと同じデータレジデンシーで Bedrock を利用する。

**US-9**：**組織管理者**として、GitHub installation ごとに日次の使用上限を設定し、暴走 PR が予算を食いつぶさないようにしたい。

**US-10**：**運用者**として、コントリビュータが追加で 5 commit プッシュしたとき、PR 全体ではなく新規コードだけを再レビューする incremental review を期待する。

### 5.3 カスタマイズストーリー (v0.2 〜 v0.3)

**US-11**：**テックリード**として、チームのコードルール（命名・エラーハンドリング・テストパターン）を Markdown で書き、review-agent に PR ごとに enforcement させたい。

**US-12**：**バンドル skill 利用者**として、`@review-agent/skill-owasp-top10` を config に追加するだけで OWASP 系の問題が自動検出されてほしい。

**US-13**：**エンジニアリングマネージャ**として、`<org>/.github` 内の単一 `review-agent.yml` を 100 リポすべてに適用し、ポリシーを集中管理したい。

### 5.4 マルチテナントストーリー (v0.3)

**US-14**：**MSP / コンサル**として、複数クライアント GitHub installation を 1 つの review-agent デプロイで処理し、各クライアントのデータ・コスト・設定を厳密に分離したい。

**US-15**：**運用者**として、各テナントが自分の Anthropic / OpenAI 等 API キーを持参 (BYOK) し、保存時暗号化、ログ非記録を保証したい。

### 5.5 クロスクラウドストーリー (v0.3)

**US-16**：**GCP ネイティブチーム**として、Cloud Run + Pub/Sub + Cloud SQL でデプロイし、リージョン内 Vertex AI で Claude / Gemini を利用したい。

**US-17**：**Azure ネイティブチーム**として、Container Apps + Service Bus + Azure DB for PostgreSQL でデプロイし、リージョン内 Azure OpenAI を利用したい。

---

## 6. 機能要件

各 FR にはトレーサビリティ用の ID を付与。**MUST** = リリース時必須、**SHOULD** = 強く推奨、**MAY** = 任意。

### 6.1 レビュー生成 (FR-R)

| ID | 要件 | リリース |
|---|---|---|
| FR-R-1 | 検出した issue に対し、PR diff の行にインラインコメントを投稿**しなければならない** | v0.1 |
| FR-R-2 | 各コメントは severity（`critical` / `major` / `minor` / `info`）、説明、（該当する場合）修正提案を含**まなければならない** | v0.1 |
| FR-R-3 | レビューごとにサマリコメントを 1 件投稿し、概要と severity 別件数を含**まなければならない** | v0.1 |
| FR-R-4 | GitHub PR (v0.1) と AWS CodeCommit PR (v0.2) をサポート**しなければならない** | v0.1, v0.2 |
| FR-R-5 | 設定で明示的に範囲拡張しない限り、変更ファイルのみレビュー**しなければならない** | v0.1 |
| FR-R-6 | 同じ findings が再レビューで重複しないよう、fingerprint（file, line, rule, suggestion type）で dedup**しなければならない** | v0.1 |
| FR-R-7 | `pull_request.opened` / `synchronize` / `reopened` イベントでレビューを実行**するべき**。連続 push に対しては debounce する | v0.1 |

### 6.2 LLM プロバイダ対応 (FR-P)

| ID | 要件 | リリース |
|---|---|---|
| FR-P-1 | デフォルトプロバイダとして Anthropic Claude をサポート**しなければならない** | v0.1 |
| FR-P-2 | OpenAI を設定可能なプロバイダとしてサポート**しなければならない** | v0.2 |
| FR-P-3 | Azure OpenAI、Google Gemini、Vertex AI、AWS Bedrock、および任意の OpenAI 互換 HTTP エンドポイント (Ollama, vLLM, OpenRouter, LM Studio) をサポート**しなければならない** | v0.3 |
| FR-P-4 | プロバイダとモデルはリポジトリごとに `.review-agent.yml` で選択可能で**なければならない** | v0.1 |
| FR-P-5 | プライマリの rate-limit / availability エラー時、設定可能なフォールバックモデルへ切り替え**なければならない** | v0.1 |
| FR-P-6 | 内部プロンプトは出力言語に関係なく**英語固定**で**なければならない**（プロバイダ性能の一貫性のため） | v0.1 |
| FR-P-7 | 出力（コメント）言語はリポジトリ単位および環境変数で設定可能で**なければならない** | v0.1 |

### 6.3 カスタマイズ (FR-C)

| ID | 要件 | リリース |
|---|---|---|
| FR-C-1 | ユーザは `.review-agent/skills/` 配下に skill (Markdown + YAML) を配置して組織独自ルールを注入できる**べき** | v0.1 |
| FR-C-2 | npm 配布の `@review-agent/skill-*` skill をロードでき、SHA-256 manifest で完全性を検証**しなければならない** | v0.3 |
| FR-C-3 | Skill はファイルパス glob (`applies_to`) でフィルタ可能で**なければならない** | v0.1 |
| FR-C-4 | レビュー対象パスの絞り込み・除外 (`path_filters`, `path_instructions`) を**サポートすべき** | v0.1 |
| FR-C-5 | レビュートーン (`profile: chill | assertive`) を選択可能で**なければならない** | v0.1 |
| FR-C-6 | 組織は `<org>/.github/review-agent.yml` で集中管理**できる** | v1.0 |

### 6.4 コスト・リソース制御 (FR-CR)

| ID | 要件 | リリース |
|---|---|---|
| FR-CR-1 | PR 単位 USD 上限を強制し、超過時は hard abort**しなければならない** | v0.1 |
| FR-CR-2 | Installation 単位の日次 USD 上限をサポート**しなければならない** | v0.3 |
| FR-CR-3 | 各 LLM 呼び出し前にコスト見積もりし、残予算超過時は呼び出しを拒否**しなければならない** | v0.2 |
| FR-CR-4 | Incremental review（最終レビュー以降の新規 commit のみ対象）をサポート**しなければならない** | v0.2 |
| FR-CR-5 | Workspace サイズ・ファイル数・diff 行数に上限を設け、graceful degradation で対応**しなければならない** | v0.1 |

### 6.5 配布形態 (FR-D)

| ID | 要件 | リリース |
|---|---|---|
| FR-D-1 | ワークフローファイル追加だけで 5 分以内にインストールできる GitHub Action として配布**しなければならない** | v0.1 |
| FR-D-2 | AWS Lambda + SQS / GCP Cloud Run + Pub/Sub / Azure Container Apps + Service Bus / Kubernetes / docker-compose にデプロイ可能な webhook server として配布**しなければならない** | v0.2 (AWS), v0.3 (GCP, Azure, Helm) |
| FR-D-3 | 指定 PR を一回だけレビューする CLI を提供**しなければならない** | v0.2 |
| FR-D-4 | 3 形態すべてが**同じコード**・**同じ設定**・**同じ skill エコシステム**を共有**しなければならない** | 全リリース |

### 6.6 セキュリティ・プライバシー (FR-S)

| ID | 要件 | リリース |
|---|---|---|
| FR-S-1 | Webhook receiver は HMAC-SHA256 署名を毎リクエスト検証し、constant-time 比較を**使わなければならない** | v0.2 |
| FR-S-2 | gitleaks による diff スキャンと file-read スキャン両方を実施し、検出時は LLM 送信前に redact**しなければならない** | v0.1 |
| FR-S-3 | LLM-based detector で untrusted PR コンテンツ（title, body, comments）を prompt injection 分類**しなければならない** | v0.3 |
| FR-S-4 | LLM に対して `read_file` / `glob` / `grep` 以外のツール（write、shell、ネットワーク）を露出**してはならない** | v0.1 |
| FR-S-5 | LLM 出力を Zod スキーマ検証し、違反時は 1 回のみ retry**しなければならない** | v0.1 |
| FR-S-6 | デフォルトでメッセージ本文・差分全文・LLM 出力をログ**してはならない** | v0.1 |
| FR-S-7 | 全 API キー / トークンを runtime に managed secret store (AWS Secrets Manager / GCP Secret Manager / Azure Key Vault) から取得**しなければならない**。本番でイメージや env に焼き込まない | v0.2 |
| FR-S-8 | Per-installation BYOK secret は envelope encryption で保存時暗号化**しなければならない** | v0.3 |
| FR-S-9 | 全テーブルで Postgres Row-Level Security によりテナント分離**しなければならない** | v0.3 |

### 6.7 オブザーバビリティ (FR-O)

| ID | 要件 | リリース |
|---|---|---|
| FR-O-1 | ジョブごとに OpenTelemetry トレースを emit**しなければならない** | v0.2 |
| FR-O-2 | レビュー件数・レイテンシ・トークンコスト・コメント受容率のメトリクスを emit**しなければならない** | v0.2 |
| FR-O-3 | HMAC チェーンによる改ざん検知付きの append-only 監査ログを保持**しなければならない** | v0.3 |

---

## 7. 非機能要件

| ID | カテゴリ | 要件 |
|---|---|---|
| NFR-1 | 性能 | 典型的な 10 ファイル PR は Lambda + Sonnet 4.6 で 60 秒以内にレビュー完了**しなければならない** |
| NFR-2 | 性能 | GitHub への webhook 確認応答は 10 秒以内に 2xx を返**さなければならない** |
| NFR-3 | コスト | デフォルト設定での PR 中央値コストは $0.50 未満で**あるべき** |
| NFR-4 | 信頼性 | 1 ジョブの失敗が他のジョブに影響**してはならない**（テナント分離） |
| NFR-5 | スケーラビリティ | アーキテクチャは installation あたり日次 10,000 レビューまで再設計なしで対応**しなければならない** |
| NFR-6 | セキュリティ | CVSS 7.0 以上の脆弱性は 7 日以内に patch + 開示**しなければならない** |
| NFR-7 | プライバシー | デフォルトインストールはプロジェクトメンテナへの opt-in なしのテレメトリ送信を**してはならない** |
| NFR-8 | 移植性 | 同一コードが Node.js 24 LTS / AWS Lambda / GCP Cloud Run / Azure Container Apps / Kubernetes / docker-compose で動作**しなければならない** |
| NFR-9 | ドキュメント | 新規コントリビュータがローカル開発環境を 10 分以内にセットアップできる**べき** |
| NFR-10 | ドキュメント | 新規運用者が 30 分以内に各クラウドへデプロイできる**べき**（per-cloud README に従って） |
| NFR-11 | 互換性 | API 破壊的変更は SemVer メジャーバンプとし、UPGRADING.md で移行手順を提供**しなければならない** |
| NFR-12 | 国際化 | コメント出力は最低でも en-US, ja-JP, zh-CN, ko-KR, de-DE, fr-FR, es-ES, pt-BR をサポート**しなければならない** |

---

## 8. 成功指標

> **注**: §8.1 採用、§8.5 コミュニティは v1.0+ 以降の OSS 公開を前提とした将来指標。現フェーズ（v0.1〜v1.0）で計測すべきは §8.2 品質、§8.3 性能・コスト、§8.4 信頼性。

### 8.1 採用 (lagging) — v1.0+ 将来指標

- **インストール数**：unique GitHub App + Action ワークフローで action を pull した数
- **アクティブ installation (30日)**：直近 30 日に 1 回以上レビューを実行した installation
- **GitHub stars**：vanity metric だが関心の指標
- **npm 週間ダウンロード**：ライブラリ採用追跡
- **Docker image pulls**：server-mode 採用追跡

### 8.2 品質 (leading & lagging)

- **コメント受容率**：投稿したインラインコメントのうち "resolved" マークされた割合（dismiss と対比）。目標 75% 以上
- **False positive 率**：レビュアに「誤検出」として dismiss されたコメントの割合。目標 15% 未満
- **カバレッジ率**（eval のみ）：golden PR セットの既知バグのうち critical/major で検出できた割合。目標 80% 以上
- **ノイズ率**（eval のみ）：clean code 100 行あたりのコメント数。目標 2 未満

### 8.3 性能・コスト

- **p50 / p95 レビューレイテンシ**（webhook 受信 → レビュー投稿の wall time）
- **p50 / p95 PR あたりコスト**
- **キャッシュヒット率**（prompt caching 対応プロバイダ）

### 8.4 信頼性

- **Receiver の uptime**（テレメトリを共有しているセルフホスト install のみ）
- **ジョブフェーズ別エラー率** (clone / scan / LLM call / post)
- **Webhook 5xx 率**（0.1% 未満であるべき）

### 8.5 コミュニティ・エコシステム — v1.0+ 将来指標

- **マージ済み PR を持つ外部コントリビュータ数**
- **`@review-agent/skill-*` および第三者から公開された skill パッケージ数**
- **Issue 応答時間**（メンテナ初回応答までの中央値）

### 8.6 反実仮想（価値の証明）

パイロット導入で計測する：

- **レビューキューの深さ**（24 時間以上人間レビュー待ちの PR 数）。期待：30% 以上削減
- **バグ流出率**（agent が flag したが人間が dismiss し、main に到達したバグ）。目標 5% 未満

---

## 9. 競合分析

### 9.1 直接競合

**CodeRabbit Pro** (SaaS、クローズドソース)。UX が最も洗練。英語レビュー品質が高い。ベンダーロック、セルフホスト不可、日本語弱い。
*我々のポジショニング*：セルフホスト相当機能、BYOK、多言語対応。

**Qodo Merge / PR-Agent OSS** (Python)。成熟した OSS、複数 VCS 対応。だが Python のみで skill エコシステムなし。最近 Qodo がコミュニティに donate。
*我々のポジショニング*：TypeScript native（serverless DX が優れる）、Vercel AI SDK によるプロバイダ抽象化、skills first のカスタマイズ。

**Sourcegraph Cody** (Hybrid)。IDE 中心、PR レビューは副次的。
*我々のポジショニング*：PR レビューに特化。

**GitHub Copilot Workspace** (クローズド SaaS)。GitHub と密結合。
*我々のポジショニング*：クラウドポータブル、GCP/Azure/k8s でも動く。

**coderabbitai/ai-pr-reviewer** (TS、放棄)。CodeRabbit OSS 初代、メンテナンスモード。
*我々のポジショニング*：精神的後継者、現代的スタックとアクティブ開発。

### 9.2 間接競合

- 静的解析 (Semgrep, CodeQL)：別カテゴリ — ルールベース、AI ではない。入力ソースとして統合
- IDE コーディングアシスタント (Cursor, Copilot, Continue)：edit 時、PR 時ではない。補完的

### 9.3 防御可能な差別化

1. **プロバイダ中立性** — LLM 市場の進化に対する持続的優位
2. **Skill エコシステム** — コミュニティのネットワーク効果で防御可能
3. **日本語品質** — 支払意欲のある未開拓セグメント
4. **OSS ライセンス + セルフホスト** — 規制対象顧客に対して任意の SaaS 競合に対する防御可能性

### 9.4 我々が競争できないこと

- **ベンダー SLA / 24/7 サポート** — OSS であり、ユーザが自分のデプロイを所有
- **クローズドソースの機能速度** — SaaS 競合は私的機能を速く出せる。我々は透明性とカスタマイズ性で勝つ

---

## 10. 未解決事項

v0.1 リリース前に解決が必要。番号は実装仕様書 §22 のオープン質問と対応（同番号）。実装仕様書側で resolved 扱いの項目（#6, #15）は除外。本 PRD 独自の項目には `(PRD-only)` を付記。

1. **プロジェクト命名** — `review-agent` か scoped `@review-agent/*` か。launch 前に npm 可用性確認
   → **暫定決定**: scoped `@review-agent/*` + unscoped `review-agent` CLI（本セッションで合意）
2. **GitHub repo URL** — canonical OSS の置き場所。バッジ・docs・npm パッケージメタデータに影響
   → **暫定決定**: `github.com/almondoo/review-agent`（本セッションで確認）
3. **Anthropic Workspace setup CLI** — `review-agent setup workspace` で ZDR + spend caps を補助するか
4. **v0.1 でのバンドル skill 範囲** — `@review-agent/skill-*` namespace と starter 5 本を出すか、ユーザ提供 skill のみにするか
5. **コメント投稿時の Bot identity** — Action モードでは `github-actions[bot]`、Server モードでは App 自身の actor。dedup を正しく機能させる
7. **Renovate / Dependabot PR の扱い** — デフォルトでレビュー / スキップ / summary-only のいずれか
8. **Draft PR の扱い** — ready-for-review までスキップ / 全 push でレビュー
9. **複数 review bot 衝突** — `coderabbitai[bot]` 等が同居する場合の重複回避
10. **OSS テレメトリ opt-in** — 匿名利用統計を出すか? 出すなら何を、どう同意取得するか
11. **GHES (Enterprise Server) 互換性** — declared support / no-support / "best-effort" のどれか
    → **v1.0 決定**: `best-effort, no commitment`。CI で GHES を回さず、issues は受けるが PR は受けない。詳細は [`docs/deployment/ghes.md`](../deployment/ghes.md)。
12. **プロバイダ feature parity matrix の公開** — eval 結果 delta を docs に出すか
13. **OpenAI 互換エンドポイント preset** — `ollama:llama3:70b` 等の known-good preset を schema に含めるか
14. **LLM-based injection detector のコスト** — ~$0.001/PR の overhead を mandatory（現状）か opt-out に変更するか
15. **`(PRD-only)` メンテナガバナンス** — 当初 BDFL 一人体制か、Day 1 からチーム体制か（v1.0+ OSS 公開時に判断）

---

## 11. リスク

### 11.1 プロダクトリスク

| リスク | 発生可能性 | 影響度 | 緩和策 |
|---|---|---|---|
| プロンプト品質が初期段階で凡庸 | 高 | 高 | v0.1 前に eval ハーネスとプロンプトチューニングへ重点投資 |
| プロバイダ間の出力差で 1 つが壊れる | 中 | 中 | プロバイダ別 eval suite、早期統合テスト |
| Skill エコシステムが立ち上がらない | 中 | 中 | starter 5 本以上を `@review-agent/skill-*` で出荷、authoring 手順を docs 化 |
| デフォルト Claude が経済的でなくなる | 低 | 中 | 設計上プロバイダ非依存、ユーザは 1 行で切替可能 |

### 11.2 セキュリティリスク

| リスク | 発生可能性 | 影響度 | 緩和策 |
|---|---|---|---|
| Prompt injection が出荷時の防御を突破 | 高 | Critical | v0.3 で LLM-based detector、red-team eval fixture、脅威モデル文書化 |
| PR 差分や read file 経由の secret 漏洩 | 中 | Critical | gitleaks を 2 ヶ所（diff + file read）で実行、機密パス deny-list |
| Supply chain 経由のコンテナ侵害 | 低 | Critical | cosign 署名、依存ピン留め、CI で Trivy CVE スキャン |
| メンテナアカウント侵害 | 低 | Critical | 2FA 必須、commit 署名、ブランチ保護、OIDC release |

### 11.3 運用リスク

| リスク | 発生可能性 | 影響度 | 緩和策 |
|---|---|---|---|
| 単一 PR / installation でのコスト暴走 | 中 | 高 | 事前見積もり + hard cap + 150% kill switch + installation 日次上限 |
| Anthropic / OpenAI / Google API の破壊的変更 | 中 | 中 | Vercel AI SDK 抽象化、プロバイダドライバの分離、SDK バージョンピン |
| メンテナバーンアウト / 不在 | 中 | 高 | 早期にメンテナチーム形成、CONTRIBUTING.md による参加障壁低減 |

### 11.4 戦略リスク

| リスク | 発生可能性 | 影響度 | 緩和策 |
|---|---|---|---|
| GitHub が完全機能なネイティブ AI コードレビューを出す | 高 | 高 | セルフホスト + プロバイダ選択 + skill カスタマイズで差別化。GitHub の提供は OpenAI/Anthropic と GitHub エコシステムにロックされる |
| Anthropic / OpenAI が独自 OSS コードレビュー参照実装をリリース | 中 | 高 | review-agent を「production-ready、マルチプロバイダ」の選択肢として位置付け |
| OSS 競合が PR-Agent に集約 | 中 | 中 | 良い PR-Agent skill を取り込み、移行パスを提供 |

---

## 12. ロードマップ（高レベル）

| リリース | スコープ | 目標期間 |
|---|---|---|
| v0.1 | GitHub Action MVP、Anthropic 単独、英語+日本語出力、eval ハーネス、セキュリティベースライン | 4 週 |
| v0.2 | Server モード (AWS Lambda + SQS)、GitHub App、CodeCommit、OpenAI プロバイダ、AWS デプロイガイド | v0.1 後 4 週 |
| v0.3 | マルチテナント + RLS、BYOK、全 7 LLM プロバイダ、GCP + Azure デプロイガイド、LLM-based injection detector、Helm chart | v0.2 後 4 週 |
| v1.0 | 安定 API、フルセキュリティ監査、golden PR 50+、本番ケーススタディ 5 件 | v0.3 後 8 週 |
| Post-v1.0 | GitLab adapter、Bitbucket adapter、GHES 対応、IDE プレビュー | TBD |

実装の週次内訳は実装仕様書 §19 と §20 を参照。

### 12.1 リリース基準（acceptance criteria）

各リリースは以下のすべての条件を満たした時点でタグ付けする。リリース判定のチェックリスト。

**v0.1 — GitHub Action MVP**

- [ ] §6 で `v0.1` 指定の全 MUST 要件達成
- [ ] golden PR 30 本で precision ≥ 75%、false positive rate ≤ 15%
- [ ] eval CI gate（`eval.yml`）が緑
- [ ] SECURITY.md 公開（脅威モデル要約 + 24h SLA 報告窓口）
- [ ] README + CONTRIBUTING + LICENSE + NOTICE が揃う
- [ ] self-review CI が自リポの実 PR で 1 回以上成功
- [ ] §22 オープン質問の v0.1 ブロッカー（#1, #2, #14）が決着済み

**v0.2 — Server + GitHub App + CodeCommit + AWS**

- [ ] §6 で `v0.2` 指定の全 MUST 要件達成
- [ ] `examples/aws-lambda-terraform/` で `terraform apply` が sandbox AWS 環境で成功
- [ ] OTel スパンが Langfuse UI で確認可能
- [ ] cost ledger HMAC chain 検証スクリプトが緑
- [ ] CodeCommit sandbox repo で webhook → review → comment の end-to-end が成功
- [ ] OpenAI プロバイダで eval golden の 80% 以上が pass

**v0.3 — Multi-tenant + 全プロバイダ + GCP/Azure**

- [ ] §6 で `v0.3` 指定の全 MUST 要件達成
- [ ] RLS テスト：tenant A のデータが tenant B から不可視であることを integration test で verified
- [ ] BYOK + KMS envelope encryption の round-trip + rotation テスト緑
- [ ] GCP Cloud Run + Azure Container Apps の `terraform apply` が各 sandbox 環境で成功
- [ ] 全 7 プロバイダで eval golden 30 本のうち 80% 以上 pass
- [ ] red-team golden fixture 15 本全て CI で block されることを確認
- [ ] LLM-based injection detector の検出精度 ≥ 95%（red-team 集合で計測）
- [ ] §8.6 incident response runbook 6 本全てを tabletop drill で実証

**v1.0 — Stable**

- [ ] v0.1〜v0.3 の MUST 要件すべて達成
- [ ] golden PR 50 本以上、precision ≥ 80%、false positive rate ≤ 10%
- [ ] 第三者セキュリティ監査または同等レベルの脅威モデルレビュー完了
- [ ] §22 オープン質問すべて決着
- [ ] API 安定性宣言（SemVer に移行、UPGRADING.md 整備）
- [ ] OSS 公開判断（公開する場合は CODE_OF_CONDUCT.md / GOVERNANCE.md 整備、README/CONTRIBUTING を OSS モードに更新）

**Post-v1.0** — GitLab adapter、Bitbucket adapter、GHES の declared-support 化（v1.0 では best-effort, no commitment、[`docs/deployment/ghes.md`](../deployment/ghes.md)）、IDE プレビュー、コミュニティ形成施策（OSS 公開する場合）

---

## 13. スコープ外（明示）

- リアルタイム IDE 統合 (Cursor / Copilot / Continue を使う)
- コード生成・自動修正（read-only 設計のため）
- AI ドリブンなテスト生成
- 画像 / 図のレビュー
- Slack / Discord / Teams ボット
- レビュー閲覧用の独立 Web UI
- 複数リポにまたがる横断分析
- OSS 自体のコンプライアンス認証（SOC 2、ISO 27001）—これらはデプロイに対する認証であり、コードベースには適用されない

---

## 14. 用語集

- **GitHub App**：独自の権限と webhook を持つ GitHub アプリ。組織またはユーザにインストールされる
- **Installation**：GitHub App の単一の組織/ユーザへのデプロイ。マルチテナント分離境界
- **PR**：プルリクエスト（GitHub）または同 (CodeCommit)。同義に使用
- **Skill**：レビュールールを記述した Markdown + YAML ファイル。実行時に LLM システムプロンプトに合成される
- **Profile**：レビュートーンのプリセット（`chill` = critical/major のみ、`assertive` = info を含む全 severity）
- **Incremental review**：PR の hidden state コメントから取得した最終レビュー以降の新規 commit のみを再レビューすること
- **BYOK**：Bring Your Own Key — 各運用者が自身の LLM API クレデンシャルを供給
- **Provider**：LLM サービス（Anthropic / OpenAI / Google / Vertex / Bedrock / Azure OpenAI / OpenAI 互換）
- **Tool**：LLM が呼び出せる関数（本プロジェクトでは `read_file` / `glob` / `grep` のみ）
- **Eval**：golden PR データセットに対するプロンプト品質の回帰テスト

---

## 15. 参考資料

### 15.1 内部ドキュメント

- 実装仕様書（技術詳細・コードスニペット・型定義の source of truth）
  - 現状はオーナーがローカル保管。リポジトリには含めない方針（v0.3 時点）
  - 将来 OSS 公開する際は `docs/specs/spec.md` 等としてコミット候補
- `docs/specs/prd.md` — 本書（プロダクト要求書）
- `SECURITY.md` — 脅威モデルと脆弱性報告窓口
- `README.md` — プロジェクト方針と quickstart
- `.github/CONTRIBUTING.md` — 現在は外部コントリビューション不可方針
- `tasks/INDEX.md` — v0.1〜v0.3 タスク一覧（GitHub Issues #1〜#37 と対応）
- 以下は v0.2/v0.3 で追加予定：
  - `docs/deployment/{aws,gcp,azure}.md` — クラウド別ガイド
  - `docs/providers/*.md` — LLM プロバイダ別ガイド
  - `GOVERNANCE.md` — プロジェクトガバナンス（OSS 公開時に整備）

### 15.2 外部参考

- PR-Agent (Qodo) — https://github.com/qodo-ai/pr-agent
- reviewdog — https://github.com/reviewdog/reviewdog
- coderabbitai/ai-pr-reviewer — https://github.com/coderabbitai/ai-pr-reviewer
- Vercel AI SDK — https://sdk.vercel.ai/

---

## Appendix: English Summary

`review-agent` is an open-source, self-hosted, multi-provider AI code review
agent. Distributed as GitHub Action / Server / CLI from a single TypeScript
monorepo. Supports Anthropic Claude, OpenAI, Google Gemini, Azure OpenAI,
AWS Bedrock, Vertex AI, and any OpenAI-compatible local endpoint (Ollama,
vLLM, OpenRouter, LM Studio).

Key differentiators:

1. **Provider freedom** — pick your LLM per repository. Critical for orgs
   that mandate AWS/GCP/Azure region-local LLM endpoints.
2. **Skill ecosystem** — Markdown + YAML files that inject org-specific
   coding standards into every review.
3. **Japanese-first** — internal prompts always English (for cross-provider
   consistency), but review comments output in Japanese and 7 other
   languages.
4. **Self-host only** — no SaaS offering. Optimized for orgs with strict
   data residency requirements.
5. **Multi-tenant ready** — Postgres RLS isolation, BYOK with KMS envelope
   encryption, per-tenant cost caps.

Target personas: P1 platform engineers at mid-size enterprises, P2 tech
leads at Japanese startups, P3 security/compliance engineers, P4 OSS
maintainers.

12-month success targets: 1,000+ active installations, 5+ Japanese
enterprise users, 75%+ comment acceptance rate, median cost <$0.50/PR.

Implementation details live in `review-agent-spec.md` (~2,500 lines). This
PRD is ~530 lines presenting the strategic picture.

---

*Last updated: 2026-04-30*
*Document owner: 未定 (§10 question 8)*
*Status: Draft, pre-v0.1*