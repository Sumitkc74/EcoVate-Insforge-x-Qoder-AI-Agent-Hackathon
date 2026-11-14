/**
 * POST /api/actions
 *
 * Log a chosen DIY idea (diy_selected) for the signed-in user, so it
 * can be resumed later from the dashboard or History. The caller is
 * authenticated by session token (see lib/server-auth); the user id
 * comes from the validated token, never the body. Only the chosen-idea
 * action is accepted here — points are only ever awarded by
 * /api/verify after the AI approves the photo.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import {
  requireUser,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const body = await request.json();
    const { scanId, actionType, projectTitle, packagingType, estimatedCo2Saved } = body;

    if (!scanId || actionType !== 'diy_selected') {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Temp ids are scans that were never saved — nothing can be
    // logged against them — and the scan must belong to the caller.
    if (typeof scanId === 'string' && scanId.startsWith('temp_')) {
      return NextResponse.json({ error: 'Scan was not saved' }, { status: 400 });
    }
    const { data: scan } = await serverDb
      .from('scans')
      .select('user_id')
      .eq('id', scanId)
      .single();
    if (!scan) {
      return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
    }
    if ((scan as { user_id: string }).user_id !== userId) {
      return NextResponse.json({ error: 'Not your scan' }, { status: 403 });
    }

    // A diy_selected row records the chosen idea so it can be resumed
    // later from the dashboard or History (project_title already has
    // a column; packaging_type / estimated_co2_saved need the one-time
    // SQL below — until it is run, the insert falls back to the
    // columns that exist and resume uses generic defaults).
    const insertRow: Record<string, unknown> = {
      user_id: userId,
      scan_id: scanId,
      action_type: actionType,
      impact_score: 0,
    };
    if (typeof projectTitle === 'string' && projectTitle) {
      insertRow.project_title = projectTitle;
    }
    if (typeof packagingType === 'string' && packagingType) {
      insertRow.packaging_type = packagingType;
    }
    // Clamp the stored value, not just its type: /api/verify scores
    // points from this row (10 + CO2 x 20), so an unclamped number
    // here mints points. A single DIY idea saves well under 5 kg.
    if (typeof estimatedCo2Saved === 'number' && Number.isFinite(estimatedCo2Saved)) {
      insertRow.estimated_co2_saved = Math.min(Math.max(estimatedCo2Saved, 0), 5);
    }

    let { data, error } = await serverDb.from('user_actions').insert([insertRow]).select().single();

    if (error && /packaging_type|estimated_co2_saved|42703/.test(
      `${(error as { code?: string }).code || ''} ${(error as { message?: string }).message || ''}`,
    )) {
      // New columns not added yet: retry with only the columns that exist.
      const fallbackRow: Record<string, unknown> = {
        user_id: userId,
        scan_id: scanId,
        action_type: actionType,
        impact_score: 0,
      };
      if (insertRow.project_title) fallbackRow.project_title = insertRow.project_title;
      ({ data, error } = await serverDb.from('user_actions').insert([fallbackRow]).select().single());
    }

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true, action: data });

  } catch (error) {
    return handleRouteError(error, 'Actions API error:');
  }
}

export const runtime = 'edge';
