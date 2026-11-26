/**
 * Coordinator Agent
 * 
 * Orchestrates the 3 sub-agents in sequence:
 * Vision Agent → Research Agent → DIY Agent
 * Returns aggregated results with error handling.
 */

import { runVisionAgent } from './vision-agent';
import { runResearchAgent } from './research-agent';
import { runDIYAgent } from './diy-agent';
import { mergeVisionWithHints } from '../vision-merge';
import type { ScanResult } from '../supabase';

export interface CoordinatorResult {
  success: boolean;
  data?: ScanResult;
  partialData?: Partial<ScanResult>;
  errors: string[];
  executionTimeMs: number;
}

export interface ManualScanInput {
  product_name?: string;
  packaging_type?: string;
  detected_materials?: string[];
  // Text read from the image by the free on-device OCR step.
  label_text?: string;
}

/**
 * Free-plan fallback: when the caller supplies a product name and a
 * packaging type, Vision AI is skipped entirely. This keeps scans working
 * on backends where the Insforge AI gateway is unavailable (for example,
 * gated behind a paid plan), using only the deterministic research agent
 * and the DIY agent. The DIY agent has no fallback ideas of its own:
 * if both AI models fail, the scan stops (see below) instead of
 * showing generic template ideas.
 */

// User-facing message when the DIY ideas cannot be generated
// because the AI is unavailable. The technical error goes to the
// server log only — the user sees this, and the scan stops.
const DIY_UNAVAILABLE_MESSAGE =
  "Our AI is unavailable right now, so we can't create DIY ideas for this photo. Please try again later.";
