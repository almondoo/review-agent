import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useReviewDetail } from '../api/client.js';
import type { ReviewEventDetail } from '../api/types.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { PlatformBadge } from '../components/platform-badge.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatDateUtc, formatDuration, formatNumber } from '../lib/format.js';

function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function formatElapsed(fromIso: string, toIso: string): string {
  const diff = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (diff < 0) return '';
  if (diff < 1000) return `+${diff}ms`;
  return `+${(diff / 1000).toFixed(1)}s`;
}

type SystemPromptToggleProps = {
  prompt: string | null;
};

function SystemPromptToggle({ prompt }: SystemPromptToggleProps) {
  const [open, setOpen] = useState(false);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      style={{ marginTop: '0.5rem' }}
    >
      <summary
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.625rem',
          fontWeight: 600,
          letterSpacing: '0.08em',
          color: 'var(--graphite)',
          cursor: 'pointer',
          userSelect: 'none',
          listStyle: 'none',
        }}
      >
        {open ? '[HIDE PROMPT]' : '[SHOW PROMPT]'}
      </summary>
      <pre
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.6875rem',
          lineHeight: 1.6,
          color: 'var(--fg)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          marginTop: '0.75rem',
          backgroundColor: 'var(--bg-raised)',
          border: '1px solid var(--hairline)',
          padding: '0.875rem',
          borderRadius: 'var(--radius)',
        }}
      >
        {prompt ?? '[NULL] No snapshot.'}
      </pre>
    </details>
  );
}

type DetailLayoutProps = {
  detail: ReviewEventDetail;
};

