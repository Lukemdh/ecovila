import { sendEmail, sendSms } from './providers.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

export type NotificationReservation = {
  id: string;
  room_number?: number;
  check_in: string;
  check_out: string;
  total_price: number;
  payment_type: string;
  guest_email: string;
  guest_phone: string;
  guest_language?: string;
  guest_first_name: string;
  guest_last_name: string;
};

export type NotificationSms = {
  to: string;
  message: string;
};

export type NotificationEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

// `sms: null` marks an email-only notification. Guest SMS is sent once per
// booking group — one villa "owns" the notification and the rest of the group
// carries nothing — so multi-villa bookings no longer trigger one SMS + one
// email per villa. See mapNotificationOwners.
export type NotificationMessage = {
  sms: NotificationSms | null;
  email: NotificationEmail;
};

// Composers for single-reservation events whose SMS always goes out return this
// narrower shape so callers and tests can read `.sms` without a null check.
export type SmsNotificationMessage = NotificationMessage & { sms: NotificationSms };

export type NotificationGroupRow = { id: string; booking_group_id?: string | null };

/**
 * Guest notifications are sent once per booking group, not once per villa. Each
 * cron run / settlement processes a complete group together, so this returns a
 * map keyed by the group's "owner" reservation id (the lowest id in the group)
 * whose value is every reservation in that group. The owner sends one SMS plus
 * one email that aggregates the whole booking; the other reservations are
 * skipped entirely. The owner is deterministic, so the notification stays
 * exactly-once even if the batch is reprocessed.
 */
export function mapNotificationOwners<T extends NotificationGroupRow>(
  reservations: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const reservation of reservations) {
    const groupKey = reservation.booking_group_id || reservation.id;
    const members = groups.get(groupKey);

    if (members) {
      members.push(reservation);
    } else {
      groups.set(groupKey, [reservation]);
    }
  }

  const ownerToGroup = new Map<string, T[]>();

  for (const members of groups.values()) {
    const owner = members.reduce((lowest, row) => (row.id < lowest.id ? row : lowest), members[0]);
    ownerToGroup.set(owner.id, members);
  }

  return ownerToGroup;
}

/**
 * One accommodation line for a whole booking group, e.g. "Căsuța #3, Căsuța #5".
 * Falls back to the single brand label when no room numbers are known.
 */
export function aggregateRoomLabel(
  reservations: NotificationReservation[],
  language = 'ro',
): string {
  const labels = reservations
    .map((reservation) => roomLabel(reservation, language))
    .filter((label) => label !== 'EcoVila');

  if (!labels.length) {
    return 'EcoVila';
  }

  return [...new Set(labels)].join(', ');
}

/** Full booking-group total — the per-villa prices summed back together. */
export function aggregateTotalPrice(reservations: NotificationReservation[]): number {
  return reservations.reduce((sum, reservation) => sum + Number(reservation.total_price || 0), 0);
}

export type NotificationDeliveryStatus = 'reserved' | 'sent' | 'failed' | 'abandoned';

type NotificationEventRow = {
  delivery_status: NotificationDeliveryStatus;
  attempt_count: number;
  attempted_at: string | null;
};

type NotificationEventPatch = Record<string, unknown>;

type NotificationEventFilter<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  eq(column: string, value: unknown): NotificationEventFilter<T>;
  is(column: string, value: unknown): NotificationEventFilter<T>;
  select(columns: string): NotificationEventFilter<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T>>;
};

type NotificationEventsTable = {
  insert(payload: NotificationEventPatch): Promise<SupabaseQueryResult>;
  update(payload: NotificationEventPatch): NotificationEventFilter;
  select(columns: string): NotificationEventFilter<NotificationEventRow>;
};

type ScheduledNotificationOptions = {
  now?: Date;
  dispatch?: typeof dispatchNotification;
};

const MAX_SCHEDULED_NOTIFICATION_ATTEMPTS = 3;
const RESERVED_RETRY_TIMEOUT_MS = 3 * 60 * 1000;
const SUPPORTED_LANGUAGES = new Set(['ro', 'ru', 'en']);

export function composeBookingConfirmation(
  reservation: NotificationReservation,
  options: {
    cancellationToken: string;
    siteUrl: string;
    manageToken?: string;
    groupReservations?: NotificationReservation[];
  },
): SmsNotificationMessage {
  const language = reservationLanguage(reservation) as EmailLang;
  // The owner reservation's email represents the whole booking group: every
  // villa is listed and the per-villa prices are summed back to the full total.
  const group = options.groupReservations?.length ? options.groupReservations : [reservation];
  const roomCopy = aggregateRoomLabel(group, language);
  const cancellationLink = `${options.siteUrl}/anulare.html?token=${
    encodeURIComponent(options.cancellationToken)
  }`;
  const confirmationLink = confirmationUrl(options.siteUrl, reservation.id, options.manageToken);
  const firstName = titleCaseName(reservation.guest_first_name);
  const fullName = titleCaseName(
    `${reservation.guest_first_name} ${reservation.guest_last_name}`,
  );

  const email = buildConfirmationEmail({
    lang: language,
    firstName,
    fullName,
    roomCopy,
    checkIn: reservation.check_in,
    checkOut: reservation.check_out,
    totalPrice: aggregateTotalPrice(group),
    confirmationUrl: confirmationLink,
    cancellationUrl: cancellationLink,
    siteUrl: options.siteUrl,
  });

  return {
    sms: {
      to: reservation.guest_phone,
      message: bookingConfirmationSms({
        language,
        checkIn: reservation.check_in,
        checkOut: reservation.check_out,
      }),
    },
    email: {
      to: reservation.guest_email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    },
  };
}

export function composeCashExpiryReminder(
  reservation: NotificationReservation,
  options: { siteUrl: string; manageToken?: string; groupReservations?: NotificationReservation[] },
): NotificationMessage {
  const confirmationLink = confirmationUrl(options.siteUrl, reservation.id, options.manageToken);
  const group = options.groupReservations?.length ? options.groupReservations : [reservation];

  return {
    // Email-only: the "expiră în 5 minute" SMS was dropped — guests already see
    // the deadline at booking time and group bookings made it spammy.
    sms: null,
    email: {
      to: reservation.guest_email,
      subject: 'Rezervarea EcoVila expiră în curând',
      text: `Rezervarea dvs. expiră în 5 minute. Deschideți confirmarea: ${confirmationLink}`,
      html: reservationEmailHtml({
        title: 'Rezervarea expiră în curând',
        greeting: `Bună, ${escapeHtml(reservation.guest_first_name)}.`,
        rows: [['Rezervare', aggregateRoomLabel(group)]],
        body: 'Rezervarea cash expiră în 5 minute dacă nu este achitată la oficiu.',
        ctaUrl: confirmationLink,
        ctaLabel: 'Deschide confirmarea',
      }),
    },
  };
}