export async function runCoordinatorAgent(
  imageBase64: string,
  manual?: ManualScanInput,
  // Epoch ms by which the whole scan should be done (the scan route
  // sets it ~50s out, inside the 60s function limit). Without it the
  // steps' timeouts added up to ~145s and Vercel killed the scan
  // mid-flight. Vision and DIY clamp their attempts to it.
  deadlineMs?: number,
): Promise<CoordinatorResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const partialData: Partial<ScanResult> = {};
  // True when the material was never determined and the 'mixed
  // plastic' default was substituted (or nothing was found): the
  // results page says so instead of presenting the fallback as a
  // confident reading.
  let materialUnknown = false;

  try {
    const manualProduct = manual?.product_name?.trim();
    const manualPackaging = manual?.packaging_type?.trim();
    const manualMaterials = (manual?.detected_materials || [])
      .map((m) => m.trim())
      .filter(Boolean);

    if (manualProduct && manualPackaging) {
      console.log('Coordinator: Skipping Vision Agent, using manual details...');
      partialData.product_name = manualProduct;
      partialData.packaging_type = manualPackaging;
      if (manualMaterials.length > 0) {
        partialData.detected_materials = manualMaterials;
      } else {
        partialData.detected_materials = ['mixed plastic'];
        materialUnknown = true;
      }
      // Prefer the text actually read from the image; otherwise
      // keep the manual-entry note.
      partialData.label_text = manual?.label_text?.trim()
        ? manual.label_text.trim()
        : 'Entered manually (AI vision unavailable)';
    } else {
      // Step 1: Vision Agent
      console.log('Coordinator: Running Vision Agent...');
      const { result: visionResult, error: visionError } = await runVisionAgent(imageBase64, deadlineMs);

      if (visionError || !visionResult) {
        // Vision is down, but the scan does not have to fail: the
        // on-device results (label text, detected shape, material
        // guess) the caller sent as hints can still build a usable
        // scan. Only fail outright when there are no hints at all.
        const hasHints =
          manualProduct ||
          manualPackaging ||
          manualMaterials.length > 0 ||
          manual?.label_text?.trim();
        if (!hasHints) {
          errors.push(`Vision Agent failed: ${visionError?.message || 'Unknown error'}`);
          return {
            success: false,
            errors,
            executionTimeMs: Date.now() - startTime,
          };
        }
        errors.push(
          `Vision Agent failed (${visionError?.message || 'Unknown error'}), using on-device results instead.`,
        );
        partialData.product_name = manualProduct || 'Unknown';
        partialData.packaging_type = manualPackaging || 'unknown';
        if (manualMaterials.length > 0) {
          partialData.detected_materials = manualMaterials;
        } else {
          partialData.detected_materials = ['mixed plastic'];
          materialUnknown = true;
        }
        partialData.label_text = manual?.label_text?.trim()
          ? manual.label_text.trim()
          : 'Read on-device (AI vision unavailable)';
      } else {
        // Vision stays the authority when it is specific; the
        // on-device results only fill in where its answer is vague
        // ("Unknown", just "plastic").
        const merged = mergeVisionWithHints(visionResult, {
          product_name: manualProduct,
          packaging_type: manualPackaging,
          detected_materials: manualMaterials,
          label_text: manual?.label_text,
        });
        partialData.product_name = merged.product_name;
        partialData.detected_materials = merged.detected_materials;
        partialData.label_text = merged.label_text;
        partialData.packaging_type = merged.packaging_type;
        materialUnknown = merged.detected_materials.length === 0;
      }
    }

    // A material that is only the generic 'mixed plastic' default
    // is not a determination either: the warning under-reported
    // before, because material_unknown was only set when the list
    // was empty. A genuinely mixed item still scores as an estimate,
    // which is what the warning says.
    partialData.material_unknown =
      materialUnknown ||
      (partialData.detected_materials?.length === 1 &&
        partialData.detected_materials[0].toLowerCase() === 'mixed plastic');

    // Step 2 & 3: Run Research and DIY agents in PARALLEL for speed
    console.log('Coordinator: Running Research and DIY Agents in parallel...');
    
    const [researchResult, diyResult] = await Promise.all([
      runResearchAgent(partialData.detected_materials!, partialData.packaging_type!),
      runDIYAgent(partialData.packaging_type!, partialData.detected_materials!, deadlineMs),
    ]);

    // Process Research Agent result
    if (researchResult.error || !researchResult.result) {
      errors.push(`Research Agent failed: ${researchResult.error?.message || 'Unknown error'}`);
    } else {
      partialData.carbon_footprint_kg = researchResult.result.carbon_footprint_kg;
      partialData.recyclability_score = researchResult.result.recyclability_score;
      partialData.material_breakdown = researchResult.result.material_breakdown.map(m => ({
        material: m.material,
        percentage: m.percentage,
      }));
    }

    // Process DIY Agent result. The DIY agent has no fallback
    // ideas: when its AI calls fail, the whole scan fails instead
    // of showing generic template ideas. The project is AI-driven,
    // so a scan with no AI-made ideas is not a scan at all. The
    // technical error stays in the server log; the user sees only
    // the plain message below, and the scan route returns it as a
    // 500 the scan page shows with a Try again button.
    if (diyResult.error || !diyResult.ideas || diyResult.ideas.length === 0) {
      if (diyResult.error) {
        console.error('DIY Agent failed:', diyResult.error);
      }
      if (errors.length > 0) {
        // A research failure too: keep it in the server log even
        // though the user only sees the DIY message.
        console.error('Coordinator: other scan errors:', errors);
      }
      return {
        success: false,
        errors: [DIY_UNAVAILABLE_MESSAGE],
        executionTimeMs: Date.now() - startTime,
      };
    }
    partialData.diy_ideas = diyResult.ideas;

    const executionTimeMs = Date.now() - startTime;

    // Check if we have enough data to return success
    const hasMinimumData = partialData.product_name && partialData.packaging_type;
    
    if (hasMinimumData) {
      return {
        success: errors.length === 0,
        data: partialData as ScanResult,
        partialData: errors.length > 0 ? partialData : undefined,
        errors,
        executionTimeMs,
      };
    } else {
      return {
        success: false,
        partialData,
        errors: [...errors, 'Insufficient data collected'],
        executionTimeMs,
      };
    }
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;
    errors.push(`Coordinator error: ${(error as Error).message}`);
    
    return {
      success: false,
      partialData: Object.keys(partialData).length > 0 ? partialData : undefined,
      errors,
      executionTimeMs,
    };
  }
}
