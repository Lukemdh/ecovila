import { sendEmail, sendSms } from './providers.ts';

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

export type NotificationMessage = {
  sms: {
    to: string;
    message: string;
  };
  email: {
    to: string;
    subject: string;
    html: string;
    text: string;
  };
};

export type NotificationDeliveryStatus = 'reserved' | 'sent' | 'failed' | 'abandoned';

type NotificationEventRow = {
  delivery_status: NotificationDeliveryStatus;
  attempt_count: number;
  attempted_at: string | null;
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
  options: { cancellationToken: string; siteUrl: string },
): NotificationMessage {
  const language = reservationLanguage(reservation);
  const roomCopy = roomLabel(reservation, 'ro');
  const cancellationLink = `${options.siteUrl}/anulare.html?token=${
    encodeURIComponent(options.cancellationToken)
  }`;
  const confirmationLink = `${options.siteUrl}/confirmare.html?id=${
    encodeURIComponent(reservation.id)
  }`;
  const fullName = `${reservation.guest_first_name} ${reservation.guest_last_name}`;
  const total = `${reservation.total_price} MDL`;

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
      subject: 'Confirmare rezervare EcoVila',
      text: [
        `Bună, ${fullName}.`,
        `Rezervarea dvs. pentru ${roomCopy} este înregistrată.`,
        `Perioada: ${reservation.check_in} - ${reservation.check_out}.`,
        `Total: ${total}.`,
        `Confirmare: ${confirmationLink}`,
        `Anulare 7 zile+: ${cancellationLink}`,
      ].join('\n'),
      html: reservationEmailHtml({
        title: 'Rezervarea dvs. EcoVila este confirmată',
        greeting: `Bună, ${escapeHtml(fullName)}.`,
        rows: [
          ['Cazare', roomCopy],
          ['Perioada', `${reservation.check_in} - ${reservation.check_out}`],
          ['Total', total],
          ['Tip plată', reservation.payment_type],
        ],
        body:
          'Check-in este de la ora 13:00. Vă rugăm să rețineți că accesul cu animale de companie nu este permis.',
        ctaUrl: confirmationLink,
        ctaLabel: 'Deschide confirmarea',
        secondaryUrl: cancellationLink,
        secondaryLabel: 'Link anulare',
      }),
    },
  };
}

export function composeCashExpiryReminder(
  reservation: NotificationReservation,
  options: { siteUrl: string },
): NotificationMessage {
  const language = reservationLanguage(reservation);
  const confirmationLink = `${options.siteUrl}/confirmare.html?id=${
    encodeURIComponent(reservation.id)
  }`;

  return {
    sms: {
      to: reservation.guest_phone,
      message: cashExpiryReminderSms(language, confirmationLink),
    },
    email: {
      to: reservation.guest_email,
      subject: 'Rezervarea EcoVila expiră în curând',
      text: `Rezervarea dvs. expiră în 5 minute. Deschideți confirmarea: ${confirmationLink}`,
      html: reservationEmailHtml({
        title: 'Rezervarea expiră în curând',
        greeting: `Bună, ${escapeHtml(reservation.guest_first_name)}.`,
        rows: [['Rezervare', roomLabel(reservation)]],
        body: 'Rezervarea cash expiră în 5 minute dacă nu este achitată la oficiu.',
        ctaUrl: confirmationLink,
        ctaLabel: 'Deschide confirmarea',
      }),
    },
  };
}

export function composeExpiredCashCancellation(
  reservation: NotificationReservation,
): NotificationMessage {
  const language = reservationLanguage(reservation);

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
        rows: [['Rezervare', roomLabel(reservation)]],
        body:
          'Termenul pentru achitarea cash a expirat. Puteți crea o rezervare nouă pe ecovila.md.',
      }),
    },
  };
}

export function composeCancellationConfirmation(
  reservation: NotificationReservation,
): NotificationMessage {
  const language = reservationLanguage(reservation);
  const roomCopy = roomLabel(reservation, 'ro');

  return {
    sms: {
      to: reservation.guest_phone,
      message: cancellationConfirmationSms(reservation, language),
    },
    email: {
      to: reservation.guest_email,
      subject: 'Anulare rezervare EcoVila',
      text:
        `Rezervarea dvs. (${reservation.check_in} - ${reservation.check_out}, ${roomCopy}) a fost anulată.`,
      html: reservationEmailHtml({
        title: 'Rezervarea a fost anulată',
        greeting: `Bună, ${escapeHtml(reservation.guest_first_name)}.`,
        rows: [
          ['Cazare', roomCopy],
          ['Perioada', `${reservation.check_in} - ${reservation.check_out}`],
        ],
        body: 'Camera a fost eliberată în calendarul EcoVila.',
      }),
    },
  };
}

