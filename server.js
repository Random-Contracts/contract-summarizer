const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const multer = require('multer');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

const usageStore = {};
const FREE_LIMIT = 3;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getUser(email) {
  if (!usageStore[email]) {
    usageStore[email] = { count: 0, subscribed: false, customerId: null };
  }
  return usageStore[email];
}

// ── POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  const { email, contractContent, contractType, outputDetail, perspective } = req.body;

  if (!email || !contractContent) {
    return res.status(400).json({ error: 'Email and contract content are required.' });
  }

  const user = getUser(email);

  if (!user.subscribed && user.count >= FREE_LIMIT) {
    return res.status(402).json({
      error: 'free_limit_reached',
      message: `You've used all ${FREE_LIMIT} free analyses. Please subscribe to continue.`,
      count: user.count,
      limit: FREE_LIMIT,
    });
  }

  const detailInstruction = {
    executive: 'Provide a concise executive-level summary. Focus on the 5-8 most important points. Be brief.',
    standard: 'Provide a thorough standard summary with all requested sections.',
    detailed: 'Provide a highly detailed summary. Quote key clauses where the exact wording is material. Be comprehensive.',
  }[outputDetail] || 'Provide a thorough standard summary with all requested sections.';

  const perspectiveInstruction = {
    neutral: 'Analyze from a neutral perspective, noting risks and obligations for both parties.',
    party1: 'Flag risks and unfavorable terms especially from the perspective of the FIRST party named in the contract.',
    party2: 'Flag risks and unfavorable terms especially from the perspective of the SECOND party named in the contract.',
  }[perspective] || 'Analyze from a neutral perspective.';

  const contractTypeHint = contractType !== 'auto'
    ? `The user identifies this as a: ${contractType}.`
    : 'Read the contract carefully and identify the actual contract type from its content. Do NOT assume - base your analysis entirely on what is written in the contract text provided.';

  const systemPrompt = `You are Contract Summarizer Agent, an expert legal summarization assistant.

CRITICAL INSTRUCTIONS:
1. You must ONLY analyze the actual contract text provided by the user.
2. Do NOT make up or assume any details not present in the contract.
3. Read every word carefully - identify the REAL parties, REAL dates, REAL terms.
4. Base your entire analysis on what is ACTUALLY written in the contract.
5. If it is a real estate contract, say so. If it is an employment contract, say so. Read it first.

Respond ONLY with valid JSON. No markdown, no backticks, no preamble.

JSON structure:
{
  "docTitle": "string - the actual title from the document",
  "docDate": "string or null - actual date from document",
  "parties": [{"name": "string - actual party name", "role": "string - their actual role"}],
  "purpose": "string - what this contract actually does",
  "contractType": "string - the real type based on content",
  "executiveSummary": ["string - bullet points about THIS specific contract"],
  "keyTerms": [{"term": "string", "detail": "string - from actual contract"}],
  "obligations": [{"party": "string - actual party name", "obligation": "string"}],
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
        messages: [{
          role: 'user',
          content: `Analyze this contract carefully and return ONLY JSON based on what is actually written here:\n\n${contractContent}`
        }],
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

    user.count += 1;

    res.json({
      result,
      usage: { count: user.count, limit: FREE_LIMIT, subscribed: user.subscribed },
    });

  } catch (err) {
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

// ── POST /api/upload — extract text from Word/text files
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const filename = req.file.originalname.toLowerCase();

  try {
    let text = '';

    if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else {
      text = req.file.buffer.toString('utf-8');
    }

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract text from file. Please paste the text manually.' });
    }

    res.json({ text: text.trim() });
  } catch (err) {
    res.status(500).json({ error: 'File reading failed: ' + err.message });
  }
});

// ── POST /api/create-checkout
app.post('/api/create-checkout', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
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
    const email = session.customer_email;
    if (email) {
      const user = getUser(email);
      user.subscribed = true;
      user.customerId = session.customer;
      console.log(`Subscribed: ${email}`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    for (const [email, user] of Object.entries(usageStore)) {
      if (user.customerId === customerId) {
        user.subscribed = false;
        console.log(`Unsubscribed: ${email}`);
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
  res.json({ count: user.count, limit: FREE_LIMIT, subscribed: user.subscribed });
});

// ── GET /api/reset-test — reset usage count for testing
app.get('/api/reset-test', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  if (usageStore[email]) {
    usageStore[email].count = 0;
  }
  res.json({ message: 'Reset successful', email });
});

// Catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Contract Summarizer running on port ${PORT}`));
