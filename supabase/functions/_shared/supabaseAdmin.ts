import { createClient } from '@supabase/supabase-js';
import { requiredEnv } from './env.ts';

export type SupabaseQueryError = {
  code?: string;
  message?: string;
};

export type SupabaseQueryResult<T = unknown> = {
  data?: T | null;
  error?: SupabaseQueryError | null;
};

export type SupabaseClient = {
  from(table: string): unknown;
};

export function createServiceClient() {
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY', ['SERVICE_ROLE_KEY']);

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
