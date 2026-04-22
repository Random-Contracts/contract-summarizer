const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Supabase client
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('Supabase connected');
} else {
  console.log('Supabase not configured — history disabled');
}

// ── Plan definitions
const PLANS = {
  free:                 { name: 'Free',           monthlyAnalyses: 3,   seats: 1, price: 0 },
  starter_trial:        { name: 'Starter Trial',  monthlyAnalyses: 7,   seats: 1, trialDays: 7, price: 0 },
  starter_monthly:      { name: 'Starter',        monthlyAnalyses: 30,  seats: 1, price: 2500,   interval: 'month', stripePriceId: process.env.STRIPE_STARTER_MONTHLY_ID },
  starter_annual:       { name: 'Starter Annual', monthlyAnalyses: 30,  seats: 1, price: 25500,  interval: 'year',  stripePriceId: process.env.STRIPE_STARTER_ANNUAL_ID },
  professional_monthly: { name: 'Pro',            monthlyAnalyses: 100, seats: 2, price: 5900,   interval: 'month', stripePriceId: process.env.STRIPE_PRO_MONTHLY_ID },
  professional_annual:  { name: 'Pro Annual',     monthlyAnalyses: 100, seats: 2, price: 60228,  interval: 'year',  stripePriceId: process.env.STRIPE_PRO_ANNUAL_ID },
  team_monthly:         { name: 'Team',           monthlyAnalyses: 250, seats: 4, price: 11900,  interval: 'month', stripePriceId: process.env.STRIPE_TEAM_MONTHLY_ID },
  team_annual:          { name: 'Team Annual',    monthlyAnalyses: 250, seats: 4, price: 121308, interval: 'year',  stripePriceId: process.env.STRIPE_TEAM_ANNUAL_ID },
};

// ── Page limits and credit costs
const PAGE_LIMIT = 150;
function getDocumentCreditCost(pageCount) {
  if (!pageCount || pageCount <= 25) return 1;
  if (pageCount <= 70) return 2;
  return 3;
}
function estimatePageCount(text) {
  return Math.ceil(text.length / 1500);
}

// ── In-memory stores
const userStore = {};
const trialStore = {};
const ipTrialStore = {};

function getUser(email) {
  if (!userStore[email]) {
    userStore[email] = {
      email, plan: 'free', creditsUsed: 0, creditsLimit: 3,
      seats: 1, subscribed: false, customerId: null,
      trialStarted: null, trialExpiry: null,
      billingCycleStart: new Date(),
    };
  }
  return userStore[email];
}

function checkBillingReset(user) {
  const now = new Date();
  const daysSince = (now - new Date(user.billingCycleStart)) / (1000 * 60 * 60 * 24);
  const resetDays = user.plan.includes('annual') ? 365 : 30;
  if (daysSince >= resetDays) { user.creditsUsed = 0; user.billingCycleStart = now; }
}

function checkTrialExpiry(user) {
  if (user.plan === 'starter_trial' && user.trialExpiry) {
    if (new Date() > new Date(user.trialExpiry)) {
      user.plan = 'free'; user.creditsLimit = 3;
      user.creditsUsed = Math.min(user.creditsUsed, 3);
    }
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.connection?.remoteAddress || 'unknown';
}

// ── POST /api/start-trial
app.post('/api/start-trial', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const ip = getClientIp(req);
  const user = getUser(email);

  if (trialStore[email]) {
    return res.status(400).json({ error: 'trial_used', message: 'A free trial has already been used for this email address.' });
  }
  const ipCount = ipTrialStore[ip] || 0;
  if (ipCount >= 2) {
    return res.status(400).json({ error: 'trial_limit', message: 'The maximum number of free trials from this location has been reached. Please subscribe to continue.' });
  }

  const trialExpiry = new Date();
  trialExpiry.setDate(trialExpiry.getDate() + 7);

  user.plan = 'starter_trial';
  user.creditsLimit = 7;   // ← Capped at 7 analyses for trial
  user.creditsUsed = 0;
  user.trialStarted = new Date();
  user.trialExpiry = trialExpiry;

  trialStore[email] = { started: new Date(), ip };
  ipTrialStore[ip] = ipCount + 1;

  res.json({ message: 'Trial started', trialExpiry: trialExpiry.toISOString(), daysRemaining: 7 });
});

// ── POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  const { email, contractContent, contractType, outputDetail, perspective, estimatedPages } = req.body;
  if (!email || !contractContent) return res.status(400).json({ error: 'Email and contract content are required.' });

  const user = getUser(email);
  checkBillingReset(user);
  checkTrialExpiry(user);

  const pageCount = estimatedPages || estimatePageCount(contractContent);

  if (pageCount > PAGE_LIMIT) {
    return res.status(400).json({
      error: 'page_limit_exceeded',
      message: `This document appears to be approximately ${pageCount} pages, which exceeds our ${PAGE_LIMIT}-page limit. For lengthy agreements we recommend uploading the core contract sections separately. Please paste the relevant sections into the text box instead.`,
      pageCount,
      limit: PAGE_LIMIT,
    });
  }

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
      creditsUsed: user.creditsUsed, creditsLimit: user.creditsLimit, plan: user.plan,
    });
  }

  if (creditsRemaining < creditCost) {
    return res.status(402).json({
      error: 'insufficient_credits',
      message: `This document requires ${creditCost} credits (estimated ${pageCount} pages) but you only have ${creditsRemaining} credit${creditsRemaining === 1 ? '' : 's'} remaining.`,
      creditsRemaining, creditCost, pageCount,
    });
  }

  const detailInstruction = {
    executive: 'Provide a concise executive-level summary. Focus on the 5-8 most important points. Be brief.',
    standard: 'Provide a thorough standard summary with all requested sections.',
    detailed: 'Provide a highly detailed summary. Quote key clauses where exact wording is material.',
  }[outputDetail] || 'Provide a thorough standard summary with all requested sections.';

  const perspectiveInstruction = {
    neutral: 'Analyze from a neutral perspective, noting risks for both parties.',
    party1: 'Flag risks especially from the perspective of the FIRST party named.',
    party2: 'Flag risks especially from the perspective of the SECOND party named.',
  }[perspective] || 'Analyze from a neutral perspective.';

  const contractTypeHint = contractType !== 'auto'
    ? `The user identifies this as a: ${contractType}.`
    : 'Identify the actual contract type from its content. Do NOT assume.';

  // ── Enhanced system prompt with legal citations (Fix 3) ──
  const systemPrompt = `You are Contract Summarizer Agent, an expert legal summarization assistant.

CRITICAL INSTRUCTIONS:
1. Analyze ONLY the actual contract text provided. Do NOT invent or assume any details.
2. Identify the REAL parties, REAL dates, REAL terms from the document.
3. Identify the governing law state/jurisdiction from the contract text.
4. LEGAL COMPLIANCE ANALYSIS — this is mandatory and must be thorough:
   a. Identify the governing law jurisdiction from the contract.
   b. Cross-reference every material provision against known applicable state and federal law.
   c. For ANY provision that appears to violate, conflict with, or push the limits of applicable law, you MUST flag it in the "legalViolations" array with a specific citation to the statute, code section, or regulation (e.g., "Cal. Bus. & Prof. Code § 16600", "15 U.S.C. § 1 (Sherman Act)", "29 C.F.R. § 541.602", "FTC Franchise Rule, 16 C.F.R. Part 436").
   d. Common areas to check: non-compete enforceability and duration/geographic limits by state; non-solicitation restrictions; mandatory wage and overtime laws; FTC franchise disclosure rules; UCC Articles 1, 2, and 9 for commercial contracts; usury limits on interest rates; unconscionability doctrine; automatic renewal notice statutes; consumer protection laws (UDAP); arbitration clause enforceability under FAA and state law; attorney fee-shifting statutes; liquidated damages enforceability.
   e. Only flag genuine concerns where there is a real and specific legal conflict. Do NOT manufacture violations.
   f. Use careful language: "This provision may conflict with..." or "Under [statute], this clause appears unenforceable because..." — do NOT render definitive legal conclusions.
5. For commercial contracts, apply applicable UCC articles where relevant and cite specific UCC sections.
6. For each red flag, explain the practical real-world consequence in plain English.
7. Avoid redundancy — do not repeat the same issue across multiple sections.
8. The plain summary must be 2-3 sentences maximum suitable for someone with no legal background.
9. For each red flag, generate specific suggested alternative contract language the user could propose.
10. For key terms, note whether each appears within, above, or below standard market practice.
11. Identify negotiation leverage points — specific terms the submitting party could reasonably push back on.
12. Flag missing standard clauses that are typically expected in this contract type.
13. Flag any automatic renewal, evergreen, or self-extending provisions with exact trigger dates and required notice periods.
14. Note any defined terms that are unusually broad, circular, or potentially dangerous in scope.

Respond ONLY with valid JSON. No markdown, no backticks, no preamble.

JSON structure:
{
  "docTitle": "string - actual title from document",
  "docDate": "string or null - actual date",
  "governingLaw": "string - state/jurisdiction governing this contract",
  "parties": [{"name": "string", "role": "string"}],
  "purpose": "string",
  "contractType": "string",
  "plainSummary": "string - 2-3 sentence plain English overview for non-lawyers",
  "executiveSummary": ["string - specific facts from THIS contract only"],
  "keyTerms": [{"term": "string", "detail": "string", "marketContext": "string - within/above/below standard market practice and why"}],
  "obligations": [{"party": "string", "obligation": "string"}],
  "redFlags": [{"title": "string", "detail": "string", "consequence": "string - plain English practical impact", "severity": "high|medium|low", "suggestedLanguage": "string - specific alternative clause language to propose"}],
  "legalViolations": [{"title": "string - short description of the issue", "citation": "string - specific statute, code section, or regulation", "provision": "string - which contract provision is implicated", "detail": "string - plain English explanation of the conflict and practical significance", "severity": "high|medium|low"}],
  "missing": ["string - provisions entirely absent, not already covered in redFlags or legalViolations"],
  "negotiationPoints": ["string - specific terms or provisions the submitting party could reasonably push back on or improve"],
  "autoRenewal": {"present": true, "description": "string - exact trigger and required notice period"},
  "balance": {"score": 0-100, "label": "string", "explanation": "string"},
  "clarifications": ["string - specific actionable items not already covered in other sections"],
  "overallTone": "string"
}

balance.score: 0 = heavily favors Party 1, 50 = balanced, 100 = heavily favors Party 2.
legalViolations: return an empty array [] if no genuine legal compliance concerns are identified.
autoRenewal: set present to false and description to null if no auto-renewal clause exists.

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
        max_tokens: 6000,
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

    // Save to Supabase history
    if (supabase) {
      try {
        await supabase.from('analyses').insert({
          email,
          doc_title: result.docTitle || result.contractType || 'Untitled',
          doc_date: result.docDate || null,
          contract_type: result.contractType || null,
          governing_law: result.governingLaw || null,
          parties: JSON.stringify(result.parties || []),
          page_count: pageCount,
          credit_cost: creditCost,
          result: JSON.stringify(result),
          created_at: new Date().toISOString(),
        });
      } catch (dbErr) {
        console.error('History save failed:', dbErr.message);
      }
    }

    const trialDaysRemaining = user.trialExpiry
      ? Math.max(0, Math.ceil((new Date(user.trialExpiry) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;

    res.json({
      result,
      usage: {
        creditsUsed: user.creditsUsed,
        creditsLimit: user.creditsLimit,
        creditsRemaining: user.creditsLimit - user.creditsUsed,
        creditCost, pageCount, plan: user.plan,
        subscribed: user.subscribed, trialDaysRemaining,
      },
    });

  } catch (err) {
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

// ── GET /api/history
app.get('/api/history', async (req, res) => {
  const { email, search, type, limit = 20, offset = 0 } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  if (!supabase) {
    return res.json({ analyses: [], total: 0, historyEnabled: false });
  }

  try {
    let query = supabase
      .from('analyses')
      .select('id, doc_title, doc_date, contract_type, governing_law, parties, page_count, credit_cost, created_at', { count: 'exact' })
      .eq('email', email)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) {
      query = query.or(`doc_title.ilike.%${search}%,contract_type.ilike.%${search}%,governing_law.ilike.%${search}%,parties.ilike.%${search}%`);
    }
    if (type && type !== 'all') {
      query = query.ilike('contract_type', `%${type}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ analyses: data || [], total: count || 0, historyEnabled: true });
  } catch (err) {
    res.status(500).json({ error: 'History fetch failed', detail: err.message });
  }
});

