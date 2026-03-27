const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-memory usage store (resets on server restart)
// For production you'd replace this with a database like Supabase or PlanetScale
const usageStore = {};

const FREE_LIMIT = 3; // free analyses per email

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helper: get or init user record
function getUser(email) {
  if (!usageStore[email]) {
    usageStore[email] = { count: 0, subscribed: false, customerId: null };
  }
  return usageStore[email];
}

// ────────────────────────────────────────────
// POST /api/analyze  — proxy to Anthropic
// ────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { email, contractContent, contractType, outputDetail, perspective } = req.body;

  if (!email || !contractContent) {
    return res.status(400).json({ error: 'Email and contract content are required.' });
  }

  const user = getUser(email);

  // Check access
  if (!user.subscribed && user.count >= FREE_LIMIT) {
    return res.status(402).json({
      error: 'free_limit_reached',
      message: `You've used all ${FREE_LIMIT} free analyses. Please subscribe to continue.`,
      count: user.count,
      limit: FREE_LIMIT,
    });
  }

  const detailInstruction = {
    executive: 'Provide a concise executive-level summary. Focus on the 5–8 most important points. Be brief.',
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
    : 'Auto-detect the contract type.';

  const systemPrompt = `You are Contract Summarizer Agent, an expert legal summarization assistant. Produce plain-English summaries for non-lawyers.

CRITICAL: Respond ONLY with valid JSON. No markdown, no backticks, no preamble.

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

balance.score: 0 = heavily favors Party 1, 50 = balanced, 100 = heavily favors Party 2.

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

    // Increment usage AFTER successful analysis
    user.count += 1;

    res.json({
      result,
      usage: { count: user.count, limit: FREE_LIMIT, subscribed: user.subscribed },
    });

  } catch (err) {
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

// ────────────────────────────────────────────
// POST /api/create-checkout  — Stripe checkout
// ────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID, // set in Render env vars
        quantity: 1,
      }],
      success_url: `${process.env.APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&email=${encodeURIComponent(email)}`,
      cancel_url: `${process.env.APP_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────
// POST /api/webhook  — Stripe webhook
// Marks user as subscribed when payment succeeds
// ────────────────────────────────────────────
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
    const email = session.customer_email;
    if (email) {
      const user = getUser(email);
      user.subscribed = true;
      user.customerId = session.customer;
      console.log(`✅ Subscribed: ${email}`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // Handle cancellations - find user by customerId
    const customerId = event.data.object.customer;
    for (const [email, user] of Object.entries(usageStore)) {
      if (user.customerId === customerId) {
        user.subscribed = false;
        console.log(`❌ Unsubscribed: ${email}`);
      }
    }
  }

  res.json({ received: true });
});

// ────────────────────────────────────────────
// GET /api/status  — check user status
// ────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const user = getUser(email);
  res.json({ count: user.count, limit: FREE_LIMIT, subscribed: user.subscribed });
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Contract Summarizer running on port ${PORT}`));
