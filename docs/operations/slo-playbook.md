# SLO / dashboard playbook

> **数値ゴールは OSS デフォルトです。自社の SLA / 運用契約に合わせて締めてください。**
> 本書の閾値は「multi-tenant SaaS で review-agent を運用したいが、まだ独自
> SLA を持っていない operator」を想定した保守的デフォルト値です。本番投入前
> に、対象 PR ボリューム / LLM プロバイダ SLA / on-call 体制を踏まえて、
> P1 / P2 の閾値と SLO 目標を必ず再評価してください。

Spec references: §13.1 (OTel), §13.2 (metrics), §13.3 (audit log) /
v1.2 epic [#83](https://github.com/almondoo/review-agent/issues/83)
Phase 2 ([#91](https://github.com/almondoo/review-agent/issues/91)) /
Phase 3 ([#92](https://github.com/almondoo/review-agent/issues/92)) /
Phase 4 ([#93](https://github.com/almondoo/review-agent/issues/93)).

## 何のための playbook か

`docs/architecture/observability.md` は **どの metric / span が存在するか**
を列挙します。本書はその一段上の運用層で、

- 「どの値が異常か」 (SLO 目標値)
- 「いつ alert / page するか」 (window と閾値)
- 「どう通知するか」 (Severity ルーブリック + Slack payload テンプレ)

を定義します。Datadog / Grafana / CloudWatch / NewRelic の dashboard 実装は
operator 側の責務であり、本書は **vendor-neutral な PromQL** で表現します。

---

## SLO 目標値と alert 閾値 (初版)

| 指標 | 計測単位 | SLO 目標 | Alert 閾値 (P2) | Page (P1) |
|---|---|---|---|---|
| Review availability | 月次 `success/total` 比率 | **99.0%** | 30min window で 95% 下回り | 15min window で 90% 下回り |
| Review latency | `latency_seconds` p95 | **< 60s** | 5min window で p95 > 90s | 5min window で p95 > 180s |
| Cost burn | 日次 `cost_usd_total` | per-installation daily_cap_usd の 80% | daily_cap の 80% 越え | daily_cap の 100% 越え (= cost-guard `abort` 発火) |
| Cost-guard `kill` 発火 | per-day count | = 0 | 1 件発火 | 任意 (同一 installation で連発時のみ page) |
| Injection block | per-day count | OSS 既定 < 5 / repo / day | 10 件 / repo / day 超 | 100 件 / repo / day 超 |
| Feedback rate-limit drop | per-day count | = 0 | 1 件発火 | 任意 (abuse 疑い時のみ page) |
| Dropped by feedback (#91) | 週次 trend | 自然 trend (急変なし) | 直近 7d 平均が前週比 +200% / -80% | なし |

> Metric 名は v1.2 wave 時点 (Wave landed on `develop` 2026-05-19) の実装値です。
> 正確な定義は [`docs/architecture/observability.md`](../architecture/observability.md)
> および `packages/server/src/metrics.ts` を参照。
> [#106](https://github.com/almondoo/review-agent/issues/106) で追加予定の
> eval recorder / feedback writer fail-open metric (`review_agent_eval_record_errors_total`,
> `review_agent_feedback_rate_limit_drops_total`,
> `review_agent_review_history_pruned_total`,
> `review_agent_history_reader_errors_total`) は **#106 が landed した後に
> 本書へ追補**します。それまでは operator-supplied callback
> (`onEvalRecordError` / `onRateLimit`) 経由で個別配線してください。

---

## Severity ルーブリック (P1 / P2 / P3)

| Level | 反応時間 | 通知先 |
|---|---|---|
| **P1 (page)** | < 15 min | PagerDuty / on-call rotation。深夜起こす |
| **P2 (ticket)** | < 4 業務時間 | Slack channel、業務時間内対応 |
| **P3 (dashboard-only)** | なし | Grafana / Langfuse ダッシュボードでの観察のみ |

### 適用ガイド

- **P1**: ユーザーに直接見える / SLA breach 直結 / 悪意ある外部攻撃のバースト疑い。on-call が即応する。
- **P2**: 「24h 放置すると P1 化する」レベル。Slack channel に flag を立て、業務時間内に root-cause 調査。
- **P3**: 単発の異常では action 不要。trend が変化した時に初めて意味を持つ informational 指標 (例: `droppedByFeedback` の急変)。

`P3` を P2 に格上げするかは運用 3 ヶ月後に再評価。OSS 初期値は「dashboard 観察のみ」に留めます。

---

## 各指標の詳細

### 1. Review availability (月次 success / total 比率)

**Metric**: `review_agent_reviews_total{status, repo}`
(`status` は `success` / `failed` / `skipped`、`skipped` は分母から除外)

**SLO 目標**: 月次 99.0% 以上。

**Window 根拠**:

- **30 min P2**: GitHub Actions / Lambda の typical retry cycle (15 min × 2 attempts) を 1 周期跨ぐ。
  これより短いと一過性の rate-limit を誤検知し、長いと operator が気付くのが遅れる。
- **15 min P1**: 「on-call が起きて確認するのに見合う緊急度」。SLA で
  multi-tenant 全停止を 30 min 以内にエスカレートする想定。

**PromQL クエリ例**:

```promql
# 30min ウィンドウの success ratio (P2 alert)
(
  sum(rate(review_agent_reviews_total{status="success"}[30m]))
  /
  sum(rate(review_agent_reviews_total{status=~"success|failed"}[30m]))
) < 0.95
```

```promql
# 15min ウィンドウの success ratio (P1 page)
(
  sum(rate(review_agent_reviews_total{status="success"}[15m]))
  /
  sum(rate(review_agent_reviews_total{status=~"success|failed"}[15m]))
) < 0.90
```

```promql
# 月次 SLO trend (informational)
(
  sum(increase(review_agent_reviews_total{status="success"}[30d]))
  /
  sum(increase(review_agent_reviews_total{status=~"success|failed"}[30d]))
)
```

**注**: `status="skipped"` (incremental review が no-op を判定したケース等) は
正常系なので分母から除外します。SLA は「実際に LLM を回したレビューの成功率」
で測定します。

---

### 2. Review latency (`latency_seconds` p95)

**Metric**: `review_agent_latency_seconds_bucket{phase}` (Histogram)
(`phase` は `webhook` / `job` / `clone` / `secret_scan` / `llm.call` 等)

**SLO 目標**: end-to-end (`phase="job"`) で p95 < 60s。

**Window 根拠**:

- **5 min P2 / P1 共通**: latency は累積する性質ではなく **瞬間値** なので、
  rolling 5 min window で十分。これより長くすると recovery を検知できない。
- **90s P2 / 180s P1**: 60s SLO に対し 1.5x / 3x。1.5x は「LLM 側の slowdown
  を 1 周期吸収できる」、3x は「downstream LLM API が完全停止している疑い」。

**PromQL クエリ例**:

```promql
# 5min ウィンドウの job phase p95 (P2 alert)
histogram_quantile(
  0.95,
  sum by (le) (rate(review_agent_latency_seconds_bucket{phase="job"}[5m]))
) > 90
```

```promql
# 5min ウィンドウの job phase p95 (P1 page)
histogram_quantile(
  0.95,
  sum by (le) (rate(review_agent_latency_seconds_bucket{phase="job"}[5m]))
) > 180
```

```promql
# phase 分解 — どこで詰まっているか確認 (dashboard 用)
histogram_quantile(
  0.95,
  sum by (le, phase) (rate(review_agent_latency_seconds_bucket[5m]))
)
```

**注**: phase 別の p95 を dashboard に並べておくと、`llm.call` が遅いのか
`clone` が遅いのかが即判別できます。alert は `phase="job"` のみで OK。

---

### 3. Cost burn (日次 `cost_usd_total` vs daily_cap_usd)

**Metric**: `review_agent_cost_usd_total{model, installation}` (Counter)
+ 各 installation の `.review-agent.yml` `cost.daily_cap_usd` 設定値

**SLO 目標**: 日次累積 ≤ daily_cap の 80%。80% を超えたら fallback model
への切り替えを検討、100% で cost-guard が `abort` を発火。

**Window 根拠**:

- **日次 (`[24h]`)**: cost ledger は per-installation の **日次** 累計で
  管理する (spec §6 / `docs/cost/index.md`)。1 日途中で 80% を超えたら
  ペースが速い証拠。
- **比較対象**: per-installation の `daily_cap_usd` 設定値。これは config
  に存在するため、operator は同じ key を Prometheus の external_label /
  recording rule に展開しておく必要があります。

**PromQL クエリ例**:

```promql
# 各 installation の日次 cost (P2 alert, threshold は recording rule で注入)
sum by (installation) (increase(review_agent_cost_usd_total[24h]))
  > on(installation) group_left
    (review_agent_daily_cap_usd * 0.8)   # recording rule 経由
```

```promql
# 各 installation の日次 cost (P1 page = 100% over)
sum by (installation) (increase(review_agent_cost_usd_total[24h]))
  > on(installation) review_agent_daily_cap_usd
```

> **配線メモ**: `review_agent_daily_cap_usd{installation="..."}` は
> review-agent からは emit していません。operator が config から
> Prometheus recording rule / `static_configs` の external_labels で
> 注入してください。Cost-guard 側は同じ閾値を **runtime で評価して
> 自律的に abort/kill する** ので、本 alert は「cost-guard が発火する
> 直前を可視化する preventive 通知」という位置づけです。

---

### 4. Cost-guard `kill` 発火カウント

**Metric**: `review_agent_reviews_total{status="failed"}` の中で
`reason="cost_exceeded"` ラベル付きのもの、または
`cost_ledger.status = 'cost_exceeded'` の row insert。

**SLO 目標**: per-day = 0 件。

**Window 根拠**:

- **日次**: 1 件でも発火したら配置ミス / model 暴走の疑いなので、即時 ticket。
- **P1 page**: 「同一 installation で連発」した時のみ。単発の `kill` は
  通常 cost-cap を低く設定しているテスト環境で発生するため、page せず P2 で十分。

**PromQL クエリ例**:

```promql
# kill threshold 発火 (P2 alert)
increase(review_agent_reviews_total{status="failed"}[1d]) > 0
  and on() count(
    increase(review_agent_reviews_total{status="failed"}[1d]) > 0
  )
```

> **注**: 現状 (v1.2 wave) では `reason` label は cost-guard の
> `onThresholdCrossed` callback 経由でしか取れません。operator は
> `packages/runner/src/middleware/cost-guard.ts` の `CostThresholdEvent`
> を OTel attribute / metric label に bridge する thin glue を書く
> 必要があります。`status="failed"` は cost-exceeded 以外
> (例: rate-limit 経由の hard fail) も拾うため、bridge 配線後は
> 専用 counter `review_agent_cost_guard_kills_total` を立てる方が
> false-positive を下げられます。

---

### 5. Injection block (per-day count)

**Metric**: `review_agent_prompt_injection_blocked_total{repo}` (Counter)

**SLO 目標**: OSS 既定 < 5 件 / repo / day。

**Window 根拠**:

- **日次**: 単発の injection 試行は誤検知の可能性が高い (legitimate な PR で
  `"ignore previous instructions"` 文字列が出ることはある)。日次集計で見て
  trend を判断する。
- **10 件 P2**: 同一 repo で 10 件を超えたら attacker が連投している疑いが
  高い。
- **100 件 P1**: 大量バーストは「PR 本文を bot で書き換える攻撃」相当。on-call
  起こして対象 installation を temporary disable する判断が必要。

**PromQL クエリ例**:

```promql
# repo 単位の日次 injection block count (P2)
sum by (repo) (increase(review_agent_prompt_injection_blocked_total[1d])) > 10
```

```promql
# repo 単位の日次 injection block count (P1)
sum by (repo) (increase(review_agent_prompt_injection_blocked_total[1d])) > 100
```

```promql
# 1h 単位の burst 検知 (dashboard 用)
sum by (repo) (increase(review_agent_prompt_injection_blocked_total[1h]))
```

---

### 6. Feedback rate-limit drop (per-day count)

**Metric**: `createFeedbackWriter` の `onRateLimit` 発火回数。
v1.2 wave 時点では **OTel counter として直接 export されていない**
(#106 で `review_agent_feedback_rate_limit_drops_total` が追加予定)。

**SLO 目標**: per-day = 0 件。

**Window 根拠**:

- **日次**: 同一 PR cycle で `maxWritesPerJob` (default 10) を超えるのは
  典型的に「webhook が事故で重複発火している」「feedback comment を bot が
  spam している」のいずれか。即時 ticket。
- **P1 page**: abuse 疑い時のみ (例: 短時間に 100+ drops)。通常は P2 で
  原因調査すれば十分。

**PromQL クエリ例 (#106 landed 後)**:

```promql
# 日次 feedback rate-limit drop count (P2)
increase(review_agent_feedback_rate_limit_drops_total[1d]) > 0
```

**v1.2 wave 時点の暫定計測** (#106 未完):

- operator が `onRateLimit` callback に独自の counter (`logger.warn` →
  log-based metric / OTel custom counter) を配線する
- もしくは `review_history` 行の insert 失敗を間接的に検知する
  (`createFeedbackWriter` は drop を **silently** 行うので table 側からは
  見えない点に注意)

---

### 7. Dropped by feedback (`droppedByFeedback`, P3 trend)

**Metric**: `review_eval_event.dropped_by_feedback` 列 (per-review、Phase 4
の feedback-aware dedup が抑制した件数)。OTel counter として直接 export は
していないため、**SQL クエリで集計**するか、operator が EvalRecorder hook
で counter を立てて bridge する。

**SLO 目標**: 自然 trend。急変なし。

**Window 根拠**:

- **7d 移動平均**: 個別 review はバラつきが大きく、daily / weekly 急変が
  「学習が効きすぎ / 効かなくなった」のシグナル。
- **前週比 +200% / -80%**: +200% は「rejected_finding pattern が突然
  急増 = upstream で何かが変わった」、-80% は「学習が失われた / RLS
  config 事故で history が読めなくなった」可能性。informational のみ
  (page しない)。

**SQL クエリ例** (review_eval_event テーブル):

```sql
-- 7d 移動平均と前週比 (dashboard panel 用)
SELECT
  date_trunc('day', created_at) AS day,
  AVG(dropped_by_feedback) OVER (
    ORDER BY date_trunc('day', created_at)
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS d7_avg,
  AVG(dropped_by_feedback) OVER (
    ORDER BY date_trunc('day', created_at)
    ROWS BETWEEN 13 PRECEDING AND 7 PRECEDING
  ) AS prev_d7_avg
FROM review_eval_event
WHERE installation_id = $1
  AND created_at > now() - interval '21 days'
ORDER BY day DESC;
```

**PromQL クエリ例** (operator が counter bridge を配線した場合):

```promql
# 7d 平均 vs 前週 7d 平均の比率 (P3 dashboard only)
(
  avg_over_time(review_agent_dropped_by_feedback_total[7d])
  /
  avg_over_time(review_agent_dropped_by_feedback_total[7d] offset 7d)
)
```

詳細な SQL 集計パターンは [#103 SQL playbook](https://github.com/almondoo/review-agent/issues/103)
(別 issue) を参照してください。本書は alert 層、#103 は集計層を担当します。

---

## Slack incoming webhook テンプレ

review-agent は Slack adapter を内蔵していません。Prometheus Alertmanager /
Grafana Alerting / Datadog monitor 等から、以下の形で Slack incoming webhook
に POST してください。

### シングルテナント版

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "[P1] review-agent SLO breach" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Metric:* review_availability" },
        { "type": "mrkdwn", "text": "*Value:* 88.4%" },
        { "type": "mrkdwn", "text": "*Window:* 15min" },
        { "type": "mrkdwn", "text": "*Threshold:* 90.0%" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Open dashboard" },
          "url": "https://grafana.example.com/d/review-agent-slo"
        }
      ]
    }
  ]
}
```

### マルチテナント版 (`installation_id` を fields に追加)

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "[P1] review-agent SLO breach" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Metric:* cost_burn" },
        { "type": "mrkdwn", "text": "*Installation:* 12345" },
        { "type": "mrkdwn", "text": "*Repo:* acme/api" },
        { "type": "mrkdwn", "text": "*Value:* $14.20 / $12.00 daily cap" },
        { "type": "mrkdwn", "text": "*Window:* 24h" },
        { "type": "mrkdwn", "text": "*Action:* cost-guard `abort` will fire on next call" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Open dashboard" },
          "url": "https://grafana.example.com/d/review-agent-slo?var-installation=12345"
        },
        {
          "type": "button",
          "style": "danger",
          "text": { "type": "plain_text", "text": "Disable installation" },
          "url": "https://admin.example.com/installations/12345/disable"
        }
      ]
    }
  ]
}
```

**配線メモ**:

- Alertmanager の `slack_configs` `text` フィールドは `{{ template }}` で
  上の JSON を組み立てる前提。素の text に流すと structured fields が消える。
- PagerDuty に同じ alert を流す場合は `severity=critical` で P1 のみ、
  `severity=warning` で P2 のみを送出するルーティングを推奨。両方流すと
  on-call が深夜起こされる事故が起きる。

---

## Dashboard 推奨レイアウト (Grafana / Datadog 共通)

operator が初手で構築すべき dashboard panel の最小セット:

1. **Top row — SLO health**
   - Review availability (30min rolling) — 99.0% target line
   - Latency p95 by phase — 60s target line
   - Cost burn vs daily_cap (per installation, top 10)
2. **Middle row — Guard events**
   - Cost-guard threshold events (fallback / abort / kill 別 stacked bar)
   - Injection block count (1h rolling, per repo)
   - Feedback rate-limit drops (#106 landed 後に専用 panel)
3. **Bottom row — Quality trends (P3)**
   - `droppedByFeedback` 7d / prev-7d ratio
   - `comments_posted_total` by severity (stacked area)
   - `incremental_skipped_lines_total` trend (cost-savings の可視化)

`docs/architecture/observability.md` に列挙した全 metric は最低 1 panel
に出すと、新規 metric (#106) が追加された時の bridge 漏れを発見しやすく
なります。

---

## 関連 issue / docs

- 上位スペック: `docs/specs/review-agent-spec.md` §13.1〜§13.3
- Metric 定義: [`docs/architecture/observability.md`](../architecture/observability.md)
- SQL クエリ層 (本書の補助): [#103 review_eval_event SQL playbook](https://github.com/almondoo/review-agent/issues/103)
- 新規 metric 追加 (本書を完成度↑する): [#106 OTel metrics for fail-open events](https://github.com/almondoo/review-agent/issues/106)
- Cost cap 詳細: [`docs/cost/index.md`](../cost/index.md)
- Retention (audit_log / cost_ledger): [`docs/operations/retention.md`](./retention.md)
