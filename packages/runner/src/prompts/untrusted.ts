export type UntrustedMetadata = {
  readonly title: string;
  readonly body: string;
  readonly author: string;
};

export function wrapUntrusted(meta: UntrustedMetadata): string {
  const safe = (v: string) => v.replace(/<\/untrusted>/gi, '&lt;/untrusted&gt;');
  return [
    '<untrusted>',
    `<title>${safe(meta.title)}</title>`,
    `<author>${safe(meta.author)}</author>`,
    `<body>${safe(meta.body)}</body>`,
    '</untrusted>',
  ].join('\n');
}
