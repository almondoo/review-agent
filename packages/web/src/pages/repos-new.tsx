import { type FormEvent, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateRepo } from '../api/client.js';
import type { Platform } from '../api/types.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'github', label: '[GH] GitHub' },
  { value: 'codecommit', label: '[CC] AWS CodeCommit' },
];

export function ReposNewPage() {
  const navigate = useNavigate();
  const createRepo = useCreateRepo();
  const [platform, setPlatform] = useState<Platform>('github');
  const [name, setName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const platformId = useId();
  const nameId = useId();
  const nameErrorId = useId();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const trimmed = name.trim();
    if (!trimmed) {
      setValidationError('Repository name is required.');
      return;
    }
    if (!/^[a-zA-Z0-9._\-/]+$/.test(trimmed)) {
      setValidationError('Invalid repository name. Use letters, numbers, ., _, -, /');
      return;
    }

    createRepo.mutate({ platform, name: trimmed }, { onSuccess: () => navigate('/repos') });
  }

  const inputStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '0.625rem 0.75rem',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875rem',
    backgroundColor: 'var(--bg-raised)',
    border: '1px solid var(--hairline)',
    borderRadius: 'var(--radius)',
    color: 'var(--fg)',
    outline: 'none',
    transition: 'border-color var(--transition-fast)',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.625rem',
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--graphite)',
    marginBottom: '0.5rem',
  };

  return (
    <StaggerContainer>
      <StaggerItem>
        <SectionHeading title="Add Repo" subtitle="Connect a new repository" />
      </StaggerItem>

      <StaggerItem>
        <div style={{ maxWidth: '480px' }}>
          <form onSubmit={handleSubmit} noValidate>
            {/* Platform */}
            <div style={{ marginBottom: '1.5rem' }}>
              <label htmlFor={platformId} style={labelStyle}>
                Platform
              </label>
              <select
                id={platformId}
                value={platform}
                onChange={(e) => setPlatform(e.target.value as Platform)}
                style={inputStyle}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <Hairline style={{ marginBottom: '1.5rem' }} />

            {/* Repository name */}
            <div style={{ marginBottom: '1.5rem' }}>
              <label htmlFor={nameId} style={labelStyle}>
                Repository Name
              </label>
              <input
                id={nameId}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={platform === 'github' ? 'owner/repo-name' : 'repo-name'}
                autoComplete="off"
                style={inputStyle}
                aria-describedby={validationError ? nameErrorId : undefined}
                aria-invalid={validationError ? 'true' : undefined}
              />
              {validationError && (
                <p
                  id={nameErrorId}
                  role="alert"
                  style={{
                    marginTop: '0.375rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.625rem',
                    color: 'var(--rust)',
                  }}
                >
                  [ERROR] {validationError}
                </p>
              )}
            </div>

            {/* Mutation error */}
            {createRepo.isError && (
              <p
                role="alert"
                style={{
                  marginBottom: '1rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.625rem',
                  color: 'var(--rust)',
                }}
              >
                [ERROR] Failed to create repository. Please try again.
              </p>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <button
                type="submit"
                disabled={createRepo.isPending}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--paper)',
                  backgroundColor: createRepo.isPending ? 'var(--graphite)' : 'var(--ink)',
                  border: 'none',
                  padding: '0.625rem 1.25rem',
                  borderRadius: 'var(--radius)',
                  cursor: createRepo.isPending ? 'not-allowed' : 'pointer',
                  transition: 'background-color var(--transition-fast)',
                }}
              >
                {createRepo.isPending ? '[SAVING...]' : '[ADD REPO]'}
              </button>

              <button
                type="button"
                onClick={() => navigate('/repos')}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--graphite)',
                  padding: '0.625rem 0',
                }}
              >
                [CANCEL]
              </button>
            </div>
          </form>
        </div>
      </StaggerItem>
    </StaggerContainer>
  );
}
