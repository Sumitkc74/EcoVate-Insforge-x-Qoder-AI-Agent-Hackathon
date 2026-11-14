import { NextRequest, NextResponse } from 'next/server';
import { guessMaterialWithGroq } from '@/lib/groq-vision';
import { serverDb } from '@/lib/insforge';
import { requireUser, overAttemptCap, logAttempt, unauthorizedResponse } from '@/lib/server-auth';

// Two free attempts must fit inside the free-plan function
// limit of 60s, so each gets 25s: Gemini first, then Groq.
export const maxDuration = 60;

// Gemini free-tier material guess. The key lives only in the
// server environment (GEMINI_API_KEY, set in Vercel), never in
// the browser code and never in the repo. Without a key this
// route says so plainly instead of failing silently, so the
// button can tell the user what setup is still missing.
const MODEL = 'gemini-3.8-flash';
const MATERIALS = [
  'glass',
  'PET plastic',
  'HDPE plastic',
  'aluminum',
  'steel',
  'cardboard',
  'paper',
  'mixed plastic',
] as const;

export async function GET() {
  return NextResponse.json({ ok: true, configured: Boolean(process.env.GEMINI_API_KEY), groqConfigured: Boolean(process.env.GROQ_API_KEY) });
}

export async function POST(request: NextRequest) {
  // Every guess burns AI quota, so anonymous calls are not allowed:
  // the caller must have a valid session.
  const user = await requireUser(request);
  if (!user) return unauthorizedResponse();
  const userId = user.id;

  // Daily cap on guesses: 30/day signed in, 10/day for guests.
  // The scan page calls this on every photo whose material is
  // unknown, so without a cap a guest could burn the Gemini/Groq
  // quota with repeated guesses and never scan once. Guests get
  // more guesses than scans (10 vs 2) because retaking a photo or
  // comparing items is normal use — the cap bounds abuse, not that.
  const guessCap = user.isAnonymous ? 10 : 30;
  if (await overAttemptCap(userId, 'material_guess', 'user_actions', ['material_guess'], guessCap)) {
    return NextResponse.json(
      {
        success: false,
        error: user.isAnonymous
          ? 'Daily material-guess limit reached (10 for guest accounts). Sign in with Google for 30 a day.'
          : 'Daily material-guess limit reached (30). Try again tomorrow.',
      },
      { status: 429 },
    );
  }

  let body: { image?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const dataUrl = body.image || '';
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return NextResponse.json({ error: 'No image supplied' }, { status: 400 });
  }
  const [, mimeType, base64] = match;

  // Log the attempt in the attempt table too, so the cap counts
  // attempts even if the user_actions row below is ever deleted
  // (delete-all-projects removes every action row). The user_actions
  // row stays as well: it is the fallback the cap counts until the
  // one-time SQL creates usage_attempts.
  await logAttempt(userId, 'material_guess');

  // Log the attempt so the cap above can count it. The row carries
  // no points and no scan, and History filters by action type, so
  // it never shows up as a project. The 'material_guess' type needs
  // the one-time SQL widening the user_actions check constraint —
  // until that is run the insert fails and is logged here, and the
  // guess still works (the cap just cannot be enforced yet).
  const { error: logError } = await serverDb.from('user_actions').insert([{
    user_id: userId,
    action_type: 'material_guess',
    impact_score: 0,
  }]);
  if (logError) {
    console.error('Material-guess log error (cap unenforced until the check constraint allows material_guess):', logError);
  }

  // No Gemini key: Groq alone is still a valid attempt.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const groqMaterial = await guessMaterialWithGroq(dataUrl, MATERIALS);
    if (groqMaterial) {
      return NextResponse.json({
        material: groqMaterial,
        raw: groqMaterial,
        source: 'groq',
        note: 'This is a model guess from appearance only — please confirm it before Analyze.',
      });
    }
    return NextResponse.json(
      { error: 'No material-guess model is set up yet. Add a GEMINI_API_KEY or GROQ_API_KEY in Vercel (Production) to enable this guess.' },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: 'Look at this product packaging photo. Guess the single most likely material of the main packaging, choosing only from: glass, PET plastic, HDPE plastic, aluminum, steel, cardboard, paper, mixed plastic. Reply with ONLY the material name, then a short reason in parentheses, for example "PET plastic (clear thin-walled bottle)". If you cannot tell from appearance alone, reply "unknown".',
                },
                { inlineData: { mimeType, data: base64 } },
              ],
            },
          ],
          // Deterministic: the same photo must give the same material
          // every time. The default temperature samples randomly, so
          // one photo read PET on one run and mixed plastic on the
          // next — and the recyclability score follows the material,
          // so the whole result flipped with it. Temperature 0 makes
          // the guess consistent; it does not make it right, so the
          // confirm-before-Analyze step stays the safety net.
          generationConfig: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(25000),
      },
    );

    if (response.status === 429) {
      return NextResponse.json(
        { error: 'Gemini free-tier quota reached. Try again later, or enter the material yourself.' },
        { status: 429 },
      );
    }
    if (!response.ok) {
      const groqMaterial = await guessMaterialWithGroq(dataUrl, MATERIALS);
      if (groqMaterial) {
        return NextResponse.json({
          material: groqMaterial,
          raw: groqMaterial,
          source: 'groq',
          note: 'Gemini was unavailable, so this guess comes from Groq instead. It is a model guess from appearance only — please confirm it before Analyze.',
        });
      }
      // Diagnostic: surface Gemini's own status and error message
      // (never the API key) so a failed guess can actually be
      // debugged from the page instead of hiding behind a generic
      // message. The body is capped to keep the response small.
      let detail = '';
      try {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text);
          detail = parsed?.error?.message || '';
        } catch {
          detail = text;
        }
      } catch {
        detail = '';
      }
      return NextResponse.json(
        {
          error: 'Gemini could not guess the material. Enter it yourself instead.',
          geminiStatus: response.status,
          geminiDetail: detail.slice(0, 300),
        },
        { status: 502 },
      );
    }

    const json = await response.json();
    const raw: string =
      json?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || '')
        .join(' ')
        .trim() || '';
    const lower = raw.toLowerCase();
    const material = MATERIALS.find((m) => lower.startsWith(m.toLowerCase())) || null;
    if (!material) {
      const groqMaterial = await guessMaterialWithGroq(dataUrl, MATERIALS);
      if (groqMaterial) {
        return NextResponse.json({
          material: groqMaterial,
          raw: groqMaterial,
          source: 'groq',
          note: 'Gemini could not tell the material, so this guess comes from Groq instead. It is a model guess from appearance only — please confirm it before Analyze.',
        });
      }
    }
    return NextResponse.json({
      material,
      raw,
      source: 'gemini',
      note: 'This is a model guess from appearance only — please confirm it before Analyze.',
    });
  } catch (err) {
    console.error('Material guess error:', err);
    const groqMaterial = await guessMaterialWithGroq(dataUrl, MATERIALS);
    if (groqMaterial) {
      return NextResponse.json({
        material: groqMaterial,
        raw: groqMaterial,
        source: 'groq',
        note: 'Gemini was unavailable, so this guess comes from Groq instead. It is a model guess from appearance only — please confirm it before Analyze.',
      });
    }
    return NextResponse.json(
      {
        error: 'Gemini could not guess the material. Enter it yourself instead.',
        geminiDetail: String((err as Error).message || err).slice(0, 300),
      },
      { status: 502 },
    );
  }
}
