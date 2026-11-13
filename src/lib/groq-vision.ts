/**
 * Groq free-tier vision fallback (second attempt after Gemini).
 *
 * The model ID lives in GROQ_VISION_MODEL, not hard-coded, because
 * Groq has renamed its vision model repeatedly (Llama 4 Scout, then
 * Qwen 3.6, then Qwen 3.8). If the model 404s in future, changing
 * the env var in Vercel is enough — no code change needed.
 * Default: the model Groq's own vision docs list as of Nov 2026.
 */

const GROQ_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

async function callGroqVision(prompt: string, imageDataUrl: string): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 300,
        temperature: 0.2,
      }),
    });
    if (!response.ok) return null;
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content || '';
    const match = typeof content === 'string' ? content.match(/\{[\s\S]*\}/) : null;
    if (!match) return null;
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch (err) {
    console.error('Groq vision error:', err);
    return null;
  }
}

export async function guessMaterialWithGroq(
  imageDataUrl: string,
  materials: readonly string[],
): Promise<string | null> {
  const parsed = await callGroqVision(
    `Look at this product packaging photo. Guess the single most likely material of the main packaging, choosing only from: ${materials.join(', ')}. Reply with a JSON object only: {"material": "<one of the list, or unknown>", "reason": "<short reason>"}.`,
    imageDataUrl,
  );
  if (!parsed) return null;
  const rawMaterial = parsed.material;
  if (typeof rawMaterial !== 'string') return null;
  const found = materials.find((m) => m.toLowerCase() === rawMaterial.toLowerCase());
  return found || null;
}

// Full packaging read (product name, materials, label text,
// packaging type) for the Vision Agent. Returns the raw parsed
// object, or null when Groq is unavailable or the reply is unusable;
// the caller in free-vision.ts validates and normalizes it.
export async function analyzePackagingWithGroq(
  imageDataUrl: string,
): Promise<Record<string, unknown> | null> {
  return callGroqVision(
    `Analyze this product packaging image and extract the following information:

1. Product name (as shown on packaging)
2. Detected materials (list all materials visible: plastic, glass, paper, metal, cardboard, etc.)
3. Label text (any recycling symbols, material codes, or environmental claims)
4. Packaging type (bottle, box, bag, jar, can, wrapper, etc.)

Respond ONLY with a JSON object in this exact format:
{
  "product_name": "string",
  "detected_materials": ["material1", "material2"],
  "label_text": "string with any text found",
  "packaging_type": "string",
  "confidence": number between 0-1
}

If any information is unclear, make your best estimate and set confidence accordingly.`,
    imageDataUrl,
  );
}

// Recheck for the scan page: do the user-entered details actually
// match the photo? Returns null when Groq is unavailable or the reply
// is unusable; the caller in detail-check.ts treats that as "no
// verdict" and lets the scan proceed.
export async function checkDetailsWithGroq(
  imageDataUrl: string,
  productName: string,
  packagingType: string,
  materials: readonly string[],
): Promise<{ matches: boolean; confidence: number; observed: string; reason: string } | null> {
  const parsed = await callGroqVision(
    `You are checking whether user-entered details match a product packaging photo. The user says this photo shows: product name "${productName}", packaging type "${packagingType}", materials "${materials.join(', ') || 'not given'}". Look at the photo. Does it actually show that product and packaging type? Be fair: different brands, angles, and lighting still count as a match if the product and packaging type are right. Reply with a JSON object only: {"matches": true or false, "confidence": number between 0 and 1, "observed": "briefly, what the photo actually shows", "reason": "brief explanation"}.`,
    imageDataUrl,
  );
  if (!parsed || typeof parsed.matches !== 'boolean') return null;
  return {
    matches: parsed.matches,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    observed: typeof parsed.observed === 'string' ? parsed.observed : '',
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

export async function verifyWithGroq(
  imageDataUrl: string,
  packagingType: string,
  projectTitle: string,
): Promise<{ verified: boolean; confidence: number; feedback: string } | null> {
  const parsed = await callGroqVision(
    `You are evaluating a DIY upcycling project verification photo. Expected project: a DIY project made from a "${packagingType}", titled "${projectTitle}". Does this image show a completed DIY upcycling project using that packaging? Be fair but accurate. Reply with a JSON object only: {"verified": true or false, "confidence": number between 0 and 1, "feedback": "brief explanation"}.`,
    imageDataUrl,
  );
  if (!parsed) return null;
  return {
    verified: Boolean(parsed.verified),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    feedback: String(parsed.feedback || 'No feedback provided'),
  };
}
