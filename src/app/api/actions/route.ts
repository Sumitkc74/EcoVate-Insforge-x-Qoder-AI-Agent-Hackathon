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
    const { scanId, actionType } = body;

    if (!scanId || !actionType) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Insert action
    const { data, error } = await serverDb.from('user_actions').insert([{
      user_id: userId,
      scan_id: scanId,
      action_type: actionType,
      impact_score: 0,
    }]).select().single();

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
