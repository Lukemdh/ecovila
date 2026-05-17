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

export type NotificationDeliveryStatus = 'reserved' | 'sent' | 'failed';

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
) {
  const { error } = await client
    .from('notification_events')
    .insert({
      reservation_id: reservationId,
      event_type: eventType,
      delivery_status: 'reserved',
      attempted_at: new Date().toISOString(),
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
) {
  const { error: updateError } = await client
    .from('notification_events')
    .update({
      delivery_status: 'failed',
      last_error: error instanceof Error ? error.message : 'Notification failed.',
      completed_at: new Date().toISOString(),
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
  const reserved = await reserveNotificationEvent(client, reservationId, eventType, metadata);

  if (!reserved) {
    return { sent: false, skipped_duplicate: true };
  }

  try {
    const result = await dispatchNotification(message);
    await markNotificationEventSent(client, reservationId, eventType, result);
    return { sent: true, skipped_duplicate: false, result };
  } catch (error) {
    await markNotificationEventFailed(client, reservationId, eventType, error);
    throw error;
  }
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