function confirmationUrl(siteUrl: string, reservationId: string, manageToken?: string) {
  const params = new URLSearchParams();
  params.set('id', reservationId);

  if (manageToken) {
    params.set('manage', manageToken);
  }

  return `${siteUrl}/confirmare.html?${params.toString()}`;
}

export function composeExpiredCashCancellation(
  reservation: NotificationReservation,
  options: { groupReservations?: NotificationReservation[] } = {},
): NotificationMessage {
  const language = reservationLanguage(reservation);
  const group = options.groupReservations?.length ? options.groupReservations : [reservation];

  return {
    sms: {
      to: reservation.guest_phone,
      message: expiredCashCancellationSms(language),
    },
    email: {
      to: reservation.guest_email,
      subject: 'Rezervarea EcoVila a fost anulată',
      text: 'Rezervarea dvs. a fost anulată deoarece termenul de achitare a expirat.',
      html: reservationEmailHtml({
        title: 'Rezervarea a fost anulată',
        greeting: `Bună, ${escapeHtml(reservation.guest_first_name)}.`,
        rows: [['Rezervare', aggregateRoomLabel(group, language)]],
        body:
          'Termenul pentru achitarea cash a expirat. Puteți crea o rezervare nouă pe ecovila.md.',
      }),
    },
  };
}

export function composeCancellationConfirmation(
  reservation: NotificationReservation,
  options: { siteUrl?: string } = {},
): SmsNotificationMessage {
  const language = reservationLanguage(reservation) as EmailLang;
  const roomCopy = roomLabel(reservation, language);
  const siteUrl = (options.siteUrl || 'https://ecovila.md').replace(/\/+$/, '');
  const firstName = titleCaseName(reservation.guest_first_name);
  const fullName = titleCaseName(
    `${reservation.guest_first_name} ${reservation.guest_last_name}`,
  );

  const email = buildCancellationEmail({
    lang: language,
    firstName,
    fullName,
    roomCopy,
    checkIn: reservation.check_in,
    checkOut: reservation.check_out,
    siteUrl,
  });

  return {
    sms: {
      to: reservation.guest_phone,
      message: cancellationConfirmationSms({
        checkIn: reservation.check_in,
        checkOut: reservation.check_out,
        language,
      }),
    },
    email: {
      to: reservation.guest_email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    },
  };
}

export function composeArrivalReminder(
  reservation: NotificationReservation,
  options: { groupReservations?: NotificationReservation[] } = {},
): SmsNotificationMessage {
  const language = reservationLanguage(reservation);
  const group = options.groupReservations?.length ? options.groupReservations : [reservation];

  return {
    sms: {
      to: reservation.guest_phone,
      message: arrivalReminderSms(language),
    },
    email: {
      to: reservation.guest_email,
      subject: 'Mâine vă așteptăm la EcoVila',
      text:
        'Vă așteptăm mâine la EcoVila. Check-in de la 13:00. Accesul cu animale de companie nu este permis.',
      html: reservationEmailHtml({
        title: 'Mâine vă așteptăm la EcoVila',
        greeting: `Bună, ${escapeHtml(reservation.guest_first_name)}.`,
        rows: [
          ['Cazare', aggregateRoomLabel(group, language)],
          ['Check-in', `${reservation.check_in}, de la 13:00`],
        ],
        body:
          'Vă rugăm să rețineți: accesul cu animale de companie nu este permis pe teritoriul complexului. Adresa: str. Aerodromului 3.',
      }),
    },
  };
}

export async function dispatchNotification(message: NotificationMessage) {
  const [sms, email] = await Promise.allSettled([
    message.sms ? sendSms(message.sms) : Promise.resolve({ skipped: true }),
    sendEmail(message.email),
  ]);

  if (sms.status === 'rejected') {
    const emailDetail = email.status === 'rejected'
      ? `; email: ${providerErrorMessage(email.reason)}`
      : '';
    throw new Error(`SMS provider failed: ${providerErrorMessage(sms.reason)}${emailDetail}`);
  }

  // Email-only notification (sms === null): surface a failed email so the
  // scheduled-notification retry path still runs instead of recording success.
  if (!message.sms && email.status === 'rejected') {
    throw new Error(`Email provider failed: ${providerErrorMessage(email.reason)}`);
  }

  return {
    sms: sms.value,
    email: email.status === 'fulfilled'
      ? email.value
      : { error: providerErrorMessage(email.reason) },
  };
}

export async function reserveNotificationEvent(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  now = new Date(),
) {
  const { error } = await notificationEvents(client)
    .insert({
      reservation_id: reservationId,
      event_type: eventType,
      delivery_status: 'reserved',
      attempt_count: 1,
      attempted_at: now.toISOString(),
      metadata,
    });

  if (!error) {
    return true;
  }

  if (error.code === '23505') {
    return false;
  }

  throw new Error(error.message || 'Could not reserve notification event.');
}

export async function markNotificationEventSent(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  providerResponse: Record<string, unknown> = {},
) {
  const completionTime = new Date().toISOString();
  const { error } = await notificationEvents(client)
    .update({
      delivery_status: 'sent',
      provider_response: providerResponse,
      completed_at: completionTime,
      sent_at: completionTime,
      last_error: null,
    })
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType);

  if (error) {
    throw new Error(error.message || 'Could not mark notification as sent.');
  }
}

export async function markNotificationEventFailed(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  error: unknown,
  attemptCount = 1,
  now = new Date(),
) {
  const { error: updateError } = await notificationEvents(client)
    .update({
      delivery_status: attemptCount >= MAX_SCHEDULED_NOTIFICATION_ATTEMPTS ? 'abandoned' : 'failed',
      last_error: error instanceof Error ? error.message : 'Notification failed.',
      completed_at: now.toISOString(),
    })
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType);

  if (updateError) {
    throw new Error(updateError.message || 'Could not mark notification as failed.');
  }
}

export async function dispatchAndRecordNotification(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  message: NotificationMessage,
  metadata: Record<string, unknown> = {},
) {
  const result = await dispatchNotification(message);
  const recorded = await recordNotificationEvent(
    client,
    reservationId,
    eventType,
    metadata,
    result,
  );

  return { result, recorded };
}

export async function recordNotificationEvent(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  providerResponse: unknown = {},
) {
  const completionTime = new Date().toISOString();
  const { error } = await notificationEvents(client)
    .insert({
      reservation_id: reservationId,
      event_type: eventType,
      delivery_status: 'sent',
      attempted_at: completionTime,
      completed_at: completionTime,
      sent_at: completionTime,
      metadata,
      provider_response: providerResponse,
    });

  if (!error) {
    return true;
  }

  if (error.code === '23505') {
    return false;
  }

  throw new Error(error.message || 'Could not record notification event.');
}

function providerErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Provider request failed.');
}

export async function dispatchScheduledNotificationOnce(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  message: NotificationMessage,
  metadata: Record<string, unknown> = {},
  options: ScheduledNotificationOptions = {},
) {
  const now = options.now || new Date();
  const claim = await claimScheduledNotificationAttempt(
    client,
    reservationId,
    eventType,
    metadata,
    now,
  );

  if (claim.outcome === 'sent') {
    return { sent: false, skipped_duplicate: true };
  }

  if (claim.outcome === 'abandoned') {
    return { sent: false, skipped_duplicate: false, abandoned: true };
  }

  if (claim.outcome === 'retry_pending') {
    return { sent: false, skipped_duplicate: false, retry_pending: true };
  }

  let result: Awaited<ReturnType<typeof dispatchNotification>>;

  try {
    result = await (options.dispatch || dispatchNotification)(message);
  } catch (error) {
    await markNotificationEventFailed(
      client,
      reservationId,
      eventType,
      error,
      claim.attemptCount,
    );
    throw error;
  }

  await markNotificationEventSent(client, reservationId, eventType, result);
  return { sent: true, skipped_duplicate: false, result };
}

async function claimScheduledNotificationAttempt(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  metadata: Record<string, unknown>,
  now: Date,
) {
  const existing = await readNotificationEvent(client, reservationId, eventType);

  if (!existing) {
    const reserved = await reserveNotificationEvent(
      client,
      reservationId,
      eventType,
      metadata,
      now,
    );

    if (reserved) {
      return { outcome: 'claimed' as const, attemptCount: 1 };
    }

    const concurrentlyClaimed = await readNotificationEvent(client, reservationId, eventType);

    if (!concurrentlyClaimed) {
      throw new Error('Notification event claim was not persisted.');
    }

    return claimExistingScheduledNotificationAttempt(
      client,
      reservationId,
      eventType,
      concurrentlyClaimed,
      now,
    );
  }

  return claimExistingScheduledNotificationAttempt(
    client,
    reservationId,
    eventType,
    existing,
    now,
  );
}

async function claimExistingScheduledNotificationAttempt(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  existing: NotificationEventRow,
  now: Date,
) {
  if (existing.delivery_status === 'sent') {
    return { outcome: 'sent' as const };
  }

  if (existing.delivery_status === 'abandoned') {
    return { outcome: 'abandoned' as const };
  }

  const attemptCount = Number(existing.attempt_count || 1);

  if (
    existing.delivery_status === 'reserved' &&
    !isStaleReservation(existing.attempted_at, now)
  ) {
    return { outcome: 'retry_pending' as const };
  }

  if (attemptCount >= MAX_SCHEDULED_NOTIFICATION_ATTEMPTS) {
    const abandoned = await updateScheduledNotificationIfUnchanged(
      client,
      reservationId,
      eventType,
      existing,
      {
        delivery_status: 'abandoned',
        completed_at: now.toISOString(),
      },
    );

    return abandoned ? { outcome: 'abandoned' as const } : { outcome: 'retry_pending' as const };
  }

  const nextAttemptCount = attemptCount + 1;
  const claimed = await updateScheduledNotificationIfUnchanged(
    client,
    reservationId,
    eventType,
    existing,
    {
      delivery_status: 'reserved',
      attempt_count: nextAttemptCount,
      attempted_at: now.toISOString(),
      completed_at: null,
      last_error: null,
    },
  );

  return claimed
    ? { outcome: 'claimed' as const, attemptCount: nextAttemptCount }
    : { outcome: 'retry_pending' as const };
}

async function readNotificationEvent(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
): Promise<NotificationEventRow | null> {
  const { data, error } = await notificationEvents(client)
    .select('delivery_status, attempt_count, attempted_at')
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Could not read notification event.');
  }

  return data || null;
}

async function updateScheduledNotificationIfUnchanged(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  existing: NotificationEventRow,
  patch: Record<string, unknown>,
) {
  let query = notificationEvents(client)
    .update(patch)
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType)
    .eq('delivery_status', existing.delivery_status)
    .eq('attempt_count', existing.attempt_count);

  query = existing.attempted_at === null
    ? query.is('attempted_at', null)
    : query.eq('attempted_at', existing.attempted_at);

  const { data, error } = await query
    .select('attempt_count')
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Could not claim notification retry attempt.');
  }

  return Boolean(data);
}

function notificationEvents(client: SupabaseClient) {
  return client.from('notification_events') as NotificationEventsTable;
}

function isStaleReservation(attemptedAt: string | null, now: Date) {
  if (!attemptedAt) {
    return true;
  }

  return now.getTime() - new Date(attemptedAt).getTime() >= RESERVED_RETRY_TIMEOUT_MS;
}

function reservationLanguage(reservation: NotificationReservation) {
  const language = String(reservation.guest_language || '').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(language) ? language : 'ro';
}

function roomLabel(reservation: NotificationReservation, language = 'ro') {
  if (!reservation.room_number) {
    return 'EcoVila';
  }

  if (language === 'ru') {
    return `Домик #${reservation.room_number}`;
  }

  if (language === 'en') {
    return `Villa #${reservation.room_number}`;
  }

  return `Căsuța #${reservation.room_number}`;
}

export function bookingConfirmationSms(input: {
  language: string;
  checkIn: string;
  checkOut: string;
}) {
  const date = formatSmsDate(input.checkIn, input.language);
  const checkOutDate = formatSmsDate(input.checkOut, input.language);

  if (input.language === 'ru') {
    return `Ваша бронь подтверждена: ${date} (13.00) - ${checkOutDate} (10.00) Доступ на территорию: после 13.00. Ждём вас!`;
  }

  if (input.language === 'en') {
    return `Your reservation is confirmed: ${date} (13.00) - ${checkOutDate} (10.00) Access to the property: after 13.00. See you soon!`;
  }

  return `Rezervarea dvs este confirmata: ${date} (13.00) - ${checkOutDate} (10.00) Acces pe teritoriu: dupa 13.00. Va asteptam!`;
}

function formatSmsDate(value: string, language: string, short = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return value;
  }

  const [, year, monthText, dayText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const monthName = smsMonthName(month, language, short);

  if (!monthName || day < 1 || day > 31) {
    return value;
  }

  return `${day} ${monthName} ${year}`;
}

