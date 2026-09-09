import type { APIRoute } from 'astro';
import { validateSubmission, deliverSubmission } from '../../lib/form-delivery.mjs';
import { requestNewsletter, normalizeEmail } from '../../lib/newsletter.mjs';

export const prerender = false;
const attempts = new Map<string, { count: number; expires: number }>();
const json = (status: number, message: string) => new Response(JSON.stringify({ message }), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const env = { ...import.meta.env, ...process.env };
  const allowed = ['https://www.sph-foundation.org', 'https://sph-foundation.org'];
  if (import.meta.env.DEV) allowed.push(new URL(request.url).origin);
  if (!allowed.includes(request.headers.get('origin') || '')) return json(403, 'Please submit from the SPH website.');
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json(415, 'Invalid request format.');
  if (!env.RESEND_API_KEY || !env.SPH_EMAIL_FROM || !env.SPH_EMAIL_TO || !env.SPH_EMAIL_REPLY_TO) return json(503, 'Delivery is temporarily unavailable. Please try again later.');
  // Explicit release gate until production abuse protection and delivery are verified.
  if (!import.meta.env.DEV && env.SPH_FORMS_ENABLED !== 'true') return json(503, 'Online submissions are not available yet. Please try again later.');
  const id = request.headers.get('idempotency-key') || '';
  if (!/^[a-f0-9-]{36}$/i.test(id)) return json(400, 'Please reload the form and try again.');
  const now = Date.now();
  for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
  const bucket = attempts.get(clientAddress) || { count: 0, expires: now + 60000 };
  if (++bucket.count > 5) return json(429, 'Please wait a minute before trying again.');
  attempts.set(clientAddress, bucket);
  let parsed;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json(400, 'Empty request.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 20000) { await reader.cancel(); return json(413, 'Your message is too large.'); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    parsed = body.kind === 'newsletter' ? { kind: 'newsletter', email: normalizeEmail(body.fields?.email) } : validateSubmission(body);
  } catch { return json(400, 'Please check the required fields and try again.'); }
  try {
    if (parsed.kind === 'newsletter') {
      if (!env.RESEND_CONTACTS_API_KEY || !env.NEWSLETTER_TOKEN_SECRET || !env.SPH_SITE_URL) return json(503, 'Newsletter signup is temporarily unavailable.');
      return json(200, await requestNewsletter(parsed.email, env));
    }
    const result = await deliverSubmission(parsed, id, env);
    return json(200, result.message);
  } catch { return json(502, 'We could not confirm delivery. Please retry using this form.'); }
};
