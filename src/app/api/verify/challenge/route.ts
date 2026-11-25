/**
 * POST /api/verify/challenge
 *
 * Issues a fresh one-time code for a verification attempt. The user
 * writes the code on paper, places it beside the finished project
 * and photographs both with the in-app camera; /api/verify checks
 * the code is visible in the photo before awarding points.
 *
 * Issuing a code costs no verification attempt and no AI call — the
 * attempt is only spent when a photo is submitted. A retry always
 * requests a fresh code, so a failed attempt's code is abandoned.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/supabase';
import {
  assertServiceKey,
  requireUser,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';
import {
  generateChallengeCode,
  createChallengeToken,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/verify-challenge';

export async function POST(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const body = await request.json().catch(() => null);
    const scanId = body?.scanId as string | undefined;
    if (!scanId) {
      return NextResponse.json({ error: 'Missing required field: scanId' }, { status: 400 });
    }
    if (scanId.startsWith('temp_')) {
      return NextResponse.json(
        { error: 'This scan was not saved, so it cannot be verified. Please scan again.' },
        { status: 400 },
      );
    }

    // The scan must exist and belong to the caller — same ownership
    // check as /api/verify, so a code cannot be minted for someone
    // else's project.
    const { data: scan } = await serverDb
      .from('scans')
      .select('user_id')
      .eq('id', scanId)
      .single();
    if (!scan) {
      return NextResponse.json({ error: 'Scan not found. Please scan again.' }, { status: 404 });
    }
    if ((scan as { user_id: string }).user_id !== userId) {
      return NextResponse.json({ error: 'Not your scan' }, { status: 403 });
    }

    // An already-awarded project gets no new code: one award per
    // project. Failed and pending projects can retry — they have no
    // diy_completed row, so they reach here.
    const { data: completedAction } = await serverDb
      .from('user_actions')
      .select('id')
      .eq('user_id', userId)
      .eq('scan_id', scanId)
      .eq('action_type', 'diy_completed')
      .limit(1)
      .single();
    if (completedAction) {
      return NextResponse.json(
        { error: 'This project is already verified and its points have been awarded. It cannot be verified again.' },
        { status: 409 },
      );
    }

    const code = generateChallengeCode();
    const { token, expiresAt } = await createChallengeToken(scanId, code);
    return NextResponse.json({
      code,
      token,
      expiresAt,
      ttlSeconds: CHALLENGE_TTL_SECONDS,
    });
  } catch (error) {
    return handleRouteError(error, 'Challenge error:');
  }
}
