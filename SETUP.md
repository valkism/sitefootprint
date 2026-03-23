# Footprint — Setup Guide

## What's New in This Version
- ✅ New SVG logo (location pin + signal waves)
- ✅ 3-day free trial (was 10 days)
- ✅ Google Maps API key field in Settings (optional, stored browser-side)
- ✅ Admin panel (hidden tab, visible only to admin email)
- ✅ Max-width layout — no more stretching on wide screens
- ✅ Instrument Serif font replacing Fraunces
- ✅ Stripe payment fully wired (see env vars below)

---

## 1. Stripe Setup

In your Stripe dashboard:
1. Create a product → recurring price at **$19.95/month**
2. Copy the `price_xxxx` ID
3. Create a webhook endpoint pointing to: `https://YOUR_DOMAIN/api/stripe-webhook`
   - Events to listen for:
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_succeeded`
     - `invoice.payment_failed`
4. Copy the webhook signing secret (`whsec_xxxx`)

---

## 2. Cloudflare Environment Variables

Set these in: **Cloudflare Dashboard → Pages → Your Project → Settings → Environment Variables**

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_xxxx` (or `sk_test_xxxx` for testing) |
| `STRIPE_PRICE_ID` | `price_xxxx` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxxx` |
| `FIREBASE_PROJECT_ID` | `footprint-eb752` |
| `FIREBASE_SERVICE_ACCOUNT` | *(full JSON of your Firebase service account key)* |
| `ALLOWED_ORIGIN` | `https://yourdomain.com` |
| `GEMINI_API_KEY` | `AIza...` — free key from aistudio.google.com (enables AI pitch generation, completely free) |

> **Firebase Service Account**: Go to Firebase Console → Project Settings → Service Accounts → Generate new private key. Paste the entire JSON as the value.

---

## 3. Admin Account

The admin panel is **only visible** to the account signed in with this email:

```
footprint.admin.9x7z@proton.me
```

**Admin password**: Set this yourself when you first create the account via the Sign Up page. The admin email is verified by SHA-256 hash comparison in the browser — it's never stored in plain text in the JS bundle.

> To change the admin email: compute `sha256(your_email.toLowerCase())` and replace the `ADMIN_EMAIL_HASH` constant in `app.html` near the bottom.

### What the admin can do:
- **Grant free subscription** — sets `plan: 'gifted'`, `subscriptionStatus: 'active'` for any user. They get full Pro access with no billing.
- **Revoke subscription** — sets `plan: 'free'`, `subscriptionStatus: 'cancelled'`. You'll also need to cancel in Stripe dashboard if they were paying.
- **Look up any user** by email — see their UID, plan, Stripe customer ID, trial end date.
- **View all users** — paginated list of up to 50 most recent users.

---

## 4. Firestore Security Rules

Add these rules in Firebase Console → Firestore → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users can read/write their own doc and subcollections
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      match /leads/{leadId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
      match /scans/{scanId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }

    // Community flags — any logged-in user can read and write
    // Used to collectively flag businesses that actually have websites
    // improving accuracy for all users
    match /community_flags/{flagId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null;
    }

    // Admin can read/write all users — replace ADMIN_UID_HERE
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == 'ADMIN_UID_HERE';
      match /leads/{leadId} {
        allow read: if request.auth != null && request.auth.uid == 'ADMIN_UID_HERE';
      }
    }
  }
}
```

> **Find your admin UID**: Sign in to the app with your admin email, open browser DevTools → Application → IndexedDB → firebaseLocalStorage → look for `uid`.

---

## 5. Google Maps API Key (Optional, per-user)

Users can add their own Google Places API key in **Settings → Google Maps API**. The key is:
- Stored in `localStorage` only (browser-side, never sent to your servers)
- Used to query Google Places alongside OpenStreetMap for richer business data
- Fully optional — OSM works without it

To get a key: [console.cloud.google.com](https://console.cloud.google.com) → Enable "Places API" → Create credentials → API Key → Restrict to your domain.

---

## 6. Deploy to Cloudflare Pages

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login
wrangler login

# Deploy
cd footprint-web
wrangler pages deploy . --project-name footprint
```

Or connect your GitHub repo in the Cloudflare Pages dashboard for auto-deploy on push.

