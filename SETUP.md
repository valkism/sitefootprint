# Footprint Web — Setup Guide (Cloudflare Pages)

## IMPORTANT — Cloudflare build settings

When connecting your GitHub repo in Cloudflare Pages, use these exact settings:

  Framework preset:       None
  Build command:          (leave completely empty)
  Build output directory: /
  Root directory:         /

Do NOT let Cloudflare auto-detect the build — leave the build command blank.
This is a static site with Pages Functions, no build step needed.

---

## Testing locally

Drag any .html file straight into Chrome. Scan and CRM work immediately
since all OSM calls go directly from your browser. Auth and billing need
the full setup below.

---

## Step 1 — Firebase (15 min)

1. https://console.firebase.google.com → New project
2. Authentication → Sign-in method → Enable Email/Password + Google
3. Firestore → Create database → Production mode → pick a region
4. Firestore Security Rules:

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
         match /leads/{leadId} {
           allow read, write: if request.auth != null && request.auth.uid == userId;
         }
       }
     }
   }

5. Project Settings → Add app (Web) → copy firebaseConfig
   → paste into login.html AND app.html (6 YOUR_... values each)
6. Project Settings → Service accounts → Generate new private key → download JSON
7. Note your Project ID

---

## Step 2 — Stripe (10 min)

Stay in Test Mode until everything works.

1. https://dashboard.stripe.com → Products → Add product
   Name: Footprint Pro, Price: $19.95/month recurring
   Copy the Price ID (price_...)
2. Developers → API keys:
   - Publishable key (pk_test_...) → paste into login.html
   - Secret key (sk_test_...) → goes into Cloudflare env vars

---

## Step 3 — Deploy to Cloudflare Pages

1. Push this folder to a GitHub repo (private is fine)
2. https://pages.cloudflare.com → Create project → Connect to Git
3. Build settings — CRITICAL, use exactly these:
   - Framework preset: None
   - Build command: (empty — delete anything in this field)
   - Build output directory: /
4. Environment variables → Add all of these:

   STRIPE_SECRET_KEY        = sk_test_xxxx
   STRIPE_WEBHOOK_SECRET    = whsec_xxxx   (add after step 4)
   STRIPE_PRICE_ID          = price_xxxx
   FIREBASE_PROJECT_ID      = your-project-id
   FIREBASE_SERVICE_ACCOUNT = (entire service account JSON as one line)
   ALLOWED_ORIGIN           = https://your-site.pages.dev

5. Save and Deploy

---

## Step 4 — Stripe Webhook (after deploying)

1. Stripe → Developers → Webhooks → Add endpoint
   URL: https://your-project.pages.dev/api/stripe-webhook
2. Events to select:
   customer.subscription.created
   customer.subscription.updated
   customer.subscription.deleted
   invoice.payment_succeeded
   invoice.payment_failed
3. Copy Signing secret (whsec_...) → add to Cloudflare env vars
   as STRIPE_WEBHOOK_SECRET → redeploy

---

## Step 5 — Test

Test card: 4242 4242 4242 4242, any future date, any CVV.
Sign up → complete checkout → Firestore should show subscriptionStatus = trialing.

Switch to Live Mode in Stripe when ready, update keys in Cloudflare.

---

## File structure

  index.html                  Homepage
  login.html                  Auth
  app.html                    Full Footprint app
  wrangler.toml               Tells Cloudflare this is a Pages project
  .gitignore                  Keeps node_modules out of the repo
  functions/
    api/
      create-checkout.js      POST /api/create-checkout
      create-portal.js        POST /api/create-portal
      stripe-webhook.js       POST /api/stripe-webhook
