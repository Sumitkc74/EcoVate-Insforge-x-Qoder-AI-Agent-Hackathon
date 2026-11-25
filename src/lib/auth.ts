/**
 * Authentication Helpers
 * 
 * Utility functions for Google OAuth and session management.
 */

import { auth } from './supabase';

// Sign in with Google OAuth
export async function signInWithGoogle() {
  const { data, error } = await auth.signInWithOAuth({
    provider: 'google',
    redirectTo: `${window.location.origin}/auth/callback`,
  });

  return { data, error };
}

// Sign out
export async function signOut() {
  const { error } = await auth.signOut();
  return { error };
}

// Get current user
export async function getUser() {
  const { data, error } = await auth.getCurrentUser();
  return { user: data.user, error };
}

// Create or update user profile in database
export async function ensureUserProfile(userId: string, email: string, name?: string, avatar?: string) {
  const { db } = await import('./supabase');
  
  // Check if user exists
  const { data: existingUser } = await db
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (existingUser) {
    return { user: existingUser, error: null };
  }

  // Create new user profile
  const { data, error } = await db
    .from('users')
    .insert([
      {
        id: userId,
        email,
        name: name || email.split('@')[0],
        avatar: avatar || null,
        sustainability_score: 0,
      },
    ])
    .select()
    .single();

  return { user: data, error };
}