// ── GET /api/history/:id
app.get('/api/history/:id', async (req, res) => {
  const { email } = req.query;
  const { id } = req.params;
  if (!email || !id) return res.status(400).json({ error: 'Email and ID required.' });

  if (!supabase) return res.status(503).json({ error: 'History not enabled.' });

  try {
    const { data, error } = await supabase
      .from('analyses')
      .select('*')
      .eq('id', id)
      .eq('email', email)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Analysis not found.' });

    res.json({ analysis: { ...data, result: JSON.parse(data.result) } });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed', detail: err.message });
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
          return res.status(400).json({ error: 'scanned_pdf', message: 'This appears to be a scanned PDF. Please copy and paste the text manually instead.' });
        }
      } catch {
        return res.status(400).json({ error: 'scanned_pdf', message: 'Could not extract text from this PDF. It may be a scanned document. Please paste the text manually instead.' });
      }
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
      text = req.file.buffer.toString('utf-8');
      estimatedPages = estimatePageCount(text);
    } else {
      text = req.file.buffer.toString('utf-8');
      estimatedPages = estimatePageCount(text);
    }

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract text. Please paste the contract text manually.' });
    }

    if (estimatedPages > PAGE_LIMIT) {
      return res.status(400).json({
        error: 'page_limit_exceeded',
        message: `This document appears to be approximately ${estimatedPages} pages, which exceeds our ${PAGE_LIMIT}-page limit. Please upload the relevant sections only, or paste the key contract text into the text box.`,
        estimatedPages,
      });
    }

    const creditCost = getDocumentCreditCost(estimatedPages);
    res.json({ text: text.trim(), estimatedPages, creditCost });
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

  if (supabase) {
    try {
      await supabase.from('enterprise_inquiries').insert(inquiry);
    } catch (e) { console.error('Inquiry save failed:', e.message); }
  }

  if (process.env.CONTACT_EMAIL && process.env.SMTP_HOST) {
    try {
      const transporter = nodemailer.createTransporter({
        host: process.env.SMTP_HOST, port: process.env.SMTP_PORT || 587,
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
  const { email, planKey, isTrial } = req.body;
  if (!email || !planKey) return res.status(400).json({ error: 'Email and plan required.' });

  const plan = PLANS[planKey];
  if (!plan || !plan.stripePriceId) return res.status(400).json({ error: 'Invalid plan.' });

  try {
    const sessionConfig = {
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      automatic_tax: { enabled: true },
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(email)}&plan=${planKey}`,
      cancel_url: `${process.env.APP_URL}/#pricing`,
      metadata: { planKey, email },
    };

    if (isTrial) {
      sessionConfig.subscription_data = { trial_period_days: 7 };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
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
      user.plan = planKey; user.subscribed = true;
      user.customerId = session.customer;
      user.creditsLimit = plan.monthlyAnalyses;
      user.creditsUsed = 0; user.seats = plan.seats;
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
    plan: user.plan, subscribed: user.subscribed,
    creditsUsed: user.creditsUsed, creditsLimit: user.creditsLimit,
    creditsRemaining: user.creditsLimit - user.creditsUsed,
    seats: user.seats, trialDaysRemaining, hadTrial: !!trialStore[email],
  });
});

// ── GET /api/reset-test
app.get('/api/reset-test', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  if (userStore[email]) {
    userStore[email].creditsUsed = 0; userStore[email].plan = 'free';
    userStore[email].creditsLimit = 3; userStore[email].subscribed = false;
    userStore[email].trialExpiry = null; userStore[email].trialStarted = null;
  }
  delete trialStore[email];
  res.json({ message: 'Reset successful', email });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Contract Summarizer running on port ${PORT}`));