function DetailLayout({ detail }: DetailLayoutProps) {
  const repoId = detail.repoId;
  const summaryText =
    detail.summary ??
    (detail.outcome === 'approved'
      ? 'Review completed. No significant issues found.'
      : detail.outcome === 'changes_requested'
        ? 'Review completed. Changes requested.'
        : detail.outcome === 'commented'
          ? 'Review completed. General observations posted.'
          : 'Review did not complete successfully.');

  return (
    <StaggerContainer>
      {/* Breadcrumb */}
      <StaggerItem>
        <div
          className="label-mono"
          style={{ color: 'var(--graphite)', marginBottom: '0.5rem', fontSize: '0.6875rem' }}
        >
          <Link to="/history" style={{ color: 'var(--graphite)' }}>
            History
          </Link>
          {' / '}
          <Link to={`/repos/${repoId}`} style={{ color: 'var(--graphite)' }}>
            {detail.repoName}
          </Link>
          {' / '}
          <span>PR #{detail.pr.number}</span>
        </div>
      </StaggerItem>

      {/* Header */}
      <StaggerItem>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(28px, 3vw, 48px)',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            lineHeight: 1.05,
            fontVariationSettings: "'opsz' 72, 'SOFT' 60",
            marginBottom: '0.5rem',
          }}
        >
          PR #{detail.pr.number} — {detail.pr.title}
        </h1>

        {/* Meta row */}
        <div
          className="label-mono"
          style={{
            color: 'var(--graphite)',
            fontSize: '0.6875rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
            marginBottom: '0.75rem',
          }}
        >
          <StatusBadge status={detail.outcome} />
          <span>|</span>
          <PlatformBadge platform={detail.platform} />
          <span>|</span>
          <span>
            {detail.provider.name}/{detail.provider.model}
          </span>
          <span>|</span>
          <span>${detail.costUsd.toFixed(3)}</span>
          <span>|</span>
          <span>{formatDuration(detail.durationMs)}</span>
          <span>|</span>
          <span>{formatDateUtc(detail.createdAt)}</span>
        </div>

        <Hairline style={{ marginBottom: '2rem' }} />
      </StaggerItem>

      {/* Two-column layout */}
      <StaggerItem>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            gap: '3rem',
            alignItems: 'start',
          }}
          className="history-detail-grid"
        >
          {/* Left column */}
          <div>
            {/* Summary */}
            <section style={{ marginBottom: '3rem' }}>
              <SectionHeading title="Summary" />
              <p
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1rem',
                  lineHeight: 1.7,
                  color: 'var(--fg)',
                }}
              >
                {summaryText}
              </p>
            </section>

            {/* Comments posted */}
            <section style={{ marginBottom: '3rem' }}>
              <SectionHeading
                title="Comments Posted"
                subtitle={`${detail.comments.length} inline comment${detail.comments.length === 1 ? '' : 's'}`}
              />
              {detail.comments.length === 0 ? (
                <p className="label-mono" style={{ color: 'var(--graphite)', fontSize: '0.75rem' }}>
                  [ NO INLINE COMMENTS POSTED ]
                </p>
              ) : (
                <div>
                  {detail.comments.map((comment, idx) => (
                    <div key={`${comment.path}-${comment.line ?? 'null'}-${idx}`}>
                      {idx > 0 && <Hairline style={{ margin: '1.25rem 0' }} />}
                      <div
                        style={{
                          borderTop: idx === 0 ? '1px solid var(--hairline)' : undefined,
                          paddingTop: idx === 0 ? '1rem' : 0,
                        }}
                      >
                        <span
                          className="label-mono"
                          style={{
                            fontSize: '0.625rem',
                            color: 'var(--graphite)',
                            display: 'block',
                            marginBottom: '0.5rem',
                          }}
                        >
                          {comment.path}
                          {comment.line !== null ? `:${comment.line}` : ''}
                        </span>
                        <p
                          style={{
                            fontFamily: 'var(--font-display)',
                            fontSize: '0.875rem',
                            lineHeight: 1.6,
                            color: 'var(--fg)',
                            whiteSpace: 'pre-wrap',
                            margin: 0,
                          }}
                        >
                          {comment.body}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Tool calls */}
            <section style={{ marginBottom: '3rem' }}>
              <SectionHeading title="Tool Calls" />
              {detail.toolCalls.length === 0 ? (
                <p className="label-mono" style={{ color: 'var(--graphite)', fontSize: '0.75rem' }}>
                  [ NO TOOL CALLS RECORDED ]
                </p>
              ) : (
                <table
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    borderCollapse: 'collapse',
                    width: '100%',
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        style={{
                          textAlign: 'left',
                          color: 'var(--graphite)',
                          fontWeight: 600,
                          letterSpacing: '0.06em',
                          paddingBottom: '0.5rem',
                          borderBottom: '1px solid var(--hairline)',
                          paddingRight: '2rem',
                        }}
                      >
                        name
                      </th>
                      <th
                        style={{
                          textAlign: 'right',
                          color: 'var(--graphite)',
                          fontWeight: 600,
                          letterSpacing: '0.06em',
                          paddingBottom: '0.5rem',
                          borderBottom: '1px solid var(--hairline)',
                        }}
                      >
                        count
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.toolCalls.map((tc) => (
                      <tr key={tc.name}>
                        <td
                          style={{
                            paddingTop: '0.375rem',
                            paddingBottom: '0.375rem',
                            color: 'var(--fg)',
                            paddingRight: '2rem',
                          }}
                        >
                          {tc.name}
                        </td>
                        <td
                          style={{
                            paddingTop: '0.375rem',
                            paddingBottom: '0.375rem',
                            color: 'var(--graphite)',
                            textAlign: 'right',
                          }}
                        >
                          {tc.count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          {/* Right column (sidebar) */}
          <aside
            style={{
              position: 'sticky',
              top: '1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '2rem',
            }}
          >
            {/* Cost breakdown */}
            <div
              style={{
                backgroundColor: 'var(--bg-raised)',
                border: '1px solid var(--hairline)',
                padding: '1.25rem',
                borderRadius: 'var(--radius)',
              }}
            >
              <h3
                className="label-mono"
                style={{
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: 'var(--graphite)',
                  marginBottom: '0.875rem',
                }}
              >
                COST BREAKDOWN
              </h3>
              <dl
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  lineHeight: 1.8,
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '0 1rem',
                  margin: 0,
                }}
              >
                <dt style={{ color: 'var(--graphite)' }}>prompt tokens:</dt>
                <dd style={{ color: 'var(--fg)', textAlign: 'right', margin: 0 }}>
                  {formatNumber(detail.tokens.prompt)}
                </dd>
                <dt style={{ color: 'var(--graphite)' }}>completion tokens:</dt>
                <dd style={{ color: 'var(--fg)', textAlign: 'right', margin: 0 }}>
                  {formatNumber(detail.tokens.completion)}
                </dd>
                <dt style={{ color: 'var(--graphite)' }}>total tokens:</dt>
                <dd style={{ color: 'var(--fg)', textAlign: 'right', margin: 0 }}>
                  {formatNumber(detail.tokens.total)}
                </dd>
                <dt style={{ color: 'var(--graphite)' }}>usd:</dt>
                <dd style={{ color: 'var(--fg)', textAlign: 'right', margin: 0 }}>
                  ${detail.costUsd.toFixed(3)}
                </dd>
              </dl>
            </div>

            {/* Timing */}
            <div
              style={{
                backgroundColor: 'var(--bg-raised)',
                border: '1px solid var(--hairline)',
                padding: '1.25rem',
                borderRadius: 'var(--radius)',
              }}
            >
              <h3
                className="label-mono"
                style={{
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: 'var(--graphite)',
                  marginBottom: '0.875rem',
                }}
              >
                TIMING
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {[
                  { label: 'queued at', time: detail.timing.queuedAt },
                  { label: 'started at', time: detail.timing.startedAt },
                  { label: 'completed at', time: detail.timing.completedAt },
                ].map((entry, idx, arr) => {
                  const prevTime = idx > 0 ? (arr[idx - 1]?.time ?? null) : null;
                  const elapsed =
                    prevTime !== null && entry.time !== null
                      ? formatElapsed(prevTime, entry.time)
                      : null;

                  return (
                    <div key={entry.label}>
                      {idx > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            margin: '0.125rem 0',
                          }}
                        >
                          <div
                            aria-hidden="true"
                            style={{
                              width: '1px',
                              height: '1.5rem',
                              backgroundColor: 'var(--hairline)',
                              marginLeft: '4px',
                            }}
                          />
                          {elapsed !== null && (
                            <span
                              className="label-mono"
                              style={{ fontSize: '0.5625rem', color: 'var(--graphite)' }}
                            >
                              {elapsed}
                            </span>
                          )}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem' }}>
                        <div
                          aria-hidden="true"
                          style={{
                            width: '9px',
                            height: '9px',
                            borderRadius: '50%',
                            backgroundColor: entry.time !== null ? 'var(--ink)' : 'var(--hairline)',
                            flexShrink: 0,
                            marginTop: '3px',
                          }}
                        />
                        <div>
                          <span
                            className="label-mono"
                            style={{
                              fontSize: '0.5625rem',
                              color: 'var(--graphite)',
                              display: 'block',
                            }}
                          >
                            {entry.label}
                          </span>
                          <span
                            className="label-mono"
                            style={{ fontSize: '0.625rem', color: 'var(--fg)' }}
                          >
                            {entry.time !== null ? formatDateUtc(entry.time) : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Provider */}
            <div
              style={{
                backgroundColor: 'var(--bg-raised)',
                border: '1px solid var(--hairline)',
                padding: '1.25rem',
                borderRadius: 'var(--radius)',
              }}
            >
              <h3
                className="label-mono"
                style={{
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: 'var(--graphite)',
                  marginBottom: '0.5rem',
                }}
              >
                PROVIDER
              </h3>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: 'var(--fg)',
                }}
              >
                {detail.provider.name} / {detail.provider.model}
              </span>
            </div>

            {/* System prompt */}
            <div
              style={{
                backgroundColor: 'var(--bg-raised)',
                border: '1px solid var(--hairline)',
                padding: '1.25rem',
                borderRadius: 'var(--radius)',
              }}
            >
              <h3
                className="label-mono"
                style={{
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: 'var(--graphite)',
                  marginBottom: '0.25rem',
                }}
              >
                SYSTEM PROMPT AT REVIEW TIME
              </h3>
              <SystemPromptToggle prompt={detail.systemPromptAtReview} />
            </div>

            {/* Related links */}
            <div
              style={{
                backgroundColor: 'var(--bg-raised)',
                border: '1px solid var(--hairline)',
                padding: '1.25rem',
                borderRadius: 'var(--radius)',
              }}
            >
              <h3
                className="label-mono"
                style={{
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: 'var(--graphite)',
                  marginBottom: '0.875rem',
                }}
              >
                RELATED LINKS
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {detail.externalUrl !== null && isSafeExternalUrl(detail.externalUrl) ? (
                  <a
                    href={detail.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.6875rem',
                      color: 'var(--rust)',
                      textDecoration: 'none',
                    }}
                  >
                    View PR ↗
                  </a>
                ) : (
                  <span
                    className="label-mono"
                    style={{
                      fontSize: '0.6875rem',
                      color: 'var(--graphite)',
                      opacity: 0.4,
                      cursor: 'not-allowed',
                    }}
                    aria-disabled="true"
                  >
                    View PR ↗
                  </span>
                )}
                <Link
                  to={`/repos/${repoId}`}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    color: 'var(--graphite)',
                    textDecoration: 'none',
                  }}
                >
                  Repository →
                </Link>
                <Link
                  to={`/repos/${repoId}/prompt`}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    color: 'var(--graphite)',
                    textDecoration: 'none',
                  }}
                >
                  Edit current prompt →
                </Link>
              </div>
            </div>
          </aside>
        </div>
      </StaggerItem>
    </StaggerContainer>
  );
}

export function HistoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const safeId = id ?? '';
  const { data, isLoading, error } = useReviewDetail(safeId);

  if (isLoading) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        [LOADING REVIEW...]
      </div>
    );
  }

  if (error !== null || data === undefined) {
    return (
      <div style={{ padding: '2rem 0' }}>
        <p className="label-mono" style={{ color: 'var(--rust)', marginBottom: '1rem' }}>
          [NOT FOUND]
        </p>
        <Link to="/history" className="label-mono" style={{ color: 'var(--graphite)' }}>
          [← Back to History]
        </Link>
      </div>
    );
  }

  return <DetailLayout detail={data} />;
}
