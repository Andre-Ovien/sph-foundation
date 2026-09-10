import { createHmac, timingSafeEqual } from 'node:crypto';

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw Error('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw Error('Enter a valid email address.');
  return email;
}

function signature(payload, env) {
  if (!env.NEWSLETTER_TOKEN_SECRET) throw Error('Newsletter is not configured.');
  return createHmac('sha256', env.NEWSLETTER_TOKEN_SECRET).update(payload).digest('base64url');
}

export function makeToken(email, action, env, day = Math.floor(Date.now() / 86400000)) {
  const payload = Buffer.from(JSON.stringify({ email, action, day })).toString('base64url');
  return `${payload}.${signature(payload, env)}`;
}

export function readToken(token, env) {
  if (typeof token !== 'string' || token.length > 1000) throw Error('Invalid link.');
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) throw Error('Invalid link.');
  const expected = signature(payload, env);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw Error('Invalid link.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const today = Math.floor(Date.now() / 86400000);
  if (data.action !== 'unsubscribe' || !Number.isInteger(data.day) || data.day > today) throw Error('Invalid unsubscribe link.');
  return { ...data, email: normalizeEmail(data.email) };
}

async function contactRequest(path, env, options = {}, fetcher = fetch) {
  const response = await fetcher(`https://api.resend.com/contacts${path}`, {
    ...options, signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${env.RESEND_CONTACTS_API_KEY}`, 'Content-Type': 'application/json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Error('Subscriber service temporarily unavailable. Please try again.');
  return response.json();
}

async function sendNewsletterEmail(email, subject, text, key, env, fetcher) {
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ from: env.SPH_EMAIL_FROM, to: [email], reply_to: env.SPH_EMAIL_REPLY_TO, subject, text }),
  });
  if (!response.ok || !(await response.json()).id) throw Error('We could not send the email. Please try again.');
}

export async function requestNewsletter(value, env, fetcher = fetch) {
  const email = normalizeEmail(value);
  const existing = await contactRequest(`/${encodeURIComponent(email)}`, env, {}, fetcher);
  if (existing && !existing.unsubscribed) return 'You are already subscribed.';
  // Respect opt-outs: repeated public form submissions cannot silently resubscribe somebody.
  if (existing?.unsubscribed) return 'This address previously opted out. Please contact SPH if you want to subscribe again.';
  const created = await contactRequest('', env, { method: 'POST', body: JSON.stringify({ email, unsubscribed: false }) }, fetcher);
  if (!created?.id) throw Error('Subscription could not be saved. Please try again.');
  const unsubscribe = `${env.SPH_SITE_URL}/newsletter?token=${encodeURIComponent(makeToken(email, 'unsubscribe', env, 0))}`;
  try {
    await sendNewsletterEmail(email, 'You’re subscribed — SPH Foundation', `Thanks for subscribing to SPH Foundation updates. You’re on the list; no further action is needed.\n\nIf you did not request this, or wish to unsubscribe at any time:\n${unsubscribe}\n\nSPH Foundation Support`, `newsletter-welcome-${created.id}`, env, fetcher);
    return 'You’re subscribed. A welcome email is on its way.';
  } catch {
    return 'You’re subscribed, but the welcome email could not be sent. No need to sign up again.';
  }
}

export async function finishNewsletter(token, env, fetcher = fetch) {
  const { email, action } = readToken(token, env);
  const path = `/${encodeURIComponent(email)}`;
  const existing = await contactRequest(path, env, {}, fetcher);
  if (action === 'unsubscribe') {
    if (existing && !existing.unsubscribed) await contactRequest(path, env, { method: 'PATCH', body: JSON.stringify({ unsubscribed: true }) }, fetcher);
    return 'You’re unsubscribed from SPH newsletter updates.';
  }
  throw Error('Invalid unsubscribe link.');
}
