/**
 * "Do it later" flow: choosing a DIY idea without finishing it yet.
 *
 * A scan's DIY state is derived from its user_actions:
 * - completed: a diy_completed action exists for the scan.
 * - pending: a verification was submitted (diy_pending), awaiting review.
 * - selected: a diy_selected action exists and nothing was submitted yet.
 * - failed: the last verification was rejected (diy_failed).
 * - none: no DIY action at all — just scanned.
 *
 * The selected action carries the chosen idea (project_title, plus
 * packaging_type / estimated_co2_saved when those columns exist), so
 * the dashboard and History can send the user straight to /verify to
 * upload the completion photo later. "Add DIY" for a scan with no
 * idea yet goes through /api/diy-ideas, which regenerates the ideas
 * for the stored scan and opens the results page on the DIY tab.
 */

import type { DIYIdea, ScanResult } from './insforge';

export interface DiyActionLike {
  id: string;
  scan_id: string | null;
  action_type: string;
  project_title?: string | null;
  packaging_type?: string | null;
  estimated_co2_saved?: number | null;
  created_at: string;
}

export interface DiyScanLike {
  id: string;
  product_name: string;
  materials: string[];
  carbon_footprint: number | null;
  recyclability_score: number | null;
  image_url: string | null;
}

export type ScanDiyStatus = 'completed' | 'pending' | 'selected' | 'failed' | 'none';

export interface ScanDiyState {
  status: ScanDiyStatus;
  // Latest diy_selected action for the scan, if any (the chosen idea).
  selectedAction?: DiyActionLike;
  // Latest diy_failed action, for a retry.
  failedAction?: DiyActionLike;
}

function latestByCreatedAt(actions: DiyActionLike[]): DiyActionLike | undefined {
  return [...actions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];
}

export function getScanDiyState(scanId: string, actions: DiyActionLike[]): ScanDiyState {
  const scanActions = actions.filter((a) => a.scan_id === scanId);
  const has = (type: string) => scanActions.some((a) => a.action_type === type);
  const selected = latestByCreatedAt(
    scanActions.filter((a) => a.action_type === 'diy_selected'),
  );
  const failed = latestByCreatedAt(
    scanActions.filter((a) => a.action_type === 'diy_failed'),
  );
  if (has('diy_completed')) return { status: 'completed', selectedAction: selected };
  if (has('diy_pending')) return { status: 'pending', selectedAction: selected };
  if (selected) return { status: 'selected', selectedAction: selected, failedAction: failed };
  if (failed) return { status: 'failed', failedAction: failed };
  return { status: 'none' };
}

// Verify needs all four; the stored selection has them when the
// columns exist, otherwise the generic defaults apply.
export function buildVerifyUrl(args: {
  scanId: string;
  projectTitle: string;
  packagingType?: string | null;
  estimatedCo2Saved?: number | null;
}): string {
  const params = new URLSearchParams({
    scanId: args.scanId,
    projectTitle: args.projectTitle,
    packagingType: args.packagingType || 'packaging',
    estimatedCo2Saved: String(args.estimatedCo2Saved ?? 0.5),
  });
  return `/verify?${params.toString()}`;
}

// "Add DIY" for a scan with no idea yet: fetch fresh ideas for the
// stored scan and open the results page on the DIY tab.
export async function openAddDiy(
  router: { push: (url: string) => void },
  scan: DiyScanLike,
  userId: string,
): Promise<void> {
  const response = await fetch(`/api/diy-ideas?scanId=${encodeURIComponent(scan.id)}&userId=${encodeURIComponent(userId)}`);
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Could not load DIY ideas for this scan');
  }
  const scanData: ScanResult = {
    product_name: scan.product_name,
    detected_materials: scan.materials || [],
    label_text: '',
    packaging_type: result.packagingType || 'container',
    carbon_footprint_kg: scan.carbon_footprint ?? 0,
    recyclability_score: scan.recyclability_score ?? 0,
    material_breakdown: [],
    diy_ideas: (result.diyIdeas || []) as DIYIdea[],
  };
  const params = new URLSearchParams({
    scanId: scan.id,
    data: JSON.stringify(scanData),
    tab: 'diy',
  });
  router.push(`/results?${params.toString()}`);
}
