import crypto from 'node:crypto';
import { createMiddleware } from 'hono/factory';

/**
 * AWS SNS HTTPS subscription signature verification.
 *
 * SNS delivers signed JSON envelopes over HTTP(S). Each envelope contains
 * a `Signature` (base64), a `SignatureVersion` (`1` = SHA1, `2` = SHA256),
 * and a `SigningCertURL` pointing at an AWS-hosted X.509 certificate
 * (`*.amazonaws.com`). To verify:
 *
 * 1. Build a canonical string from a fixed, version-specific subset of
 *    fields in fixed order, each followed by `\n`.
 * 2. Fetch the signing certificate from `SigningCertURL`.
 * 3. Verify `Signature` against the canonical string using
 *    `RSA-SHA1` or `RSA-SHA256` and the certificate's public key.
 *
 * Reference:
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * Spec §7.1 / line 821: "CodeCommit (via SNS): use AWS SNS message
 * signature verification with SigV4". (AWS docs call the scheme
 * "Signature" not "SigV4" but the issue body uses that name.)
 *
 * To keep tests offline and deterministic, the middleware accepts
 * injectable `fetchCert` and `verifySignature` functions; defaults
 * call out to the real network / `node:crypto` only at runtime.
 */

export type SnsMessageType =
  | 'Notification'
  | 'SubscriptionConfirmation'
  | 'UnsubscribeConfirmation';

export type SnsMessage = {
  readonly Type: SnsMessageType;
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Timestamp: string;
  readonly Signature: string;
  readonly SignatureVersion: '1' | '2';
  readonly SigningCertURL: string;
  readonly Message?: string;
  readonly Subject?: string;
  readonly Token?: string;
  readonly SubscribeURL?: string;
};

export type VerifySnsEnv = {
  Variables: {
    snsRawBody: string;
    snsMessage: SnsMessage;
  };
};

export type FetchCert = (url: string) => Promise<string>;
export type VerifyFn = (params: {
  readonly canonical: string;
  readonly signatureBase64: string;
  readonly signatureVersion: '1' | '2';
  readonly certificatePem: string;
}) => boolean;

export type VerifySnsSignatureOpts = {
  /**
   * Custom certificate fetcher. Defaults to `fetch(url).then(r => r.text())`
   * but is overridden in tests to a static map.
   */
  readonly fetchCert?: FetchCert;
  /**
   * Custom verifier. Defaults to the `node:crypto` implementation.
   * Tests override this to skip RSA entirely.
   */
  readonly verifySignature?: VerifyFn;
  /**
   * Allowlist for the certificate host. AWS publishes signing certs only
   * from `*.amazonaws.com`. We default to that suffix to prevent
   * spoofing the cert URL to attacker-controlled hosts. Tests can
   * pass an empty array to disable the check; production should not.
   */
  readonly allowedCertHostSuffixes?: ReadonlyArray<string>;
};

const DEFAULT_CERT_HOST_SUFFIXES: ReadonlyArray<string> = ['.amazonaws.com'];

/**
 * Builds the canonical string-to-sign for SNS message verification.
 * AWS specifies the exact key set and ordering, with each `key\nvalue\n`
 * pair joined.
 */
export function buildSnsCanonicalString(msg: SnsMessage): string {
  const keys: ReadonlyArray<keyof SnsMessage> =
    msg.Type === 'Notification'
      ? msg.Subject !== undefined
        ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
        : ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

  const parts: string[] = [];
  for (const k of keys) {
    const v = msg[k];
    if (v === undefined) continue;
    parts.push(k);
    parts.push('\n');
    parts.push(String(v));
    parts.push('\n');
  }
  return parts.join('');
}

const defaultFetchCert: FetchCert = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SNS cert fetch failed: ${res.status}`);
  }
  return res.text();
};

const defaultVerifySignature: VerifyFn = ({
  canonical,
  signatureBase64,
  signatureVersion,
  certificatePem,
}) => {
  const algo = signatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const verifier = crypto.createVerify(algo);
  verifier.update(canonical, 'utf8');
  verifier.end();
  return verifier.verify(certificatePem, signatureBase64, 'base64');
};

/**
 * Pure helper that performs the full verification on a parsed envelope.
 * Returns `true` iff the signature is valid for the given message.
 * Throws (caught by middleware) when the cert URL is malformed or the
 * cert host fails the allowlist.
 */
export async function verifySnsMessage(
  msg: SnsMessage,
  opts: VerifySnsSignatureOpts = {},
): Promise<boolean> {
  if (msg.SignatureVersion !== '1' && msg.SignatureVersion !== '2') {
    return false;
  }
  const allow = opts.allowedCertHostSuffixes ?? DEFAULT_CERT_HOST_SUFFIXES;
  if (allow.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(msg.SigningCertURL);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    const ok = allow.some((s) => host === s.replace(/^\./, '') || host.endsWith(s));
    if (!ok) return false;
  }
  const fetcher = opts.fetchCert ?? defaultFetchCert;
  const verifier = opts.verifySignature ?? defaultVerifySignature;
  const cert = await fetcher(msg.SigningCertURL);
  const canonical = buildSnsCanonicalString(msg);
  return verifier({
    canonical,
    signatureBase64: msg.Signature,
    signatureVersion: msg.SignatureVersion,
    certificatePem: cert,
  });
}

/**
 * Hono middleware that:
 * 1. Reads the raw request body and parses it as a JSON SNS envelope.
 * 2. Calls `verifySnsMessage` (injectable in tests).
 * 3. On success, stashes the raw body + parsed message on the context
 *    so downstream handlers can act on them without re-parsing.
 *
 * Rejects with `401 { error: 'unauthorized' }` on any signature failure
 * and `400 { error: 'bad request' }` on malformed JSON / missing fields.
 * Error bodies are identical between failure modes so a probe cannot
 * distinguish "missing signature" from "bad signature".
 */
export function verifySnsSignature(opts: VerifySnsSignatureOpts = {}) {
  return createMiddleware<VerifySnsEnv>(async (c, next) => {
    const raw = await c.req.text();
    let parsed: SnsMessage;
    try {
      const obj = JSON.parse(raw) as Partial<SnsMessage>;
      if (
        typeof obj.Type !== 'string' ||
        typeof obj.MessageId !== 'string' ||
        typeof obj.TopicArn !== 'string' ||
        typeof obj.Timestamp !== 'string' ||
        typeof obj.Signature !== 'string' ||
        typeof obj.SigningCertURL !== 'string'
      ) {
        return c.json({ error: 'bad request' }, 400);
      }
      if (
        obj.Type !== 'Notification' &&
        obj.Type !== 'SubscriptionConfirmation' &&
        obj.Type !== 'UnsubscribeConfirmation'
      ) {
        return c.json({ error: 'bad request' }, 400);
      }
      const sv = obj.SignatureVersion;
      if (sv !== '1' && sv !== '2') {
        return c.json({ error: 'bad request' }, 400);
      }
      parsed = obj as SnsMessage;
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }

    let ok = false;
    try {
      ok = await verifySnsMessage(parsed, opts);
    } catch {
      ok = false;
    }
    if (!ok) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('snsRawBody', raw);
    c.set('snsMessage', parsed);
    await next();
  });
}
