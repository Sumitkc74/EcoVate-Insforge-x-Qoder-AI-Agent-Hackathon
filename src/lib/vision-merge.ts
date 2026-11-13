/**
 * Vision merge: how the free vision answer and the on-device results
 * are combined.
 *
 * The free vision models sometimes answer with a generic word
 * ("Unknown", "plastic") even when the on-device check already found
 * something more specific (the label text, "PET plastic"). Vision stays
 * the authority when it is specific; the on-device results only fill in
 * where the vision answer is vague. A hint material replaces a vision
 * material only when it is a more specific version of it ("PET plastic"
 * for "plastic"), never to add materials vision did not see.
 *
 * Lives here (not in the coordinator) so both the coordinator and the
 * free-vision second opinion can use it without a circular import.
 */

export interface VisionRead {
  product_name: string;
  detected_materials: string[];
  label_text: string;
  packaging_type: string;
}

export interface VisionHints {
  product_name?: string;
  packaging_type?: string;
  detected_materials?: string[];
  label_text?: string;
}

// Below this confidence a vision read is worth a second opinion
// from the other free model.
export const SECOND_OPINION_CONFIDENCE = 0.5;

// A vision answer is vague when it says nothing useful: a placeholder
// name ("Unknown"), or a label note that just says nothing was found.
const VAGUE_NAMES = new Set([
  'unknown',
  'unlabeled',
  'unlabelled',
  'unidentified',
  'n/a',
  'na',
  'none',
  'product',
  'item',
  'packaging',
  'unknown product',
]);

export function isVagueName(name: string): boolean {
  return VAGUE_NAMES.has(name.trim().toLowerCase());
}

function isVagueLabel(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t === '' ||
    t === 'none' ||
    t === 'n/a' ||
    t === 'na' ||
    /no (visible )?(text|symbols?|labels?|writing) (detected|found)/.test(t)
  );
}

// True when a vision read is too vague (or too unsure) to trust
// on its own: a placeholder name/packaging, or low confidence.
export function isVagueVision(result: {
  product_name: string;
  packaging_type: string;
  confidence: number;
}): boolean {
  return (
    isVagueName(result.product_name) ||
    isVagueName(result.packaging_type) ||
    result.confidence < SECOND_OPINION_CONFIDENCE
  );
}

export function mergeVisionWithHints(
  vision: VisionRead,
  hints: VisionHints,
): VisionRead {
  const hintProduct = hints.product_name?.trim();
  const hintPackaging = hints.packaging_type?.trim();
  const hintMaterials = (hints.detected_materials || [])
    .map((m) => m.trim())
    .filter(Boolean);
  const hintLabel = hints.label_text?.trim();

  const product_name =
    isVagueName(vision.product_name) && hintProduct
      ? hintProduct
      : vision.product_name;
  const packaging_type =
    isVagueName(vision.packaging_type) && hintPackaging
      ? hintPackaging
      : vision.packaging_type;

  const detected_materials = [...vision.detected_materials];
  for (const hint of hintMaterials) {
    const lower = hint.toLowerCase();
    const idx = detected_materials.findIndex(
      (v) => lower.includes(v.toLowerCase()) && lower !== v.toLowerCase(),
    );
    if (idx >= 0) detected_materials[idx] = hint;
  }
  if (detected_materials.length === 0 && hintMaterials.length > 0) {
    detected_materials.push(...hintMaterials);
  }

  const label_text =
    isVagueLabel(vision.label_text) && hintLabel
      ? hintLabel
      : vision.label_text;

  return { product_name, detected_materials, label_text, packaging_type };
}
