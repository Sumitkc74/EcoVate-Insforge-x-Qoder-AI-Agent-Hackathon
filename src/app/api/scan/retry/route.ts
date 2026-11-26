/**
 * POST /api/scan/retry
 *
 * Retry a failed scan from History: re-run the analysis on the SAME
 * stored photo, no re-upload. Only a scan recorded with scan_error
 * (the coordinator-failure 500 in /api/scan) can be retried here.
 *
 * - The photo is read straight from storage (service key), never
 *   through its URL — the stored URL is a signed proxy link.
 * - The retry counts as a fresh scan attempt (new cap row): the
 *   original failed attempt was refunded when it failed, so a
 *   retry that fails is refunded the same way and costs nothing.
 * - On success the failed row becomes a normal scan in place (same
 *   id, scan_error cleared, results stored, created_at moved to
 *   now so it surfaces as a fresh scan) and a 'scanned' action is
 *   logged, exactly as a fresh scan would. The response has the
 *   same shape as POST /api/scan, so the caller can open the
 *   results page the same way.
 * - On failure the row stays failed with the new error message.
 * - A failed scan whose photo was never saved (no image_url) cannot
 *   be retried: the caller must send the user back to the scan page
 *   to re-upload instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runCoordinatorAgent } from '@/lib/agents';
import { serverDb, serverStorage } from '@/lib/supabase';
import { storageKeyFromUrl, imageUrlForDisplay } from '@/lib/storage';
import {
  assertServiceKey,
  requireUser,
  overAttemptCap,
  claimAttemptWithId,
  refundAttempt,
  guestPoolUsed,
  GUEST_DAILY_POOL,
  GUEST_POOL_MESSAGE,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

// Research figures are estimates: when the research step failed
// there is no figure at all, and storing 0 presented a fabricated
// "0 kg / 0%" as a measured result. Null means unavailable.
function researchValue(value: number | null | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

export async function POST(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const body = await request.json().catch(() => null);
    const scanId = body?.scanId as string | undefined;
    if (!scanId || typeof scanId !== 'string') {
      return NextResponse.json({ error: 'Missing required field: scanId' }, { status: 400 });
    }
    if (scanId.startsWith('temp_')) {
      return NextResponse.json(
        { error: 'This scan was not saved, so it cannot be retried. Please scan again.' },
        { status: 400 },
      );
    }

    const { data: scan } = await serverDb
      .from('scans')
      .select('*')
      .eq('id', scanId)
      .single();
    if (!scan) {
      return NextResponse.json({ error: 'Scan not found. Please scan again.' }, { status: 404 });
    }
    if ((scan as { user_id: string }).user_id !== userId) {
      return NextResponse.json({ error: 'Not your scan' }, { status: 403 });
    }
    // Only a recorded failure can be retried: a scan that already
    // has results is not a failed scan, and re-running it here
    // would mint a second scan on the same row.
    const scanError = (scan as { scan_error?: string | null }).scan_error;
    if (!scanError) {
      return NextResponse.json(
        { error: 'This scan did not fail, so there is nothing to retry.' },
        { status: 400 },
      );
    }
    // Without the stored photo there is nothing to re-analyse: the
    // upload itself failed on the original attempt, so the row says
    // so and the user re-uploads from the scan page instead.
    const imageUrl = (scan as { image_url?: string | null }).image_url;
    if (!imageUrl) {
      return NextResponse.json(
        {
          error: "The photo wasn't saved with this scan, so it can't be retried. Please scan again from the Scan page.",
          photoMissing: true,
        },
        { status: 400 },
      );
    }

    // The retry is a fresh attempt: same caps as a new scan, same
    // shared guest pool. The original failed attempt was already
    // refunded, so this is the only row the retry can cost.
    const scanCap = user.isAnonymous ? 2 : 30;
    if (await overAttemptCap(userId, 'scan', 'scans', null, scanCap)) {
      return NextResponse.json(
        {
          success: false,
          error: user.isAnonymous
            ? 'Daily scan limit reached (2 for guest accounts). Sign in with Google for 30 a day.'
            : 'Daily scan limit reached (30). Try again tomorrow.',
        },
        { status: 429 },
      );
    }
    if (user.isAnonymous && (await guestPoolUsed()) >= GUEST_DAILY_POOL) {
      return NextResponse.json(
        { success: false, error: GUEST_POOL_MESSAGE },
        { status: 429 },
      );
    }
    const claim = await claimAttemptWithId(userId, 'scan', 'scans', null, scanCap);
    if (claim.overCap) {
      return NextResponse.json(
        {
          success: false,
          error: user.isAnonymous
            ? 'Daily scan limit reached (2 for guest accounts). Sign in with Google for 30 a day.'
            : 'Daily scan limit reached (30). Try again tomorrow.',
        },
        { status: 429 },
      );
    }

    // Read the stored photo back from storage for the coordinator.
    // A missing or unreadable photo refunds the claim: the attempt
    // produced nothing, and the row keeps its old error.
    const key = storageKeyFromUrl(imageUrl);
    let base64Image: string | null = null;
    try {
      const { data: blob, error: dlError } = key
        ? await serverStorage.from('user-uploads').download(key)
        : { data: null, error: new Error('No storage key') };
      if (!dlError && blob) {
        const contentType = blob.type || 'image/jpeg';
        const buffer = Buffer.from(await blob.arrayBuffer());
        base64Image = `data:${contentType};base64,${buffer.toString('base64')}`;
      }
    } catch (e) {
      console.error('Scan retry: could not read stored photo:', e);
    }
    if (!base64Image) {
      await refundAttempt(claim.attemptId, userId);
      return NextResponse.json(
        {
          success: false,
          error: "The saved photo could not be read, so the scan can't be retried. Please scan again from the Scan page.",
        },
        { status: 500 },
      );
    }

    // The original attempt already passed the detail-mismatch
    // recheck (it runs before the claim, and the failure came
    // after it), so the retry does not re-run it. Manual details
    // are only on the row when the original scan ran on them
    // (packaging_type is set from manual input only); pass them
    // back so a manual scan retries as a manual scan, not as a
    // vision scan that could read something different.
    const manualPackaging = (scan as { packaging_type?: string | null }).packaging_type;
    const manual = manualPackaging
      ? {
          product_name: (scan as { product_name?: string }).product_name,
          packaging_type: manualPackaging,
          detected_materials: Array.isArray((scan as { materials?: unknown }).materials)
            ? ((scan as { materials: string[] }).materials)
            : [],
          label_text: (scan as { label_text?: string | null }).label_text || undefined,
        }
      : undefined;

    const deadlineMs = Date.now() + 50000;
    const coordinatorResult = await runCoordinatorAgent(base64Image, manual, deadlineMs);

    const visionFallback = coordinatorResult.errors.some((e) =>
      e.includes('using on-device results'),
    )
      ? 'AI vision was unavailable for this scan, so it was built from the on-device reading instead. Double-check the details.'
      : null;

    if (!coordinatorResult.success && !coordinatorResult.data) {
      // Still failing: refund the retry's claim and keep the row
      // failed, with the new error replacing the old one so History
      // always shows what the latest attempt did.
      await refundAttempt(claim.attemptId, userId);
      const retryError = coordinatorResult.errors.join('; ') || 'Scan failed';
      const { error: updateError } = await serverDb
        .from('scans')
        .update({ scan_error: retryError })
        .eq('id', scanId)
        .eq('user_id', userId);
      if (updateError) console.error('Scan retry: could not update failed row:', updateError);
      return NextResponse.json({
        success: false,
        error: retryError,
        errors: coordinatorResult.errors,
        executionTimeMs: coordinatorResult.executionTimeMs,
      }, { status: 500 });
    }

    // Success: the failed row becomes a normal scan in place — same
    // id, same photo, results stored, scan_error cleared, created_at
    // moved to now so it reads as a fresh scan in History. The
    // update only touches a row that is still failed, so two retries
    // racing each other cannot both log a 'scanned' action below.
    const { data: updatedRows, error: updateError } = await serverDb
      .from('scans')
      .update({
        product_name: coordinatorResult.data!.product_name,
        materials: coordinatorResult.data!.detected_materials,
        carbon_footprint: researchValue(coordinatorResult.data!.carbon_footprint_kg),
        recyclability_score: researchValue(coordinatorResult.data!.recyclability_score),
        diy_ideas: coordinatorResult.data!.diy_ideas || [],
        scan_error: null,
        created_at: new Date().toISOString(),
      })
      .eq('id', scanId)
      .eq('user_id', userId)
      .not('scan_error', 'is', null)
      .select('id');
    if (updateError) {
      console.error('Scan retry: could not save the retried scan:', updateError);
      return NextResponse.json(
        { success: false, error: 'The scan worked, but it could not be saved to History. Please try again.' },
        { status: 500 },
      );
    }
    if (!updatedRows || updatedRows.length === 0) {
      // Another retry already turned this row into a normal scan.
      return NextResponse.json(
        { success: false, error: 'This scan was already retried successfully. Please check your History.' },
        { status: 409 },
      );
    }

    // Log the scan action, as the scan route does for a fresh scan:
    // "Add DIY" reads the packaging type from here.
    try {
      const actionRow: Record<string, unknown> = {
        user_id: userId,
        scan_id: scanId,
        action_type: 'scanned',
        impact_score: 0,
        image_url: imageUrl,
      };
      const packagingType = coordinatorResult.data!.packaging_type;
      if (packagingType) actionRow.packaging_type = packagingType;
      const { error: actionError } = await serverDb.from('user_actions').insert([actionRow]);
      if (actionError && /packaging_type|42703/.test(
        `${(actionError as { code?: string }).code || ''} ${(actionError as { message?: string }).message || ''}`,
      )) {
        const { packaging_type: _dropped, ...fallbackRow } = actionRow;
        await serverDb.from('user_actions').insert([fallbackRow]);
      } else if (actionError) {
        console.error('Action log error:', actionError);
      }
    } catch (actionErr) {
      console.error('Action log error:', actionErr);
    }

    return NextResponse.json({
      success: true,
      scanId,
      data: coordinatorResult.data,
      errors: coordinatorResult.errors.length > 0 ? coordinatorResult.errors : undefined,
      executionTimeMs: coordinatorResult.executionTimeMs,
      scanSaved: true,
      imageUrl: await imageUrlForDisplay(imageUrl),
      visionFallback,
    });
  } catch (error) {
    return handleRouteError(error, 'Scan retry API error:');
  }
}

export const maxDuration = 60;
