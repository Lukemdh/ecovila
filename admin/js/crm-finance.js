(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmFinance = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const MODE_NIGHTS = 'nights';
  const MODE_PAID = 'paid';
  const COMMERCIAL_PAYMENT_TYPES = new Set(['cash', 'card', 'mia']);
  const ONLINE_PAYMENT_TYPES = new Set(['card', 'mia']);
  // Commission lost on a cancelled-and-refunded online booking = the ~0.7% MAIB
  // took on the inbound payment (wasted, since the booking netted nothing) PLUS
  // MAIB's interbank payout fee to refund the guest. That payout fee is a flat
  // tier, NOT a percentage (owner's MAIB rates, confirmed against a maibmerchants
  // statement — a 12,200 refund cost exactly 40 MDL): 20 MDL under 10,000 MDL,
  // 40 MDL at/above 10,000 MDL, charged once per refund. Applied only to
  // actually-refunded online cancellations (see summarizeCancellationRows).
  const INBOUND_COMMISSION_RATE = 0.007;
  const REFUND_FEE_TIER_THRESHOLD = 10000;
  const REFUND_FEE_UNDER_THRESHOLD = 20;
  const REFUND_FEE_AT_OR_OVER_THRESHOLD = 40;

  function refundTransferFee(amount) {
    return Number(amount || 0) >= REFUND_FEE_TIER_THRESHOLD
      ? REFUND_FEE_AT_OR_OVER_THRESHOLD
      : REFUND_FEE_UNDER_THRESHOLD;
  }
  const ROOM_TYPE_LABELS = Object.freeze({
    small: 'Căsuță mică',
    large: 'Căsuță mare',
    hotel: 'Hotel',
  });

  let activeFinance = null;

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.from((scope || root.document).querySelectorAll(selector));
  }

  function parseISODate(date) {
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function toISODate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, amount) {
    const parsed = parseISODate(date);
    if (!parsed) {
      return '';
    }

    parsed.setUTCDate(parsed.getUTCDate() + Number(amount || 0));
    return toISODate(parsed);
  }

  function addMonths(date, amount) {
    const parsed = parseISODate(date);
    if (!parsed) {
      return '';
    }

    return toISODate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + Number(amount || 0), 1)));
  }

  function firstOfMonth(date) {
    const parsed = parseISODate(date);
    if (!parsed) {
      return '';
    }

    return toISODate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1)));
  }

  function daysBetween(startDate, endDate) {
    const start = parseISODate(startDate);
    const end = parseISODate(endDate);
    if (!start || !end) {
      return 0;
    }

    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
  }

  function isOneDayRange(rangeStart, rangeEnd) {
    return daysBetween(rangeStart, rangeEnd) === 1;
  }

  function todayISO() {
    return root.EcoVilaCrmCalendar?.todayISO?.() || new Date().toISOString().slice(0, 10);
  }

  function isCancelled(reservation) {
    return Boolean(reservation?.cancelled_at || reservation?.payment_status === 'cancelled');
  }

  function isPaid(reservation) {
    return reservation?.payment_status === 'paid';
  }

  function bookedNights(reservation) {
    return daysBetween(reservation?.check_in, reservation?.check_out);
  }

  function overlappingNights(reservation, rangeStart, rangeEnd) {
    const checkIn = reservation?.check_in;
    const checkOut = reservation?.check_out;
    if (!checkIn || !checkOut || checkOut <= rangeStart || checkIn >= rangeEnd) {
      return 0;
    }

    const overlapStart = checkIn > rangeStart ? checkIn : rangeStart;
    const overlapEnd = checkOut < rangeEnd ? checkOut : rangeEnd;
    return daysBetween(overlapStart, overlapEnd);
  }

  function isPaidAtInRange(reservation, rangeStart, rangeEnd) {
    if (!reservation?.paid_at) {
      return false;
    }

    const paidAt = new Date(reservation.paid_at).getTime();
    const start = new Date(`${rangeStart}T00:00:00.000Z`).getTime();
    const end = new Date(`${rangeEnd}T00:00:00.000Z`).getTime();
    return Number.isFinite(paidAt) && paidAt >= start && paidAt < end;
  }

  function reservationKey(reservation) {
    return reservation?.booking_group_id || reservation?.id || '';
  }

  function emptySummary() {
    return {
      commercialTotal: 0,
      cashTotal: 0,
      onlineTotal: 0,
      officeTotal: 0,
      occupiedNights: 0,
      paidBookings: 0,
      averageBookingValue: 0,
      roomTypeTotals: {
        small: 0,
        large: 0,
        hotel: 0,
      },
    };
  }

  function roundMoney(value) {
    return Math.round(Number(value || 0));
  }

  function contributionForMode(reservation, mode, rangeStart, rangeEnd) {
    const nights = bookedNights(reservation);
    const total = Number(reservation?.total_price || 0);

    if (!nights || total < 0) {
      return { amount: 0, nights: 0 };
    }

    if (mode === MODE_PAID) {
      if (!isPaidAtInRange(reservation, rangeStart, rangeEnd)) {
        return { amount: 0, nights: 0 };
      }

      return { amount: total, nights };
    }

    const overlap = overlappingNights(reservation, rangeStart, rangeEnd);
    if (!overlap) {
      return { amount: 0, nights: 0 };
    }

    return { amount: (total / nights) * overlap, nights: overlap };
  }

  function summarizeFinanceRows(input) {
    const rows = input?.rows || [];
    const mode = input?.mode === MODE_PAID ? MODE_PAID : MODE_NIGHTS;
    const rangeStart = input?.rangeStart || firstOfMonth(todayISO());
    const rangeEnd = input?.rangeEnd || addMonths(rangeStart, 1);
    const summary = emptySummary();
    const commercialKeys = new Set();

    rows.forEach((reservation) => {
      if (!isPaid(reservation) || isCancelled(reservation)) {
        return;
      }

      const paymentType = reservation.payment_type || '';
      if (!COMMERCIAL_PAYMENT_TYPES.has(paymentType) && paymentType !== 'office') {
        return;
      }

      const contribution = contributionForMode(reservation, mode, rangeStart, rangeEnd);
      if (!contribution.nights || !contribution.amount) {
        return;
      }

      summary.occupiedNights += contribution.nights;

      if (paymentType === 'office') {
        summary.officeTotal += contribution.amount;
        return;
      }

      const key = reservationKey(reservation);
      if (key) {
        commercialKeys.add(key);
      }

      summary.commercialTotal += contribution.amount;
      if (paymentType === 'cash') {
        summary.cashTotal += contribution.amount;
      } else {
        summary.onlineTotal += contribution.amount;
      }

      const roomType = reservation.rooms?.type || reservation.room_type || '';
      if (roomType in summary.roomTypeTotals) {
        summary.roomTypeTotals[roomType] += contribution.amount;
      }
    });

    // Paid "add guests" differences are their own dated online income. They fold
    // into the commercial + online totals (and the villa-type split) by paid_at,
    // never inflating the booking's original paid day. Pre-filtered to the range
    // by the fetch, they only apply in the "paid" (Încasări) view.
    if (mode === MODE_PAID) {
      (input?.changeRows || []).forEach((change) => {
        const amount = Number(change.difference_amount || 0);
        if (!(amount > 0)) {
          return;
        }

        summary.commercialTotal += amount;
        summary.onlineTotal += amount;

        const roomType = change.room_type || '';
        if (roomType in summary.roomTypeTotals) {
          summary.roomTypeTotals[roomType] += amount;
        }

        const key = change.booking_group_id || change.id;
        if (key) {
          commercialKeys.add(key);
        }
      });
    }

    summary.commercialTotal = roundMoney(summary.commercialTotal);
    summary.cashTotal = roundMoney(summary.cashTotal);
    summary.onlineTotal = roundMoney(summary.onlineTotal);
    summary.officeTotal = roundMoney(summary.officeTotal);
    Object.keys(summary.roomTypeTotals).forEach((type) => {
      summary.roomTypeTotals[type] = roundMoney(summary.roomTypeTotals[type]);
    });
    summary.paidBookings = commercialKeys.size;
    summary.averageBookingValue = summary.paidBookings
      ? roundMoney(summary.commercialTotal / summary.paidBookings)
      : 0;

    return summary;
  }

  function normalizeBookedDayRows(rows) {
    return (rows || [])
      .filter((reservation) => {
        if (!reservation?.id) {
          return false;
        }
        // Keep live bookings, plus ones that were actually paid then cancelled
        // (real refunds, shown as "anulată"); drop never-paid abandoned holds.
        return !isCancelled(reservation) || Boolean(reservation.paid_at);
      })
      .map((reservation) => {
        const kids = Array.isArray(reservation.kids_ages) ? reservation.kids_ages.length : 0;
        return {
          id: reservation.id,
          bookingGroupId: reservation.booking_group_id || reservation.id || '',
          roomNumber: Number(reservation.rooms?.number || reservation.room_number || 0),
          roomType: reservation.rooms?.type || reservation.room_type || '',
          checkIn: reservation.check_in || '',
          checkOut: reservation.check_out || '',
          nights: bookedNights(reservation),
          adults: Number(reservation.adults || 0),
          kids,
          totalPrice: Number(reservation.total_price || 0),
          paymentType: reservation.payment_type || '',
          paymentStatus: reservation.payment_status || '',
          createdAt: reservation.created_at || '',
        };
      })
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  function groupBookedDayRows(rows) {
    const groups = new Map();
    const order = [];

    (rows || []).forEach((row) => {
      const key = row.bookingGroupId || `single:${row.id}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(row);
    });

    return order
      .map((key) => {
        const villas = groups
          .get(key)
          .slice()
          .sort((left, right) => left.roomNumber - right.roomNumber);
        const primary = villas[0];
        return {
          key,
          villas,
          // total_price is split across villas, so the booking total is the sum.
          totalPrice: villas.reduce((sum, villa) => sum + Number(villa.totalPrice || 0), 0),
          // adults/kids are stored as the whole-booking party on every villa row.
          adults: primary.adults,
          kids: primary.kids,
          nights: primary.nights,
          checkIn: primary.checkIn,
          checkOut: primary.checkOut,
          createdAt: primary.createdAt,
          paymentType: primary.paymentType,
          paymentStatus: primary.paymentStatus,
        };
      })
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  function villaCountLabel(count) {
    if (count === 1) {
      return '1 vilă';
    }

    return `${count} vile`;
  }

  function formatCalendarMonth(date) {
    const parsed = parseISODate(firstOfMonth(date));
    const formatted = new Intl.DateTimeFormat('ro-MD', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(parsed);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  function isFullMonth(rangeStart, rangeEnd) {
    return rangeStart === firstOfMonth(rangeStart) && rangeEnd === addMonths(rangeStart, 1);
  }

  function formatRangeLabel(context, state) {
    if (isFullMonth(state.rangeStart, state.rangeEnd)) {
      return formatCalendarMonth(state.rangeStart);
    }

    const endLabel = addDays(state.rangeEnd, -1);
    return `${context.formatDate(state.rangeStart)} - ${context.formatDate(endLabel)}`;
  }

  function setText(selector, value) {
    const node = qs(selector);
    if (node) {
      node.textContent = String(value);
    }
  }

  function formatMDL(context, amount) {
    return context.formatMDL ? context.formatMDL(amount) : `${Number(amount || 0).toLocaleString('ro-MD')} MDL`;
  }

  function formatCreatedAt(value) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      return '';
    }

    return new Intl.DateTimeFormat('ro-MD', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Chisinau',
    }).format(parsed);
  }

  function formatStayDate(context, date) {
    return date ? context.formatDate(date) : '--';
  }

  function roomTypeLabel(type) {
    return ROOM_TYPE_LABELS[type] || 'Cazare';
  }

  function partyLabel(row) {
    const adults = row.adults === 1 ? '1 adult' : `${row.adults} adulți`;
    if (!row.kids) {
      return adults;
    }

    return `${adults}, ${row.kids === 1 ? '1 copil' : `${row.kids} copii`}`;
  }

  function nightsLabel(row) {
    if (row.nights === 1) {
      return '1 noapte';
    }

    return `${row.nights} nopți`;
  }

  function paymentLabel(row) {
    if (row.paymentStatus === 'cancelled') {
      return 'anulată';
    }

    if (row.paymentStatus === 'paid') {
      if (row.paymentType === 'office') {
        return 'din oficiu';
      }
      return row.paymentType === 'cash' ? 'cash plătit' : 'online plătit';
    }

    if (row.paymentStatus === 'pending') {
      return row.paymentType === 'cash' ? 'cash în așteptare' : 'în așteptare';
    }

    return row.paymentStatus || 'rezervare';
  }

  function syncControls(context, state) {
    setText('[data-finance-range-label]', formatRangeLabel(context, state));

    qsa('[data-finance-mode]').forEach((button) => {
      const active = button.dataset.financeMode === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderSummary(context, summary) {
    setText('[data-finance-commercial-total]', formatMDL(context, summary.commercialTotal));
    setText('[data-finance-cash-total]', formatMDL(context, summary.cashTotal));
    setText('[data-finance-online-total]', formatMDL(context, summary.onlineTotal));
    setText('[data-finance-office-total]', formatMDL(context, summary.officeTotal));
    setText('[data-finance-occupied-nights]', summary.occupiedNights);
    setText('[data-finance-paid-bookings]', summary.paidBookings);
    setText('[data-finance-average-booking]', formatMDL(context, summary.averageBookingValue));

    Object.entries(ROOM_TYPE_LABELS).forEach(([type]) => {
      const container = qs(`[data-finance-room-type="${type}"]`);
      const value = container?.querySelector?.('[data-finance-room-total]');
      if (value) {
        value.textContent = formatMDL(context, summary.roomTypeTotals[type] || 0);
      }
    });
  }

  function buildBookedSummary(context, data, titleText, metaText) {
    const title = root.document.createElement('strong');
    title.textContent = titleText;

    const meta = root.document.createElement('span');
    meta.textContent = metaText;

    const stay = root.document.createElement('span');
    stay.textContent = `${formatStayDate(context, data.checkIn)} - ${formatStayDate(context, data.checkOut)}`;

    const total = root.document.createElement('span');
    total.textContent = formatMDL(context, data.totalPrice);

    const bookedAt = root.document.createElement('span');
    bookedAt.textContent = `Rezervat: ${formatCreatedAt(data.createdAt)}`;

    const status = root.document.createElement('span');
    status.className = 'crm-finance-booked-status';
    status.textContent = paymentLabel(data);

    return [title, meta, stay, total, bookedAt, status];
  }

  function buildBookedVillaBreakdown(context, villas) {
    const breakdown = root.document.createElement('ul');
    breakdown.className = 'crm-finance-booked-card__villas';

    villas.forEach((villa) => {
      const item = root.document.createElement('li');

      const name = root.document.createElement('span');
      name.className = 'crm-finance-booked-villa__name';
      name.textContent = villa.roomNumber ? `Vila #${villa.roomNumber}` : roomTypeLabel(villa.roomType);

      const type = root.document.createElement('span');
      type.textContent = roomTypeLabel(villa.roomType);

      const price = root.document.createElement('span');
      price.className = 'crm-finance-booked-villa__price';
      price.textContent = formatMDL(context, villa.totalPrice);

      item.append(name, type, price);
      breakdown.appendChild(item);
    });

    return breakdown;
  }

  function renderBookedDayRows(context, state) {
    const section = qs('[data-finance-booked-day]');
    const list = qs('[data-finance-booked-list]');
    const empty = qs('[data-finance-booked-empty]');
    const count = qs('[data-finance-booked-count]');
    if (!section || !list || !empty) {
      return;
    }

    const visible = state.mode === MODE_PAID && isOneDayRange(state.rangeStart, state.rangeEnd);
    section.hidden = !visible;
    if (!visible) {
      list.innerHTML = '';
      if (count) {
        count.textContent = '0';
      }
      return;
    }

    const groups = groupBookedDayRows(normalizeBookedDayRows(state.bookedDayRows));
    const changes = (state.changeRows || []).filter((change) => Number(change.difference_amount || 0) > 0);
    if (count) {
      count.textContent = String(groups.length + changes.length);
    }
    empty.hidden = groups.length + changes.length > 0;
    list.innerHTML = '';

    groups.forEach((group) => {
      const card = root.document.createElement('article');
      card.className = 'crm-finance-booked-card';

      if (group.villas.length === 1) {
        const villa = group.villas[0];
        const titleText = villa.roomNumber ? `Vila #${villa.roomNumber}` : roomTypeLabel(villa.roomType);
        const metaText = `${roomTypeLabel(villa.roomType)} · ${partyLabel(group)} · ${nightsLabel(group)}`;
        card.append(...buildBookedSummary(context, group, titleText, metaText));
        list.appendChild(card);
        return;
      }

      card.classList.add('crm-finance-booked-card--group');

      const summary = root.document.createElement('div');
      summary.className = 'crm-finance-booked-card__summary';
      summary.append(
        ...buildBookedSummary(
          context,
          group,
          villaCountLabel(group.villas.length),
          `${partyLabel(group)} · ${nightsLabel(group)}`,
        ),
      );

      card.append(summary, buildBookedVillaBreakdown(context, group.villas));
      list.appendChild(card);
    });

    changes.forEach((change) => {
      list.appendChild(buildChangeCard(context, change));
    });
  }

  function changeDeltaLabel(change) {
    const addedAdults = Number(change.new_adults || 0) - Number(change.prev_adults || 0);
    const prevKids = Array.isArray(change.prev_kids_ages) ? change.prev_kids_ages.length : 0;
    const newKids = Array.isArray(change.new_kids_ages) ? change.new_kids_ages.length : 0;
    const addedKids = newKids - prevKids;
    const parts = [];
    if (addedAdults > 0) {
      parts.push(addedAdults === 1 ? '+1 adult' : `+${addedAdults} adulți`);
    }
    if (addedKids > 0) {
      parts.push(addedKids === 1 ? '+1 copil' : `+${addedKids} copii`);
    }
    return parts.join(', ') || 'persoane adăugate';
  }

  function buildChangeCard(context, change) {
    const card = root.document.createElement('article');
    card.className = 'crm-finance-booked-card crm-finance-booked-card--change';

    const title = root.document.createElement('strong');
    title.textContent = `Diferență · ${changeDeltaLabel(change)}`;

    const meta = root.document.createElement('span');
    meta.textContent = roomTypeLabel(change.room_type || '');

    const stay = root.document.createElement('span');
    stay.textContent = `${formatStayDate(context, change.check_in)} - ${formatStayDate(context, change.check_out)}`;

    const total = root.document.createElement('span');
    total.textContent = formatMDL(context, change.difference_amount);

    const paidAt = root.document.createElement('span');
    paidAt.textContent = `Achitat: ${formatCreatedAt(change.paid_at)}`;

    const status = root.document.createElement('span');
    status.className = 'crm-finance-booked-status';
    status.textContent = 'online plătit diferență';

    card.append(title, meta, stay, total, paidAt, status);
    return card;
  }

  function isOnlinePayment(paymentType) {
    return ONLINE_PAYMENT_TYPES.has(paymentType || '');
  }

  // A refund only happened when an online (card/mia) booking was cancelled inside
  // the refund window: the reservation-cancel flow stamps 'guest_request_refunded'
  // in that single case (a kept, out-of-window cancellation stays 'guest_request').
  function isCancellationRefunded(row) {
    return isOnlinePayment(row?.paymentType) && row?.cancellationReason === 'guest_request_refunded';
  }

  function guestName(reservation) {
    const first = String(reservation?.guest_first_name || '').trim();
    const last = String(reservation?.guest_last_name || '').trim();
    return `${first} ${last}`.trim();
  }

  function normalizeCancellationRows(rows) {
    return (rows || [])
      .filter((reservation) => Boolean(reservation?.id && reservation.cancelled_at && reservation.paid_at))
      .map((reservation) => {
        const kids = Array.isArray(reservation.kids_ages) ? reservation.kids_ages.length : 0;
        return {
          id: reservation.id,
          bookingGroupId: reservation.booking_group_id || reservation.id || '',
          roomNumber: Number(reservation.rooms?.number || reservation.room_number || 0),
          roomType: reservation.rooms?.type || reservation.room_type || '',
          checkIn: reservation.check_in || '',
          checkOut: reservation.check_out || '',
          nights: bookedNights(reservation),
          adults: Number(reservation.adults || 0),
          kids,
          totalPrice: Number(reservation.total_price || 0),
          paymentType: reservation.payment_type || '',
          cancelledAt: reservation.cancelled_at || '',
          cancellationReason: reservation.cancellation_reason || '',
          guestName: guestName(reservation),
        };
      })
      // Most recent cancellation first — the owner scans "what just got cancelled".
      .sort((left, right) => String(right.cancelledAt).localeCompare(String(left.cancelledAt)));
  }

  function groupCancellationRows(rows) {
    const groups = new Map();
    const order = [];

    (rows || []).forEach((row) => {
      const key = row.bookingGroupId || `single:${row.id}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(row);
    });

    return order
      .map((key) => {
        const villas = groups
          .get(key)
          .slice()
          .sort((left, right) => left.roomNumber - right.roomNumber);
        const primary = villas[0];
        return {
          key,
          villas,
          // A group cancels as a unit, so total_price sums across its villa rows.
          totalPrice: villas.reduce((sum, villa) => sum + Number(villa.totalPrice || 0), 0),
          adults: primary.adults,
          kids: primary.kids,
          nights: primary.nights,
          checkIn: primary.checkIn,
          checkOut: primary.checkOut,
          cancelledAt: primary.cancelledAt,
          cancellationReason: primary.cancellationReason,
          paymentType: primary.paymentType,
          guestName: primary.guestName,
          refunded: isCancellationRefunded(primary),
        };
      })
      .sort((left, right) => String(right.cancelledAt).localeCompare(String(left.cancelledAt)));
  }

  function summarizeCancellationRows(input) {
    const groups = groupCancellationRows(normalizeCancellationRows(input?.rows || []));
    let refundedTotal = 0;
    // The payout fee is tiered per refund, so it is summed per group (one refund
    // transfer per booking group) rather than derived from the total.
    let refundFees = 0;
    groups.forEach((group) => {
      if (group.refunded) {
        refundedTotal += group.totalPrice;
        refundFees += refundTransferFee(group.totalPrice);
      }
    });
    refundedTotal = roundMoney(refundedTotal);

    return {
      // One cancelled booking (across however many villas) counts once.
      count: groups.length,
      refundedTotal,
      commissionLost: roundMoney(refundedTotal * INBOUND_COMMISSION_RATE + refundFees),
    };
  }

  function cancellationStatusLabel(group) {
    if (group.refunded) {
      return 'rambursat';
    }

    if (group.paymentType === 'office') {
      return 'din oficiu';
    }

    if (group.paymentType === 'cash') {
      return 'cash · fără rambursare';
    }

    return 'fără rambursare';
  }

  function buildCancellationSummary(context, data, titleText, metaText) {
    const title = root.document.createElement('strong');
    title.textContent = titleText;

    const meta = root.document.createElement('span');
    meta.textContent = metaText;

    const stay = root.document.createElement('span');
    stay.textContent = `${formatStayDate(context, data.checkIn)} - ${formatStayDate(context, data.checkOut)}`;

    const total = root.document.createElement('span');
    total.textContent = formatMDL(context, data.totalPrice);

    const cancelledAt = root.document.createElement('span');
    cancelledAt.textContent = `Anulat: ${formatCreatedAt(data.cancelledAt)}`;

    const status = root.document.createElement('span');
    status.className = 'crm-finance-booked-status';
    status.textContent = cancellationStatusLabel(data);

    return [title, meta, stay, total, cancelledAt, status];
  }

  function renderCancellations(context, state) {
    const summary = summarizeCancellationRows({ rows: state.cancellationRows });
    setText('[data-finance-cancelled-count]', summary.count);
    setText('[data-finance-commission-lost]', formatMDL(context, summary.commissionLost));
    setText('[data-finance-refunded-total]', formatMDL(context, summary.refundedTotal));

    const list = qs('[data-finance-cancel-list]');
    const empty = qs('[data-finance-cancel-empty]');
    const count = qs('[data-finance-cancel-count]');
    if (!list || !empty) {
      return;
    }

    const groups = groupCancellationRows(normalizeCancellationRows(state.cancellationRows));
    if (count) {
      count.textContent = String(groups.length);
    }
    empty.hidden = groups.length > 0;
    list.innerHTML = '';

    groups.forEach((group) => {
      const card = root.document.createElement('article');
      card.className = 'crm-finance-booked-card crm-finance-cancel-card';
      if (group.refunded) {
        card.classList.add('crm-finance-cancel-card--refunded');
      }

      if (group.villas.length === 1) {
        const villa = group.villas[0];
        const villaText = villa.roomNumber ? `Vila #${villa.roomNumber}` : roomTypeLabel(villa.roomType);
        const titleText = group.guestName || villaText;
        const metaLead = group.guestName ? villaText : roomTypeLabel(villa.roomType);
        const metaText = `${metaLead} · ${partyLabel(group)} · ${nightsLabel(group)}`;
        card.append(...buildCancellationSummary(context, group, titleText, metaText));
        list.appendChild(card);
        return;
      }

      card.classList.add('crm-finance-booked-card--group');

      const groupSummary = root.document.createElement('div');
      groupSummary.className = 'crm-finance-booked-card__summary';
      const titleText = group.guestName || villaCountLabel(group.villas.length);
      const metaText = group.guestName
        ? `${villaCountLabel(group.villas.length)} · ${partyLabel(group)} · ${nightsLabel(group)}`
        : `${partyLabel(group)} · ${nightsLabel(group)}`;
      groupSummary.append(...buildCancellationSummary(context, group, titleText, metaText));

      card.append(groupSummary, buildBookedVillaBreakdown(context, group.villas));
      list.appendChild(card);
    });
  }

  function refundVillaLabel(refund) {
    const villas = Array.isArray(refund.villas) ? refund.villas : [];
    if (villas.length > 1) {
      return villaCountLabel(villas.length);
    }
    const villa = villas[0];
    if (villa?.number) {
      return `Vila #${villa.number}`;
    }
    return roomTypeLabel(villa?.type || '');
  }

  function formatRefundEta(eligibleAt) {
    const when = formatCreatedAt(eligibleAt);
    const ms = new Date(eligibleAt).getTime() - Date.now();
    if (!when || !Number.isFinite(ms)) {
      return when || '--';
    }
    const hours = Math.max(0, Math.round(ms / 3600000));
    return `${when} (în ~${hours}h)`;
  }

  async function handleScheduledRefundAction(context, state, refund, action, button) {
    const confirmMessage = action === 'cancel'
      ? 'Anulezi restituirea? Banii NU vor fi returnați oaspetelui (rezervarea rămâne anulată).'
      : 'Eliberezi restituirea acum, înainte de expirarea perioadei de 60h?';
    if (typeof root.confirm === 'function' && !root.confirm(confirmMessage)) {
      return;
    }

    const buttons = qsa('button', button.closest?.('.crm-finance-scheduled-card') || root.document);
    buttons.forEach((node) => {
      node.disabled = true;
    });

    try {
      await root.EcoVilaSupabase.controlScheduledRefund(context.client, {
        action,
        payId: refund.payId,
        bookingGroupId: refund.bookingGroupId,
      });
      await loadFinance(context, state);
    } catch (error) {
      buttons.forEach((node) => {
        node.disabled = false;
      });
      context.setAlert(error?.message || 'Acțiunea asupra restituirii nu s-a putut efectua.');
    }
  }

  function buildScheduledRefundCard(context, state, refund) {
    const card = root.document.createElement('article');
    card.className = 'crm-finance-scheduled-card';

    const info = root.document.createElement('div');
    info.className = 'crm-finance-scheduled-card__info';

    const villaText = refundVillaLabel(refund);
    const title = root.document.createElement('strong');
    title.textContent = refund.guestName || villaText;

    const meta = root.document.createElement('span');
    meta.textContent = `${villaText} · ${formatStayDate(context, refund.checkIn)} - ${
      formatStayDate(context, refund.checkOut)
    }`;

    const amount = root.document.createElement('span');
    amount.className = 'crm-finance-scheduled-card__amount';
    amount.textContent = formatMDL(context, refund.amount);

    const eta = root.document.createElement('span');
    eta.className = 'crm-finance-scheduled-card__eta';
    eta.textContent = `Se procesează: ${formatRefundEta(refund.eligibleAt)}`;

    info.append(title, meta, amount, eta);

    const actions = root.document.createElement('div');
    actions.className = 'crm-finance-scheduled-card__actions';

    const release = root.document.createElement('button');
    release.type = 'button';
    release.className = 'crm-button crm-button--small';
    release.textContent = 'Eliberează acum';
    release.addEventListener('click', () =>
      handleScheduledRefundAction(context, state, refund, 'release', release));

    const cancel = root.document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'crm-button crm-button--small crm-button--danger';
    cancel.textContent = 'Anulează restituirea';
    cancel.addEventListener('click', () =>
      handleScheduledRefundAction(context, state, refund, 'cancel', cancel));

    actions.append(release, cancel);
    card.append(info, actions);
    return card;
  }

  function renderScheduledRefunds(context, state) {
    const section = qs('[data-finance-scheduled]');
    const list = qs('[data-finance-scheduled-list]');
    const empty = qs('[data-finance-scheduled-empty]');
    const count = qs('[data-finance-scheduled-count]');
    if (!section || !list) {
      return;
    }

    const refunds = state.scheduledRefunds || [];
    // Action-oriented panel: only surfaces when money is actually pending.
    section.hidden = refunds.length === 0;
    if (count) {
      count.textContent = String(refunds.length);
    }
    if (empty) {
      empty.hidden = refunds.length > 0;
    }

    list.innerHTML = '';
    refunds.forEach((refund) => {
      list.appendChild(buildScheduledRefundCard(context, state, refund));
    });
  }

  function fetchScheduledRefundsSafe(context) {
    // Never let the (diana-only) scheduled-refunds call break the finance load —
    // a failure just leaves the panel empty.
    if (typeof root.EcoVilaSupabase.fetchScheduledRefunds !== 'function') {
      return Promise.resolve([]);
    }
    return root.EcoVilaSupabase.fetchScheduledRefunds(context.client).catch((error) => {
      console.error('Could not load scheduled refunds', error);
      return [];
    });
  }

  async function loadFinance(context, state) {
    syncControls(context, state);
    const financeOptions = {
      mode: state.mode,
      rangeStart: state.rangeStart,
      rangeEnd: state.rangeEnd,
    };
    const shouldLoadBookedDay = state.mode === MODE_PAID && isOneDayRange(state.rangeStart, state.rangeEnd);
    const loadChanges = state.mode === MODE_PAID;
    // Cancellations are keyed by cancelled_at, orthogonal to the Nopți/Încasări
    // mode, so they always load for the selected range (today or a wider span).
    const [rows, bookedDayRows, changeRows, cancellationRows, scheduledRefunds] = await Promise.all([
      root.EcoVilaSupabase.fetchFinanceReservations(context.client, financeOptions),
      shouldLoadBookedDay
        ? root.EcoVilaSupabase.fetchFinanceBookedReservations(context.client, {
            rangeStart: state.rangeStart,
            rangeEnd: state.rangeEnd,
          })
        : Promise.resolve([]),
      loadChanges
        ? root.EcoVilaSupabase.fetchFinanceChangePayments(context.client, {
            rangeStart: state.rangeStart,
            rangeEnd: state.rangeEnd,
          })
        : Promise.resolve([]),
      root.EcoVilaSupabase.fetchFinanceCancellations(context.client, {
        rangeStart: state.rangeStart,
        rangeEnd: state.rangeEnd,
      }),
      // Pending refunds are not range-scoped — always the full current list.
      fetchScheduledRefundsSafe(context),
    ]);
    state.rows = rows || [];
    state.bookedDayRows = bookedDayRows || [];
    state.changeRows = changeRows || [];
    state.cancellationRows = cancellationRows || [];
    state.scheduledRefunds = scheduledRefunds || [];
    renderSummary(context, summarizeFinanceRows({
      rows: state.rows,
      changeRows: state.changeRows,
      mode: state.mode,
      rangeStart: state.rangeStart,
      rangeEnd: state.rangeEnd,
    }));
    renderBookedDayRows(context, state);
    renderCancellations(context, state);
    renderScheduledRefunds(context, state);
  }

  function setRange(context, state, rangeStart, rangeEnd) {
    if (!rangeStart || !rangeEnd || rangeEnd <= rangeStart) {
      return;
    }

    state.rangeStart = rangeStart;
    state.rangeEnd = rangeEnd;
    state.currentMonth = firstOfMonth(rangeStart);
    state.draftStart = rangeStart;
    state.draftEnd = addDays(rangeEnd, -1);
    syncControls(context, state);
  }

  function showToday() {
    if (!activeFinance) {
      return null;
    }

    const { context, state } = activeFinance;
    const today = todayISO();
    setRange(context, state, today, addDays(today, 1));
    return loadFinance(context, state).catch((error) => {
      context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.');
    });
  }

  function shiftRange(context, state, amount) {
    if (isFullMonth(state.rangeStart, state.rangeEnd)) {
      setRange(context, state, addMonths(state.rangeStart, amount), addMonths(state.rangeEnd, amount));
      return;
    }

    const length = daysBetween(state.rangeStart, state.rangeEnd);
    setRange(context, state, addDays(state.rangeStart, length * amount), addDays(state.rangeEnd, length * amount));
  }

  function isClickInsideFinanceRangePicker(event) {
    return Boolean(
      event.composedPath?.().some((node) => {
        return node?.dataset && 'financeRangePicker' in node.dataset;
      }) || event.target.closest?.('[data-finance-range-picker]'),
    );
  }

  function renderFinanceCalendar(context, state) {
    const calendar = qs('[data-finance-range-calendar]');
    const title = qs('[data-finance-calendar-title]');
    const grid = qs('[data-finance-calendar-grid]');
    if (!calendar || !grid) {
      return;
    }

    calendar.hidden = !state.calendarOpen;
    if (title) {
      title.textContent = formatCalendarMonth(state.currentMonth);
    }

    grid.innerHTML = '';
    const monthStart = parseISODate(state.currentMonth);
    const mondayOffset = (monthStart.getUTCDay() + 6) % 7;
    const startDate = addDays(state.currentMonth, -mondayOffset);

    for (let index = 0; index < 42; index += 1) {
      const date = addDays(startDate, index);
      const parsed = parseISODate(date);
      const button = root.document.createElement('button');
      button.type = 'button';
      button.textContent = String(parsed.getUTCDate());
      button.dataset.date = date;
      button.classList.toggle('is-muted', parsed.getUTCMonth() !== monthStart.getUTCMonth());
      button.classList.toggle('is-selected', date === state.draftStart || date === state.draftEnd);
      button.classList.toggle('is-in-range', Boolean(state.draftStart && state.draftEnd && date > state.draftStart && date < state.draftEnd));
      button.addEventListener('click', () => selectFinanceDate(context, state, date));
      grid.appendChild(button);
    }
  }

  function selectFinanceDate(context, state, date) {
    if (!state.draftStart || state.draftEnd || date < state.draftStart) {
      state.draftStart = date;
      state.draftEnd = '';
    } else {
      state.draftEnd = date;
    }

    renderFinanceCalendar(context, state);
  }

  function init(context) {
    const today = todayISO();
    const state = {
      // Default to today's Încasări (paid) view: a single-day range (parity with
      // the Daily/Ștergare tabs) in "paid" mode, which also surfaces the
      // "Rezervări create în ziua selectată" list. The owner can switch to Nopți
      // or widen the range to a month/any span via the calendar.
      mode: MODE_PAID,
      rangeStart: today,
      rangeEnd: addDays(today, 1),
      draftStart: today,
      draftEnd: today,
      currentMonth: firstOfMonth(today),
      calendarOpen: false,
      rows: [],
      bookedDayRows: [],
      changeRows: [],
      cancellationRows: [],
      scheduledRefunds: [],
    };
    activeFinance = { context, state };

    qs('[data-finance-prev]')?.addEventListener('click', () => {
      shiftRange(context, state, -1);
      loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
    });
    qs('[data-finance-next]')?.addEventListener('click', () => {
      shiftRange(context, state, 1);
      loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
    });
    qs('[data-finance-range-label]')?.addEventListener('click', () => {
      state.calendarOpen = true;
      state.draftStart = state.rangeStart;
      state.draftEnd = addDays(state.rangeEnd, -1);
      state.currentMonth = firstOfMonth(state.rangeStart);
      renderFinanceCalendar(context, state);
    });
    qsa('[data-finance-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.financeMode === MODE_PAID ? MODE_PAID : MODE_NIGHTS;
        loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
      });
    });
    qs('[data-finance-calendar-prev]')?.addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, -1);
      renderFinanceCalendar(context, state);
    });
    qs('[data-finance-calendar-next]')?.addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, 1);
      renderFinanceCalendar(context, state);
    });
    qs('[data-finance-calendar-clear]')?.addEventListener('click', () => {
      state.draftStart = '';
      state.draftEnd = '';
      renderFinanceCalendar(context, state);
    });
    qs('[data-finance-calendar-apply]')?.addEventListener('click', () => {
      const draftEnd = state.draftEnd || state.draftStart;
      if (state.draftStart && draftEnd && draftEnd >= state.draftStart) {
        setRange(context, state, state.draftStart, addDays(draftEnd, 1));
        state.calendarOpen = false;
        renderFinanceCalendar(context, state);
        loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
      }
    });
    root.document.addEventListener('click', (event) => {
      if (!state.calendarOpen || isClickInsideFinanceRangePicker(event)) {
        return;
      }
      state.calendarOpen = false;
      renderFinanceCalendar(context, state);
    });

    syncControls(context, state);
    renderFinanceCalendar(context, state);
    loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));

    context.client
      .channel('crm-finance-reservations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () => loadFinance(context, state))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservation_changes' }, () => loadFinance(context, state))
      .subscribe();
  }

  return {
    MODE_NIGHTS,
    MODE_PAID,
    ROOM_TYPE_LABELS,
    addDays,
    addMonths,
    firstOfMonth,
    groupBookedDayRows,
    groupCancellationRows,
    init,
    isClickInsideFinanceRangePicker,
    loadFinance,
    normalizeBookedDayRows,
    normalizeCancellationRows,
    showToday,
    summarizeCancellationRows,
    summarizeFinanceRows,
  };
});
