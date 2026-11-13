/**
 * POST /api/actions
 * 
 * Log user actions (diy_selected, etc.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, auth } from '@/lib/insforge';

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const { data: userData, error: authError } = await auth.getCurrentUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = userData.user.id;
    const body = await request.json();
    const { scanId, actionType, projectTitle, packagingType, estimatedCo2Saved } = body;

    if (!scanId || !actionType) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
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
    if (typeof estimatedCo2Saved === 'number' && Number.isFinite(estimatedCo2Saved)) {
      insertRow.estimated_co2_saved = estimatedCo2Saved;
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
    console.error('Actions API error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
}

export const runtime = 'edge';
