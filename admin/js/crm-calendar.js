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
  const SHORT_ROOM_LABELS = {
    small: 'Mică',
    large: 'Mare',
    hotel: 'Hotel',
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

  function todayISO() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function parseISOParts(value) {
    const [year, month, day] = toISODate(value).split('-').map((part) => Number(part));
    return { year, month, day };
  }

  function startOfMonth(date) {
    const { year, month } = parseISOParts(date);
    return `${year}-${String(month).padStart(2, '0')}-01`;
  }

  function addMonths(date, months) {
    const { year, month } = parseISOParts(date);
    const next = new Date(Date.UTC(year, month - 1 + months, 1));
    return next.toISOString().slice(0, 10);
  }

  function daysInMonth(date) {
    const { year, month } = parseISOParts(date);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function enumerateMonthDates(date) {
    const monthStart = startOfMonth(date);
    return enumerateDates(monthStart, daysInMonth(monthStart));
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

  function roomShortLabel(roomOrReservation) {
    const type = roomOrReservation?.type || roomType(roomOrReservation);
    return SHORT_ROOM_LABELS[type] || 'Cameră';
  }

  function roomLabel(reservation) {
    const number = roomNumber(reservation);
    return `${ROOM_LABELS[roomType(reservation)] || 'Cameră'} #${number || '-'}`;
  }

  function guestName(reservation) {
    return [reservation.guest_first_name, reservation.guest_last_name].filter(Boolean).join(' ').trim();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function formatCalendarPhone(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }

    const digits = raw.replace(/\D/g, '');
    const local = digits.startsWith('373') && digits.length === 11 ? digits.slice(3) : digits;
    if (local.length !== 8) {
      return raw;
    }

    return `+373 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }

  function sortReservations(reservations) {
    return (reservations || []).slice().sort((left, right) => {
      return roomNumber(left) - roomNumber(right) || String(left.check_in).localeCompare(String(right.check_in));
    });
  }

  function bookingGroupId(reservation) {
    return reservation.booking_group_id || reservation.id || '';
  }

  function roomKey(reservation) {
    return reservation.room_id || reservation.rooms?.id || '';
  }

  function isCancelled(reservation) {
    return Boolean(reservation.cancelled_at) || reservation.payment_status === 'cancelled';
  }

  function groupReservationRows(reservations) {
    const groups = new Map();

    (reservations || []).forEach((reservation) => {
      const key = bookingGroupId(reservation);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(reservation);
    });

    return Array.from(groups.entries()).map(([groupId, rows]) => ({
      bookingGroupId: groupId,
      reservations: sortReservations(rows),
    }));
  }

  function uniqueSortedNumbers(reservations) {
    return Array.from(new Set((reservations || []).map(roomNumber).filter(Boolean))).sort((left, right) => left - right);
  }

  function formatRoomNumbers(reservations) {
    const numbers = uniqueSortedNumbers(reservations);

    if (!numbers.length) {
      return 'Camere';
    }

    if (numbers.length === 1) {
      return roomLabel(reservations[0]);
    }

    const contiguous = numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);
    return contiguous
      ? `Camere ${numbers[0]}-${numbers[numbers.length - 1]}`
      : `Camere ${numbers.join(', ')}`;
  }

  function splitContiguousRows(reservations, roomIndexes) {
    const sorted = (reservations || [])
      .map((reservation) => ({
        reservation,
        roomIndex: roomIndexes.get(roomKey(reservation)),
      }))
      .filter((item) => Number.isInteger(item.roomIndex))
      .sort((left, right) => left.roomIndex - right.roomIndex);

    const segments = [];
    let current = [];

    sorted.forEach((item) => {
      const previous = current[current.length - 1];
      if (previous && item.roomIndex !== previous.roomIndex + 1) {
        segments.push(current);
        current = [];
      }
      current.push(item);
    });

    if (current.length) {
      segments.push(current);
    }

    return segments;
  }

  function dateIndex(dates, date) {
    return dates.indexOf(toISODate(date));
  }

  function buildReservationBlocks(reservations, rooms, dates, options) {
    const showCancelled = Boolean(options?.showCancelled);
    const visibleReservations = (reservations || []).filter((reservation) => showCancelled || !isCancelled(reservation));
    const roomIndexes = new Map((rooms || []).map((room, index) => [room.id, index]));
    const firstDate = dates?.[0];
    const lastDate = dates?.[dates.length - 1];
    const rangeEnd = lastDate ? addDays(lastDate, 1) : '';

    if (!firstDate || !rangeEnd) {
      return [];
    }

    const blocks = [];

    groupReservationRows(visibleReservations).forEach((group) => {
      const rowsByDateRange = new Map();
      group.reservations.forEach((reservation) => {
        const key = `${reservation.check_in || ''}|${reservation.check_out || ''}`;
        if (!rowsByDateRange.has(key)) {
          rowsByDateRange.set(key, []);
        }
        rowsByDateRange.get(key).push(reservation);
      });

      rowsByDateRange.forEach((rangeRows) => {
        splitContiguousRows(rangeRows, roomIndexes).forEach((segment) => {
          const segmentReservations = segment.map((item) => item.reservation);
          const primary = segmentReservations[0];
          const startDate = primary.check_in > firstDate ? primary.check_in : firstDate;
          const endDate = primary.check_out < rangeEnd ? primary.check_out : rangeEnd;
          const startIndex = dateIndex(dates, startDate);
          const exclusiveEndIndex = dateIndex(dates, addDays(endDate, -1));

          if (startIndex < 0 || exclusiveEndIndex < startIndex) {
            return;
          }

          const minRoomIndex = segment[0].roomIndex;
          const maxRoomIndex = segment[segment.length - 1].roomIndex;

          blocks.push({
            id: `${group.bookingGroupId}-${primary.check_in}-${primary.check_out}-${minRoomIndex}`,
            bookingGroupId: group.bookingGroupId,
            primary,
            reservations: segmentReservations,
            reservationIds: segmentReservations.map((reservation) => reservation.id),
            roomIds: segmentReservations.map(roomKey).filter(Boolean),
            roomNumbers: uniqueSortedNumbers(segmentReservations),
            roomLabel: formatRoomNumbers(segmentReservations),
            startDate,
            endDate,
            columnStart: startIndex + 2,
            columnSpan: exclusiveEndIndex - startIndex + 1,
            rowStart: minRoomIndex + 2,
            rowSpan: maxRoomIndex - minRoomIndex + 1,
          });
        });
      });
    });

    return blocks.sort((left, right) => left.rowStart - right.rowStart || left.columnStart - right.columnStart);
  }

  function groupPendingCashReservations(reservations) {
    return groupReservationRows(reservations).map((group) => {
      const sorted = sortReservations(group.reservations);
      const primary = sorted[0] || {};
      return {
        bookingGroupId: group.bookingGroupId,
        primary,
        reservations: sorted,
        reservationIds: sorted.map((reservation) => reservation.id),
        roomIds: sorted.map(roomKey).filter(Boolean),
        roomNumbers: uniqueSortedNumbers(sorted),
        roomLabel: formatRoomNumbers(sorted),
        totalPrice: sorted.reduce((sum, reservation) => sum + Number(reservation.total_price || 0), 0),
        cash_expires_at: sorted
          .map((reservation) => reservation.cash_expires_at)
          .filter(Boolean)
          .sort()[0] || null,
      };
    }).sort((left, right) => String(left.cash_expires_at || '').localeCompare(String(right.cash_expires_at || '')));
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
    addMonths,
    buildReservationBlocks,
    calculateDragMove,
    daysInMonth,
    enumerateDates,
    enumerateMonthDates,
    escapeHtml,
    formatCalendarPhone,
    formatRoomNumbers,
    getCardClass,
    guestName,
    groupPendingCashReservations,
    groupReservationRows,
    isCancelled,
    overlapsDate,
    requiresSwapConfirmation,
    roomLabel,
    roomNumber,
    roomShortLabel,
    roomType,
    sortReservations,
    startOfMonth,
    todayISO,
    toISODate,
  };
});
