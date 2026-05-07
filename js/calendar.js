(function (root, factory) {
  let pricing = root.EcoVilaPricing;

  if (!pricing && typeof require === 'function') {
    pricing = require('./pricing.js');
  }

  const api = factory(pricing);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (pricing) {
  'use strict';

  if (!pricing) {
    throw new Error('EcoVilaCalendar requires EcoVilaPricing to be loaded first.');
  }

  function isActiveReservation(reservation) {
    if (!reservation) {
      return false;
    }

    if (reservation.cancelled_at || reservation.payment_status === 'cancelled') {
      return false;
    }

    return !reservation.payment_status || ['pending', 'paid'].includes(reservation.payment_status);
  }

  function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
    const normalizedLeftStart = pricing.toISODate(leftStart);
    const normalizedLeftEnd = pricing.toISODate(leftEnd);
    const normalizedRightStart = pricing.toISODate(rightStart);
    const normalizedRightEnd = pricing.toISODate(rightEnd);

    if (normalizedLeftStart >= normalizedLeftEnd || normalizedRightStart >= normalizedRightEnd) {
      throw new Error('Date ranges must have an end date after the start date.');
    }

    return normalizedLeftStart < normalizedRightEnd && normalizedRightStart < normalizedLeftEnd;
  }

  function reservationOverlapsRange(reservation, checkIn, checkOut) {
    return rangesOverlap(reservation.check_in, reservation.check_out, checkIn, checkOut);
  }

  function isRoomAvailable(input) {
    return !(input.reservations || []).some((reservation) => {
      return (
        isActiveReservation(reservation) &&
        reservation.room_id === input.roomId &&
        reservationOverlapsRange(reservation, input.checkIn, input.checkOut)
      );
    });
  }

  function getAvailableRooms(input) {
    return (input.rooms || []).filter((room) => {
      return (
        room.is_active !== false &&
        (!input.type || room.type === input.type) &&
        isRoomAvailable({
          roomId: room.id,
          reservations: input.reservations || [],
          checkIn: input.checkIn,
          checkOut: input.checkOut,
        })
      );
    });
  }

  function getAvailabilityByType(input) {
    return Object.keys(pricing.ROOM_TYPES).reduce((availability, type) => {
      const party = input.party || { adults: 1, kidsAges: [] };
      const neededUnits = pricing.getUnitsNeeded(type, party);
      const availableRooms = getAvailableRooms({
        rooms: input.rooms,
        reservations: input.reservations,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        type,
      });

      availability[type] = {
        type,
        neededUnits,
        availableRooms,
        availableCount: availableRooms.length,
        isAvailable: availableRooms.length >= neededUnits,
      };

      return availability;
    }, {});
  }

  function hasAnyAvailability(input) {
    return Object.values(getAvailabilityByType(input)).some((typeAvailability) => {
      return typeAvailability.isAvailable;
    });
  }

  function isDateFullyUnavailable(input) {
    const checkIn = pricing.toISODate(input.date);
    const checkOut = pricing.addDays(checkIn, 1);

    return !hasAnyAvailability({
      rooms: input.rooms,
      reservations: input.reservations,
      checkIn,
      checkOut,
      party: input.party,
    });
  }

  function getUnavailableDates(input) {
    const days = Number(input.days || 0);
    const unavailableDates = [];

    for (let index = 0; index < days; index += 1) {
      const date = pricing.addDays(input.startDate, index);

      if (
        isDateFullyUnavailable({
          rooms: input.rooms,
          reservations: input.reservations,
          date,
          party: input.party,
        })
      ) {
        unavailableDates.push(date);
      }
    }

    return unavailableDates;
  }

  function orderRoomsForAssignment(rooms, type) {
    const config = pricing.ROOM_TYPES[type];

    if (!config) {
      throw new Error(`Unknown accommodation type: ${type}`);
    }

    return (rooms || [])
      .filter((room) => room.is_active !== false && room.type === type)
      .slice()
      .sort((left, right) => {
        return config.assignmentDirection === 'descending'
          ? Number(right.number) - Number(left.number)
          : Number(left.number) - Number(right.number);
      });
  }

  function chooseRoomsForAssignment(input) {
    const neededUnits = input.units || pricing.getUnitsNeeded(input.type, input.party || { adults: 1, kidsAges: [] });
    const selectedNumbers = Array.from(new Set(input.selectedRoomNumbers || []));
    const availableRooms = getAvailableRooms({
      rooms: input.rooms,
      reservations: input.reservations,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      type: input.type,
    });
    const availableByNumber = new Map(availableRooms.map((room) => [Number(room.number), room]));
    const explicitlySelectedRooms = selectedNumbers.map((roomNumber) => {
      const room = availableByNumber.get(Number(roomNumber));

      if (!room) {
        throw new Error(`Selected room ${roomNumber} is not available for this stay.`);
      }

      return room;
    });
    const explicitlySelectedIds = new Set(explicitlySelectedRooms.map((room) => room.id));
    const automaticallyOrderedRooms = orderRoomsForAssignment(availableRooms, input.type).filter((room) => {
      return !explicitlySelectedIds.has(room.id);
    });
    const chosenRooms = explicitlySelectedRooms.concat(automaticallyOrderedRooms).slice(0, neededUnits);

    if (chosenRooms.length < neededUnits) {
      throw new Error(`Not enough available ${input.type} rooms for ${neededUnits} unit(s).`);
    }

    return {
      type: input.type,
      neededUnits,
      rooms: chosenRooms,
      roomIds: chosenRooms.map((room) => room.id),
      roomNumbers: chosenRooms.map((room) => Number(room.number)),
      explicitlySelected: explicitlySelectedRooms.length > 0,
    };
  }

  function findEarliestAvailability(input) {
    const maxDays = Number(input.maxDays || 180);
    const stayNights = Number(input.stayNights || 1);

    for (let offset = 0; offset < maxDays; offset += 1) {
      const checkIn = pricing.addDays(input.startDate, offset);
      const checkOut = pricing.addDays(checkIn, stayNights);
      const availableRooms = getAvailableRooms({
        rooms: input.rooms,
        reservations: input.reservations,
        checkIn,
        checkOut,
        type: input.type,
      });
      const neededUnits = pricing.getUnitsNeeded(input.type, input.party || { adults: 1, kidsAges: [] });

      if (availableRooms.length >= neededUnits) {
        return {
          type: input.type,
          checkIn,
          checkOut,
          neededUnits,
          availableRooms,
          availableCount: availableRooms.length,
        };
      }
    }

    return null;
  }

  return {
    chooseRoomsForAssignment,
    findEarliestAvailability,
    getAvailabilityByType,
    getAvailableRooms,
    getUnavailableDates,
    hasAnyAvailability,
    isActiveReservation,
    isDateFullyUnavailable,
    isRoomAvailable,
    orderRoomsForAssignment,
    rangesOverlap,
    reservationOverlapsRange,
  };
});
