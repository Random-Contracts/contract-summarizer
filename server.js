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
  free:                 { name: 'Free',           monthlyAnalyses: 5,   seats: 1, price: 0 },
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

// ── In-memory fallback store
const userStore = {};
const ipTrialStore = {};

// ── Supabase user functions
async function getUserFromDB(email) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    if (error || !data) return null;
    return data;
  } catch { return null; }
}

async function upsertUserToDB(userData) {
  if (!supabase) return;
  try {
    await supabase.from('users').upsert({
      email: userData.email,
      plan: userData.plan,
      credits_used: userData.creditsUsed,
      credits_limit: userData.creditsLimit,
      seats: userData.seats,
      subscribed: userData.subscribed,
      customer_id: userData.customerId,
      trial_started: userData.trialStarted,
      trial_expiry: userData.trialExpiry,
      billing_cycle_start: userData.billingCycleStart,
      had_trial: userData.hadTrial || false,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });
  } catch (e) {
    console.error('upsertUserToDB error:', e.message);
  }
}

function dbRowToUser(row) {
  return {
    email: row.email,
    plan: row.plan || 'free',
    creditsUsed: row.credits_used || 0,
    creditsLimit: row.credits_limit || 5,
    seats: row.seats || 1,
    subscribed: row.subscribed || false,
    customerId: row.customer_id || null,
    trialStarted: row.trial_started || null,
    trialExpiry: row.trial_expiry || null,
    billingCycleStart: row.billing_cycle_start || new Date().toISOString(),
    hadTrial: row.had_trial || false,
  };
}

function defaultUser(email) {
  return {
    email,
    plan: 'free',
    creditsUsed: 0,
    creditsLimit: 5,
    seats: 1,
    subscribed: false,
    customerId: null,
    trialStarted: null,
    trialExpiry: null,
    billingCycleStart: new Date().toISOString(),
    hadTrial: false,
  };
}

async function getUser(email) {
  const dbUser = await getUserFromDB(email);
  if (dbUser) {
    const user = dbRowToUser(dbUser);
    userStore[email] = user;
    return user;
  }
  if (!userStore[email]) {
    userStore[email] = defaultUser(email);
  }
  return userStore[email];
}

async function saveUser(user) {
  userStore[user.email] = user;
  await upsertUserToDB(user);
}

