/**
 * InsForge Client Configuration
 * 
 * This file initializes the InsForge SDK client for authentication,
 * database, storage, and AI operations.
 */

import { createClient } from '@insforge/sdk';

// InsForge backend configuration
const INSFORGE_URL = process.env.NEXT_PUBLIC_INSFORGE_URL || 'https://8t37jscx.us-west.insforge.app';
const INSFORGE_ANON_KEY = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '';

// Create InsForge client instance
export const insforge = createClient({
  baseUrl: INSFORGE_URL,
  anonKey: INSFORGE_ANON_KEY,
});

// Export typed helpers
export const auth = insforge.auth;
export const db = insforge.database;
export const storage = insforge.storage;
export const ai = insforge.ai;

// Server-side database client with service role key (bypasses RLS)
// Only use in API routes, never expose to client
export const serverDb = createClient({
  baseUrl: INSFORGE_URL,
  anonKey: process.env.INSFORGE_SERVICE_KEY || INSFORGE_ANON_KEY,
}).database;

// Server-side storage client with the service key (bypasses storage
// policies). Uploads happen from API routes only, so they must not
// depend on the anon key or on storage RLS policies: with the anon
// client every upload failed silently and History rows were saved
// with no photo. Only use in API routes, never expose to client.
export const serverStorage = createClient({
  baseUrl: INSFORGE_URL,
  anonKey: process.env.INSFORGE_SERVICE_KEY || INSFORGE_ANON_KEY,
}).storage;

// Type definitions for database tables
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  sustainability_score: number;
  created_at: string;
}

export interface Scan {
  id: string;
  user_id: string;
  product_name: string;
  materials: string[];
  carbon_footprint: number | null;
  recyclability_score: number | null;
  image_url: string | null;
  created_at: string;
}

export interface UserAction {
  id: string;
  user_id: string;
  scan_id: string | null;
  action_type: 'scanned' | 'diy_selected' | 'diy_completed' | 'diy_pending' | 'diy_failed';
  impact_score: number;
  image_url: string | null;
  created_at: string;
  // Verification feedback (the AI's reason) and the project title,
  // saved by /api/verify. Null on older rows, which predate the columns.
  feedback?: string | null;
  project_title?: string | null;
}

// DIY Idea type for agent responses
export interface DIYIdea {
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  materials_needed: string[];
  steps: string[];
  estimated_co2_saved_kg: number;
}

// Scan result type
export interface ScanResult {
  product_name: string;
  detected_materials: string[];
  label_text: string;
  packaging_type: string;
  // True when the material was never actually determined and
  // 'mixed plastic' was substituted as the default (or nothing was
  // found at all): the results page says so instead of presenting
  // the fallback as a confident reading. Scan-time only — it is not
  // stored on the scan row.
  material_unknown?: boolean;
  carbon_footprint_kg: number;
  recyclability_score: number;
  material_breakdown: { material: string; percentage: number }[];
  diy_ideas: DIYIdea[];
}
