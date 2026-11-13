/**
 * GET /api/leaderboard
 *
 * Returns top users ranked by sustainability score.
 *
 * One entry per person: the same email can have more than one user
 * row (e.g. an imported row plus the row created when signing in to
 * a new backend), so rows are merged by email, their scores summed,
 * and the newest row's id/name/avatar kept — so the "You" highlight
 * in the dashboard still matches the signed-in account.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';

interface LeaderboardUser {
  id: string;
  email: string | null;
  name: string;
  avatar: string;
  sustainability_score: number;
  created_at: string;
}

export async function GET(request: NextRequest) {
  try {
    // Scores are derived, never stored: add up each user's History
    // actions. The users.sustainability_score column is not read —
    // it is a stale cache (a scan once reset it to 0) and a number
    // in it can exist with no history behind it. The service client
    // is needed here because the anon client cannot read other
    // users' actions.
    const { data: allUsers, error: usersError } = await serverDb
      .from('users')
      .select('id, email, name, avatar, created_at')
      .limit(100);

    if (usersError) {
      throw usersError;
    }

    const { data: allActions, error: actionsError } = await serverDb
      .from('user_actions')
      .select('user_id, impact_score');

    if (actionsError) {
      throw actionsError;
    }

    const pointsByUser = new Map<string, number>();
    for (const action of (allActions || []) as Array<{ user_id: string; impact_score: number }>) {
      pointsByUser.set(action.user_id, (pointsByUser.get(action.user_id) || 0) + (action.impact_score || 0));
    }

    const topUsers = (allUsers || []).map((user: { id: string; email: string | null; name: string; avatar: string; created_at: string }) => ({
      ...user,
      sustainability_score: pointsByUser.get(user.id) || 0,
    }));

    // Merge duplicate rows for the same person by email.
    const merged = new Map<string, LeaderboardUser>();
    for (const user of (topUsers || []) as LeaderboardUser[]) {
      const key = user.email ? user.email.trim().toLowerCase() : `id:${user.id}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...user });
      } else {
        existing.sustainability_score += user.sustainability_score || 0;
        // Keep the newest row's identity (the live account).
        if (new Date(user.created_at).getTime() > new Date(existing.created_at).getTime()) {
          existing.id = user.id;
          existing.name = user.name;
          existing.avatar = user.avatar;
          existing.created_at = user.created_at;
        }
      }
    }

    // Rank by summed score, newest first on ties.
    const rankedUsers = [...merged.values()]
      .sort((a, b) =>
        (b.sustainability_score - a.sustainability_score) ||
        (new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      )
      .slice(0, 20)
      // Email is only used for merging; never expose it in the response.
      .map(({ email: _email, ...user }, index) => ({
        rank: index + 1,
        ...user,
      }));

    return NextResponse.json({
      success: true,
      leaderboard: rankedUsers,
    });

  } catch (error) {
    console.error('Leaderboard API error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
}

export const runtime = 'edge';