function checkBillingReset(user) {
  const now = new Date();
  const daysSince = (now - new Date(user.billingCycleStart)) / (1000 * 60 * 60 * 24);
  const resetDays = user.plan.includes('annual') ? 365 : 30;
  if (daysSince >= resetDays) {
    user.creditsUsed = 0;
    user.billingCycleStart = now.toISOString();
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
app.post('/api/start-trial', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const ip = getClientIp(req);
  const user = await getUser(email);

  if (user.hadTrial) {
    return res.status(400).json({ error: 'trial_used', message: 'A free trial has already been used for this email address.' });
  }
  const ipCount = ipTrialStore[ip] || 0;
  if (ipCount >= 2) {
    return res.status(400).json({ error: 'trial_limit', message: 'The maximum number of free trials from this location has been reached.' });
  }

  const trialExpiry = new Date();
  trialExpiry.setDate(trialExpiry.getDate() + 7);

  user.plan = 'starter_trial';
  user.creditsLimit = 7;
  user.creditsUsed = 0;
  user.trialStarted = new Date().toISOString();
  user.trialExpiry = trialExpiry.toISOString();
  user.hadTrial = true;

  ipTrialStore[ip] = ipCount + 1;
  await saveUser(user);

  res.json({ message: 'Trial started', trialExpiry: trialExpiry.toISOString(), daysRemaining: 7 });
});

// ── POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  const { email, contractContent, contractType, outputDetail, perspective, estimatedPages } = req.body;
  if (!email || !contractContent) return res.status(400).json({ error: 'Email and contract content are required.' });

  const user = await getUser(email);
  checkBillingReset(user);
  checkTrialExpiry(user);

  const pageCount = estimatedPages || estimatePageCount(contractContent);

  if (pageCount > PAGE_LIMIT) {
    return res.status(400).json({
      error: 'page_limit_exceeded',
      message: `This document appears to be approximately ${pageCount} pages, which exceeds our ${PAGE_LIMIT}-page limit. Please paste the relevant sections into the text box instead.`,
      pageCount, limit: PAGE_LIMIT,
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
        : 'You have used all your analyses for this billing period.',
      creditsUsed: user.creditsUsed, creditsLimit: user.creditsLimit, plan: user.plan,
    });
  }

  if (creditsRemaining < creditCost) {
    return res.status(402).json({
      error: 'insufficient_credits',
      message: `This document requires ${creditCost} credits but you only have ${creditsRemaining} remaining.`,
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

  const systemPrompt = `You are Contract Summarizer Agent, an expert legal summarization assistant with deep knowledge of state and federal contract law across all U.S. jurisdictions.

CRITICAL INSTRUCTIONS:
1. Analyze ONLY the actual contract text provided. Do NOT invent or assume any details.
2. Identify the REAL parties, REAL dates, REAL terms from the document.
3. Identify the governing law state/jurisdiction from the contract text.
4. LEGAL COMPLIANCE ANALYSIS — this is mandatory and must be thorough:
   a. Identify the governing law jurisdiction from the contract.
   b. Cross-reference every material provision against known applicable state and federal law using the STATE-SPECIFIC LEGAL KNOWLEDGE below.
   c. For ANY provision that appears to violate, conflict with, or push the limits of applicable law, flag it in "legalViolations" with a specific citation to the statute, code section, or regulation.
   d. Only flag genuine concerns. Do NOT manufacture violations.
   e. Use careful language: "This provision may conflict with..." or "Under [statute], this clause appears unenforceable because..." — do NOT render definitive legal conclusions.
   f. Where well-established jurisprudence supports a conclusion, you may reference the legal principle and note it is supported by case law, but do not cite specific case names unless you are certain of their accuracy.
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

════════════════════════════════════════════════════════
FEDERAL LAW — APPLIES IN ALL STATES
════════════════════════════════════════════════════════

FRANCHISE AGREEMENTS:
- FTC Franchise Rule (16 C.F.R. Part 436): Franchisors must provide a Franchise Disclosure Document (FDD) at least 14 calendar days before signing. Failure is a federal violation.
- FDD must contain 23 specific disclosure items. Flag missing disclosures.
- FTC Act § 5: Unfair or deceptive acts in franchise agreements are prohibited.
- Good cause for termination: Many states require good cause; flag termination-at-will provisions in franchise agreements as potentially unenforceable in regulated states.

EMPLOYMENT — FEDERAL FLOOR:
- FLSA (29 U.S.C. § 201 et seq.): Federal minimum wage $7.25/hr; overtime at 1.5x for hours over 40/week for non-exempt employees. Flag any contract provisions that attempt to waive overtime or misclassify employees.
- FMLA (29 U.S.C. § 2601): Employers with 50+ employees must provide 12 weeks unpaid leave. Flag contracts that attempt to limit this right.
- Title VII (42 U.S.C. § 2000e): Prohibits discriminatory termination provisions.
- ADA (42 U.S.C. § 12101): Reasonable accommodation obligations cannot be waived by contract.
- NLRA (29 U.S.C. § 151): Prohibits contracts that restrict employees' rights to organize or discuss wages. Mutual non-disparagement clauses may implicate NLRA rights.
- Worker classification: Flag independent contractor provisions that may misclassify employees under IRS 20-factor test and DOL economic reality test.

COMMERCIAL CONTRACTS — UCC:
- UCC Article 2 (goods): Implied warranty of merchantability (§ 2-314) and fitness for particular purpose (§ 2-315) apply unless explicitly disclaimed in conspicuous language. Flag inadequate disclaimer language.
- UCC Article 9 (secured transactions): Security interests must be properly perfected by filing. Flag security interest provisions lacking perfection requirements.
- UCC § 2-207: Battle of the forms — additional terms in acceptance may not become part of contract between merchants.
- UCC § 2-302: Unconscionable contracts or clauses may be voided by courts.

ARBITRATION:
- Federal Arbitration Act (9 U.S.C. § 1): Arbitration agreements are generally enforceable. However, flag class action waivers in consumer contracts as they may be unenforceable in some states.
- Ending Forced Arbitration of Sexual Assault and Sexual Harassment Act (2022): Arbitration clauses cannot be enforced against sexual harassment/assault claims.

AUTOMATIC RENEWAL — FTC:
- FTC guidelines require clear and conspicuous disclosure of auto-renewal terms. Flag buried or unclear auto-renewal provisions in consumer-facing contracts.

INTEREST RATES:
- Federal usury law does not cap rates for most commercial loans. State usury laws apply — check state-specific section below.

════════════════════════════════════════════════════════
STATE-SPECIFIC LEGAL KNOWLEDGE
════════════════════════════════════════════════════════

── LOUISIANA ──
NON-COMPETE AGREEMENTS (La. R.S. 23:921):
- Louisiana STRONGLY disfavors non-competes. The opening provision declares them null and void unless a specific statutory exception applies.
- Eight enumerated relationship exceptions exist (employer/employee, business sale, partnership dissolution, franchisor/franchisee, etc.). Flag any non-compete that does not clearly fit one of these eight categories.
- Duration: Cannot exceed 2 years from termination of the relationship. Any longer duration is null and void — not reformable by courts.
- Geography: MUST be defined by specific named parishes or municipalities. A radius-based restriction (e.g., "within 10 miles") is unenforceable under Louisiana law even if duration is compliant. Courts have consistently voided radius-based restrictions. The specific parishes must be listed in the agreement itself.
- Business scope: Must identify the specific business activity prohibited.
- Choice of law: Attempts to apply another state's law to Louisiana employees are null and void under La. R.S. 23:921(A)(2).
- Physicians: As of January 1, 2025, primary care physician non-competes cannot exceed 3 years (Acts 2024, No. 273 — La. R.S. 23:921(M)).
- Remedy: Courts will not reform an overbroad Louisiana non-compete — they void it entirely.

EMPLOYMENT (Louisiana):
- At-will employment state. Employer may terminate for any reason not prohibited by law or contract.
- Final paycheck: La. R.S. 23:631 requires payment of all wages due within 15 days of termination or next regular payday. Failure triggers penalty wages (La. R.S. 23:632) of up to 90 days additional wages.
- Louisiana Whistleblower Act (La. R.S. 23:967): Prohibits retaliatory discharge for reporting violations of law.
- Louisiana Employment Discrimination Law (La. R.S. 23:301 et seq.): Applies to employers with 20+ employees.
- Workers' compensation: La. R.S. 23:1021 et seq. — employers cannot contract out of workers' comp obligations.

LEASE AGREEMENTS (Louisiana):
- La. C.C. Art. 2711: Assignment of lease requires lessor consent unless lease expressly permits assignment.
- La. C.C. Art. 2668 et seq.: Governs lease formation. Lease of immovable for more than one year must be in writing.
- La. C.C. Art. 2719: Lessor must deliver leased thing in good condition and maintain it.
- Commercial lease automatic renewal: Louisiana courts have enforced automatic renewal clauses but require clear notice provisions.

COMMERCIAL/SALES CONTRACTS (Louisiana):
- Louisiana has adopted the UCC (La. R.S. 10:1-101 et seq.) but with civil law modifications. Louisiana is a civil law state — code provisions control over common law principles.
- Redhibition (La. C.C. Art. 2520): Seller's warranty against hidden defects in sales of movables. Cannot be fully disclaimed in consumer transactions.
- Seller's disclosure obligations under Louisiana law are broader than many states.

FRANCHISE AGREEMENTS (Louisiana):
- Louisiana Unfair Trade Practices Act (La. R.S. 51:1401 et seq.) applies to franchise relationships.
- No specific Louisiana franchise relationship act — FTC Rule governs disclosure. However, LUTPA provides remedies for deceptive practices in franchise sales.
- Non-compete provisions in franchise agreements governed by La. R.S. 23:921(K) — franchisor/franchisee exception applies, subject to same duration and geographic restrictions.

REAL ESTATE (Louisiana):
- Act of sale of immovable property must be executed before a notary and two witnesses, or by authentic act (La. C.C. Art. 1833).
- Louisiana does not have a mortgage contingency requirement by statute — flag its absence in purchase agreements.
- Seller's disclosure: Louisiana Property Disclosure Act (La. R.S. 9:3196) requires residential sellers to disclose known defects.
- 1031 exchanges: Flag tight closing deadlines that may not accommodate exchange requirements.

USURY (Louisiana):
- La. R.S. 9:3500 et seq.: Maximum interest rates vary by loan type. Consumer loans: generally 36% APR maximum. Commercial loans between sophisticated parties: rate set by agreement, but unconscionability doctrine applies.

── TEXAS ──
NON-COMPETE AGREEMENTS (Tex. Bus. & Com. Code § 15.50):
- Enforceable if: (1) part of an otherwise enforceable agreement, (2) contains reasonable limitations as to time, geography, and scope of activity, and (3) supported by consideration (e.g., confidential information, specialized training).
- Unlike Louisiana, Texas courts may reform (blue-pencil) an overbroad non-compete to make it reasonable rather than voiding it entirely.
- Duration: No statutory maximum. Courts assess reasonableness — 2 years is generally upheld; over 5 years rarely survives.
- Geography: Must be reasonable in relation to the employer's business operations. A nationwide restriction for a regional employer is likely overbroad.
- Physicians: Special rules under Tex. Bus. & Com. Code § 15.50(b) — physician non-competes must provide for buyout at reasonable price and cannot restrict patients with acute conditions.
- Consideration: Must be tied to a legitimate business interest (trade secrets, confidential info, specialized training). Non-competes given to at-will employees at hiring without additional consideration may be challenged.

EMPLOYMENT (Texas):
- At-will employment state. Strong at-will presumption.
- Tex. Lab. Code § 61.014: Final wages due within 6 days of termination (involuntary) or next regular payday (voluntary resignation).
- Texas Payday Law (Tex. Lab. Code Ch. 61): Wage claims administrative process through TWC.
- Texas Commission on Human Rights Act (Tex. Lab. Code Ch. 21): Applies to employers with 15+ employees. Mirrors Title VII plus state-specific protections.
- Wrongful termination: Texas recognizes Sabine Pilot exception — cannot terminate employee for refusing to perform an illegal act.

FRANCHISE AGREEMENTS (Texas):
- Texas Business Opportunity Act (Tex. Bus. & Com. Code Ch. 51): Requires registration and disclosure for certain business opportunities. Franchises exempt if FTC disclosure compliant.
- Texas does not have a specific franchise relationship act governing termination rights — FTC Rule and contract terms control.
- However, Texas DTPA (Tex. Bus. & Com. Code Ch. 17) applies to deceptive practices in franchise sales — provides up to 3x damages for knowing violations.
- Good cause for termination: Not required by Texas statute, but courts scrutinize termination provisions for unconscionability.
- Non-compete in franchise: Governed by § 15.50 — must meet reasonableness standard. Texas courts have upheld post-termination non-competes in franchise agreements when geographically limited to franchised territory.

COMMERCIAL CONTRACTS (Texas):
- Texas UCC (Tex. Bus. & Com. Code Title 1): Standard UCC provisions apply.
- Tex. Bus. & Com. Code § 2.719: Limitation of consequential damages enforceable unless unconscionable.
- Texas usury: Tex. Fin. Code § 302.001 — maximum rates vary. Commercial loans between corporations: rate agreed upon. Consumer loans: state maximum applies.
- Automatic renewal (Texas): Tex. Bus. & Com. Code § 2.309 and common law — automatic renewal clauses enforceable if clear. No specific automatic renewal statute for most commercial contracts.

REAL ESTATE (Texas):
- Texas Property Code § 5.008: Seller's disclosure notice required for residential sales of 1-4 units.
- Texas deed of trust (not mortgage) state — security instruments use trustees.
- Earnest money disputes: Texas Property Code § 5.013 — specific procedures for release of earnest money.
- Texas does not require attorney involvement in real estate closings — title companies commonly handle.

── CALIFORNIA ──
NON-COMPETE AGREEMENTS (Cal. Bus. & Prof. Code § 16600):
- California has one of the nation's strictest non-compete laws. § 16600 voids every contract restraining someone from engaging in a lawful profession, trade, or business EXCEPT narrow statutory exceptions (sale of business goodwill, dissolution of partnership or LLC).
- Employment non-competes are VOID in California regardless of where signed if the employee lives or works in California. This applies even if the contract has a non-California choice of law clause.
- SB 699 (eff. Jan. 1, 2024): Employers cannot enforce non-competes against California employees regardless of where the contract was signed. Attempting to enforce void non-competes is an unlawful business practice.
- AB 1076 (eff. Jan. 1, 2024): Employers must notify employees hired after Jan. 1, 2022 that their non-compete is void.
- Non-solicitation of customers: Also generally void under § 16600 post-2008 Supreme Court ruling.
- Trade secret protection available under CUTSA (Cal. Civ. Code § 3426) as alternative to non-competes.

EMPLOYMENT (California):
- California Labor Code § 201: All wages due immediately upon involuntary termination. § 202: 72 hours notice for voluntary resignation, then wages due at separation.
- Waiting time penalties (Cal. Lab. Code § 203): Up to 30 days additional wages for late final payment.
- Meal and rest breaks (Cal. Lab. Code §§ 226.7, 512): 30-min unpaid meal break for shifts over 5 hours; 10-min paid rest break per 4 hours. Premium pay (1 hour wages) per missed break.
- Overtime: California overtime begins at 8 hours/day (not just 40 hours/week). Double time after 12 hours/day. Flag contracts that only reference federal 40-hr overtime threshold.
- WARN Act (Cal. Lab. Code § 1400): California WARN requires 60-day notice for mass layoffs at facilities with 75+ employees (stricter than federal 100-employee threshold).
- AB5 / Dynamex: Strict ABC test for independent contractor classification. Flag independent contractor provisions involving California workers.
- Non-disclosure agreements: SB 1300 limits NDAs that prevent employees from disclosing facts of harassment/discrimination claims.

FRANCHISE AGREEMENTS (California):
- California Franchise Investment Law (Corp. Code § 31000 et seq.): Requires franchise registration with DBO before offering/selling franchises in California.
- California Franchise Relations Act (Bus. & Prof. Code § 20000 et seq.): Requires good cause for franchise termination; minimum 30-day notice and cure period for curable defaults; 180-day notice for non-curable termination. This is one of the strongest franchise relationship laws in the country.
- Non-compete in California franchise: Void under § 16600 for employees of franchisees. Post-termination non-competes in franchisor/franchisee agreements are highly problematic in California.

REAL ESTATE (California):
- Cal. Civ. Code § 1102 et seq.: Mandatory seller disclosure (TDS — Transfer Disclosure Statement) for residential 1-4 unit sales.
- Rent control: Many California cities have rent control ordinances — flag lease provisions in regulated jurisdictions.
- Proposition 13 implications for commercial property transfers — flag for tax reassessment risk.

USURY (California):
- Cal. Const. Art. XV: General usury limit 10% for personal/commercial loans. Loans by licensed lenders, banks, and certain commercial lenders exempt. Flag interest rates above 10% in unlicensed lender agreements.

── NEW YORK ──
NON-COMPETE AGREEMENTS (New York):
- New York applies a reasonableness test — no single statute governs. Courts use a multi-factor analysis: (1) necessary to protect legitimate employer interest, (2) not unduly burdensome on employee, (3) not injurious to public, (4) reasonable in time and geography.
- Legitimate interests: Trade secrets, confidential customer relationships, specialized training. Courts are skeptical of non-competes for general employees without access to confidential information.
- "Inevitable disclosure" doctrine: New York courts have shown reluctance to apply this doctrine broadly.
- NY Freelance Isn't Free Act (Admin. Code § 20-927): Written contracts required for freelancers for $800+ in services; payment within 30 days.

EMPLOYMENT (New York):
- New York Labor Law § 191: Frequency of pay requirements by employee classification. Manual workers must be paid weekly.
- New York Labor Law § 195: Written notice of wage rate, overtime rate, and pay day required at hiring.
- New York Labor Law § 193: Prohibited wage deductions — employers cannot deduct from wages except for specific permitted items.
- New York City Human Rights Law: Broader protections than state law — applies to employers with 4+ employees; includes protections for sexual orientation, gender identity, and other categories.
- WARN Act: New York WARN (Lab. Law § 860) requires 90-day notice (stricter than federal 60-day) for mass layoffs affecting 25+ employees.
- Paid Family Leave (NY Workers' Compensation Law § 200-242): Up to 12 weeks paid leave. Cannot be waived by contract.

FRANCHISE AGREEMENTS (New York):
- New York Franchise Sales Act (Gen. Bus. Law Art. 33): Registration and disclosure required for franchise offerings in New York.
- New York does not have a franchise relationship act — FTC Rule and contract terms govern termination.
- New York courts apply general contract unconscionability principles to franchise termination clauses.

── FLORIDA ──
NON-COMPETE AGREEMENTS (Fla. Stat. § 542.335):
- Florida is one of the most employer-friendly non-compete states. § 542.335 expressly validates non-competes supported by a legitimate business interest.
- Legitimate business interests include: trade secrets, confidential information, substantial customer relationships, customer goodwill, specialized training.
- Duration presumptions: ≤6 months — presumptively reasonable; 6 months to 2 years — presumptively reasonable in most contexts; >2 years — presumptively unreasonable (but rebuttable).
- Courts SHALL (mandatory) enforce reasonable restrictions and MAY modify (blue-pencil) overbroad provisions.
- Employee hardship is NOT a defense — Florida statute explicitly prohibits courts from considering hardship on the employee.
- Courts must consider the legitimate business interest when assessing geographic scope.

EMPLOYMENT (Florida):
- At-will employment state. Strong at-will presumption.
- Florida Minimum Wage Act (Fla. Stat. § 448.110): Florida minimum wage higher than federal — indexed annually. Flag contracts specifying only federal minimum wage for Florida employees.
- Florida Wage Payment Act (Fla. Stat. § 448.08): Final wages due on next regular payday. Attorney fees available to prevailing employee in wage disputes.
- Florida Civil Rights Act (Fla. Stat. § 760.01): Applies to employers with 15+ employees. Mirrors Title VII plus marital status protection.

FRANCHISE AGREEMENTS (Florida):
- Florida Franchise Act (Fla. Stat. § 817.416): Prohibits fraudulent and misleading statements in franchise sales. Provides private right of action.
- Florida does not have a franchise relationship act — contract terms and FTC Rule govern.
- Florida courts generally enforce franchise termination provisions as written if unambiguous.
- Florida non-compete law (§ 542.335) applies to post-termination non-competes in franchise agreements.

── ILLINOIS ──
NON-COMPETE AGREEMENTS (820 ILCS 90):
- Illinois Freedom to Work Act (eff. Jan. 1, 2022): Non-competes prohibited for employees earning ≤$75,000/year (threshold increases $5,000 every 5 years through 2037).
- Non-solicitation agreements prohibited for employees earning ≤$45,000/year.
- Employers must advise employees in writing to consult an attorney before signing. Must provide at least 14 days to review.
- Adequate consideration: Must be more than 2 years continued employment for existing employees.
- Courts may reform (blue-pencil) overbroad Illinois non-competes.

EMPLOYMENT (Illinois):
- Illinois Wage Payment and Collection Act (820 ILCS 115): Final wages due at next regular payday; severance agreements must be in writing.
- Illinois Human Rights Act (775 ILCS 5): Applies to employers with 15+ employees; broader protections than Title VII including ancestry, military status, unfavorable discharge from military.
- Illinois Employee Classification Act (820 ILCS 185): Strict misclassification rules for construction industry.
- Illinois WARN Act (820 ILCS 65): 60-day notice required for plant closings and mass layoffs affecting 25+ employees.

── GEORGIA ──
NON-COMPETE AGREEMENTS (O.C.G.A. § 13-8-50 et seq.):
- Georgia Restrictive Covenants Act (eff. 2011): Significantly liberalized non-compete enforcement. Courts may blue-pencil and modify overbroad provisions.
- Reasonable time: Generally 2 years or less presumptively reasonable.
- Geographic scope: Must be reasonable in relation to employer's territory. Can reference specific counties, states, or territories where employee had material contact with customers.
- Must protect a legitimate business interest.
- Applies to employees, independent contractors, and partners.

EMPLOYMENT (Georgia):
- At-will employment state.
- Georgia has no state minimum wage law — federal $7.25/hr applies.
- Georgia wage payment: Final wages due by next regular payday.
- Georgia does not have a state WARN Act — federal law applies.

── MINNESOTA ──
NON-COMPETE AGREEMENTS (Minn. Stat. § 181.988 — eff. July 1, 2023):
- Minnesota BANNED non-compete agreements for employees and independent contractors effective July 1, 2023.
- Any non-compete agreement signed after July 1, 2023 with a Minnesota employee is void and unenforceable regardless of the choice of law clause.
- Non-solicitation of customers and confidentiality agreements remain permissible.
- Pre-July 2023 non-competes: Governed by common law reasonableness standard — courts applied 5-factor test.
- Flag any non-compete with a Minnesota employee as presumptively void if signed after July 1, 2023.

EMPLOYMENT (Minnesota):
- Minnesota Payment of Wages Act (Minn. Stat. § 181.101): Final wages due within 24 hours of demand after termination (involuntary); next regular payday for voluntary resignation.
- Minnesota Human Rights Act (Minn. Stat. § 363A): One of the broadest anti-discrimination statutes — applies to employers with 1+ employee; covers sexual orientation, gender identity, familial status, and other protected classes.
- Minnesota Earned Sick and Safe Time (eff. Jan. 1, 2024): Employees accrue 1 hour per 33 hours worked; up to 48 hours per year. Cannot be waived by contract.
- Minnesota WARN: No separate state WARN Act — federal law applies.
- Minnesota Non-Compete Ban: See above. Applies to all new agreements with Minnesota residents regardless of where employer is located.

── WASHINGTON STATE ──
NON-COMPETE AGREEMENTS (RCW 49.62):
- Washington Noncompetition Covenant Act (eff. Jan. 1, 2020): Non-competes enforceable only for employees earning ≥$100,000/year (indexed annually) and independent contractors earning ≥$250,000/year.
- Duration: Rebuttably presumed unreasonable if exceeding 18 months.
- Disclosure: Must be disclosed to prospective employees no later than time of acceptance of offer; existing employees must receive independent consideration.
- Courts must reform non-competes that violate the Act rather than voiding them entirely.
- Penalties: Employers who violate the Act must pay $5,000 or actual damages (whichever greater) plus attorney fees.

EMPLOYMENT (Washington):
- Washington minimum wage is one of the highest in the nation — indexed annually (check current rate).
- Washington Paid Family and Medical Leave (RCW 50A): Mandatory state program — employers cannot contract around it.
- Washington Consumer Protection Act (RCW 19.86): Applies to unfair employment practices in some contexts.

── COLORADO ──
NON-COMPETE AGREEMENTS (C.R.S. § 8-2-113 — eff. Aug. 10, 2022):
- Colorado significantly restricted non-competes in 2022. Non-competes only enforceable for employees earning ≥$123,750/year (2024 threshold — indexed annually) in highly specialized roles.
- Non-solicitation of customers: Enforceable only for employees earning ≥$74,250/year (2024 — indexed).
- Must be for protection of trade secrets.
- Must be provided to employee before job offer acceptance (prospective) or before additional consideration is provided (existing employees).
- Colorado choice-of-law: Colorado law applies to Colorado employees regardless of choice-of-law clause if employee is a Colorado resident or primarily works in Colorado.

════════════════════════════════════════════════════════
CONTRACT TYPE — SPECIFIC LEGAL CHECKLIST
════════════════════════════════════════════════════════

EMPLOYMENT CONTRACTS (all states):
- Check: At-will vs. for-cause termination standard. If for-cause, is "cause" defined specifically enough to be enforceable?
- Check: Severance provisions — are they conditioned on release of claims? Is the release ADEA-compliant (21 days to consider, 7-day revocation for workers 40+)?
- Check: Non-compete, non-solicitation, and confidentiality provisions against governing state law.
- Check: Arbitration clause — does it waive class action? Does it cover sexual harassment claims (may be unenforceable under 2022 federal law)?
- Check: IP assignment — does it improperly claim employee's pre-existing or personal inventions? California, Delaware, Minnesota, North Carolina, Washington limit employer IP assignment clauses.
- Check: Wage and hour compliance — is compensation structure FLSA-compliant? Are overtime exemptions properly structured?
- Missing provisions to flag: Expense reimbursement policy; PTO/vacation policy and payout on termination; benefits continuation provisions; return of property obligations.

FRANCHISE AGREEMENTS (all states):
- Check: FDD provided at least 14 days before signing (federal requirement).
- Check: Termination for cause — is "cause" defined? Is there a cure period for curable defaults?
- Check: Territory exclusivity — is it exclusive or non-exclusive? Are protected territory boundaries clearly defined?
- Check: Renewal terms — automatic renewal vs. franchisor discretion? Conditions for renewal?
- Check: Transfer restrictions — right of first refusal, transfer fees, approval standards.
- Check: Non-compete post-termination — is it enforceable under governing state law?
- Check: Royalty and fee escalation provisions — automatic increases?
- Check: System change authority — does franchisor have unlimited right to change the system? Flag if so.
- Missing provisions to flag: Earnings claim (if not in FDD); dispute resolution/mediation before litigation; most favored nation protection.

NON-DISCLOSURE / CONFIDENTIALITY AGREEMENTS:
- Check: Definition of "confidential information" — is it overbroad or circular?
- Check: Exclusions — does it properly exclude publicly available information, independently developed information, information received from third parties?
- Check: Duration — indefinite NDAs for trade secrets are generally enforceable; indefinite NDAs for general business information may not be.
- Check: Mutual vs. one-sided — flag one-sided NDAs.
- Check: Return/destruction of materials obligation upon termination.
- California: SB 1300/SB 820 limits NDAs covering harassment/discrimination facts.

REAL ESTATE PURCHASE AGREEMENTS:
- Check: Contingencies — financing, inspection, appraisal. Are they adequately defined with clear triggering standards?
- Check: Deposit/earnest money — refundable vs. non-refundable? Under what conditions?
- Check: As-is provisions — does seller disclosure comply with state law despite as-is language?
- Check: Closing cost allocation — standard allocation or modified? Flag unusual allocations.
- Check: Proration of taxes, rents, utilities as of closing date.
- Check: Risk of loss — who bears risk between contract and closing?
- Check: Title insurance — who pays? What standard?
- Missing provisions to flag: Survey contingency; environmental inspection right; 1031 exchange cooperation clause; post-closing escrow for representations.

LEASE AGREEMENTS:
- Check: Rent escalation — fixed increases vs. CPI adjustment? Cap on CPI adjustments?
- Check: CAM (Common Area Maintenance) charges — are they capped? Are audit rights provided?
- Check: Assignment and subletting rights — tenant-friendly or landlord-controlled?
- Check: Personal guarantee — is it unlimited? Consider carve-out for good-guy guarantee.
- Check: Renewal options — at market or fixed rent? Notice requirements?
- Check: Exclusivity clause in retail leases — is use clause broad enough?
- Check: Force majeure — does it excuse rent payments?
- Missing provisions to flag: SNDA (Subordination, Non-Disturbance, Attornment); landlord estoppel certificate obligation; tenant improvement allowance; holdover rent cap.

SERVICE AGREEMENTS / MASTER SERVICE AGREEMENTS (MSAs):
- Check: Independent contractor vs. employee classification — apply ABC test for governing state.
- Check: Limitation of liability — is it mutual? Is it reasonable relative to contract value? Flag if one party has uncapped liability while the other is capped.
- Check: Indemnification — is it one-sided? Does it cover indemnitee's own negligence (may be unenforceable in some states)?
- Check: IP ownership — work-for-hire vs. license? What happens to pre-existing IP brought to the engagement?
- Check: Termination for convenience — notice period adequate? Is there a kill fee or payment for work in progress?
- Check: Non-solicitation of employees — enforceability under governing state law.
- Check: MSA vs. SOW hierarchy — which controls in case of conflict? If not specified, flag as ambiguous.
- Check: Whether the MSA's limitation of liability cap applies per-SOW or in aggregate — this distinction is worth significant money in disputes.
- Check: Change order process — is there a written change order requirement? Oral modifications may be unenforceable if contract requires written amendments.
- Missing provisions: Insurance requirements and certificates; data security and breach notification obligations; SLA metrics and remedies for failure; acceptance criteria for deliverables; dispute escalation before litigation.

STATEMENTS OF WORK (SOWs):
- Check: Are deliverables defined with specificity — vague deliverables lead to disputes about completion.
- Check: Acceptance criteria — how is completion measured? Who has final acceptance authority? Is there a deemed acceptance provision if client fails to respond within X days?
- Check: Payment triggers — milestone-based or time-based? What happens if client delays a milestone?
- Check: Timeline dependencies — are client obligations (approvals, feedback, access) clearly tied to timeline adjustments?
- Check: Intellectual property created under the SOW — does the MSA IP provision apply? Is there a specific ownership clause in the SOW?
- Missing provisions: Expense reimbursement policy; travel approval process; subcontractor approval rights.

INDEPENDENT CONTRACTOR AGREEMENTS:
- Check: IRS 20-Factor Test indicators — flag provisions suggesting employee status: set hours, required location, employer-provided tools, prohibition on working for others, hourly pay rather than project pay, no risk of loss for contractor.
- Check: ABC Test (California, New Jersey, Massachusetts, and others) — contractor must: (A) be free from control, (B) perform work outside usual course of business, (C) be engaged in independently established trade. Flag if any factor appears to fail.
- Check: Control provisions — does the agreement specify HOW work is done (employee indicator) or only the result (contractor indicator)?
- Check: Exclusivity — a prohibition on working for other clients strongly suggests employment. Flag if present.
- Check: IP assignment — contractor IP assignments are valid but must be clearly documented. Flag missing or ambiguous IP ownership clauses.
- Check: Benefits language — contractor agreements should expressly state no benefits, workers' comp, unemployment insurance. Flag missing disclaimers.
- Check: Duration — long-term open-ended contractor relationships are higher misclassification risk. Flag relationships over 1 year with no defined project scope.
- Misclassification risk: California (AB5) applies strict ABC test with very limited exceptions. Flag any California worker classified as contractor unless they clearly qualify for a recognized exemption (e.g., licensed professional, single-engagement project).
- Missing provisions: Indemnification for contractor's own taxes and benefits; right to audit; equipment and expense ownership; termination for convenience with notice.

SHAREHOLDER AGREEMENTS / OPERATING AGREEMENTS / PARTNERSHIP AGREEMENTS:
- Check: Voting rights — are they proportional to ownership? Are supermajority requirements specified for major decisions (sale of company, new equity issuance, debt over threshold)?
- Check: Buy-sell provisions — is there a right of first refusal (ROFR) on share transfers? Is the buyout price mechanism defined (formula, appraisal, or negotiation)?
- Check: Deadlock provisions — what happens when owners are equally split on a major decision? Absence of a deadlock mechanism in a 50/50 company is a significant red flag.
- Check: Drag-along rights — can a majority force minority to sell in a company sale transaction? Are minority protections adequate?
- Check: Tag-along rights — can minority follow majority in a sale at the same price and terms? Absence of tag-along is a red flag for minority owners.
- Check: Death, disability, divorce — does the agreement address what happens to shares upon death, incapacity, or divorce of a shareholder? Absence is a major red flag.
- Check: Non-compete obligations on owners — are they enforceable under governing state law? Apply state-specific non-compete analysis.
- Check: Fiduciary duties — does the agreement attempt to waive or limit fiduciary duties? Some states (Delaware, Nevada) permit this; others do not.
- Check: Distributions — is there a mandatory distribution policy for tax distributions? S-corp and LLC operating agreements should address tax distributions to prevent members from owing taxes on income they did not receive as cash.
- Check: Manager vs. member managed (LLCs) — authority of managers clearly defined? Limitations on manager authority specified?
- Check: Dissolution and wind-up — liquidation preference, distribution waterfall, and wind-up procedures.
- Check: Capital calls — are members obligated to contribute additional capital? What happens if a member fails to meet a capital call?
- Missing provisions: Anti-dilution protection; information rights for minority owners; exit mechanism for deadlocked companies; right of first offer vs. right of first refusal distinction.

LICENSING AGREEMENTS:
- Check: Scope of license — exclusive vs. non-exclusive; field of use limitations; geographic scope; sublicensing rights.
- Check: Exclusivity — if exclusive, is there a minimum performance requirement to maintain exclusivity? Unlimited exclusivity without performance requirements is a red flag for licensors.
- Check: Royalty structure — fixed fee, percentage of net sales, per-unit royalty? How is "net sales" defined? Deductions from gross sales should be specifically enumerated.
- Check: Royalty audit rights — does licensor have right to audit licensee's books? Notice period and frequency limits for audits?
- Check: Term and termination — termination for breach with cure period? Termination for convenience? Post-termination obligations (sell-off period for inventory)?
- Check: Bankruptcy protection — under 11 U.S.C. § 365(n), licensees of intellectual property have the right to retain their license even if licensor files for bankruptcy and rejects the agreement. Flag if agreement attempts to waive this right.
- Check: Improvements and derivative works — who owns improvements made by licensee? Does licensor get a grant-back license to licensee improvements?
- Check: Quality control — for trademark licenses, licensor must maintain quality control or risk naked license (trademark abandonment). Flag trademark licenses without quality control provisions.
- Check: Representations and warranties — does licensor warrant ownership and non-infringement? Does licensor indemnify for third-party IP claims?
- Missing provisions: Most favored nation pricing; source code escrow for software licenses; performance benchmarks; marketing and promotional obligations.

NON-DISCLOSURE AGREEMENTS (NDAs):
- Check: Definition of confidential information — is it overbroad (everything disclosed) or does it require marking as confidential? Overbroad definitions may be unenforceable.
- Check: Exclusions — public domain, independently developed, received from third parties, required by law. All four standard exclusions should be present.
- Check: Duration — indefinite NDAs for trade secrets are generally enforceable. Indefinite NDAs for general business information may not be. California courts have voided indefinite NDAs in employment contexts.
- Check: Permitted disclosures — employees, advisors, legal counsel on need-to-know basis with confidentiality obligations. Are these permitted disclosures reasonable?
- Check: Mutual vs. one-sided — flag one-sided NDAs where only one party discloses. Mutual NDAs are more balanced and often more appropriate.
- Check: Return/destruction obligations — upon termination or demand, must confidential information be returned or destroyed? Is certification required?
- Check: Remedies — does agreement provide for injunctive relief without bond requirement? Courts generally honor these provisions.
- Check: Residuals clause — some NDAs allow use of information retained in unaided memory. This significantly limits NDA protection. Flag if present.
- California: SB 1300 and SB 820 — NDAs that prevent disclosure of facts related to harassment or discrimination claims are void. Flag such provisions.
- Missing provisions: Specific handling requirements for highly sensitive information; data security obligations; notification of breach of confidentiality.

SETTLEMENT AGREEMENTS:
- Check: Scope of release — is it a general release (all claims) or specific release (identified claims only)? General releases in employment contexts must comply with ADEA (workers 40+ get 21 days to review and 7-day revocation right).
- Check: Unknown claims — does the release include unknown claims? California Civil Code § 1542 waiver must be expressly stated for California residents to release unknown claims.
- Check: Tax treatment — CRITICALLY IMPORTANT: Physical injury settlements are tax-free under IRC § 104. Employment settlements for back pay, front pay, and emotional distress (absent physical injury) are taxable. Settlements characterized as back pay are subject to payroll taxes. Flag settlements that do not address tax characterization — the allocation between taxable and non-taxable components should be expressly stated and consistent with the underlying facts.
- Check: Confidentiality — is the settlement amount confidential? Non-disclosure of terms vs. non-disclosure of the existence of settlement are different obligations. Flag which applies.
- Check: Non-disparagement — mutual or one-sided? California AB 2770 protects certain employee statements about workplace harassment — flag non-disparagement clauses that may conflict.
- Check: Medicare/Medicaid set-aside — for personal injury settlements involving Medicare beneficiaries, failure to address Medicare's conditional payment interests can result in liability to CMS. Flag personal injury settlements without Medicare set-aside provisions.
- Check: Structured payment provisions — interest rate on deferred payments? Security for future payments? Consequences of missed payments?
- Missing provisions: Return of property; cooperation obligations; reference letter (in employment cases); reinstatement waiver; court approval requirement (for class actions or minor settlements).

INSURANCE POLICIES (special analysis mode):
- NOTE: Insurance policies are adhesion contracts — terms are set by insurer and are not negotiated. Analysis focuses on coverage scope, exclusions, conditions, and gaps rather than negotiation points.
- Check: Coverage grant — what is actually covered? Is the coverage grant broad or narrow?
- Check: Exclusions — list all material exclusions. Flag exclusions that may be broader than expected or that conflict with the insured's stated purpose.
- Check: Conditions precedent to coverage — notice requirements, cooperation obligations, proof of loss deadlines. Failure to satisfy conditions can void coverage even for covered losses.
- Check: Policy limits and sublimits — are sublimits adequate for specific risk categories (e.g., cyber sublimit within a commercial policy)?
- Check: Deductibles and retentions — are they per-occurrence or aggregate?
- Check: Claims-made vs. occurrence — claims-made policies cover claims filed during the policy period; occurrence policies cover incidents during the policy period regardless of when claim is filed. Tail coverage / extended reporting period for claims-made policies.
- Check: Additional insured provisions — are required additional insureds listed? Is additional insured coverage primary and non-contributory?
- Check: Subrogation waiver — is waiver of subrogation in favor of required parties present?
- Check: Assignment clause — most policies prohibit assignment without insurer consent. Flag for business sale transactions.
- Missing coverage to flag: Employment practices liability (EPLI) gap; cyber liability gap; directors and officers (D&O) gap; umbrella/excess coverage adequacy.

VENDOR / SUPPLIER AGREEMENTS:
- Check: Service level agreements (SLAs) — are performance metrics defined with specificity? What are the remedies for failure (credits, termination right)?
- Check: Delivery obligations — force majeure definition broad enough to excuse supply chain disruptions?
- Check: Price escalation — fixed pricing or subject to adjustment? Indexing mechanism (CPI, PPI)?
- Check: Most favored nation (MFN) pricing — is buyer entitled to best pricing offered to comparable customers?
- Check: Minimum purchase commitments — is buyer obligated to minimum purchases? Consequences of shortfall?
- Check: Quality and inspection rights — right to audit supplier facilities? Rejection rights for nonconforming goods?
- Check: Termination for convenience — notice period? Cancellation fees for orders in process?
- Missing provisions: Business continuity and disaster recovery obligations; data security requirements; conflict minerals compliance; supply chain transparency; insurance requirements.

════════════════════════════════════════════════════════
INSTRUCTION FOR APPLYING STATE-SPECIFIC KNOWLEDGE
════════════════════════════════════════════════════════
When you identify the governing law:
1. Apply ALL relevant provisions from the state-specific section above for that state.
2. If the governing state is not listed above, apply general common law principles and federal law, and note that state-specific analysis is based on general principles.
3. For multi-state contracts or choice of law issues, apply the chosen state's law but flag if a different state's mandatory law may override (e.g., California employees, Minnesota employees).
4. Always cite the specific statute when flagging a legal compliance issue.
5. Use careful hedging language — "may conflict with," "appears unenforceable under," "should be verified with local counsel" — do not render definitive legal conclusions.
6. For spreadsheet or data files that are not contracts: identify the data type, summarize key figures, flag data quality issues (invalid entries, missing fields, inconsistencies between related figures), and clearly state this is not a legal contract.

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
        max_tokens: 8000,
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
    await saveUser(user);

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

  if (!supabase) return res.json({ analyses: [], total: 0, historyEnabled: false });

  try {
    let query = supabase
      .from('analyses')
      .select('id, doc_title, doc_date, contract_type, governing_law, parties, page_count, credit_cost, created_at', { count: 'exact' })
      .eq('email', email)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) query = query.or(`doc_title.ilike.%${search}%,contract_type.ilike.%${search}%,governing_law.ilike.%${search}%,parties.ilike.%${search}%`);
    if (type && type !== 'all') query = query.ilike('contract_type', `%${type}%`);

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
      return res.status(400).json({ error: 'Could not extract text. Please paste the contract text manually.' });
    }

    if (estimatedPages > PAGE_LIMIT) {
      return res.status(400).json({
        error: 'page_limit_exceeded',
        message: `This document appears to be approximately ${estimatedPages} pages, which exceeds our ${PAGE_LIMIT}-page limit.`,
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

// ── POST /api/billing-portal
app.post('/api/billing-portal', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const user = await getUser(email);
  if (!user.customerId) return res.status(400).json({ error: 'No subscription found.' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.customerId,
      return_url: process.env.APP_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/webhook
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
      const user = await getUser(email);
      const plan = PLANS[planKey];
      user.plan = planKey;
      user.subscribed = true;
      user.customerId = session.customer;
      user.creditsLimit = plan.monthlyAnalyses;
      user.creditsUsed = 0;
      user.seats = plan.seats;
      user.billingCycleStart = new Date().toISOString();
      await saveUser(user);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    if (supabase) {
      try {
        const { data } = await supabase.from('users').select('*').eq('customer_id', customerId).single();
        if (data) {
          const user = dbRowToUser(data);
          user.plan = 'free';
          user.subscribed = false;
          user.creditsLimit = 3;
          user.creditsUsed = 0;
          await saveUser(user);
        }
      } catch (e) { console.error('subscription.deleted error:', e.message); }
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const customerId = event.data.object.customer;
    if (supabase) {
      try {
        const { data } = await supabase.from('users').select('*').eq('customer_id', customerId).single();
        if (data && data.subscribed) {
          const user = dbRowToUser(data);
          user.creditsUsed = 0;
          user.billingCycleStart = new Date().toISOString();
          await saveUser(user);
        }
      } catch (e) { console.error('invoice.payment_succeeded error:', e.message); }
    }
  }

  res.json({ received: true });
});

// ── GET /api/status
app.get('/api/status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const user = await getUser(email);
  checkBillingReset(user);
  checkTrialExpiry(user);
  await saveUser(user);
  const trialDaysRemaining = user.trialExpiry
    ? Math.max(0, Math.ceil((new Date(user.trialExpiry) - new Date()) / (1000 * 60 * 60 * 24)))
    : null;
  res.json({
    plan: user.plan, subscribed: user.subscribed,
    creditsUsed: user.creditsUsed, creditsLimit: user.creditsLimit,
    creditsRemaining: user.creditsLimit - user.creditsUsed,
    seats: user.seats, trialDaysRemaining, hadTrial: user.hadTrial,
  });
});

// ── GET /api/reset-test
app.get('/api/reset-test', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const user = await getUser(email);
  user.creditsUsed = 0;
  user.plan = 'free';
  user.creditsLimit = 3;
  user.subscribed = false;
  user.trialExpiry = null;
  user.trialStarted = null;
  user.hadTrial = false;
  user.customerId = null;
  await saveUser(user);
  res.json({ message: 'Reset successful', email });
});

// ── GET /sample — public sample output page
app.get('/sample', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sample.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Contract Summarizer running on port ${PORT}`));
