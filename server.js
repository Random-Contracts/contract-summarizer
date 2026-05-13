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

// Credit cost by page count
function getDocumentCreditCost(pageCount) {
  if (pageCount <= 5) return 1;
  if (pageCount <= 20) return 2;
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
        credits_limit: 3,
        seats: 1,
        trial_used: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
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
      analyses_used: user.analyses_used,
      analyses_limit: user.analyses_limit,
      seats: user.seats,
      period_end: user.period_end,
      trial_used: user.trial_used,
      subscribed: user.plan !== 'trial' && user.plan !== 'free'
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
      analyses_used: user.analyses_used,
      analyses_limit: user.analyses_limit,
      seats: user.seats,
      period_end: user.period_end,
      trial_used: user.trial_used,
      subscribed: user.plan !== 'trial' && user.plan !== 'free'
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
      pageCount = Math.ceil(contractText.length / 3000);

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

    const pageCount = estimatedPages || Math.ceil(contractContent.length / 3000);
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

    const systemPrompt = `You are an expert contract attorney with 30 years of experience analyzing commercial contracts. You provide thorough, practical analysis that helps business people and attorneys understand contracts quickly and completely.

Your analysis must be structured, comprehensive, and written in plain English that non-lawyers can understand, while also being substantive enough for attorney review.`;

    const userPrompt = `Please analyze the following contract and provide a comprehensive analysis in this exact format:

## CONTRACT OVERVIEW
**Document Type:** [Identify the specific type of contract]
**Jurisdiction:** [Identify governing law/jurisdiction if stated, or note if not specified]
**Parties:** [List all parties and their roles]
**Effective Date:** [State the effective date or execution date]
**Contract Value/Consideration:** [State the value, payment terms, or consideration]

## PLAIN ENGLISH SUMMARY
Provide a 3-5 paragraph plain English summary of what this contract does, what each party is agreeing to, and the overall purpose and effect of the agreement. Write this as if explaining to a smart business person who is not a lawyer.

## KEY TERMS AND CONDITIONS
List and explain the 8-12 most important terms, provisions, and conditions in the contract. For each one:
- **[Term Name]:** Explain what it means in plain English and why it matters

## CRITICAL CLAUSES ANALYSIS
Analyze these specific clause types if present:
- **Termination:** Who can terminate, under what conditions, with what notice, and what are the consequences
- **Renewal/Extension:** Auto-renewal provisions, notice requirements, renewal terms
- **Exclusivity:** Any exclusivity provisions and their scope and duration
- **Intellectual Property:** Ownership, licensing, work-for-hire provisions
- **Confidentiality/NDA:** Scope, duration, exceptions, and obligations
- **Non-Compete/Non-Solicitation:** Scope, geography, duration, enforceability concerns
- **Indemnification:** Who indemnifies whom, scope of indemnification, limitations
- **Limitation of Liability:** Caps on damages, exclusions, consequential damages waivers
- **Force Majeure:** Scope and effect of force majeure provisions
- **Dispute Resolution:** Arbitration, mediation, litigation, venue, governing law

## FINANCIAL TERMS
Detail all financial provisions including:
- Payment amounts, schedules, and methods
- Late payment penalties or interest
- Price adjustment mechanisms
- Expense reimbursement
- Taxes and fees allocation
- Financial penalties or liquidated damages

## RISK ASSESSMENT
### High Risk Items 🔴
List provisions that create significant risk or liability exposure

### Medium Risk Items 🟡
List provisions that warrant attention or negotiation

### Favorable Provisions 🟢
List provisions that are favorable or protective

## MARKET CONTEXT
- Are the terms favorable, unfavorable, or market-standard?
- What provisions are unusual or non-standard?
- How does this compare to typical industry practice?

## PRACTICAL CONSEQUENCES
- What happens if either party breaches this contract?
- What are the real-world consequences of the key obligations?
- What practical risks should the parties be aware of?

## UCC CONSIDERATIONS
If this contract involves the sale of goods, analyze applicable UCC provisions including implied warranties, risk of loss, and any warranty disclaimers.

## RECOMMENDED REDLINES
Provide 5-8 specific suggested modifications:
1. **[Clause to modify]:** Current concern → Suggested revision
2. [Continue for each recommendation]

## MISSING PROVISIONS
Identify important provisions absent from this contract.

## SUMMARY OF ACTION ITEMS
Prioritized list of:
- Issues requiring immediate attention before signing
- Provisions to negotiate
- Missing items to add
- Items to confirm with client

---
CONTRACT TEXT TO ANALYZE:
${contractContent}`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const analysis = message.content[0].text;

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
        analysis,
        page_count: pageCount,
        credit_cost: creditCost,
        contract_type: docType,
        created_at: new Date().toISOString()
      });

    const responseData = {
      success: true,
      analysis,
      filename: filename || 'Contract Analysis',
      pageCount,
      creditCost,
      analysesUsed: user.credits_used + creditCost,
      analysesLimit: user.credits_limit,
      analysesRemaining: remainingAnalyses - creditCost
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
