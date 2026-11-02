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
import type { ScanResult } from '../insforge';

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
 * and the DIY agent's built-in fallback ideas.
 */
export async function runCoordinatorAgent(
  imageBase64: string,
  manual?: ManualScanInput,
): Promise<CoordinatorResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const partialData: Partial<ScanResult> = {};

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
      partialData.detected_materials = manualMaterials.length > 0 ? manualMaterials : ['mixed plastic'];
      // Prefer the text actually read from the image; otherwise
      // keep the manual-entry note.
      partialData.label_text = manual?.label_text?.trim()
        ? manual.label_text.trim()
        : 'Entered manually (AI vision unavailable)';
    } else {
      // Step 1: Vision Agent
      console.log('Coordinator: Running Vision Agent...');
      const { result: visionResult, error: visionError } = await runVisionAgent(imageBase64);

      if (visionError || !visionResult) {
        errors.push(`Vision Agent failed: ${visionError?.message || 'Unknown error'}`);
        return {
          success: false,
          errors,
          executionTimeMs: Date.now() - startTime,
        };
      }

      partialData.product_name = visionResult.product_name;
      partialData.detected_materials = visionResult.detected_materials;
      partialData.label_text = visionResult.label_text;
      partialData.packaging_type = visionResult.packaging_type;
    }

    // Step 2 & 3: Run Research and DIY agents in PARALLEL for speed
    console.log('Coordinator: Running Research and DIY Agents in parallel...');
    
    const [researchResult, diyResult] = await Promise.all([
      runResearchAgent(partialData.detected_materials!, partialData.packaging_type!),
      runDIYAgent(partialData.packaging_type!, partialData.detected_materials!),
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

    // Process DIY Agent result. The DIY agent returns built-in fallback
    // ideas even when its AI call fails, so keep those ideas usable.
    if (diyResult.ideas && diyResult.ideas.length > 0) {
      partialData.diy_ideas = diyResult.ideas;
    }
    if (diyResult.error) {
      errors.push(`DIY Agent failed, using fallback ideas: ${diyResult.error.message || 'Unknown error'}`);
    } else if (!diyResult.ideas || diyResult.ideas.length === 0) {
      errors.push('DIY Agent failed: Unknown error');
    }

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
