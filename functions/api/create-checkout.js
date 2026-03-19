// functions/api/create-checkout.js
// Cloudflare Pages Function — Stripe Checkout with multi-tier support
//
// Set in Cloudflare Dashboard → Pages → Settings → Environment Variables:
//   STRIPE_SECRET_KEY          = sk_live_xxxx
//   STRIPE_PRICE_ID_SOLO       = price_xxxx   ($19/mo)
//   STRIPE_PRICE_ID_PARTNERSHIP = price_xxxx  ($39/mo)
//   STRIPE_PRICE_ID_AGENCY     = price_xxxx   ($89/mo)
//   STRIPE_PRICE_ID_ENTERPRISE = price_xxxx   ($199/mo)
//   ALLOWED_ORIGIN             = https://yourdomain.com

export async function onRequestPost(context) {
  const { request, env } = context;

  const allowedOrigin = env.ALLOWED_ORIGIN;
  if (!allowedOrigin) {
    return new Response(JSON.stringify({ error: 'Server misconfigured', url: null }), { status: 500 });
  }

  const requestOrigin = request.headers.get('Origin') || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (requestOrigin && !requestOrigin.startsWith(allowedOrigin)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }

  const { uid, email, trialDays = 3, successUrl, cancelUrl, plan = 'solo' } = body;

  if (!uid || !email) {
    return new Response(JSON.stringify({ error: 'uid and email required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Verify Firebase ID token
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.replace('Bearer ', '');
  if (idToken) {
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
        if (payload.sub !== uid) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }
    } catch { /* proceed */ }
  }

  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: 'Stripe not configured', url: null }), {
      status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Select price ID based on plan
  const priceMap = {
    solo:         env.STRIPE_PRICE_ID_SOLO         || env.STRIPE_PRICE_ID,
    partnership:  env.STRIPE_PRICE_ID_PARTNERSHIP  || env.STRIPE_PRICE_ID,
    agency:       env.STRIPE_PRICE_ID_AGENCY       || env.STRIPE_PRICE_ID,
    enterprise:   env.STRIPE_PRICE_ID_ENTERPRISE   || env.STRIPE_PRICE_ID,
  };
  const priceId = priceMap[plan] || env.STRIPE_PRICE_ID;

  if (!priceId) {
    return new Response(JSON.stringify({ error: 'No Stripe price configured for plan: ' + plan, url: null }), {
      status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Tier display names for Stripe checkout
  const planNames = { solo: 'Solo', partnership: 'Partnership', agency: 'Agency', enterprise: 'Enterprise' };
  const planPrices = { solo: '$19', partnership: '$39', agency: '$89', enterprise: '$199' };

  try {
    const origin = allowedOrigin;

    // Find or create Stripe customer
    // Sanitize email before interpolating into the Stripe search query
    const safeEmail = email.replace(/['"\\]/g, '');
    const searchRes = await stripeRequest(stripeKey, `customers/search?query=email:"${safeEmail}"&limit=1`);
    let customerId = searchRes.data?.[0]?.id;
    let isExistingCustomer = !!customerId;

    if (!customerId) {
      const newCustomer = await stripeRequest(stripeKey, 'customers', 'POST', {
        email,
        metadata: { firebaseUid: uid, plan }
      });
      customerId = newCustomer.id;
    }

    // Prevent trial abuse — no second trial
    let actualTrialDays = trialDays;
    if (isExistingCustomer) {
      const subs = await stripeRequest(stripeKey, `subscriptions?customer=${customerId}&limit=10`);
      const hadTrial = subs.data?.some(s => s.trial_end !== null);
      if (hadTrial) actualTrialDays = 0;
    }

    const planName = planNames[plan] || 'Solo';
    const planPrice = planPrices[plan] || '$19';

    const session = await stripeRequest(stripeKey, 'checkout/sessions', 'POST', {
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: actualTrialDays,
        metadata: { firebaseUid: uid, plan, tier: plan }
      },
      payment_method_collection: 'always',
      custom_text: {
        submit: {
          message: actualTrialDays > 0
            ? `${planName} plan — ${planPrice}/month after your ${actualTrialDays}-day free trial. Cancel anytime.`
            : `${planName} plan — ${planPrice}/month. Cancel anytime.`
        }
      },
      allow_promotion_codes: 'true',
      success_url: sanitizeUrl(successUrl, origin) || `${origin}/app.html?welcome=1&plan=${plan}`,
      cancel_url:  sanitizeUrl(cancelUrl,  origin) || `${origin}/login.html`,
    });

    return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Stripe checkout error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Checkout failed', url: null }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

function sanitizeUrl(url, origin) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin === origin) return url;
    return null;
  } catch { return null; }
}

async function stripeRequest(secretKey, path, method = 'GET', data = null) {
  const url = `https://api.stripe.com/v1/${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  };
  if (data && method !== 'GET') opts.body = toFormData(data);
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Stripe error: ${res.status}`);
  return json;
}

function toFormData(obj, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && value !== undefined) {
      if (typeof value === 'object' && !Array.isArray(value)) {
        parts.push(toFormData(value, fullKey));
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => parts.push(toFormData(v, `${fullKey}[${i}]`)));
      } else {
        parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
      }
    }
  }
  return parts.join('&');
}
