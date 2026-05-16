export type UntrustedCommit = {
  readonly sha: string;
  readonly message: string;
};

export type UntrustedMetadata = {
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRef?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly commitMessages?: ReadonlyArray<UntrustedCommit>;
};

/**
 * Escape any literal `</untrusted>` substring (case-insensitive) so
 * attacker-supplied PR content cannot break out of the wrapper. The
 * runner relies on this single closing tag being the only literal
 * `</untrusted>` in the composed user message; an unescaped one
 * inside a label / commit body would let an attacker hand the LLM
 * arbitrary instructions outside the data envelope.
 */
function safe(value: string): string {
  return value.replace(/<\/untrusted>/gi, '&lt;/untrusted&gt;');
}

function renderLabels(labels: ReadonlyArray<string>): string {
  // Each label is escaped against `</untrusted>` AND wrapped in its
  // own `<label>` child so the LLM sees a clean list rather than a
  // free-form comma-joined string an attacker could rewrite into
  // pseudo-structure.
  const items = labels.map((l) => `  <label>${safe(l)}</label>`).join('\n');
  return ['<labels>', items, '</labels>'].join('\n');
}

function renderCommits(commits: ReadonlyArray<UntrustedCommit>): string {
  // Each commit gets a `<commit sha="...">message</commit>` child.
  // The sha goes in an attribute so the LLM can refer to it
  // discretely; the message body is escaped against `</untrusted>`.
  const items = commits
    .map((c) => `  <commit sha="${safe(c.sha)}">${safe(c.message)}</commit>`)
    .join('\n');
  return ['<commits>', items, '</commits>'].join('\n');
}

export function wrapUntrusted(meta: UntrustedMetadata): string {
  const sections: string[] = [
    '<untrusted>',
    `<title>${safe(meta.title)}</title>`,
    `<author>${safe(meta.author)}</author>`,
    `<body>${safe(meta.body)}</body>`,
  ];
  if (meta.baseRef !== undefined && meta.baseRef.length > 0) {
    sections.push(`<base_branch>${safe(meta.baseRef)}</base_branch>`);
  }
  if (meta.labels && meta.labels.length > 0) {
    sections.push(renderLabels(meta.labels));
  }
  if (meta.commitMessages && meta.commitMessages.length > 0) {
    sections.push(renderCommits(meta.commitMessages));
  }
  sections.push('</untrusted>');
  return sections.join('\n');
}
