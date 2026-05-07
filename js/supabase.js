(function (root, factory) {
  const api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaSupabase = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (defaultRoot) {
  'use strict';

  const CLIENT_OPTIONS = Object.freeze({
    auth: Object.freeze({
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }),
  });

  function queryMeta(documentRef, selector, attribute) {
    return documentRef?.querySelector?.(selector)?.getAttribute(attribute) || '';
  }

  function getSupabaseConfig(options) {
    const root = options?.root || defaultRoot;
    const documentRef = options?.document || root.document;
    const config = root.EcoVilaSupabaseConfig || root.ECOVILA_SUPABASE_CONFIG || {};
    const url =
      config.url ||
      config.supabaseUrl ||
      root.ECOVILA_SUPABASE_URL ||
      queryMeta(documentRef, 'meta[name="ecovila:supabase-url"]', 'content') ||
      queryMeta(documentRef, '[data-supabase-url]', 'data-supabase-url');
    const anonKey =
      config.anonKey ||
      config.supabaseAnonKey ||
      root.ECOVILA_SUPABASE_ANON_KEY ||
      queryMeta(documentRef, 'meta[name="ecovila:supabase-anon-key"]', 'content') ||
      queryMeta(documentRef, '[data-supabase-anon-key]', 'data-supabase-anon-key');

    if (!url || !anonKey) {
      throw new Error(
        'Missing Supabase config. Set window.EcoVilaSupabaseConfig = { url, anonKey } before js/supabase.js is used.',
      );
    }

    return { url, anonKey };
  }

  function createSupabaseClient(config, library) {
    const supabaseLibrary = library || defaultRoot.supabase;

    if (!supabaseLibrary?.createClient) {
      throw new Error('Supabase JS client is not loaded. Include @supabase/supabase-js before js/supabase.js.');
    }

    return supabaseLibrary.createClient(config.url, config.anonKey, CLIENT_OPTIONS);
  }

  function getSupabaseClient(options) {
    const root = options?.root || defaultRoot;

    if (root.__EcoVilaSupabaseClient) {
      return root.__EcoVilaSupabaseClient;
    }

    const config = getSupabaseConfig({ root, document: options?.document });
    root.__EcoVilaSupabaseClient = createSupabaseClient(config, options?.library || root.supabase);

    return root.__EcoVilaSupabaseClient;
  }

  async function unwrapSupabaseResult(resultPromise) {
    const result = await resultPromise;

    if (result.error) {
      throw result.error;
    }

    return result.data || [];
  }

  function applyDateRange(query, startDate, endDate) {
    let nextQuery = query;

    if (startDate && typeof nextQuery.gte === 'function') {
      nextQuery = nextQuery.gte('date', startDate);
    }

    if (endDate && typeof nextQuery.lte === 'function') {
      nextQuery = nextQuery.lte('date', endDate);
    }

    return nextQuery;
  }

  function fetchRooms(client) {
    return unwrapSupabaseResult(
      client
        .from('rooms')
        .select('id, number, type, is_active')
        .eq('is_active', true)
        .order('number', { ascending: true }),
    );
  }

  function fetchPricingTiers(client) {
    return unwrapSupabaseResult(
      client
        .from('pricing_tiers')
        .select('nights_tier, day_type, adult_price, kid_price, effective_from, created_at')
        .order('effective_from', { ascending: true }),
    );
  }

  function fetchHolidays(client, options) {
    const query = client
      .from('holidays')
      .select('date, label')
      .order('date', { ascending: true });

    return unwrapSupabaseResult(applyDateRange(query, options?.startDate, options?.endDate));
  }

  function fetchAvailabilityBlocks(client, options) {
    return unwrapSupabaseResult(
      client.rpc('get_public_availability_blocks', {
        range_start: options.startDate,
        range_end: options.endDate,
      }),
    );
  }

  return {
    CLIENT_OPTIONS,
    createSupabaseClient,
    fetchAvailabilityBlocks,
    fetchHolidays,
    fetchPricingTiers,
    fetchRooms,
    getSupabaseClient,
    getSupabaseConfig,
    unwrapSupabaseResult,
  };
});
