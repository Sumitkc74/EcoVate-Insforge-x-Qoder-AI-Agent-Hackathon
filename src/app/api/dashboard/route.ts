/**
 * GET/POST /api/dashboard
 * 
 * Returns user profile, stats, and activity history.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, auth } from '@/lib/insforge';

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

  // Calculate score from actions as fallback
  let calculatedScore = 0;

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

  // Calculate stats
  const typedActions = actions as Array<{ action_type: string; impact_score: number }>;
  const totalScans = scans.length;
  const completedProjects = typedActions.filter(a => a.action_type === 'diy_completed').length;
  const totalImpact = typedActions.reduce((sum, a) => sum + (a.impact_score || 0), 0);
  
  // Use calculated score if profile score is 0
  calculatedScore = totalImpact;
  if (userProfile.sustainability_score === 0 && calculatedScore > 0) {
    userProfile.sustainability_score = calculatedScore;
  }
  
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
    // Try cookie auth
    const { data: userData } = await auth.getCurrentUser();
    
    if (userData?.user) {
      return NextResponse.json(await getDashboardData(userData.user.id));
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const bodyUserId = body.userId as string;

    // Accept userId from body
    if (bodyUserId) {
      return NextResponse.json(await getDashboardData(bodyUserId));
    }

    // Fallback to cookie auth
    const { data: userData } = await auth.getCurrentUser();
    
    if (userData?.user) {
      return NextResponse.json(await getDashboardData(userData.user.id));
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
}

export const runtime = 'edge';
