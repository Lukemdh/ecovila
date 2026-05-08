(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const ROOM_LABELS = {
    small: 'Căsuța mică',
    large: 'Căsuța mare',
    hotel: 'Cameră în hotel',
  };

  function toISODate(value) {
    if (!value) {
      return new Date().toISOString().slice(0, 10);
    }

    if (root.EcoVilaPricing?.toISODate) {
      return root.EcoVilaPricing.toISODate(value);
    }

    return new Date(value).toISOString().slice(0, 10);
  }

  function addDays(date, days) {
    if (root.EcoVilaPricing?.addDays) {
      return root.EcoVilaPricing.addDays(date, days);
    }

    return new Date(new Date(`${toISODate(date)}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
  }

  function enumerateDates(startDate, days) {
    return Array.from({ length: days }, (_, index) => addDays(startDate, index));
  }

  function overlapsDate(reservation, date) {
    const iso = toISODate(date);
    return reservation.check_in <= iso && reservation.check_out > iso;
  }

  function roomNumber(reservation) {
    return Number(reservation.rooms?.number || reservation.room_number || 0);
  }

  function roomType(reservation) {
    return reservation.rooms?.type || reservation.room_type || '';
  }

  function roomLabel(reservation) {
    const number = roomNumber(reservation);
    return `${ROOM_LABELS[roomType(reservation)] || 'Cameră'} #${number || '-'}`;
  }

  function guestName(reservation) {
    return [reservation.guest_first_name, reservation.guest_last_name].filter(Boolean).join(' ').trim();
  }

  function sortReservations(reservations) {
    return (reservations || []).slice().sort((left, right) => {
      return roomNumber(left) - roomNumber(right) || String(left.check_in).localeCompare(String(right.check_in));
    });
  }

  function getCardClass(reservation) {
    if (reservation.payment_status === 'cancelled') {
      return 'crm-reservation-card--cancelled';
    }

    if (reservation.payment_type === 'cash' && reservation.payment_status === 'pending') {
      return 'crm-reservation-card--pending';
    }

    if (reservation.payment_type === 'cash') {
      return 'crm-reservation-card--paid-cash';
    }

    return 'crm-reservation-card--paid-card';
  }

  function calculateDragMove(source, target) {
    return {
      reservationId: source?.reservationId,
      sourceRoomId: source?.roomId,
      targetRoomId: target?.roomId,
      sourceDate: source?.date,
      targetDate: target?.date,
    };
  }

  function requiresSwapConfirmation(leftReservation, rightReservation) {
    return Boolean(leftReservation?.room_explicitly_selected || rightReservation?.room_explicitly_selected);
  }

  return {
    addDays,
    calculateDragMove,
    enumerateDates,
    getCardClass,
    guestName,
    overlapsDate,
    requiresSwapConfirmation,
    roomLabel,
    roomNumber,
    roomType,
    sortReservations,
    toISODate,
  };
});
