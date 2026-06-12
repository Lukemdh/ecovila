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

  const PHOTO_BUCKET = 'ecovila-photos';
  const PHOTO_CACHE_CONTROL = '31536000';
  const PHOTO_VARIANTS = Object.freeze({
    preview: Object.freeze({ width: 1400, height: 1050, quality: 72, resize: 'cover' }),
    wide: Object.freeze({ width: 2200, height: 950, quality: 72, resize: 'cover' }),
    card: Object.freeze({ width: 900, height: 600, quality: 72, resize: 'cover' }),
    thumbnail: Object.freeze({ width: 360, height: 240, quality: 65, resize: 'cover' }),
    // 'contain' keeps the original aspect ratio: this variant feeds the pop-up
    // carousel and lightbox, where portrait photos must never be cropped.
    full: Object.freeze({ width: 1800, height: 1800, quality: 78, resize: 'contain' }),
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

  function createClientOptions(options) {
    const authOptions = {
      ...CLIENT_OPTIONS.auth,
    };

    if (options?.authStorage) {
      authOptions.storage = options.authStorage;
    }

    return {
      ...CLIENT_OPTIONS,
      auth: authOptions,
    };
  }

  function createSupabaseClient(config, library, options) {
    const supabaseLibrary = library || defaultRoot.supabase;

    if (!supabaseLibrary?.createClient) {
      throw new Error('Supabase JS client is not loaded. Include @supabase/supabase-js before js/supabase.js.');
    }

    return supabaseLibrary.createClient(config.url, config.anonKey, createClientOptions(options));
  }

  function getSupabaseClient(options) {
    const root = options?.root || defaultRoot;

    if (root.__EcoVilaSupabaseClient) {
      return root.__EcoVilaSupabaseClient;
    }

    const config = getSupabaseConfig({ root, document: options?.document });
    root.__EcoVilaSupabaseClient = createSupabaseClient(config, options?.library || root.supabase, {
      authStorage: options?.authStorage,
    });

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

  async function createMaibPaymentRequest(client, context) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('maib-create-payment', {
      body: context,
    });

    if (result.error) {
      throw result.error;
    }

    return result.data || {};
  }

  async function refundMaibPaymentRequest(client, input) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('maib-refund', {
      body: {
        payId: input?.payId || '',
        bookingGroupId: input?.bookingGroupId || '',
        amount: input?.amount ?? null,
        reason: input?.reason || 'crm_cancellation',
      },
    });

    if (result.error) {
      throw result.error;
    }

    return result.data || {};
  }

  async function startReservationLookup(client, phone) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('reservation-lookup-start', {
      body: { phone },
    });

    if (result.error) {
      throw result.error;
    }

    return result.data || {};
  }

  async function verifyReservationLookup(client, input) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('reservation-lookup-verify', {
      body: {
        lookupId: input?.lookupId || '',
        code: input?.code || '',
      },
    });

    if (result.error) {
      throw result.error;
    }

    return result.data || {};
  }

  async function fetchManagedReservationDetails(client, input) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('reservation-manage-details', {
      body: {
        manageToken: input?.manageToken || '',
        reservationId: input?.reservationId || '',
      },
    });

    if (result.error) {
      throw result.error;
    }

    return result.data || {};
  }

  async function cancelManagedReservation(client, input) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('reservation-cancel', {
      body: {
        manageToken: input?.manageToken || '',
        reservationId: input?.reservationId || '',
      },
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

  function fetchFinanceReservations(client, options) {
    let query = client
      .from('reservations')
      .select(
        [
          'id',
          'booking_group_id',
          'room_id',
          'check_in',
          'check_out',
          'total_price',
          'payment_type',
          'payment_status',
          'paid_at',
          'cancelled_at',
          'rooms(id, number, type)',
        ].join(', '),
      )
      .eq('payment_status', 'paid')
      .is('cancelled_at', null);

    if (options?.mode === 'paid') {
      query = query
        .gte('paid_at', `${options.rangeStart}T00:00:00.000Z`)
        .lt('paid_at', `${options.rangeEnd}T00:00:00.000Z`)
        .order('paid_at', { ascending: true });
    } else {
      query = query
        .gt('check_out', options?.rangeStart)
        .lt('check_in', options?.rangeEnd)
        .order('check_in', { ascending: true });
    }

    return unwrapSupabaseResult(query);
  }

  function fetchFinanceBookedReservations(client, options) {
    const rangeStart = options?.rangeStart;
    const rangeEnd = options?.rangeEnd;
    let query = client
      .from('reservations')
      .select(
        [
          'id',
          'booking_group_id',
          'room_id',
          'guest_first_name',
          'guest_last_name',
          'check_in',
          'check_out',
          'adults',
          'kids_ages',
          'total_price',
          'payment_type',
          'payment_status',
          'created_at',
          'cancelled_at',
          'rooms(id, number, type)',
        ].join(', '),
      )
      .neq('payment_status', 'cancelled')
      .is('cancelled_at', null);

    if (rangeStart) {
      query = query.gte('created_at', `${rangeStart}T00:00:00.000Z`);
    }

    if (rangeEnd) {
      query = query.lt('created_at', `${rangeEnd}T00:00:00.000Z`);
    }

    return unwrapSupabaseResult(query.order('created_at', { ascending: true }));
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

  function normalizePhoneSearch(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.startsWith('0') ? digits.slice(1) : digits;
  }

  async function searchReservations(client, filters) {
    const name = filters?.name?.trim();
    const phone = normalizePhoneSearch(filters?.phone);
    const roomIds = Array.isArray(filters?.roomIds) ? filters.roomIds.filter(Boolean) : [];
    const hasGuestFilter = Boolean(name || phone || roomIds.length);

    let nameMatchIds = null;
    if (name) {
      const matches = await unwrapSupabaseResult(
        client.rpc('search_reservation_ids', { search_name: name }),
      );
      nameMatchIds = matches.map((row) => row.id);
      if (!nameMatchIds.length) {
        return [];
      }
    }

    let query = client
      .from('reservations')
      .select('id, room_id, guest_first_name, guest_last_name, guest_phone, check_in, check_out, payment_status, rooms(number, type)')
      .order('check_in', { ascending: false })
      .limit(50);

    if (filters?.date) {
      query = query.lte('check_in', filters.date).gte('check_out', filters.date);
    } else if (!hasGuestFilter) {
      query = query.gte('check_out', filters?.fromDate || new Date().toISOString().slice(0, 10));
    }

    if (nameMatchIds) {
      query = query.in('id', nameMatchIds);
    }

    if (roomIds.length) {
      query = query.in('room_id', roomIds);
    }

    if (phone) {
      query = query.ilike('guest_phone', `%${phone}%`);
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
      .from(PHOTO_BUCKET)
      .upload(path, file, { upsert: options?.upsert === true, cacheControl: PHOTO_CACHE_CONTROL });
  }

  function getPhotoTransform(options) {
    if (options?.transform) {
      return options.transform;
    }

    return PHOTO_VARIANTS[options?.variant] || null;
  }

  function getCrmPhotoPublicUrl(client, storagePath, options) {
    const transform = getPhotoTransform(options);
    const publicUrlOptions = transform ? { transform } : undefined;

    return client.storage
      .from(PHOTO_BUCKET)
      .getPublicUrl(storagePath, publicUrlOptions)
      .data?.publicUrl || '';
  }

  function getCrmPhotoUrlSet(client, storagePath) {
    return {
      originalUrl: getCrmPhotoPublicUrl(client, storagePath),
      previewUrl: getCrmPhotoPublicUrl(client, storagePath, { variant: 'preview' }),
      wideUrl: getCrmPhotoPublicUrl(client, storagePath, { variant: 'wide' }),
      cardUrl: getCrmPhotoPublicUrl(client, storagePath, { variant: 'card' }),
      thumbnailUrl: getCrmPhotoPublicUrl(client, storagePath, { variant: 'thumbnail' }),
      fullUrl: getCrmPhotoPublicUrl(client, storagePath, { variant: 'full' }),
    };
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
      const urlSet = photo.urls || getCrmPhotoUrlSet(client, photo.storage_path);
      const publicUrl = photo.publicUrl || urlSet.previewUrl || urlSet.originalUrl;

      if (!slug || !publicUrl) {
        return;
      }

      if (!library[slug]) {
        library[slug] = [];
      }

      library[slug].push({
        id: photo.id || '',
        url: publicUrl,
        originalUrl: urlSet.originalUrl || publicUrl,
        previewUrl: urlSet.previewUrl || publicUrl,
        wideUrl: urlSet.wideUrl || publicUrl,
        cardUrl: urlSet.cardUrl || publicUrl,
        thumbnailUrl: urlSet.thumbnailUrl || publicUrl,
        fullUrl: urlSet.fullUrl || publicUrl,
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

  async function fetchPendingReservationStatus(client, input) {
    const details = await fetchManagedReservationDetails(client, input);
    const summary = details?.reservation || {};
    const primary = Array.isArray(details?.reservations) ? details.reservations[0] || {} : {};

    return [{
      payment_type: summary.paymentType || primary.payment_type || '',
      payment_status: summary.paymentStatus || primary.payment_status || '',
      cash_expires_at: primary.cash_expires_at || null,
      cash_extended: Boolean(primary.cash_extended),
    }];
  }

  async function extendCashReservation(client, input) {
    if (!client?.functions?.invoke) {
      throw new Error('Supabase Edge Functions are not available on this client.');
    }

    const result = await client.functions.invoke('reservation-extend-cash', {
      body: {
        manageToken: input?.manageToken || '',
        reservationId: input?.reservationId || '',
      },
    });

    if (result.error) {
      throw result.error;
    }

    return result.data?.cash_expires_at || null;
  }

  async function cancelPendingReservation(client, input) {
    const result = await cancelManagedReservation(client, input);
    return result?.status === 'cancelled' || result?.ok === true;
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
    PHOTO_CACHE_CONTROL,
    PHOTO_VARIANTS,
    cancelPendingReservation,
    cancelReservationByToken,
    confirmReservationPayment,
    createMaibPaymentRequest,
    refundMaibPaymentRequest,
    createReservationRequest,
    startReservationLookup,
    verifyReservationLookup,
    fetchManagedReservationDetails,
    cancelManagedReservation,
    extendCashReservation,
    fetchPendingReservationStatus,
    fetchReservationByToken,
    createSupabaseClient,
    fetchAvailabilityBlocks,
    fetchAdminReservations,
    fetchCrmPhotos,
    fetchDailyStatuses,
    fetchFinanceBookedReservations,
    fetchFinanceReservations,
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
    getCrmPhotoUrlSet,
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
