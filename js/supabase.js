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

  function insertPendingReservations(client, payloads) {
    return unwrapSupabaseResult(
      client
        .from('reservations')
        .insert(payloads),
    );
  }

  async function createReservationRequest(client, payloads) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('create-reservation', {
      body: { reservations: payloads },
    });

    if (result.error) {
      throw result.error;
    }

    return result.data || {};
  }

  function fetchAdminReservations(client, options) {
    let query = client
      .from('reservations')
      .select(
        [
          'id',
          'booking_group_id',
          'room_id',
          'guest_first_name',
          'guest_last_name',
          'guest_phone',
          'guest_email',
          'guest_language',
          'check_in',
          'check_out',
          'adults',
          'kids_ages',
          'total_price',
          'towel_cards_issued',
          'payment_type',
          'payment_status',
          'room_explicitly_selected',
          'conference_room',
          'notes',
          'cash_expires_at',
          'cash_extended',
          'created_by',
          'created_at',
          'cancelled_at',
          'cancellation_reason',
          'rooms(id, number, type)',
        ].join(', '),
      )
      .order('check_in', { ascending: true });

    if (options?.startDate) {
      query = query.gt('check_out', options.startDate);
    }

    if (options?.endDate) {
      query = query.lt('check_in', options.endDate);
    }

    return unwrapSupabaseResult(query);
  }

  function fetchPendingCashReservations(client) {
    return unwrapSupabaseResult(
      client
        .from('reservations')
        .select('id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_language, check_in, check_out, total_price, payment_type, payment_status, cash_expires_at, rooms(id, number, type)')
        .eq('payment_type', 'cash')
        .eq('payment_status', 'pending')
        .is('cancelled_at', null)
        .order('cash_expires_at', { ascending: true }),
    );
  }

  function updateReservation(client, reservationId, values) {
    return unwrapSupabaseResult(
      client
        .from('reservations')
        .update(values)
        .eq('id', reservationId)
        .select(),
    );
  }

  function updateReservationGroup(client, bookingGroupId, values) {
    return unwrapSupabaseResult(
      client
        .from('reservations')
        .update(values)
        .eq('booking_group_id', bookingGroupId)
        .select(),
    );
  }

  async function confirmReservationPayment(client, input) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('confirm-reservation-payment', {
      body: {
        reservationId: input?.reservationId || '',
        bookingGroupId: input?.bookingGroupId || '',
      },
    });

    if (result.error) {
      throw result.error;
    }

    return result.data || {};
  }

  function insertStaffReservations(client, payloads) {
    return unwrapSupabaseResult(
      client
        .from('reservations')
        .insert(payloads)
        .select(),
    );
  }

  function searchReservations(client, filters) {
    let query = client
      .from('reservations')
      .select('id, room_id, guest_first_name, guest_last_name, guest_phone, check_in, check_out, payment_status, rooms(number, type)')
      .gte('check_out', filters?.fromDate || new Date().toISOString().slice(0, 10))
      .order('check_in', { ascending: true })
      .limit(25);

    if (filters?.date) {
      query = query.lte('check_in', filters.date).gte('check_out', filters.date);
    }

    if (filters?.phone) {
      query = query.ilike('guest_phone', `%${filters.phone}%`);
    }

    if (filters?.name) {
      const name = `%${filters.name}%`;
      query = query.or(`guest_first_name.ilike.${name},guest_last_name.ilike.${name}`);
    }

    return unwrapSupabaseResult(query);
  }

  function fetchDailyStatuses(client, serviceDate, reservationIds) {
    let query = client
      .from('crm_daily_statuses')
      .select('reservation_id, service_date, checked_in_at, checked_out_at, checkout_note, updated_by, updated_at')
      .eq('service_date', serviceDate);

    if (reservationIds?.length) {
      query = query.in('reservation_id', reservationIds);
    }

    return unwrapSupabaseResult(query);
  }

  function upsertDailyStatus(client, payload) {
    return unwrapSupabaseResult(
      client
        .from('crm_daily_statuses')
        .upsert(payload, { onConflict: 'reservation_id,service_date' })
        .select(),
    );
  }

  function fetchTowelCounts(client, serviceDate) {
    return unwrapSupabaseResult(
      client
        .from('crm_towel_counts')
        .select('room_id, service_date, towel_count, updated_by, updated_at')
        .eq('service_date', serviceDate),
    );
  }

  function upsertTowelCount(client, payload) {
    return unwrapSupabaseResult(
      client
        .from('crm_towel_counts')
        .upsert(payload, { onConflict: 'room_id,service_date' })
        .select(),
    );
  }

  function fetchPhotoSections(client) {
    return unwrapSupabaseResult(
      client
        .from('crm_photo_sections')
        .select('id, slug, label, display_order')
        .order('display_order', { ascending: true }),
    );
  }

  function fetchCrmPhotos(client, status) {
    let query = client
      .from('crm_photos')
      .select('id, section_id, storage_path, alt_text, sort_order, status, created_at, updated_at, published_at, crm_photo_sections(slug, label, display_order)')
      .order('sort_order', { ascending: true });

    if (status) {
      query = query.eq('status', status);
    }

    return unwrapSupabaseResult(query);
  }

  function uploadCrmPhoto(client, path, file, options) {
    return client.storage
      .from('ecovila-photos')
      .upload(path, file, { upsert: options?.upsert === true, cacheControl: '3600' });
  }

  function getCrmPhotoPublicUrl(client, storagePath) {
    return client.storage
      .from('ecovila-photos')
      .getPublicUrl(storagePath)
      .data?.publicUrl || '';
  }

  function insertCrmPhoto(client, payload) {
    return unwrapSupabaseResult(
      client
        .from('crm_photos')
        .insert(payload)
        .select(),
    );
  }

  function updateCrmPhoto(client, photoId, values) {
    return unwrapSupabaseResult(
      client
        .from('crm_photos')
        .update(values)
        .eq('id', photoId)
        .select(),
    );
  }

  function deleteCrmPhoto(client, photoId) {
    return unwrapSupabaseResult(
      client
        .from('crm_photos')
        .delete()
        .eq('id', photoId)
        .select(),
    );
  }

  function publishCrmPhotos(client) {
    return unwrapSupabaseResult(client.rpc('publish_crm_photos'));
  }

  function fetchPublishedPhotos(client) {
    return unwrapSupabaseResult(
      client
        .from('crm_photos')
        .select('id, section_id, storage_path, alt_text, sort_order, status, crm_photo_sections(slug, label, display_order)')
        .eq('status', 'published')
        .order('sort_order', { ascending: true }),
    );
  }

  function groupPublishedPhotos(client, photos) {
    const library = {};

    (photos || []).forEach((photo) => {
      const slug = photo.crm_photo_sections?.slug || photo.section_slug || '';
      const publicUrl = photo.publicUrl || getCrmPhotoPublicUrl(client, photo.storage_path);

      if (!slug || !publicUrl) {
        return;
      }

      if (!library[slug]) {
        library[slug] = [];
      }

      library[slug].push({
        id: photo.id || '',
        url: publicUrl,
        storagePath: photo.storage_path || '',
        alt: photo.alt_text || '',
        sortOrder: Number(photo.sort_order || 999),
      });
    });

    Object.values(library).forEach((items) => {
      items.sort((left, right) => left.sortOrder - right.sortOrder);
    });

    return library;
  }

  async function fetchPublicPhotoLibrary(client) {
    const photos = await fetchPublishedPhotos(client);
    return groupPublishedPhotos(client, photos);
  }

  function fetchPendingReservationStatus(client, reservationId) {
    return unwrapSupabaseResult(
      client.rpc('get_pending_reservation_status', { res_id: reservationId }),
    );
  }

  async function extendCashReservation(client, reservationId) {
    const result = await client.rpc('extend_cash_reservation', { res_id: reservationId });

    if (result.error) {
      throw result.error;
    }

    return result.data;
  }

  async function cancelPendingReservation(client, reservationId) {
    const result = await client.rpc('cancel_pending_reservation', { res_id: reservationId });

    if (result.error) {
      throw result.error;
    }

    return result.data;
  }

  async function cancelReservationByToken(client, token, phone) {
    const result = await client.rpc('cancel_reservation_by_token', {
      lookup_token: token,
      confirming_phone: phone,
    });

    if (result.error) {
      throw result.error;
    }

    return result.data;
  }

  function fetchReservationByToken(client, token) {
    return unwrapSupabaseResult(
      client.rpc('get_reservation_by_cancellation_token', { lookup_token: token }),
    );
  }

  function insertPricingRows(client, rows) {
    return unwrapSupabaseResult(
      client
        .from('pricing_tiers')
        .upsert(rows, { onConflict: 'nights_tier,day_type,effective_from' })
        .select(),
    );
  }

  function insertHoliday(client, payload) {
    return unwrapSupabaseResult(
      client
        .from('holidays')
        .insert(payload)
        .select(),
    );
  }

  function deleteHoliday(client, holidayDate) {
    return unwrapSupabaseResult(
      client
        .from('holidays')
        .delete()
        .eq('date', holidayDate)
        .select(),
    );
  }

  return {
    CLIENT_OPTIONS,
    cancelPendingReservation,
    cancelReservationByToken,
    confirmReservationPayment,
    createReservationRequest,
    extendCashReservation,
    fetchPendingReservationStatus,
    fetchReservationByToken,
    createSupabaseClient,
    fetchAvailabilityBlocks,
    fetchAdminReservations,
    fetchCrmPhotos,
    fetchDailyStatuses,
    fetchHolidays,
    fetchPendingCashReservations,
    fetchPhotoSections,
    fetchPublishedPhotos,
    fetchPublicPhotoLibrary,
    fetchPricingTiers,
    fetchRooms,
    fetchTowelCounts,
    getSupabaseClient,
    getSupabaseConfig,
    getCrmPhotoPublicUrl,
    groupPublishedPhotos,
    insertCrmPhoto,
    insertHoliday,
    insertPendingReservations,
    insertPricingRows,
    insertStaffReservations,
    publishCrmPhotos,
    searchReservations,
    updateCrmPhoto,
    updateReservationGroup,
    updateReservation,
    deleteCrmPhoto,
    deleteHoliday,
    uploadCrmPhoto,
    upsertDailyStatus,
    upsertTowelCount,
    unwrapSupabaseResult,
  };
});
