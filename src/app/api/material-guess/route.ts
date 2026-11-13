import { NextRequest, NextResponse } from 'next/server';
import { guessMaterialWithGroq } from '@/lib/groq-vision';
import { requireUser, unauthorizedResponse } from '@/lib/server-auth';

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
  // the caller must have a valid session. (No service key needed
  // here — this route never touches the database.)
  const user = await requireUser(request);
  if (!user) return unauthorizedResponse();

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
