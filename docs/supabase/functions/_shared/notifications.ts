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

export function composeBookingConfirmation(
  reservation: NotificationReservation,
  options: { cancellationToken: string; siteUrl: string },
): NotificationMessage {
  const roomCopy = roomLabel(reservation);
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
      message: [
        'EcoVila: Rezervarea dvs. a fost confirmată!',
        `${roomCopy}, ${reservation.check_in} - ${reservation.check_out}`,
        `Total: ${total} (${reservation.payment_type})`,
        `Anulare (7 zile+): ${cancellationLink}`,
      ].join('\n'),
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
  const confirmationLink = `${options.siteUrl}/confirmare.html?id=${
    encodeURIComponent(reservation.id)
  }`;

  return {
    sms: {
      to: reservation.guest_phone,
      message: [
        'EcoVila: Rezervarea dvs. expiră în 5 minute.',
        `Achitați la str. Aerodromului 3 sau extindeți pe site: ${confirmationLink}`,
      ].join('\n'),
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
  return {
    sms: {
      to: reservation.guest_phone,
      message:
        'EcoVila: Rezervarea dvs. a fost anulată deoarece termenul de achitare a expirat.\nPuteți rezerva din nou pe ecovila.md',
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
  const roomCopy = roomLabel(reservation);

  return {
    sms: {
      to: reservation.guest_phone,
      message:
        `EcoVila: Rezervarea dvs. (${reservation.check_in} - ${reservation.check_out}, ${roomCopy}) a fost anulată.`,
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
  return {
    sms: {
      to: reservation.guest_phone,
      message: [
        'EcoVila: Vă așteptăm mâine! Check-in de la 13:00.',
        'Vă rugăm să rețineți: accesul cu animale de companie nu este permis pe teritoriul complexului.',
        'Adresa: str. Aerodromului 3. Ne vedem mâine!',
      ].join('\n'),
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
  const [sms, email] = await Promise.all([
    sendSms(message.sms),
    sendEmail(message.email),
  ]);

  return { sms, email };
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
      delivery_status: attemptCount >= MAX_SCHEDULED_NOTIFICATION_ATTEMPTS
        ? 'abandoned'
        : 'failed',
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
  const recorded = await recordNotificationEvent(client, reservationId, eventType, metadata);

  return { result, recorded };
}

export async function recordNotificationEvent(
  client: any,
  reservationId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
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
    });

  if (!error) {
    return true;
  }

  if (error.code === '23505') {
    return false;
  }

  throw new Error(error.message || 'Could not record notification event.');
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

    return abandoned
      ? { outcome: 'abandoned' as const }
      : { outcome: 'retry_pending' as const };
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

function roomLabel(reservation: NotificationReservation) {
  return reservation.room_number ? `Căsuța #${reservation.room_number}` : 'EcoVila';
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
