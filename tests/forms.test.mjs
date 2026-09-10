import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSubmission, deliverSubmission } from '../src/lib/form-delivery.mjs';
import { requestNewsletter, makeToken, readToken, finishNewsletter, normalizeEmail, NEWSLETTER_SEGMENT_ID } from '../src/lib/newsletter.mjs';

const env = { RESEND_API_KEY: 'test-send', RESEND_CONTACTS_API_KEY: 'test-contacts', NEWSLETTER_TOKEN_SECRET: 'test-secret-only', SPH_EMAIL_FROM: 'SPH <support@example.org>', SPH_EMAIL_TO: 'staff@example.org', SPH_EMAIL_REPLY_TO: 'staff@example.org', SPH_SITE_URL: 'https://example.org' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const contact = { kind: 'contact', fields: { name: 'Test', email: 'test@example.org', message: 'Hello' } };

test('unsubscribe page preserves native POST origin while keeping the token out of referrers', () => {
  const page = readFileSync(new URL('../src/pages/newsletter.astro', import.meta.url), 'utf8');
  assert.match(page, /headers\.set\('Referrer-Policy', 'strict-origin'\)/);
  assert.match(page, /headers\.get\('origin'\) !== Astro\.url\.origin/);
  assert.match(page, /Astro\.request\.method === 'POST'/);
});

test('validates required fields and email; rejects attachments and unknown pathway', () => {
  assert.equal(validateSubmission(contact).email, 'test@example.org');
  assert.throws(() => validateSubmission({ ...contact, fields: { ...contact.fields, name: '' } }));
  assert.throws(() => validateSubmission({ ...contact, fields: { ...contact.fields, email: 'x\r\nbcc:y@example.org' } }));
  assert.throws(() => validateSubmission({ ...contact, fields: { ...contact.fields, 'document-id': 'x' } }));
  assert.throws(() => validateSubmission({ kind: 'intake', fields: { pathway: 'constructor' } }));
});

test('sends staff notification first, fixed recipient, separate generic receipt with idempotency', async () => {
  const calls = [];
  const fake = async (url, opts) => { calls.push({ url, ...opts, data: JSON.parse(opts.body) }); return response({ id: 'accepted' }); };
  await deliverSubmission(validateSubmission(contact), 'test-id', env, fake);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].data.to, ['staff@example.org']);
  assert.equal(calls[0].data.reply_to, 'test@example.org');
  assert.deepEqual(calls[1].data.to, ['test@example.org']);
  assert.ok(!calls[1].data.text.includes('Hello'));
  assert.notEqual(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});

test('does not send receipt after staff failure; reports partial receipt failure honestly', async () => {
  let calls = 0;
  await assert.rejects(deliverSubmission(validateSubmission(contact), 'id', env, async () => { calls++; return response({}, 503); }));
  assert.equal(calls, 1);
  calls = 0;
  const result = await deliverSubmission(validateSubmission(contact), 'id', env, async () => ++calls === 1 ? response({ id: 'yes' }) : response({}, 503));
  assert.match(result.message, /do not need to resubmit/);
});

test('newsletter subscribes immediately, sends one welcome, rejects duplicate and preserves opt-out', async () => {
  let subscriber = null;
  let sends = 0;
  let creates = 0;
  const fake = async (url, opts = {}) => {
    if (url.endsWith('/emails')) { sends++; return response({ id: 'mail' }); }
    if (opts.method === 'POST') {
      assert.deepEqual(JSON.parse(opts.body).segments, [{ id: NEWSLETTER_SEGMENT_ID }]);
      creates++; subscriber = { id: 'subscriber', email: 'test@example.org', unsubscribed: false }; return response(subscriber);
    }
    if (opts.method === 'PATCH') { subscriber.unsubscribed = true; return response(subscriber); }
    return subscriber ? response(subscriber) : response({}, 404);
  };
  assert.match(await requestNewsletter(' Test@Example.org ', env, fake), /welcome email/);
  assert.equal(await requestNewsletter('test@example.org', env, fake), 'You are already subscribed.');
  assert.equal(creates, 1); assert.equal(sends, 1);
  const token = makeToken('test@example.org', 'unsubscribe', env, 0);
  assert.match(await finishNewsletter(token, env, fake), /unsubscribed/);
  assert.match(await requestNewsletter('test@example.org', env, fake), /opted out/);
  assert.equal(creates, 1); assert.equal(sends, 1);
});

test('subscriber outage cannot be mistaken for new contact; forged tokens rejected', async () => {
  await assert.rejects(requestNewsletter('test@example.org', env, async () => response({}, 500)));
  assert.throws(() => normalizeEmail('bad'));
  const token = makeToken('test@example.org', 'unsubscribe', env, 0);
  assert.equal(readToken(token, env).email, 'test@example.org');
  assert.throws(() => readToken(token + 'a', env));
  assert.throws(() => readToken(makeToken('test@example.org', 'confirm', env), env));
});
