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
import { assertServiceKey, handleRouteError } from '@/lib/server-auth';

interface LeaderboardUser {
  id: string;
  email: string | null;
  name: string;
  avatar: string;
  sustainability_score: number;
  created_at: string;
}

// The board changes only when someone completes a DIY project, so
// a 60-second cache is plenty — without it every dashboard load
// re-reads the whole user_actions table. The response is identical
// for every viewer (public by design, emails stripped), so it is
// safe to cache in memory and at the edge. A fresh completion shows
// up within a minute.
const CACHE_TTL_MS = 60_000;
let cachedBoard: { at: number; body: { success: true; leaderboard: unknown[] } } | null = null;

export async function GET(request: NextRequest) {
  try {
    if (cachedBoard && Date.now() - cachedBoard.at < CACHE_TTL_MS) {
      return NextResponse.json(cachedBoard.body, {
        headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=30' },
      });
    }

    // Public by design (names and scores only — emails are stripped
    // below), but the service client is still needed to read other
    // users' actions, so a missing service key is a 503, not a
    // silent empty board.
    assertServiceKey();
    // Scores are derived, never stored: add up each user's History
    // actions. The users.sustainability_score column is not read —
    // it is a stale cache (a scan once reset it to 0) and a number
    // in it can exist with no history behind it. The service client
    // is needed here because the anon client cannot read other
    // users' actions. The two reads are independent, so they run
    // together instead of one after the other.
    const [{ data: allUsers, error: usersError }, { data: allActions, error: actionsError }] =
      await Promise.all([
        serverDb
          .from('users')
          .select('id, email, name, avatar, created_at')
          .limit(100),
        serverDb
          .from('user_actions')
          .select('user_id, impact_score'),
      ]);

    if (usersError) {
      throw usersError;
    }

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

    const body = {
      success: true as const,
      leaderboard: rankedUsers,
    };
    cachedBoard = { at: Date.now(), body };
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=30' },
    });

  } catch (error) {
    return handleRouteError(error, 'Leaderboard API error:');
  }
}

export const runtime = 'edge';
