import { NextResponse } from 'next/server';

// Gemini free-tier material guess. The key lives only in the
// server environment (GEMINI_API_KEY, set in Vercel), never in
// the browser code and never in the repo. Without a key this
// route says so plainly instead of failing silently, so the
// button can tell the user what setup is still missing.
const MODEL = 'gemini-2.5-flash';
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
  return NextResponse.json({ ok: true, configured: Boolean(process.env.GEMINI_API_KEY) });
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Gemini is not set up yet. Add a GEMINI_API_KEY in Vercel (Production) to enable this guess.' },
      { status: 503 },
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
        signal: AbortSignal.timeout(30000),
      },
    );

    if (response.status === 429) {
      return NextResponse.json(
        { error: 'Gemini free-tier quota reached. Try again later, or enter the material yourself.' },
        { status: 429 },
      );
    }
    if (!response.ok) {
      return NextResponse.json({ error: 'Gemini could not guess the material. Enter it yourself instead.' }, { status: 502 });
    }

    const json = await response.json();
    const raw: string =
      json?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || '')
        .join(' ')
        .trim() || '';
    const lower = raw.toLowerCase();
    const material = MATERIALS.find((m) => lower.startsWith(m.toLowerCase())) || null;
    return NextResponse.json({
      material,
      raw,
      note: 'This is a model guess from appearance only — please confirm it before Analyze.',
    });
  } catch (err) {
    console.error('Material guess error:', err);
    return NextResponse.json({ error: 'Gemini could not guess the material. Enter it yourself instead.' }, { status: 502 });
  }
}