function smsMonthName(month: number, language: string, short = false) {
  const shortMonths: Record<string, string[]> = {
    ru: [
      'янв',
      'фев',
      'мар',
      'апр',
      'мая',
      'июн',
      'июл',
      'авг',
      'сен',
      'окт',
      'ноя',
      'дек',
    ],
  };
  const months: Record<string, string[]> = {
    ro: [
      'Ianuarie',
      'Februarie',
      'Martie',
      'Aprilie',
      'Mai',
      'Iunie',
      'Iulie',
      'August',
      'Septembrie',
      'Octombrie',
      'Noiembrie',
      'Decembrie',
    ],
    ru: [
      'января',
      'февраля',
      'марта',
      'апреля',
      'мая',
      'июня',
      'июля',
      'августа',
      'сентября',
      'октября',
      'ноября',
      'декабря',
    ],
    en: [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ],
  };

  if (short) {
    return shortMonths[language]?.[month - 1] || months[language]?.[month - 1] ||
      months.ro[month - 1] || '';
  }

  return months[language]?.[month - 1] || months.ro[month - 1] || '';
}

function expiredCashCancellationSms(language: string) {
  if (language === 'ru') {
    return [
      'EcoVila: Ваше бронирование отменено, так как срок оплаты истек.',
      'Вы можете забронировать снова на ecovila.md',
    ].join('\n');
  }

  if (language === 'en') {
    return [
      'EcoVila: Your reservation was cancelled because the payment deadline expired.',
      'You can book again at ecovila.md',
    ].join('\n');
  }

  return [
    'EcoVila: Rezervarea dvs. a fost anulată deoarece termenul de achitare a expirat.',
    'Puteți rezerva din nou pe ecovila.md',
  ].join('\n');
}

export function cancellationConfirmationSms(input: {
  checkIn: string;
  checkOut: string;
  language: string;
}) {
  const language = SUPPORTED_LANGUAGES.has(input.language) ? input.language : 'ro';
  const checkIn = formatSmsDate(input.checkIn, language);
  const checkOut = formatSmsDate(input.checkOut, language);

  if (language === 'ru') {
    return `Ваша бронь отменена: ${checkIn} - ${checkOut}. Надеемся снова увидеть вас!`;
  }

  if (language === 'en') {
    return `Your reservation is cancelled: ${checkIn} - ${checkOut}. We hope to see you again soon!`;
  }

  return `Rezervarea dvs este anulata: ${checkIn} - ${checkOut}. Speram sa ne mai vedem in curand!`;
}

export function bookingChangeSms(input: {
  language: string;
  newAdults: number;
  newKids: number;
  difference: number;
}) {
  const language = SUPPORTED_LANGUAGES.has(input.language) ? input.language : 'ro';
  const amount = formatEmailMoney(input.difference);
  const free = !(Number(input.difference) > 0);
  const adults = Math.max(0, Math.trunc(input.newAdults));
  const kids = Math.max(0, Math.trunc(input.newKids));

  if (language === 'ru') {
    const guests = `${adults} взрослых${kids ? ` и ${kids} детей` : ''}`;
    const tail = free ? '' : ` Разница ${amount} MDL оплачена.`;
    return `EcoVila: ваша бронь обновлена. Теперь включает ${guests}.${tail}`;
  }

  if (language === 'en') {
    const guests = `${adults} adults${kids ? ` and ${kids} children` : ''}`;
    const tail = free ? '' : ` The ${amount} MDL difference has been paid.`;
    return `EcoVila: your reservation was updated. It now includes ${guests}.${tail}`;
  }

  const guests = `${adults} adulti${kids ? ` si ${kids} copii` : ''}`;
  const tail = free ? '' : ` Diferenta de ${amount} MDL a fost achitata.`;
  return `EcoVila: rezervarea ta a fost actualizata. Acum include ${guests}.${tail}`;
}

function arrivalReminderSms(language: string) {
  if (language === 'ru') {
    return 'Ждем вас завтра в EcoVila! Заезд и доступ на территорию с 13.00. Вопросы: 060120220';
  }

  if (language === 'en') {
    return 'We look forward to welcoming you tomorrow at EcoVila! Check-in and property access from 13.00. Questions: 060120220';
  }

  return 'Va asteptam maine la EcoVila! Check-in si acces pe teritoriu - de la 13.00. Pentru intrebari: 060120220';
}

export type EmailLang = 'ro' | 'ru' | 'en';

const EMAIL_PHONE_DISPLAY = '+373 60 120 220';
const EMAIL_PHONE_HREF = 'tel:+37360120220';
const EMAIL_LOGO_PATH = '/assets/logo.png';

const EMAIL_COLORS = {
  bg: '#F7F4EF',
  card: '#FFFAF2',
  white: '#FFFFFF',
  green: '#5F7A3A',
  greenDark: '#4B6529',
  greenSoft: '#EEF3E6',
  cocoa: '#8B7564',
  ink: '#332F2C',
  muted: '#6E6760',
  border: '#E7DFD2',
  row: '#EFE8DC',
};

const EMAIL_MONTHS: Record<EmailLang, string[]> = {
  ro: [
    'ianuarie',
    'februarie',
    'martie',
    'aprilie',
    'mai',
    'iunie',
    'iulie',
    'august',
    'septembrie',
    'octombrie',
    'noiembrie',
    'decembrie',
  ],
  ru: [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
};

export function normalizeEmailLang(value: unknown): EmailLang {
  const lang = String(value || '').trim().toLowerCase();
  return lang === 'ru' || lang === 'en' ? lang : 'ro';
}

export function titleCaseName(value: string): string {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase())
    .join(' ');
}

function formatEmailDate(value: string, lang: EmailLang): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) {
    return String(value || '');
  }

  const [, year, monthText, dayText] = match;
  const monthName = EMAIL_MONTHS[lang]?.[Number(monthText) - 1];
  const day = Number(dayText);

  if (!monthName || day < 1 || day > 31) {
    return value;
  }

  return `${day} ${monthName} ${year}`;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }

  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function nightsLabel(count: number, lang: EmailLang): string {
  if (lang === 'ru') {
    const mod10 = count % 10;
    const mod100 = count % 100;
    let word = 'ночей';

    if (mod10 === 1 && mod100 !== 11) {
      word = 'ночь';
    } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      word = 'ночи';
    }

    return `${count} ${word}`;
  }

  if (lang === 'en') {
    return `${count} ${count === 1 ? 'night' : 'nights'}`;
  }

  return `${count} ${count === 1 ? 'noapte' : 'nopți'}`;
}

function formatEmailMoney(amount: number): string {
  const value = Math.round(Number(amount) || 0);
  const grouped = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return value < 0 ? `-${grouped}` : grouped;
}

type EmailRow = { label: string; value: string; total?: boolean };

