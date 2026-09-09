import { createHash } from 'node:crypto';

const commonTimes = ['morning', 'afternoon', 'evening', 'anytime'];
const sizes = ['1', '2', '3', '4', '5', '6', '7+'];
const schemas = {
  contact: { name: 100, email: 254, message: 3000 },
  individual: {
    individualName: 100, individualEmail: 254, individualPhone: 30,
    individualContactTime: commonTimes, applyingAs: ['self', 'household'],
    individualHouseholdSize: sizes,
    individualMonthlyHouseholdIncome: ['under-1000', '1000-under-2500', '2500-under-4000', '4000-under-6000', '6000-plus'],
    individualEmploymentStatus: ['', 'employed', 'looking-for-employment', 'student'],
    individualSituation: 1500,
  },
  agency: {
    agencyName: 140, agencyType: ['hospital', 'social-services', 'veterans', 'housing', 'other'],
    caseworkerName: 100, caseworkerEmail: 254, caseworkerPhone: 30,
    caseworkerContactTime: commonTimes, referralName: 100, referralHouseholdSize: sizes, referralSituation: 1500,
  },
};

export function validateSubmission(body) {
  const kind = body?.kind === 'contact' ? 'contact' : body?.kind === 'intake' ? body.fields?.pathway : '';
  if (!Object.hasOwn(schemas, kind) || !body.fields || typeof body.fields !== 'object') throw Error('Choose a valid form.');
  const fields = {};
  for (const [key, rule] of Object.entries(schemas[kind])) {
    const value = body.fields[key] ?? '';
    if (typeof value !== 'string') throw Error('Invalid field value.');
    const clean = value.trim();
    if (Array.isArray(rule) ? !rule.includes(clean) : !clean || clean.length > rule) throw Error('Please complete all required fields with valid values.');
    fields[key] = clean;
  }
  const email = fields.email || fields.individualEmail || fields.caseworkerEmail;
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || /[\r\n]/.test(email)) throw Error('Enter a valid email address.');
  if (Object.keys(body.fields).some(key => key.startsWith('document-'))) throw Error('Document delivery is not enabled.');
  if (kind === 'individual') {
    for (const key of ['backgroundCheckAcknowledgement', 'drugTestAcknowledgement']) {
      if (body.fields[key] !== undefined && body.fields[key] !== 'on') throw Error('Invalid acknowledgement.');
      fields[key] = body.fields[key] === 'on' ? 'Willing to discuss; NOT authorization' : 'Not selected';
    }
  }
  return { kind, fields, email: email.toLowerCase() };
}

export async function deliverSubmission(submission, requestId, env, fetcher = fetch) {
  const { kind, fields, email } = submission;
  const fingerprint = createHash('sha256').update(JSON.stringify(submission)).digest('hex');
  const baseKey = `${requestId}-${fingerprint}`;
  const send = async (suffix, message) => {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${baseKey}-${suffix}` },
      body: JSON.stringify({ from: env.SPH_EMAIL_FROM, ...message }),
    });
    if (!response.ok) throw Error('Email provider unavailable');
    const result = await response.json();
    if (!result.id) throw Error('Email provider did not accept message');
  };
  await send('staff', {
    to: [env.SPH_EMAIL_TO], reply_to: email,
    subject: kind === 'contact' ? 'New SPH contact message' : `New SPH ${kind} housing inquiry`,
    text: Object.entries(fields).map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1')}: ${value}`).join('\n\n') + '\n\nNo supporting documents attached. Preliminary acknowledgements are not screening authorization.',
  });
  try {
    await send('receipt', {
      to: [email], reply_to: env.SPH_EMAIL_REPLY_TO,
      subject: 'We received your message — SPH Foundation',
      text: 'Thank you for contacting SPH Foundation. We received your message, and our team will review it and follow up in due course.\n\nThis acknowledgement is not an application approval or a guarantee of housing. Please do not email identity documents, bank statements, or Social Security information.\n\nSPH Foundation Support',
    });
    return { message: 'Your message has been sent. A confirmation email is on its way.' };
  } catch {
    return { message: 'Your message was sent to SPH, but the confirmation email could not be sent. You do not need to resubmit.' };
  }
}
