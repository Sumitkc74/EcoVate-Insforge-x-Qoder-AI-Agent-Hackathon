/**
 * GET /api/backup
 *
 * Owner-only full-database export as a dated JSON download:
 * users, scans, user_actions, usage_attempts — every column of
 * every row, plus the raw storage key next to each photo URL so
 * a later storage export can be matched to its row.
 *
 * Auth is a single shared secret, not a user session: EcoVate
 * has no admin role, so the X-Backup-Token header must equal
 * the BACKUP_TOKEN env var. If the env var is unset, token auth
 * is off and every request is refused. The weekly unattended
 * download uses this token; there is no browser UI for it.
 *
 * The dump covers the database rows only. The photo files
 * themselves live in the private user-uploads bucket and need a
 * separate storage export to be fully safe.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/supabase';
import { assertServiceKey, handleRouteError } from '@/lib/server-auth';
import { storageKeyFromUrl } from '@/lib/storage';

export const runtime = 'edge';

const TABLES = ['users', 'scans', 'user_actions', 'usage_attempts'] as const;

// Constant-time compare so the timing does not reveal how many
// leading characters matched. (No node:crypto here: this route
// runs on the edge runtime.)
function tokenMatches(provided: string | null): boolean {
  const expected = process.env.BACKUP_TOKEN;
  if (!expected || !provided) return false;
  let diff = provided.length ^ expected.length;
  const len = Math.max(provided.length, expected.length);
  for (let i = 0; i < len; i++) {
    diff |= (provided.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function GET(request: NextRequest) {
  try {
    assertServiceKey();
    if (!tokenMatches(request.headers.get('x-backup-token'))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const tables: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const { data, error } = await serverDb.from(table).select('*');
      if (error) throw error;
      tables[table] = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        if (typeof r.image_url === 'string') {
          r.storage_key = storageKeyFromUrl(r.image_url);
        }
        if (typeof r.avatar_url === 'string') {
          r.avatar_storage_key = storageKeyFromUrl(r.avatar_url);
        }
        return r;
      });
    }

    const date = new Date().toISOString().slice(0, 10);
    const body = {
      exported_at: new Date().toISOString(),
      counts: Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [name, rows.length]),
      ),
      tables,
    };
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ecovate-backup-${date}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleRouteError(error, 'Backup API error:');
  }
}
