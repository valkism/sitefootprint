// functions/api/create-portal.js
// Cloudflare Pages Function
// Lets users manage their own billing via Stripe's hosted portal

export async function onRequestPost(context) {
  const { request, env } = context;

  // Fail closed — never fall back to wildcard CORS
  const allowedOrigin = env.ALLOWED_ORIGIN;
  if (!allowedOrigin) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500 });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // ── Require a valid Firebase ID token ───────────────────────────────────
  const authHeader = request.headers.get('Authorization');
  const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Verify the token with Firebase Auth REST API (cryptographic server-side check)
  const verifiedUid = await verifyFirebaseToken(idToken, env.FIREBASE_WEB_API_KEY);
  if (!verifiedUid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const { uid } = body;
  if (!uid) {
    return new Response(JSON.stringify({ error: 'uid required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // ── Confirm the token belongs to the uid being requested ────────────────
  if (verifiedUid !== uid) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    // Look up stripeCustomerId from Firestore via REST API
    const projectId = env.FIREBASE_PROJECT_ID;
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;

    // Get a Firebase Admin access token using service account
    const accessToken = await getFirebaseAccessToken(env.FIREBASE_SERVICE_ACCOUNT);

    const firestoreRes = await fetch(firestoreUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!firestoreRes.ok) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const userDoc = await firestoreRes.json();
    const stripeCustomerId = userDoc.fields?.stripeCustomerId?.stringValue;

    if (!stripeCustomerId) {
      return new Response(JSON.stringify({ error: 'No billing account found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Create portal session
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `customer=${stripeCustomerId}&return_url=${encodeURIComponent(allowedOrigin + '/app.html')}`
    });

    const portal = await portalRes.json();
    if (!portalRes.ok) throw new Error(portal.error?.message || 'Portal creation failed');

    return new Response(JSON.stringify({ url: portal.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// ── Verify Firebase ID token via Google's accounts:lookup endpoint ────────
// Sends the raw token to Google, which validates signature, expiry, audience,
// and issuer — returns the uid if valid, null otherwise.
async function verifyFirebaseToken(idToken, webApiKey) {
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${webApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const user = data.users?.[0];
    if (!user?.localId) return null;
    return user.localId;
  } catch {
    return null;
  }
}

// ── Get a short-lived Firebase Admin access token from service account ────
async function getFirebaseAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform'
  };

  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const body   = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const input  = `${header}.${body}`;

  const privateKey = await importPrivateKey(sa.private_key);
  const signature  = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input));
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${input}.${sig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function importPrivateKey(pem) {
  const pemContents = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
