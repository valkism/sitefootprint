// functions/api/create-checkout.js
// Cloudflare Pages Function
// Environment variables set in Cloudflare dashboard → Settings → Environment variables:
//   STRIPE_SECRET_KEY   = sk_live_xxxx
//   STRIPE_PRICE_ID     = price_xxxx

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const { uid, email, trialDays = 3, successUrl, cancelUrl } = body;

  if (!uid || !email) {
    return new Response(JSON.stringify({ error: 'uid and email required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const stripeKey = env.STRIPE_SECRET_KEY;
  const priceId   = env.STRIPE_PRICE_ID;

  try {
    // Find or create Stripe customer
    const searchRes = await stripeRequest(stripeKey, `customers/search?query=email:"${email}"&limit=1`);
    let customerId = searchRes.data?.[0]?.id;

    if (!customerId) {
      const newCustomer = await stripeRequest(stripeKey, 'customers', 'POST', {
        email,
        metadata: { firebaseUid: uid }
      });
      customerId = newCustomer.id;
    }

    // Create checkout session with trial
    const origin = env.ALLOWED_ORIGIN || new URL(request.url).origin;
    const session = await stripeRequest(stripeKey, 'checkout/sessions', 'POST', {
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: trialDays,
        metadata: { firebaseUid: uid }
      },
      payment_method_collection: 'always',
      allow_promotion_codes: 'true',
      success_url: successUrl || `${origin}/app.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancelUrl  || `${origin}/login.html`,
    });

    return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Stripe checkout error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Checkout failed' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Minimal Stripe API helper (no SDK needed in Workers)
async function stripeRequest(secretKey, path, method = 'GET', data = null) {
  const url = `https://api.stripe.com/v1/${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  };

  if (data && method !== 'GET') {
    opts.body = toFormData(data);
  }

  const res = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok) {
    throw new Error(json.error?.message || `Stripe error: ${res.status}`);
  }

  return json;
}

// Convert object to URL-encoded form data (what Stripe expects)
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
