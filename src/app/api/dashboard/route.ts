/**
 * GET/POST /api/dashboard
 * 
 * Returns user profile, stats, and activity history.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import {
  assertServiceKey,
  requireUser,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

async function getDashboardData(userId: string) {
  // Get user profile (may fail due to RLS, provide defaults)
  let userProfile = {
    id: userId,
    email: '',
    name: null as string | null,
    avatar: null as string | null,
    sustainability_score: 0,
    created_at: new Date().toISOString(),
  };

  try {
    const { data: profile, error: userError } = await serverDb
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (!userError && profile) {
      userProfile = profile;
    }
  } catch (e) {
    console.error('Profile fetch error:', e);
  }

  // Get scan history
  let scans: unknown[] = [];
  let scanErrorMsg: string | null = null;
  try {
    const { data, error } = await serverDb
      .from('scans')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) {
      console.error('Scans fetch error:', error);
      scanErrorMsg = error.message;
    } else if (data) {
      scans = data;
    }
  } catch (e) {
    console.error('Scans fetch exception:', e);
    scanErrorMsg = (e as Error).message;
  }

  // Get user actions
  let actions: unknown[] = [];
  try {
    const { data, error } = await serverDb
      .from('user_actions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (!error && data) {
      actions = data;
    }
  } catch (e) {
    console.error('Actions fetch error:', e);
  }

  // The score is derived, never stored: add up every action's points
  // from History. The 20 most recent actions above are only for
  // display, so the sum uses its own un-limited fetch — otherwise a
  // user with more than 20 actions would lose points from the total.
  // Nothing here reads users.sustainability_score: that column is a
  // stale cache (a scan once reset it to 0), and a number in it can
  // exist with no history behind it.
  let totalImpact = 0;
  let completedProjects = 0;
  try {
    const { data: scoreRows, error: scoreError } = await serverDb
      .from('user_actions')
      .select('action_type, impact_score')
      .eq('user_id', userId);
    if (!scoreError && scoreRows) {
      const scored = scoreRows as Array<{ action_type: string; impact_score: number }>;
      totalImpact = scored.reduce((sum, a) => sum + (a.impact_score || 0), 0);
      completedProjects = scored.filter(a => a.action_type === 'diy_completed').length;
    }
  } catch (e) {
    console.error('Score sum error:', e);
  }

  const totalScans = scans.length;
  // The dashboard score and the History total are the same derived number.
  userProfile.sustainability_score = totalImpact;
  
  // Estimate environmental impact
  const estimatedWaterSaved = totalScans * 2.5; // liters
  const estimatedPlasticDiverted = totalScans * 0.05; // kg

  return {
    success: true,
    profile: userProfile,
    stats: {
      totalScans,
      completedProjects,
      totalImpact,
      estimatedWaterSaved: Math.round(estimatedWaterSaved * 10) / 10,
      estimatedPlasticDiverted: Math.round(estimatedPlasticDiverted * 100) / 100,
    },
    recentScans: scans,
    recentActions: actions,
    debug: {
      scanError: scanErrorMsg,
      userId,
      scanCount: scans.length,
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    return NextResponse.json(await getDashboardData(user.id));
  } catch (error) {
    return handleRouteError(error, 'Dashboard API error:');
  }
}

export async function POST(request: NextRequest) {
  try {
    // The user id comes from the validated session token, never the
    // body: anyone could pass any id from the public leaderboard.
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    return NextResponse.json(await getDashboardData(user.id));
  } catch (error) {
    return handleRouteError(error, 'Dashboard API error:');
  }
}

export const runtime = 'edge';
