const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Plan definitions
const PLANS = {
  free:                  { name: 'Free',                  monthlyAnalyses: 3,   seats: 1, price: 0 },
  starter_trial:         { name: 'Starter Trial',         monthlyAnalyses: 40,  seats: 1, trialDays: 10, price: 0 },
  starter_monthly:       { name: 'Starter',               monthlyAnalyses: 40,  seats: 1, price: 1900,  interval: 'month', stripePriceId: process.env.STRIPE_STARTER_MONTHLY_ID },
  starter_annual:        { name: 'Starter Annual',        monthlyAnalyses: 40,  seats: 1, price: 19380, interval: 'year',  stripePriceId: process.env.STRIPE_STARTER_ANNUAL_ID },
  professional_monthly:  { name: 'Professional',          monthlyAnalyses: 50,  seats: 1, price: 3400,  interval: 'month', stripePriceId: process.env.STRIPE_PRO_MONTHLY_ID },
  professional_annual:   { name: 'Professional Annual',   monthlyAnalyses: 50,  seats: 1, price: 34680, interval: 'year',  stripePriceId: process.env.STRIPE_PRO_ANNUAL_ID },
  team_monthly:          { name: 'Team',                  monthlyAnalyses: 250, seats: 4, price: 6900,  interval: 'month', stripePriceId: process.env.STRIPE_TEAM_MONTHLY_ID },
  team_annual:           { name: 'Team Annual',           monthlyAnalyses: 250, seats: 4, price: 70452, interval: 'year',  stripePriceId: process.env.STRIPE_TEAM_ANNUAL_ID },
};

// ── In-memory stores
const userStore = {};
const trialStore = {};
const ipTrialStore = {};

function getUser(email) {
  if (!userStore[email]) {
    userStore[email] = {
      email,
      plan: 'free',
      creditsUsed: 0,
      creditsLimit: 3,
      seats: 1,
      subscribed: false,
      customerId: null,
      trialStarted: null,
      trialExpiry: null,
      billingCycleStart: new Date(),
    };
  }
  return userStore[email];
}

function getDocumentCreditCost(pageCount) {
  if (!pageCount || pageCount <= 20) return 1;
  if (pageCount <= 50) return 2;
  return 3;
}

function estimatePageCount(text) {
  return Math.ceil(text.length / 1500);
}

function checkBillingReset(user) {
  const now = new Date();
  const cycleStart = new Date(user.billingCycleStart);
  const daysSinceCycle = (now - cycleStart) / (1000 * 60 * 60 * 24);
  const resetDays = user.plan.includes('annual') ? 365 : 30;
  if (daysSinceCycle >= resetDays) {
    user.creditsUsed = 0;
    user.billingCycleStart = now;
  }
}

function checkTrialExpiry(user) {
  if (user.plan === 'starter_trial' && user.trialExpiry) {
    if (new Date() > new Date(user.trialExpiry)) {
      user.plan = 'free';
      user.creditsLimit = 3;
      user.creditsUsed = Math.min(user.creditsUsed, 3);
    }
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.connection?.remoteAddress || 'unknown';
}

// ── POST /api/start-trial
app.post('/api/start-trial', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const ip = getClientIp(req);

  if (trialStore[email]) {
    return res.status(400).json({
      error: 'trial_used',
      message: 'A free trial has already been used for this email address.',
    });
  }

  const ipCount = ipTrialStore[ip] || 0;
  if (ipCount >= 2) {
    return res.status(400).json({
      error: 'trial_limit',
      message: 'The maximum number of free trials from this location has been reached. Please subscribe to continue.',
    });
  }

  const user = getUser(email);
  const trialExpiry = new Date();
  trialExpiry.setDate(trialExpiry.getDate() + 10);

  user.plan = 'starter_trial';
  user.creditsLimit = 40;
  user.creditsUsed = 0;
  user.trialStarted = new Date();
  user.trialExpiry = trialExpiry;

  trialStore[email] = { started: new Date(), ip };
  ipTrialStore[ip] = ipCount + 1;

  res.json({
    message: 'Trial started successfully',
    trialExpiry: trialExpiry.toISOString(),
    daysRemaining: 10,
  });
});

// ── POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  const { email, contractContent, contractType, outputDetail, perspective, estimatedPages } = req.body;

  if (!email || !contractContent) {
    return res.status(400).json({ error: 'Email and contract content are required.' });
  }

  const user = getUser(email);
  checkBillingReset(user);
  checkTrialExpiry(user);

  const pageCount = estimatedPages || estimatePageCount(contractContent);
  const creditCost = getDocumentCreditCost(pageCount);
  const creditsRemaining = user.creditsLimit - user.creditsUsed;

  if (creditsRemaining <= 0) {
    return res.status(402).json({
      error: 'credits_exhausted',
      message: user.plan === 'free'
        ? 'You have used all your free analyses. Start a free trial or subscribe to continue.'
        : user.plan === 'starter_trial'
        ? 'You have used all your trial analyses. Please subscribe to continue.'
        : 'You have used all your analyses for this billing period. Please upgrade or wait for your next billing cycle.',
      creditsUsed: user.creditsUsed,
      creditsLimit: user.creditsLimit,
      plan: user.plan,
    });
  }

  if (creditsRemaining < creditCost) {
    return res.status(402).json({
      error: 'insufficient_credits',
      message: `This document requires ${creditCost} analysis credits (estimated ${pageCount} pages) but you only have ${creditsRemaining} credit${creditsRemaining === 1 ? '' : 's'} remaining. Please upgrade your plan.`,
      creditsRemaining,
      creditCost,
      pageCount,
    });
  }

  const detailInstruction = {
    executive: 'Provide a concise executive-level summary. Focus on the 5-8 most important points. Be brief.',
    standard: 'Provide a thorough standard summary with all requested sections.',
    detailed: 'Provide a highly detailed summary. Quote key clauses where the exact wording is material. Be comprehensive.',
  }[outputDetail] || 'Provide a thorough standard summary with all requested sections.';

  const perspectiveInstruction = {
    neutral: 'Analyze from a neutral perspective, noting risks and obligations for both parties.',
    party1: 'Flag risks and unfavorable terms especially from the perspective of the FIRST party named.',
    party2: 'Flag risks and unfavorable terms especially from the perspective of the SECOND party named.',
  }[perspective] || 'Analyze from a neutral perspective.';

  const contractTypeHint = contractType !== 'auto'
    ? `The user identifies this as a: ${contractType}.`
    : 'Read the contract carefully and identify the actual contract type from its content. Do NOT assume.';

  const systemPrompt = `You are Contract Summarizer Agent, an expert legal summarization assistant.

CRITICAL INSTRUCTIONS:
1. You must ONLY analyze the actual contract text provided.
2. Do NOT make up or assume any details not present in the contract.
3. Read every word carefully - identify the REAL parties, REAL dates, REAL terms.
4. Base your entire analysis on what is ACTUALLY written in the contract.

Respond ONLY with valid JSON. No markdown, no backticks, no preamble.

JSON structure:
{
  "docTitle": "string",
  "docDate": "string or null",
  "parties": [{"name": "string", "role": "string"}],
  "purpose": "string",
  "contractType": "string",
  "executiveSummary": ["string"],
  "keyTerms": [{"term": "string", "detail": "string"}],
  "obligations": [{"party": "string", "obligation": "string"}],
  "redFlags": [{"title": "string", "detail": "string", "severity": "high|medium|low"}],
  "missing": ["string"],
  "balance": {"score": 0-100, "label": "string", "explanation": "string"},
  "clarifications": ["string"],
  "overallTone": "string"
}

${detailInstruction}
${perspectiveInstruction}
${contractTypeHint}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Analyze this contract and return ONLY JSON:\n\n${contractContent}` }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Claude API error', detail: err });
    }

    const data = await response.json();
    const rawText = data.content.map(b => b.text || '').join('').trim();
    const clean = rawText.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
    const result = JSON.parse(clean);

    user.creditsUsed += creditCost;

    const trialDaysRemaining = user.trialExpiry
      ? Math.max(0, Math.ceil((new Date(user.trialExpiry) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;

    res.json({
      result,
      usage: {
        creditsUsed: user.creditsUsed,
        creditsLimit: user.creditsLimit,
        creditsRemaining: user.creditsLimit - user.creditsUsed,
        creditCost,
        pageCount,
        plan: user.plan,
        subscribed: user.subscribed,
        trialDaysRemaining,
      },
    });

  } catch (err) {
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

// ── POST /api/upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const filename = req.file.originalname.toLowerCase();

  try {
    let text = '';
    let estimatedPages = 1;

    if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
      estimatedPages = estimatePageCount(text);
    } else if (filename.endsWith('.pdf')) {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        text = pdfData.text;
        estimatedPages = pdfData.numpages || estimatePageCount(text);
        if (text.trim().split(/\s+/).length < 50) {
          return res.status(400).json({ error: 'scanned_pdf', message: 'This appears to be a scanned PDF. Please paste the text manually instead.' });
        }
      } catch {
        return res.status(400).json({ error: 'scanned_pdf', message: 'Could not extract text from this PDF. Please paste the text manually instead.' });
      }
    } else {
      text = req.file.buffer.toString('utf-8');
      estimatedPages = estimatePageCount(text);
    }

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract text from file. Please paste the text manually.' });
    }

    res.json({ text: text.trim(), estimatedPages, creditCost: getDocumentCreditCost(estimatedPages) });
  } catch (err) {
    res.status(500).json({ error: 'File reading failed: ' + err.message });
  }
});

