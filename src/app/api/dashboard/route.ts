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
  guestPoolUsed,
  guestPersonalUsage,
  GUEST_DAILY_POOL,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

async function getDashboardData(userId: string) {
  // The four reads are independent, so they run together instead of
  // one after the other. Each fetcher swallows its own failure and
  // returns a default — one slow or failing table must not take the
  // whole dashboard down, as before.
  const defaultProfile = {
    id: userId,
    email: '',
    name: null as string | null,
    avatar: null as string | null,
    sustainability_score: 0,
    created_at: new Date().toISOString(),
  };

  const fetchProfile = async () => {
    try {
      const { data: profile, error: userError } = await serverDb
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();
      if (!userError && profile) return profile;
    } catch (e) {
      console.error('Profile fetch error:', e);
    }
    return defaultProfile;
  };

  const fetchScans = async (): Promise<{ rows: unknown[]; count: number | null; error: string | null }> => {
    try {
      const { data, error, count } = await serverDb
        .from('scans')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) {
        console.error('Scans fetch error:', error);
        return { rows: [], count: null, error: error.message };
      }
      return { rows: data || [], count: typeof count === 'number' ? count : null, error: null };
    } catch (e) {
      console.error('Scans fetch exception:', e);
      return { rows: [], count: null, error: (e as Error).message };
    }
  };

  const fetchActions = async (): Promise<unknown[]> => {
    try {
      const { data, error } = await serverDb
        .from('user_actions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (!error && data) return data;
    } catch (e) {
      console.error('Actions fetch error:', e);
    }
    return [];
  };

  // The score is derived, never stored: add up every action's points
  // from History. The 20 most recent actions above are only for
  // display, so the sum uses its own un-limited fetch — otherwise a
  // user with more than 20 actions would lose points from the total.
  // Nothing here reads users.sustainability_score: that column is a
  // stale cache (a scan once reset it to 0), and a number in it can
  // exist with no history behind it.
  const fetchScore = async (): Promise<{ totalImpact: number; completedProjects: number }> => {
    try {
      const { data: scoreRows, error: scoreError } = await serverDb
        .from('user_actions')
        .select('action_type, impact_score')
        .eq('user_id', userId);
      if (!scoreError && scoreRows) {
        const scored = scoreRows as Array<{ action_type: string; impact_score: number }>;
        return {
          totalImpact: scored.reduce((sum, a) => sum + (a.impact_score || 0), 0),
          completedProjects: scored.filter(a => a.action_type === 'diy_completed').length,
        };
      }
    } catch (e) {
      console.error('Score sum error:', e);
    }
    return { totalImpact: 0, completedProjects: 0 };
  };

  const [userProfile, scansRes, actions, scoreRes] = await Promise.all([
    fetchProfile(),
    fetchScans(),
    fetchActions(),
    fetchScore(),
  ]);
  const scans = scansRes.rows;
  const scanErrorMsg = scansRes.error;
  const { totalImpact, completedProjects } = scoreRes;

  // totalScans is the real count, not the 10 rows shown: the scans
  // query asks for an exact count alongside its 10-row page. If the
  // backend does not return a count, fall back to the rows in hand.
  const totalScans = scansRes.count ?? scans.length;
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

async function dashboardResponse(user: { id: string; isAnonymous: boolean }) {
  const data = await getDashboardData(user.id);
  // Guests see only their own daily use (scans 0/2, verifications
  // 0/2) — never the shared pool count, which other guests' activity
  // would move. When the shared pool is done, the card says the
  // guest logins are exhausted for the day instead of showing a
  // number.
  if (!user.isAnonymous) return NextResponse.json(data);
  const [usage, poolUsed] = await Promise.all([
    guestPersonalUsage(user.id),
    guestPoolUsed(),
  ]);
  return NextResponse.json({
    ...data,
    guestUsage: usage,
    guestPoolExhausted: poolUsed >= GUEST_DAILY_POOL,
  });
}

export async function GET(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    return dashboardResponse(user);
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
    return dashboardResponse(user);
  } catch (error) {
    return handleRouteError(error, 'Dashboard API error:');
  }
}

export const runtime = 'edge';
