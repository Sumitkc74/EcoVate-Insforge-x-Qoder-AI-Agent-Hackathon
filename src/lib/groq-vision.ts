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