export function composeArrivalReminder(reservation: NotificationReservation): NotificationMessage {
  const language = reservationLanguage(reservation);

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
          ['Cazare', roomLabel(reservation)],
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
    sendSms(message.sms),
    sendEmail(message.email),
  ]);

  if (sms.status === 'rejected') {
    const emailDetail = email.status === 'rejected'
      ? `; email: ${providerErrorMessage(email.reason)}`
      : '';
    throw new Error(`SMS provider failed: ${providerErrorMessage(sms.reason)}${emailDetail}`);
  }

  return {
    sms: sms.value,
    email: email.status === 'fulfilled'
      ? email.value
      : { error: providerErrorMessage(email.reason) },
  };
}

export async function reserveNotificationEvent(
  client: any,
  reservationId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  now = new Date(),
) {
  const { error } = await client
    .from('notification_events')
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
  client: any,
  reservationId: string,
  eventType: string,
  providerResponse: Record<string, unknown> = {},
) {
  const completionTime = new Date().toISOString();
  const { error } = await client
    .from('notification_events')
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
  client: any,
  reservationId: string,
  eventType: string,
  error: unknown,
  attemptCount = 1,
  now = new Date(),
) {
  const { error: updateError } = await client
    .from('notification_events')
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
  client: any,
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
  client: any,
  reservationId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  providerResponse: unknown = {},
) {
  const completionTime = new Date().toISOString();
  const { error } = await client
    .from('notification_events')
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
  client: any,
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
  client: any,
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
  client: any,
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
  client: any,
  reservationId: string,
  eventType: string,
): Promise<NotificationEventRow | null> {
  const { data, error } = await client
    .from('notification_events')
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
  client: any,
  reservationId: string,
  eventType: string,
  existing: NotificationEventRow,
  patch: Record<string, unknown>,
) {
  let query = client
    .from('notification_events')
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

function bookingConfirmationSms(input: {
  language: string;
  checkIn: string;
  checkOut: string;
}) {
  const useShortDate = input.language === 'ru';
  const date = formatSmsDate(input.checkIn, input.language, useShortDate);
  const checkOutDate = formatSmsDate(input.checkOut, input.language, useShortDate);

  if (input.language === 'ru') {
    return `Бронь: ${date}, 13.00 - ${checkOutDate}, 10.00. Вход с 13.00.`;
  }

  if (input.language === 'en') {
    return `Your reservation is confirmed: ${date}, 13.00 - ${checkOutDate}, 10.00. Access to the property: after 13.00. See you soon!`;
  }

  return `Rezervarea dvs este confirmata: ${date}, 13.00 - ${checkOutDate}, 10.00. Acces pe teritoriu: dupa 13.00. Va asteptam!`;
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

function cashExpiryReminderSms(language: string, confirmationLink: string) {
  if (language === 'ru') {
    return [
      'EcoVila: Ваше бронирование истекает через 5 минут.',
      `Оплатите по адресу ул. Аэродромулуй 3 или продлите на сайте: ${confirmationLink}`,
    ].join('\n');
  }

  if (language === 'en') {
    return [
      'EcoVila: Your reservation expires in 5 minutes.',
      `Pay at str. Aerodromului 3 or extend it on the site: ${confirmationLink}`,
    ].join('\n');
  }

  return [
    'EcoVila: Rezervarea dvs. expiră în 5 minute.',
    `Achitați la str. Aerodromului 3 sau extindeți pe site: ${confirmationLink}`,
  ].join('\n');
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

function cancellationConfirmationSms(
  reservation: NotificationReservation,
  language: string,
) {
  const useShortDate = language === 'ru';
  const checkIn = formatSmsDate(reservation.check_in, language, useShortDate);
  const checkOut = formatSmsDate(reservation.check_out, language, useShortDate);

  if (language === 'ru') {
    return `Бронь ${checkIn} - ${checkOut} отменена.`;
  }

  if (language === 'en') {
    return `Your reservation ${checkIn} - ${checkOut} was cancelled.`;
  }

  return `Rezervarea dvs ${checkIn} - ${checkOut} este anulata`;
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
