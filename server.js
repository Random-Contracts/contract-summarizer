const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// CRITICAL: Stripe webhook must come BEFORE express.json() middleware
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.email;
      const planId = session.metadata?.planId;
      const billingCycle = session.metadata?.billingCycle || 'monthly';
      const subscriptionId = session.subscription;

      if (email && planId) {
        const plan = PLANS[planId];
        if (plan) {
          const periodStart = new Date();
          const periodEnd = new Date();
          if (billingCycle === 'annual') {
            periodEnd.setFullYear(periodEnd.getFullYear() + 1);
          } else {
            periodEnd.setMonth(periodEnd.getMonth() + 1);
          }

          const { error } = await supabase
            .from('users')
            .upsert({
              email,
              plan: planId,
              billing_cycle: billingCycle,
              stripe_subscription_id: subscriptionId,
              stripe_customer_id: session.customer,
              credits_used: 0,
              credits_limit: plan.analyses,
              seats: plan.seats,
              period_start: periodStart.toISOString(),
              period_end: periodEnd.toISOString(),
              trial_used: true,
              updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

          if (error) console.error('Error updating user after checkout:', error);
          else console.log(`Subscription activated for ${email} on ${planId} plan`);
        }
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      const { data: userData } = await supabase
        .from('users')
        .select('*')
        .eq('stripe_customer_id', customerId)
        .single();

      if (userData) {
        const plan = PLANS[userData.plan];
        const periodStart = new Date();
        const periodEnd = new Date();
        if (userData.billing_cycle === 'annual') {
          periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        } else {
          periodEnd.setMonth(periodEnd.getMonth() + 1);
        }

        const { error } = await supabase
          .from('users')
          .update({
            credits_used: 0,
            credits_limit: plan ? plan.analyses : userData.credits_limit,
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('Error resetting analyses on renewal:', error);
        else console.log(`Analyses reset for customer ${customerId}`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const { error } = await supabase
        .from('users')
        .update({
          plan: 'free',
          stripe_subscription_id: null,
          credits_limit: 0,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_customer_id', customerId);

      if (error) console.error('Error downgrading cancelled subscription:', error);
      else console.log(`Subscription cancelled for customer ${customerId}`);
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const status = subscription.status;

      if (status === 'past_due' || status === 'unpaid') {
        const { error } = await supabase
          .from('users')
          .update({
            subscription_status: status,
            updated_at: new Date().toISOString()
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('Error updating subscription status:', error);
      }
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Standard middleware (must come AFTER webhook route)
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Plan definitions
const PLANS = {
  starter: { analyses: 30, seats: 1, monthlyPrice: 25, annualPrice: 21.25 },
  pro: { analyses: 100, seats: 2, monthlyPrice: 59, annualPrice: 50.15 },
  team: { analyses: 250, seats: 4, monthlyPrice: 119, annualPrice: 101.15 }
};

// Credit cost by page count - matches pricing page
function getDocumentCreditCost(pageCount) {
  if (pageCount <= 25) return 1;
  if (pageCount <= 70) return 2;
  return 3;
}

// Multer configuration - field name 'file' matches index.html formData.append('file', file)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload PDF, Word, or Excel files.'));
    }
  }
});

// Auth: send magic link
app.post('/auth/send-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: `${process.env.APP_URL}/auth/callback` }
    });

    if (error) throw error;
    res.json({ success: true, message: 'Magic link sent' });
  } catch (err) {
    console.error('Send link error:', err);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

// Auth: verify token
app.post('/auth/verify', async (req, res) => {
  const { token, email } = req.body;
  if (!token || !email) return res.status(400).json({ error: 'Token and email required' });

  try {
    const { data, error } = await supabaseAdmin.auth.verifyOtp({
      email,
      token,
      type: 'email'
    });

    if (error) throw error;

    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!existingUser) {
      await supabaseAdmin.from('users').insert({
        email,
        plan: 'trial',
        credits_used: 0,
        credits_limit: 5,
        seats: 1,
        trial_used: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    } else if (existingUser.plan === 'free' && existingUser.credits_limit > 0) {
      // Migrate legacy "free" plan users to "trial" so they can use their credits
      await supabaseAdmin.from('users')
        .update({ plan: 'trial', updated_at: new Date().toISOString() })
        .eq('email', email);
    }

    res.json({ success: true, session: data.session, user: data.user });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Get user status - supports header, query param, or body
app.get('/api/status', async (req, res) => {
  const email = req.headers['x-user-email'] || req.query.email;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    res.json({
      email: user.email,
      plan: user.plan,
      billing_cycle: user.billing_cycle,
      analyses_used: user.credits_used,
      analyses_limit: user.credits_limit,
      seats: user.seats,
      period_end: user.period_end,
      trial_used: user.trial_used,
      subscribed: user.plan !== 'trial' && user.plan !== 'free',
      creditsRemaining: user.credits_limit - user.credits_used,
      creditsLimit: user.credits_limit,
    });
  } catch (err) {
    console.error('User status error:', err);
    res.status(500).json({ error: 'Failed to get user status' });
  }
});

// Backward compat
app.get('/user/status', async (req, res) => {
  const email = req.headers['x-user-email'] || req.query.email;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    res.json({
      email: user.email,
      plan: user.plan,
      billing_cycle: user.billing_cycle,
      analyses_used: user.credits_used,
      analyses_limit: user.credits_limit,
      seats: user.seats,
      period_end: user.period_end,
      trial_used: user.trial_used,
      subscribed: user.plan !== 'trial' && user.plan !== 'free',
      creditsRemaining: user.credits_limit - user.credits_used,
      creditsLimit: user.credits_limit,
    });
  } catch (err) {
    console.error('User status error:', err);
    res.status(500).json({ error: 'Failed to get user status' });
  }
});

// Get contract history
app.get('/history', async (req, res) => {
  const email = req.headers['x-user-email'] || req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const offset = (page - 1) * limit;

  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    let query = supabaseAdmin
      .from('contracts')
      .select('*', { count: 'exact' })
      .eq('user_email', email)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike('filename', `%${search}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ contracts: data, total: count, page, limit });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Get single contract
app.get('/history/:id', async (req, res) => {
  const email = req.headers['x-user-email'] || req.query.email;
  const { id } = req.params;

  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data, error } = await supabaseAdmin
      .from('contracts')
      .select('*')
      .eq('id', id)
      .eq('user_email', email)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Contract not found' });

    res.json(data);
  } catch (err) {
    console.error('Get contract error:', err);
    res.status(500).json({ error: 'Failed to get contract' });
  }
});

// Delete contract
app.delete('/history/:id', async (req, res) => {
  const email = req.headers['x-user-email'] || req.query.email;
  const { id } = req.params;

  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { error } = await supabaseAdmin
      .from('contracts')
      .delete()
      .eq('id', id)
      .eq('user_email', email);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete contract error:', err);
    res.status(500).json({ error: 'Failed to delete contract' });
  }
});

// Stripe checkout
app.post(['/api/create-checkout', '/create-checkout-session'], async (req, res) => {
  const { email, planId, billingCycle } = req.body;

  if (!email || !planId) return res.status(400).json({ error: 'Email and plan required' });

  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  const priceIds = {
    starter: {
      monthly: process.env.STRIPE_STARTER_MONTHLY_ID,
      annual: process.env.STRIPE_STARTER_ANNUAL_ID
    },
    pro: {
      monthly: process.env.STRIPE_PRO_MONTHLY_ID,
      annual: process.env.STRIPE_PRO_ANNUAL_ID
    },
    team: {
      monthly: process.env.STRIPE_TEAM_MONTHLY_ID,
      annual: process.env.STRIPE_TEAM_ANNUAL_ID
    }
  };

  const priceId = priceIds[planId]?.[billingCycle || 'monthly'];
  if (!priceId) return res.status(400).json({ error: 'Price not found' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { email, planId, billingCycle: billingCycle || 'monthly' },
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Billing portal
app.post('/api/billing-portal', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('stripe_customer_id')
      .eq('email', email)
      .single();

    if (!user?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.APP_URL}`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal session error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Enterprise contact
app.post('/api/enterprise-contact', async (req, res) => {
  const { name, email, company, phone, message } = req.body;
  if (!name || !email || !company) {
    return res.status(400).json({ error: 'Name, email, and company required' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('enterprise_inquiries')
      .insert({
        name,
        email,
        company,
        phone: phone || null,
        message: message || null,
        created_at: new Date().toISOString()
      });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Enterprise contact error:', err);
    res.status(500).json({ error: 'Failed to submit inquiry' });
  }
});

// File upload - extracts text and returns it to frontend
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const email = req.headers['x-user-email'] || req.body?.email;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let contractText = '';
    let pageCount = 1;
    const mimeType = req.file.mimetype;
    const filename = req.file.originalname;

    if (mimeType === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(req.file.buffer);
      contractText = pdfData.text;
      // FIX 4: Use numpages directly — no division. Previously may have been halved.
      pageCount = pdfData.numpages;

      if (!contractText || contractText.trim().length < 100) {
        return res.status(422).json({
          error: 'SCANNED_PDF',
          message: 'This appears to be a scanned PDF. Please upload a text-based PDF or Word document.'
        });
      }

      if (pageCount > 150) {
        return res.status(422).json({
          error: 'TOO_MANY_PAGES',
          message: `Document has ${pageCount} pages. Maximum is 150 pages.`
        });
      }

    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      contractText = result.value;
      // FIX 4: Changed divisor from 3000 to 1500 chars/page for more accurate Word doc page count
      pageCount = Math.ceil(contractText.length / 1500);

      if (pageCount > 150) {
        return res.status(422).json({
          error: 'TOO_MANY_PAGES',
          message: `Document is approximately ${pageCount} pages. Maximum is 150 pages.`
        });
      }

    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel'
    ) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheets = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
      });
      contractText = sheets.join('\n\n');
      pageCount = 1;
    }

    if (!contractText || contractText.trim().length < 50) {
      return res.status(422).json({ error: 'Could not extract text from file' });
    }

    const creditCost = getDocumentCreditCost(pageCount);

    res.json({
      success: true,
      text: contractText,
      filename,
      estimatedPages: pageCount,
      creditCost
    });

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to process file' });
  }
});

// Main analysis endpoint
app.post('/api/analyze', async (req, res) => {
  const email = req.headers['x-user-email'] || req.body?.email;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { contractContent, estimatedPages, contractType, filename } = req.body;

  if (!contractContent || contractContent.trim().length < 50) {
    return res.status(400).json({ error: 'No contract provided' });
  }

  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (userError || !user) return res.status(404).json({ error: 'User not found' });

    const remainingAnalyses = user.credits_limit - user.credits_used;
    if (remainingAnalyses <= 0) {
      return res.status(403).json({
        error: 'Analysis limit reached',
        code: 'LIMIT_REACHED',
        plan: user.plan,
        credits_used: user.credits_used,
        credits_limit: user.credits_limit
      });
    }

    const pageCount = estimatedPages || Math.ceil(contractContent.length / 1500);
    const creditCost = getDocumentCreditCost(pageCount);

    if (creditCost > remainingAnalyses) {
      return res.status(403).json({
        error: 'Insufficient credits',
        code: 'INSUFFICIENT_CREDITS',
        creditsRequired: creditCost,
        creditsRemaining: remainingAnalyses
      });
    }

    const warningThreshold = Math.ceil(user.credits_limit * 0.1);
    const willRemainAfter = remainingAnalyses - creditCost;
    const docType = contractType || 'auto-detect';

    const systemPrompt = `You are an expert contract attorney with 30 years of experience analyzing commercial contracts. You respond ONLY with valid JSON — no markdown, no preamble, no explanation outside the JSON object.`;

    const userPrompt = `Analyze this contract and return ONLY a valid JSON object with this exact structure (no markdown, no backticks, just raw JSON):

{
  "docTitle": "short descriptive title of the contract",
  "contractType": "type of contract",
  "docDate": "effective date or null",
  "governingLaw": "governing state/jurisdiction or null",
  "plainSummary": "2-3 sentence plain English summary of what this contract does",
  "executiveSummary": ["bullet 1", "bullet 2", "bullet 3", "bullet 4"],
  "purpose": "one sentence describing the overall purpose",
  "parties": [
    {"name": "Party A name", "role": "their role"},
    {"name": "Party B name", "role": "their role"}
  ],
  "keyTerms": [
    {"term": "term name", "detail": "plain English explanation", "marketContext": "is this standard, favorable, or unusual?"},
    ...up to 10 terms
  ],
  "obligations": [
    {"party": "Party name or Both", "obligation": "what they must do"},
    ...up to 10 obligations
  ],
  "redFlags": [
    {"title": "risk title", "severity": "high|medium|low", "detail": "explanation", "consequence": "practical impact", "suggestedLanguage": "suggested replacement language or null"},
    ...
  ],
  "legalViolations": [
    {"title": "issue title", "citation": "statute or case citation", "provision": "contract provision at issue", "detail": "explanation"},
    ...or empty array if none
  ],
  "negotiationPoints": ["point 1", "point 2", ...up to 6],
  "missing": ["missing provision 1", "missing provision 2", ...],
  "clarifications": ["question 1", "question 2", ...up to 5],
  "autoRenewal": {"present": true/false, "description": "description or null"},
  "balance": {"score": 0-100, "label": "Balanced|Favors Party A|Favors Party B", "explanation": "brief explanation"},
  "overallTone": "brief tone description"
}

CONTRACT TYPE CONTEXT: ${docType}
CONTRACT TEXT:
${contractContent}`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    let result;
    try {
      const raw = message.content[0].text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
      result = JSON.parse(raw);
    } catch(parseErr) {
      console.error('JSON parse error:', parseErr);
      // Fallback: wrap raw text in a minimal result object
      result = {
        docTitle: filename || 'Contract Analysis',
        contractType: docType,
        plainSummary: message.content[0].text.substring(0, 500),
        executiveSummary: ['Analysis completed — see plain summary above'],
        purpose: '',
        parties: [],
        keyTerms: [],
        obligations: [],
        redFlags: [],
        legalViolations: [],
        negotiationPoints: [],
        missing: [],
        clarifications: [],
        autoRenewal: { present: false },
        balance: { score: 50, label: 'Unknown', explanation: '' },
        overallTone: ''
      };
    }

    await supabaseAdmin
      .from('users')
      .update({
        credits_used: user.credits_used + creditCost,
        updated_at: new Date().toISOString()
      })
      .eq('email', email);

    await supabaseAdmin
      .from('contracts')
      .insert({
        user_email: email,
        filename: filename || 'Contract Analysis',
        analysis: JSON.stringify(result),
        page_count: pageCount,
        credit_cost: creditCost,
        contract_type: docType,
        created_at: new Date().toISOString()
      });

    const usageObj = {
      creditsRemaining: remainingAnalyses - creditCost,
      creditsLimit: user.credits_limit,
      creditCost,
      pageCount,
      plan: user.plan,
      subscribed: user.plan !== 'trial' && user.plan !== 'free'
    };

    const responseData = {
      success: true,
      result,
      usage: usageObj,
      filename: filename || 'Contract Analysis'
    };

    if (willRemainAfter <= warningThreshold && willRemainAfter > 0) {
      responseData.warning = `You have ${willRemainAfter} analyses remaining this period.`;
    }

    res.json(responseData);

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// FIX 3: Reset test endpoint (for development/testing only)
app.post('/api/reset-test', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        credits_used: 0,
        credits_limit: 5,
        plan: 'trial',
        updated_at: new Date().toISOString()
      })
      .eq('email', email);

    if (error) throw error;
    res.json({ success: true, message: `Credits reset for ${email}` });
  } catch (err) {
    console.error('Reset test error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Contract Summarizer server running on port ${PORT}`);
});
