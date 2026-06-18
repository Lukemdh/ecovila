import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  createMaibCheckout,
  createMaibMiaQr,
  getMaibCallbackUrl,
  getMaibMiaCallbackUrl,
} from '../_shared/maib.ts';
import {
  assertEligibleForChange,
  attachChangePayment,
  CHANGE_PAYMENT_MINUTES,
  insertChangeRow,
  loadBookingGroupForChange,
  minutesFromNowIso,
  quoteBookingChange,
  settleChangePaid,
  supersedeOpenChanges,
  validateManageTokenPhone,
} from '../_shared/reservationChanges.ts';

// Guest adds adults/children to a confirmed booking and pays only the price
// difference (ADR-057). The party fit + difference are recomputed server-side;
// the browser quote is advisory. A +373 guest pays via MIA QR, everyone else
// via card Checkout. A zero difference (only free young children) is applied
// instantly with no payment.
Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const manageToken = String(body?.manageToken || '').trim();
    const reservationId = String(body?.reservationId || '').trim();

    if (!manageToken || !reservationId) {
      throw new HttpError(400, 'manageToken and reservationId are required.');
    }

    const client = createServiceClient();
    const phone = await validateManageTokenPhone(client, manageToken);
    const reservations = await loadBookingGroupForChange(client, reservationId, phone);
    assertEligibleForChange(reservations);

    const quote = await quoteBookingChange(client, {
      reservations,
      newAdults: Number(body?.adults),
      newKidsAges: Array.isArray(body?.kidsAges) ? body.kidsAges : [],
    });

    const bookingGroupId = String(reservations[0].booking_group_id);
    const reservationIds = reservations.map((row) => String(row.id));
    await supersedeOpenChanges(client, bookingGroupId);

    // Free addition (e.g. an infant): no payment, apply immediately.
    if (quote.difference === 0) {
      const change = await insertChangeRow(client, {
        bookingGroupId,
        reservationIds,
        quote,
        paymentRail: null,
        status: 'pending',
        expiresAt: null,
        paidAt: null,
        appliedAt: null,
      });
      await settleChangePaid(client, change, new Date().toISOString(), 'change-create-free');

      return jsonResponse(
        { ok: true, applied: true, difference: 0, status: 'paid', changeId: change.id },
        {},
        request,
      );
    }

    const rail = phone.startsWith('+373') ? 'mia' : 'card';
    const expiresAt = minutesFromNowIso(CHANGE_PAYMENT_MINUTES);
    const change = await insertChangeRow(client, {
      bookingGroupId,
      reservationIds,
      quote,
      paymentRail: rail,
      status: 'pending',
      expiresAt,
      paidAt: null,
      appliedAt: null,
    });

    if (rail === 'mia') {
      const qr = await createMaibMiaQr({
        amount: quote.difference,
        orderId: change.id,
        description: `EcoVila add guests ${change.id}`,
        callbackUrl: getMaibMiaCallbackUrl(),
        expiresAt,
      });
      await attachChangePayment(client, change.id, {
        payId: qr.qrId,
        checkoutUrl: qr.url,
        expiresAt: qr.expiresAt || expiresAt,
        raw: qr.raw,
      });

      return jsonResponse(
        {
          ok: true,
          rail: 'mia',
          changeId: change.id,
          qrUrl: qr.url,
          expiresAt: qr.expiresAt || expiresAt,
          amount: quote.difference,
        },
        {},
        request,
      );
    }

    const primary = reservations[0];
    const successUrl = changeReturnUrl(reservationId, manageToken, 'success');
    const failUrl = changeReturnUrl(reservationId, manageToken, 'failed');
    const checkout = await createMaibCheckout({
      amount: quote.difference,
      // The change id is the MAIB order id so the callback routes this payment
      // to its change row, never to the booking's original maib_payments row.
      bookingGroupId: change.id,
      description: `EcoVila add guests ${change.id}`,
      guestEmail: String(primary.guest_email || ''),
      guestName: `${primary.guest_first_name || ''} ${primary.guest_last_name || ''}`.trim(),
      guestPhone: String(primary.guest_phone || ''),
      language: String(primary.guest_language || '') || undefined,
      createdAt: new Date().toISOString(),
      callbackUrl: getMaibCallbackUrl(),
      successUrl,
      failUrl,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent') || '',
    });
    await attachChangePayment(client, change.id, {
      payId: checkout.payId,
      checkoutUrl: checkout.payUrl,
      expiresAt,
      raw: checkout.raw,
    });

    return jsonResponse(
      {
        ok: true,
        rail: 'card',
        changeId: change.id,
        payUrl: checkout.payUrl,
        amount: quote.difference,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

function changeReturnUrl(reservationId: string, manageToken: string, change: 'success' | 'failed') {
  const params = new URLSearchParams();
  params.set('id', reservationId);
  if (manageToken) params.set('manage', manageToken);
  params.set('change', change);
  return `${getSiteUrl()}/gestionare.html?${params.toString()}`;
}

function getClientIp(request: Request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
}
