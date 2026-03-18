// functions/api/generate-pitch.js
// Cloudflare Pages Function — AI Pitch Generator using Google Gemini (FREE tier)
//
// Gemini Flash free tier: 15 requests/min, 1M tokens/day — no cost, no credit card.
// Even with hundreds of active users this will never be exceeded.
//
// Setup (takes 2 minutes):
//   1. Go to aistudio.google.com
//   2. Click "Get API key" → "Create API key"
//   3. In Cloudflare Dashboard → Pages → Your Project → Settings → Environment Variables:
//      Add:  GEMINI_API_KEY = AIza...your key here

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'GEMINI_API_KEY not set in Cloudflare environment variables. Get a free key at aistudio.google.com.',
      text: null
    }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const { prompt } = body;
  if (!prompt || typeof prompt !== 'string' || prompt.length > 2000) {
    return new Response(JSON.stringify({ error: 'Invalid prompt' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    // Gemini 2.0 Flash — fastest, most capable free model
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.7,
        }
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Gemini error:', resp.status, errText);

      // Handle rate limit gracefully
      if (resp.status === 429) {
        return new Response(JSON.stringify({
          error: 'Rate limit reached — try again in a moment.',
          text: null
        }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        error: 'AI generation failed. Check your GEMINI_API_KEY is correct.',
        text: null
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const data = await resp.json();

    // Extract text from Gemini response structure
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    if (!text) {
      return new Response(JSON.stringify({
        error: 'Empty response from Gemini.',
        text: null
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ text, error: null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Pitch generation error:', err);
    return new Response(JSON.stringify({ error: err.message, text: null }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