type EmailInfoCard = {
  title: string;
  lines: string[];
  phoneLead: string;
};

function renderReservationEmail(input: {
  lang: EmailLang;
  siteUrl: string;
  preheader: string;
  tagline: string;
  badgeSymbol: string;
  badgeBg: string;
  heading: string;
  greetingHtml: string;
  intro: string;
  rows: EmailRow[];
  primary?: { label: string; url: string };
  secondary?: { label: string; url: string };
  info?: EmailInfoCard;
  closing: string;
}): string {
  const c = EMAIL_COLORS;
  const logoUrl = `${input.siteUrl}${EMAIL_LOGO_PATH}`;

  const rowsHtml = input.rows
    .map((row, index) => {
      const isLast = index === input.rows.length - 1;

      if (row.total) {
        return `<tr>
                <td style="padding:18px 20px; background:${c.greenSoft}; font-size:16px; font-weight:700; color:${c.ink};">${
          escapeHtml(row.label)
        }</td>
                <td align="right" style="padding:18px 20px; background:${c.greenSoft}; font-size:22px; line-height:1.1; font-weight:800; color:${c.greenDark}; white-space:nowrap;">${
          escapeHtml(row.value)
        }</td>
              </tr>`;
      }

      const border = isLast ? '' : ` border-bottom:1px solid ${c.row};`;
      return `<tr>
              <td style="padding:14px 20px;${border} font-size:15px; color:${c.muted};">${
        escapeHtml(row.label)
      }</td>
              <td align="right" style="padding:14px 20px;${border} font-size:15px; font-weight:600; color:${c.ink};">${
        escapeHtml(row.value)
      }</td>
            </tr>`;
    })
    .join('');

  const primaryHtml = input.primary
    ? `<tr>
            <td align="center" style="padding:26px 0 8px 0;">
              <a href="${
      escapeAttribute(input.primary.url)
    }" style="display:inline-block; background:${c.green}; color:#ffffff; text-decoration:none; font-size:16px; font-weight:700; line-height:1; padding:16px 36px; border-radius:999px;">${
      escapeHtml(input.primary.label)
    }</a>
            </td>
          </tr>`
    : '';

  const secondaryHtml = input.secondary
    ? `<tr>
            <td align="center" style="padding:6px 0 2px 0;">
              <a href="${
      escapeAttribute(input.secondary.url)
    }" style="color:${c.muted}; font-size:14px; text-decoration:underline;">${
      escapeHtml(input.secondary.label)
    }</a>
            </td>
          </tr>`
    : '';

  const infoHtml = input.info
    ? `<tr>
          <td style="padding-top:18px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${c.card}; border:1px solid ${c.border}; border-radius:18px;">
              <tr>
                <td style="padding:18px 22px;">
                  <p style="margin:0 0 10px 0; font-size:15px; line-height:1.5; color:${c.ink};"><strong>${
      escapeHtml(input.info.title)
    }</strong></p>
                  ${
      input.info.lines
        .map(
          (line) =>
            `<p style="margin:0 0 6px 0; font-size:14px; line-height:1.5; color:${c.muted};">${
              escapeHtml(line)
            }</p>`,
        )
        .join('')
    }
                  <p style="margin:6px 0 0 0; font-size:14px; line-height:1.5; color:${c.muted};">${
      escapeHtml(input.info.phoneLead)
    } <a href="${EMAIL_PHONE_HREF}" style="color:${c.green}; font-weight:700; text-decoration:none;">${EMAIL_PHONE_DISPLAY}</a>.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>`
    : '';

  return [
    '<!doctype html>',
    `<html lang="${input.lang}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light only">',
    `<title>${escapeHtml(input.heading)}</title>`,
    '</head>',
    `<body style="margin:0; padding:0; background:${c.bg}; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color:${c.ink};">`,
    `<div style="display:none; max-height:0; overflow:hidden; opacity:0; color:${c.bg};">${
      escapeHtml(input.preheader)
    }</div>`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${c.bg}; margin:0; padding:0;">`,
    '<tr>',
    '<td align="center" style="padding:28px 14px;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px; width:100%;">',
    '<tr>',
    '<td align="center" style="padding:8px 18px 16px 18px;">',
    `<img src="${
      escapeAttribute(logoUrl)
    }" width="148" alt="EcoVila" style="display:block; max-width:148px; height:auto; border:0; margin:0 auto;">`,
    `<div style="font-size:12px; letter-spacing:2px; text-transform:uppercase; color:${c.cocoa}; margin-top:12px;">${
      escapeHtml(input.tagline)
    }</div>`,
    '</td>',
    '</tr>',
    '<tr>',
    `<td style="background:${c.card}; border:1px solid ${c.border}; border-radius:24px; padding:30px 24px;">`,
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">',
    '<tr>',
    '<td align="center" style="padding-bottom:14px;">',
    `<div style="width:56px; height:56px; line-height:56px; border-radius:50%; background:${input.badgeBg}; color:#ffffff; font-size:30px; font-weight:700; text-align:center;">${input.badgeSymbol}</div>`,
    '</td>',
    '</tr>',
    '<tr>',
    '<td align="center" style="padding:0 6px;">',
    `<h1 style="margin:0; font-size:27px; line-height:1.22; font-weight:700; color:${c.ink};">${
      escapeHtml(input.heading)
    }</h1>`,
    '</td>',
    '</tr>',
    '<tr>',
    '<td align="center" style="padding:16px 6px 22px 6px;">',
    `<p style="margin:0 0 6px 0; font-size:18px; line-height:1.4; font-weight:600; color:${c.cocoa};">${input.greetingHtml}</p>`,
    `<p style="margin:0; font-size:15px; line-height:1.55; color:${c.muted};">${
      escapeHtml(input.intro)
    }</p>`,
    '</td>',
    '</tr>',
    '<tr>',
    `<td style="background:${c.white}; border:1px solid ${c.border}; border-radius:18px; overflow:hidden;">`,
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">',
    rowsHtml,
    '</table>',
    '</td>',
    '</tr>',
    primaryHtml,
    secondaryHtml,
    '</table>',
    '</td>',
    '</tr>',
    infoHtml,
    '<tr>',
    '<td align="center" style="padding:26px 20px 4px 20px;">',
    `<p style="margin:0; font-size:18px; line-height:1.5; color:${c.cocoa}; font-weight:600;">${
      escapeHtml(input.closing)
    }</p>`,
    `<p style="margin:12px 0 0 0; font-size:12px; line-height:1.5; color:#9a9085;">EcoVila</p>`,
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}

const CONFIRM_COPY: Record<EmailLang, {
  subject: string;
  preheader: string;
  tagline: string;
  heading: string;
  greeting: (name: string) => string;
  greetingFallback: string;
  intro: string;
  labels: {
    checkIn: string;
    checkOut: string;
    duration: string;
    accommodation: string;
    total: string;
  };
  cta: string;
  cancel: string;
  cancelTextLabel: string;
  info: { title: string; lines: string[]; phoneLead: string };
  closing: string;
  textDetails: string;
  textArrival: string;
}> = {
  ro: {
    subject: 'Rezervarea ta la EcoVila este confirmată',
    preheader: 'Detaliile rezervării tale și informații utile pentru sosire.',
    tagline: 'Odihnă all-inclusive la Orheiul Vechi',
    heading: 'Rezervarea ta la EcoVila este confirmată',
    greeting: (name) => `Bună, ${name}!`,
    greetingFallback: 'Bună!',
    intro: 'Îți mulțumim pentru rezervare. Ne bucurăm să te primim la EcoVila.',
    labels: {
      checkIn: 'Check-in',
      checkOut: 'Check-out',
      duration: 'Durată',
      accommodation: 'Cazare',
      total: 'Total',
    },
    cta: 'Vezi rezervarea',
    cancel: 'Anulează rezervarea',
    cancelTextLabel: 'Anulare 20 zile+',
    info: {
      title: 'Accesul pe teritoriu este permis după ora 13:00.',
      lines: ['Check-in de la 13:00.', 'Check-out până la 10:00.'],
      phoneLead: 'Pentru întrebări ne poți suna la',
    },
    closing: 'Te așteptăm cu drag la EcoVila.',
    textDetails: 'Detaliile rezervării',
    textArrival: 'Informații utile',
  },
  ru: {
    subject: 'Ваша бронь в EcoVila подтверждена',
    preheader: 'Детали вашей брони и полезная информация к заезду.',
    tagline: 'All-inclusive отдых в Орхеюл Векь',
    heading: 'Ваша бронь в EcoVila подтверждена',
    greeting: (name) => `Здравствуйте, ${name}!`,
    greetingFallback: 'Здравствуйте!',
    intro: 'Спасибо за бронирование. Будем рады встретить вас в EcoVila.',
    labels: {
      checkIn: 'Заезд',
      checkOut: 'Выезд',
      duration: 'Длительность',
      accommodation: 'Размещение',
      total: 'Итого',
    },
    cta: 'Открыть бронь',
    cancel: 'Отменить бронь',
    cancelTextLabel: 'Отмена (от 20 дней)',
    info: {
      title: 'Доступ на территорию открыт после 13:00.',
      lines: ['Заезд с 13:00.', 'Выезд до 10:00.'],
      phoneLead: 'По вопросам звоните нам по номеру',
    },
    closing: 'Будем рады видеть вас в EcoVila.',
    textDetails: 'Детали брони',
    textArrival: 'Полезная информация',
  },
  en: {
    subject: 'Your EcoVila reservation is confirmed',
    preheader: 'Your reservation details and helpful arrival information.',
    tagline: 'All-inclusive escape at Orheiul Vechi',
    heading: 'Your EcoVila reservation is confirmed',
    greeting: (name) => `Hi ${name}!`,
    greetingFallback: 'Hello!',
    intro: 'Thank you for your reservation. We look forward to welcoming you to EcoVila.',
    labels: {
      checkIn: 'Check-in',
      checkOut: 'Check-out',
      duration: 'Duration',
      accommodation: 'Accommodation',
      total: 'Total',
    },
    cta: 'View reservation',
    cancel: 'Cancel reservation',
    cancelTextLabel: 'Cancellation (20+ days)',
    info: {
      title: 'Access to the property opens after 13:00.',
      lines: ['Check-in from 13:00.', 'Check-out until 10:00.'],
      phoneLead: 'For any questions, call us at',
    },
    closing: 'We look forward to welcoming you to EcoVila.',
    textDetails: 'Reservation details',
    textArrival: 'Helpful information',
  },
};

const CANCEL_COPY: Record<EmailLang, {
  subject: string;
  preheader: string;
  tagline: string;
  heading: string;
  greeting: (name: string) => string;
  greetingFallback: string;
  intro: string;
  labels: { period: string; duration: string; accommodation: string };
  cta: string;
  closing: string;
  textDetails: string;
}> = {
  ro: {
    subject: 'Rezervarea ta la EcoVila a fost anulată',
    preheader: 'Rezervarea a fost anulată. Te poți întoarce la noi oricând.',
    tagline: 'Odihnă all-inclusive la Orheiul Vechi',
    heading: 'Rezervarea ta a fost anulată',
    greeting: (name) => `Bună, ${name}.`,
    greetingFallback: 'Bună.',
    intro:
      'Rezervarea de mai jos a fost anulată, iar camera a fost eliberată în calendarul EcoVila.',
    labels: { period: 'Perioada', duration: 'Durată', accommodation: 'Cazare' },
    cta: 'Rezervează din nou',
    closing: 'Sperăm să te revedem curând la EcoVila.',
    textDetails: 'Rezervarea anulată',
  },
  ru: {
    subject: 'Ваша бронь в EcoVila отменена',
    preheader: 'Бронь отменена. Вы всегда можете вернуться к нам.',
    tagline: 'All-inclusive отдых в Орхеюл Векь',
    heading: 'Ваша бронь отменена',
    greeting: (name) => `Здравствуйте, ${name}.`,
    greetingFallback: 'Здравствуйте.',
    intro: 'Бронь, указанная ниже, отменена, и домик снова свободен в календаре EcoVila.',
    labels: { period: 'Период', duration: 'Длительность', accommodation: 'Размещение' },
    cta: 'Забронировать снова',
    closing: 'Будем рады снова видеть вас в EcoVila.',
    textDetails: 'Отменённая бронь',
  },
  en: {
    subject: 'Your EcoVila reservation has been cancelled',
    preheader: 'Your reservation was cancelled. You are welcome back anytime.',
    tagline: 'All-inclusive escape at Orheiul Vechi',
    heading: 'Your reservation has been cancelled',
    greeting: (name) => `Hi ${name},`,
    greetingFallback: 'Hello,',
    intro:
      'The reservation below has been cancelled and the room is free again in the EcoVila calendar.',
    labels: { period: 'Dates', duration: 'Duration', accommodation: 'Accommodation' },
    cta: 'Book again',
    closing: 'We hope to welcome you back to EcoVila soon.',
    textDetails: 'Cancelled reservation',
  },
};

export function buildConfirmationEmail(args: {
  lang: EmailLang;
  firstName: string;
  fullName: string;
  roomCopy: string;
  checkIn: string;
  checkOut: string;
  totalPrice: number;
  confirmationUrl: string;
  cancellationUrl: string;
  siteUrl: string;
}): { subject: string; text: string; html: string } {
  const copy = CONFIRM_COPY[args.lang];
  const checkInLabel = formatEmailDate(args.checkIn, args.lang);
  const checkOutLabel = formatEmailDate(args.checkOut, args.lang);
  const stay = nightsLabel(nightsBetween(args.checkIn, args.checkOut), args.lang);
  const totalLabel = `${formatEmailMoney(args.totalPrice)} MDL`;
  const greetingText = args.firstName ? copy.greeting(args.firstName) : copy.greetingFallback;
  const greetingHtml = args.firstName
    ? copy.greeting(escapeHtml(args.firstName))
    : copy.greetingFallback;

  const rows: EmailRow[] = [
    { label: copy.labels.checkIn, value: checkInLabel },
    { label: copy.labels.checkOut, value: checkOutLabel },
    { label: copy.labels.duration, value: stay },
    { label: copy.labels.accommodation, value: args.roomCopy },
    { label: copy.labels.total, value: totalLabel, total: true },
  ];

  const html = renderReservationEmail({
    lang: args.lang,
    siteUrl: args.siteUrl,
    preheader: copy.preheader,
    tagline: copy.tagline,
    badgeSymbol: '✓',
    badgeBg: EMAIL_COLORS.green,
    heading: copy.heading,
    greetingHtml,
    intro: copy.intro,
    rows,
    primary: { label: copy.cta, url: args.confirmationUrl },
    secondary: { label: copy.cancel, url: args.cancellationUrl },
    info: copy.info,
    closing: copy.closing,
  });

  const text = [
    copy.heading,
    '',
    greetingText,
    '',
    copy.intro,
    '',
    copy.textDetails,
    `${copy.labels.checkIn}: ${checkInLabel}`,
    `${copy.labels.checkOut}: ${checkOutLabel}`,
    `${copy.labels.duration}: ${stay}`,
    `${copy.labels.accommodation}: ${args.roomCopy}`,
    `${copy.labels.total}: ${totalLabel}`,
    '',
    `${copy.cta}: ${args.confirmationUrl}`,
    `${copy.cancelTextLabel}: ${args.cancellationUrl}`,
    '',
    copy.textArrival,
    copy.info.title,
    ...copy.info.lines,
    `${copy.info.phoneLead} ${EMAIL_PHONE_DISPLAY}.`,
    '',
    copy.closing,
  ].join('\n');

  return { subject: copy.subject, text, html };
}

export function buildCancellationEmail(args: {
  lang: EmailLang;
  firstName: string;
  fullName: string;
  roomCopy: string;
  checkIn: string;
  checkOut: string;
  siteUrl: string;
}): { subject: string; text: string; html: string } {
  const copy = CANCEL_COPY[args.lang];
  const period = `${formatEmailDate(args.checkIn, args.lang)} – ${
    formatEmailDate(args.checkOut, args.lang)
  }`;
  const stay = nightsLabel(nightsBetween(args.checkIn, args.checkOut), args.lang);
  const rebookUrl = `${args.siteUrl}/rezervari.html`;
  const greetingText = args.firstName ? copy.greeting(args.firstName) : copy.greetingFallback;
  const greetingHtml = args.firstName
    ? copy.greeting(escapeHtml(args.firstName))
    : copy.greetingFallback;

  const rows: EmailRow[] = [
    { label: copy.labels.period, value: period },
    { label: copy.labels.duration, value: stay },
    { label: copy.labels.accommodation, value: args.roomCopy },
  ];

  const html = renderReservationEmail({
    lang: args.lang,
    siteUrl: args.siteUrl,
    preheader: copy.preheader,
    tagline: copy.tagline,
    badgeSymbol: '✕',
    badgeBg: EMAIL_COLORS.cocoa,
    heading: copy.heading,
    greetingHtml,
    intro: copy.intro,
    rows,
    primary: { label: copy.cta, url: rebookUrl },
    closing: copy.closing,
  });

  const text = [
    copy.heading,
    '',
    greetingText,
    '',
    copy.intro,
    '',
    copy.textDetails,
    `${copy.labels.period}: ${period}`,
    `${copy.labels.duration}: ${stay}`,
    `${copy.labels.accommodation}: ${args.roomCopy}`,
    '',
    `${copy.cta}: ${rebookUrl}`,
    '',
    copy.closing,
  ].join('\n');

  return { subject: copy.subject, text, html };
}

export function buildBookingChangeEmail(args: {
  lang: EmailLang;
  firstName: string;
  roomCopy: string;
  checkIn: string;
  checkOut: string;
  newAdults: number;
  newKids: number;
  addedAdults: number;
  addedKids: number;
  difference: number;
  siteUrl: string;
  confirmationUrl?: string;
}): { subject: string; text: string; html: string } {
  const copy = CHANGE_COPY[args.lang];
  const checkInLabel = formatEmailDate(args.checkIn, args.lang);
  const checkOutLabel = formatEmailDate(args.checkOut, args.lang);
  const stay = nightsLabel(nightsBetween(args.checkIn, args.checkOut), args.lang);
  const guestsLabel = partyLabelForEmail(args.lang, args.newAdults, args.newKids);
  const addedLabel = partyLabelForEmail(args.lang, args.addedAdults, args.addedKids);
  const differenceLabel = Number(args.difference) > 0
    ? `${formatEmailMoney(args.difference)} MDL`
    : copy.freeLabel;
  const greetingText = args.firstName ? copy.greeting(args.firstName) : copy.greetingFallback;
  const greetingHtml = args.firstName
    ? copy.greeting(escapeHtml(args.firstName))
    : copy.greetingFallback;

  const rows: EmailRow[] = [
    { label: copy.labels.checkIn, value: checkInLabel },
    { label: copy.labels.checkOut, value: checkOutLabel },
    { label: copy.labels.duration, value: stay },
    { label: copy.labels.accommodation, value: args.roomCopy },
    { label: copy.labels.added, value: addedLabel },
    { label: copy.labels.guests, value: guestsLabel },
    { label: copy.labels.difference, value: differenceLabel, total: true },
  ];

  const html = renderReservationEmail({
    lang: args.lang,
    siteUrl: args.siteUrl,
    preheader: copy.preheader,
    tagline: copy.tagline,
    badgeSymbol: '✓',
    badgeBg: EMAIL_COLORS.green,
    heading: copy.heading,
    greetingHtml,
    intro: copy.intro,
    rows,
    primary: args.confirmationUrl ? { label: copy.cta, url: args.confirmationUrl } : undefined,
    info: copy.info,
    closing: copy.closing,
  });

  const text = [
    copy.heading,
    '',
    greetingText,
    '',
    copy.intro,
    '',
    copy.textDetails,
    `${copy.labels.checkIn}: ${checkInLabel}`,
    `${copy.labels.checkOut}: ${checkOutLabel}`,
    `${copy.labels.duration}: ${stay}`,
    `${copy.labels.accommodation}: ${args.roomCopy}`,
    `${copy.labels.added}: ${addedLabel}`,
    `${copy.labels.guests}: ${guestsLabel}`,
    `${copy.labels.difference}: ${differenceLabel}`,
    '',
    ...(args.confirmationUrl ? [`${copy.cta}: ${args.confirmationUrl}`, ''] : []),
    copy.closing,
  ].join('\n');

  return { subject: copy.subject, text, html };
}

function partyLabelForEmail(lang: EmailLang, adults: number, kids: number): string {
  const a = Math.max(0, Math.trunc(adults));
  const k = Math.max(0, Math.trunc(kids));

  if (lang === 'ru') {
    const adultsLabel = `${a} ${a === 1 ? 'взрослый' : 'взрослых'}`;
    return k ? `${adultsLabel} · ${k} ${k === 1 ? 'ребёнок' : 'детей'}` : adultsLabel;
  }
  if (lang === 'en') {
    const adultsLabel = `${a} ${a === 1 ? 'adult' : 'adults'}`;
    return k ? `${adultsLabel} · ${k} ${k === 1 ? 'child' : 'children'}` : adultsLabel;
  }
  const adultsLabel = `${a} ${a === 1 ? 'adult' : 'adulți'}`;
  return k ? `${adultsLabel} · ${k} ${k === 1 ? 'copil' : 'copii'}` : adultsLabel;
}

const CHANGE_COPY: Record<EmailLang, {
  subject: string;
  preheader: string;
  tagline: string;
  heading: string;
  greeting: (name: string) => string;
  greetingFallback: string;
  intro: string;
  labels: {
    checkIn: string;
    checkOut: string;
    duration: string;
    accommodation: string;
    added: string;
    guests: string;
    difference: string;
  };
  cta: string;
  freeLabel: string;
  info: { title: string; lines: string[]; phoneLead: string };
  closing: string;
  textDetails: string;
}> = {
  ro: {
    subject: 'Rezervarea ta la EcoVila a fost actualizată',
    preheader: 'Am adăugat persoanele la rezervarea ta și am încasat diferența.',
    tagline: 'Odihnă all-inclusive la Orheiul Vechi',
    heading: 'Rezervarea ta a fost actualizată',
    greeting: (name) => `Bună, ${name}!`,
    greetingFallback: 'Bună!',
    intro: 'Am adăugat persoanele solicitate la rezervarea ta. Mai jos găsești detaliile actualizate.',
    labels: {
      checkIn: 'Check-in',
      checkOut: 'Check-out',
      duration: 'Durată',
      accommodation: 'Cazare',
      added: 'Persoane adăugate',
      guests: 'Oaspeți acum',
      difference: 'Diferență achitată',
    },
    cta: 'Vezi rezervarea',
    freeLabel: 'Gratuit',
    info: {
      title: 'Accesul pe teritoriu este permis după ora 13:00.',
      lines: ['Check-in de la 13:00.', 'Check-out până la 10:00.'],
      phoneLead: 'Pentru întrebări ne poți suna la',
    },
    closing: 'Te așteptăm cu drag la EcoVila.',
    textDetails: 'Detaliile actualizate',
  },
  ru: {
    subject: 'Ваша бронь в EcoVila обновлена',
    preheader: 'Мы добавили гостей к вашей брони и приняли оплату разницы.',
    tagline: 'All-inclusive отдых в Орхеюл Векь',
    heading: 'Ваша бронь обновлена',
    greeting: (name) => `Здравствуйте, ${name}!`,
    greetingFallback: 'Здравствуйте!',
    intro: 'Мы добавили запрошенных гостей к вашей брони. Ниже — обновлённые детали.',
    labels: {
      checkIn: 'Заезд',
      checkOut: 'Выезд',
      duration: 'Длительность',
      accommodation: 'Размещение',
      added: 'Добавлено гостей',
      guests: 'Гостей теперь',
      difference: 'Оплачена разница',
    },
    cta: 'Открыть бронь',
    freeLabel: 'Бесплатно',
    info: {
      title: 'Доступ на территорию открыт после 13:00.',
      lines: ['Заезд с 13:00.', 'Выезд до 10:00.'],
      phoneLead: 'По вопросам звоните нам по номеру',
    },
    closing: 'Будем рады видеть вас в EcoVila.',
    textDetails: 'Обновлённые детали',
  },
  en: {
    subject: 'Your EcoVila reservation was updated',
    preheader: 'We added the guests to your reservation and collected the difference.',
    tagline: 'All-inclusive escape at Orheiul Vechi',
    heading: 'Your reservation was updated',
    greeting: (name) => `Hi ${name}!`,
    greetingFallback: 'Hello!',
    intro: 'We added the requested guests to your reservation. Here are the updated details.',
    labels: {
      checkIn: 'Check-in',
      checkOut: 'Check-out',
      duration: 'Duration',
      accommodation: 'Accommodation',
      added: 'Guests added',
      guests: 'Guests now',
      difference: 'Difference paid',
    },
    cta: 'View reservation',
    freeLabel: 'Free',
    info: {
      title: 'Access to the property opens after 13:00.',
      lines: ['Check-in from 13:00.', 'Check-out until 10:00.'],
      phoneLead: 'For any questions, call us at',
    },
    closing: 'We look forward to welcoming you to EcoVila.',
    textDetails: 'Updated details',
  },
};

function reservationEmailHtml(input: {
  title: string;
  greeting: string;
  rows: Array<[string, string]>;
  body: string;
  ctaUrl?: string;
  ctaLabel?: string;
  secondaryUrl?: string;
  secondaryLabel?: string;
}) {
  const rows = input.rows
    .map(([label, value]) => {
      return `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
    })
    .join('');
  const cta = input.ctaUrl
    ? `<p><a href="${escapeAttribute(input.ctaUrl)}">${
      escapeHtml(input.ctaLabel || 'Deschide')
    }</a></p>`
    : '';
  const secondary = input.secondaryUrl
    ? `<p><a href="${escapeAttribute(input.secondaryUrl)}">${
      escapeHtml(input.secondaryLabel || 'Link')
    }</a></p>`
    : '';

  return [
    '<!doctype html>',
    '<html><body>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p>${input.greeting}</p>`,
    `<table>${rows}</table>`,
    `<p>${escapeHtml(input.body)}</p>`,
    cta,
    secondary,
    '</body></html>',
  ].join('');
}

function escapeHtml(value: string) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