// ── POST /api/enterprise-contact
app.post('/api/enterprise-contact', async (req, res) => {
  const { name, email, company, phone, numberOfUsers, message } = req.body;
  if (!name || !email || !company || !message) {
    return res.status(400).json({ error: 'Name, email, company and message are required.' });
  }

  const inquiry = { name, email, company, phone, numberOfUsers, message, receivedAt: new Date().toISOString() };
  console.log('Enterprise inquiry:', JSON.stringify(inquiry, null, 2));

  if (process.env.CONTACT_EMAIL && process.env.SMTP_HOST) {
    try {
      const transporter = nodemailer.createTransporter({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.CONTACT_EMAIL,
        subject: `Enterprise Inquiry — ${company}`,
        text: `Name: ${name}\nEmail: ${email}\nCompany: ${company}\nPhone: ${phone||'N/A'}\nUsers: ${numberOfUsers||'N/A'}\n\n${message}`,
      });
    } catch (e) { console.error('Email failed:', e.message); }
  }

  res.json({ message: 'Thank you for your inquiry. We will be in touch within one business day.' });
});

// ── POST /api/create-checkout
app.post('/api/create-checkout', async (req, res) => {
  const { email, planKey } = req.body;
  if (!email || !planKey) return res.status(400).json({ error: 'Email and plan required.' });

  const plan = PLANS[planKey];
  if (!plan || !plan.stripePriceId) return res.status(400).json({ error: 'Invalid plan.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      automatic_tax: { enabled: true },
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(email)}&plan=${planKey}`,
      cancel_url: `${process.env.APP_URL}/#pricing`,
      metadata: { planKey, email },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/webhook
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.metadata?.email;
    const planKey = session.metadata?.planKey;
    if (email && planKey && PLANS[planKey]) {
      const user = getUser(email);
      const plan = PLANS[planKey];
      user.plan = planKey;
      user.subscribed = true;
      user.customerId = session.customer;
      user.creditsLimit = plan.monthlyAnalyses;
      user.creditsUsed = 0;
      user.seats = plan.seats;
      user.billingCycleStart = new Date();
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    for (const user of Object.values(userStore)) {
      if (user.customerId === customerId) {
        user.plan = 'free'; user.subscribed = false;
        user.creditsLimit = 3; user.creditsUsed = 0;
      }
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const customerId = event.data.object.customer;
    for (const user of Object.values(userStore)) {
      if (user.customerId === customerId && user.subscribed) {
        user.creditsUsed = 0;
        user.billingCycleStart = new Date();
      }
    }
  }

  res.json({ received: true });
});

// ── GET /api/status
app.get('/api/status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const user = getUser(email);
  checkBillingReset(user);
  checkTrialExpiry(user);
  const trialDaysRemaining = user.trialExpiry
    ? Math.max(0, Math.ceil((new Date(user.trialExpiry) - new Date()) / (1000 * 60 * 60 * 24)))
    : null;
  res.json({
    plan: user.plan,
    subscribed: user.subscribed,
    creditsUsed: user.creditsUsed,
    creditsLimit: user.creditsLimit,
    creditsRemaining: user.creditsLimit - user.creditsUsed,
    seats: user.seats,
    trialDaysRemaining,
    hadTrial: !!trialStore[email],
  });
});

// ── GET /api/reset-test (remove before public launch)
app.get('/api/reset-test', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  if (userStore[email]) {
    userStore[email].creditsUsed = 0;
    userStore[email].plan = 'free';
    userStore[email].creditsLimit = 3;
    userStore[email].subscribed = false;
    userStore[email].trialExpiry = null;
    userStore[email].trialStarted = null;
  }
  delete trialStore[email];
  res.json({ message: 'Reset successful', email });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Contract Summarizer running on port ${PORT}`));
