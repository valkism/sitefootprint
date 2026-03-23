// functions/api/stripe-webhook.js
// Cloudflare Pages Function
// Handles Stripe events and updates Firestore user subscription status

export async function onRequestPost(context) {
  const { request, env } = context;

  // Verify Stripe webhook signature
  const payload   = await request.text();
  const sigHeader = request.headers.get('stripe-signature');

  const isValid = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response('Invalid signature', { status: 400 });
  }

  const event = JSON.parse(payload);
  const data  = event.data.object;

  try {
    const projectId = env.FIREBASE_PROJECT_ID;
    const accessToken = await getFirebaseAccessToken(env.FIREBASE_SERVICE_ACCOUNT);

    switch (event.type) {

      case 'customer.subscription.created': {
        const uid = data.metadata?.firebaseUid;
        if (uid) {
          await updateFirestore(projectId, accessToken, uid, {
            subscriptionStatus:   data.status,
            stripeSubscriptionId: data.id,
            stripeCustomerId:     data.customer,
            trialEnds:            data.trial_end ? new Date(data.trial_end * 1000).toISOString() : null,
            plan:                 'trial',
          });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Fetch the subscription to get firebaseUid from metadata
        const sub = await stripeGet(env.STRIPE_SECRET_KEY, `subscriptions/${data.subscription}`);
        const uid = sub.metadata?.firebaseUid;
        if (uid) {
          await updateFirestore(projectId, accessToken, uid, {
            subscriptionStatus: 'active',
            plan: 'pro',
            currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const sub = await stripeGet(env.STRIPE_SECRET_KEY, `subscriptions/${data.subscription}`);
        const uid = sub.metadata?.firebaseUid;
        if (uid) {
          await updateFirestore(projectId, accessToken, uid, {
            subscriptionStatus: 'past_due',
            plan: 'restricted',
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const uid = data.metadata?.firebaseUid;
        if (uid) {
          await updateFirestore(projectId, accessToken, uid, {
            subscriptionStatus: 'cancelled',
            plan: 'free',
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const uid = data.metadata?.firebaseUid;
        if (uid) {
          const plan = data.status === 'active' ? 'pro' : data.status === 'trialing' ? 'trial' : 'free';
          await updateFirestore(projectId, accessToken, uid, {
            subscriptionStatus: data.status,
            plan,
          });
        }
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Webhook error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── Verify Stripe webhook signature (HMAC-SHA256) ─────────────────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts    = sigHeader.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).slice(2);
    const signature = parts.find(p => p.startsWith('v1=')).slice(3);
    const signedPayload = `${timestamp}.${payload}`;

    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );

    const expectedSig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const expectedHex = Array.from(new Uint8Array(expectedSig)).map(b => b.toString(16).padStart(2,'0')).join('');

    // Constant-time comparison
    if (expectedHex.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

// ── Firestore REST update ─────────────────────────────────────────────────
async function updateFirestore(projectId, accessToken, uid, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;

  // Build Firestore field mask and document
  const firestoreFields = {};
  const fieldPaths = [];

  for (const [key, value] of Object.entries(fields)) {
    fieldPaths.push(key);
    if (value === null) {
      firestoreFields[key] = { nullValue: null };
    } else if (typeof value === 'string') {
      firestoreFields[key] = { stringValue: value };
    } else if (typeof value === 'boolean') {
      firestoreFields[key] = { booleanValue: value };
    } else if (typeof value === 'number') {
      firestoreFields[key] = { integerValue: value };
    }
  }

  const updateMask = fieldPaths.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');

  await fetch(`${url}?${updateMask}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: firestoreFields })
  });
}

// ── Stripe GET helper ─────────────────────────────────────────────────────
async function stripeGet(secretKey, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { 'Authorization': `Bearer ${secretKey}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Stripe error: ${res.status}`);
  return json;
}

// ── Firebase JWT helper (same as create-portal.js) ───────────────────────
async function getFirebaseAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform'
  };

  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const body   = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const input  = `${header}.${body}`;

  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature  = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input));
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${input}.${sig}`
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}
