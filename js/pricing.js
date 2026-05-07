(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_PREMIUM_NEXT_DAYS = [6, 0];

  const ROOM_TYPES = Object.freeze({
    small: Object.freeze({
      type: 'small',
      label: 'Căsuță Mică',
      maxAdults: 2,
      maxKids: 2,
      minimumAdults: 2,
      roomNumbers: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
      assignmentDirection: 'descending',
    }),
    large: Object.freeze({
      type: 'large',
      label: 'Căsuță Mare',
      maxAdults: 4,
      maxKids: 2,
      minimumAdults: 3,
      roomNumbers: Object.freeze([9, 10, 11, 12, 13, 14, 15]),
      assignmentDirection: 'ascending',
    }),
    hotel: Object.freeze({
      type: 'hotel',
      label: 'Cameră în Hotel',
      maxAdults: 2,
      maxKids: 2,
      minimumAdults: 2,
      roomNumbers: Object.freeze([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]),
      assignmentDirection: 'ascending',
    }),
  });

  function assertRoomType(roomType) {
    if (!ROOM_TYPES[roomType]) {
      throw new Error(`Unknown accommodation type: ${roomType}`);
    }

    return ROOM_TYPES[roomType];
  }

  function parseISODate(value) {
    if (value instanceof Date) {
      return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    }

    const match = String(value || '').match(ISO_DATE_PATTERN);
    if (!match) {
      throw new Error(`Expected date in YYYY-MM-DD format, received: ${value}`);
    }

    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, monthIndex, day));

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== monthIndex ||
      date.getUTCDate() !== day
    ) {
      throw new Error(`Invalid calendar date: ${value}`);
    }

    return date;
  }

  function toISODate(value) {
    return parseISODate(value).toISOString().slice(0, 10);
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function compareDates(left, right) {
    const normalizedLeft = toISODate(left);
    const normalizedRight = toISODate(right);

    if (normalizedLeft < normalizedRight) {
      return -1;
    }

    if (normalizedLeft > normalizedRight) {
      return 1;
    }

    return 0;
  }

  function addDays(date, days) {
    const parsed = parseISODate(date);
    return new Date(parsed.getTime() + days * DAY_MS).toISOString().slice(0, 10);
  }

  function enumerateNights(checkIn, checkOut) {
    const start = toISODate(checkIn);
    const end = toISODate(checkOut);

    if (start >= end) {
      throw new Error('Check-out must be after check-in.');
    }

    const nights = [];
    for (let current = start; current < end; current = addDays(current, 1)) {
      nights.push(current);
    }

    return nights;
  }

  function getNightsTier(nights) {
    const normalized = Number(nights);

    if (!Number.isInteger(normalized) || normalized < 1) {
      throw new Error('A booking must contain at least one night.');
    }

    return normalized === 1 ? 1 : normalized === 2 ? 2 : 3;
  }

  function normalizeParty(party) {
    const adults = Number(party?.adults || 0);
    const kidsAges = Array.isArray(party?.kidsAges)
      ? party.kidsAges.map((age) => Number(age))
      : [];

    return {
      adults,
      kidsAges,
      kids: kidsAges.length,
    };
  }

  function validateParty(party, options) {
    const settings = Object.assign({ publicBooking: true }, options);
    const normalized = normalizeParty(party);
    const errors = [];

    if (!Number.isInteger(normalized.adults) || normalized.adults < 0) {
      errors.push('Adult count must be a non-negative integer.');
    }

    normalized.kidsAges.forEach((age) => {
      if (!Number.isInteger(age) || age < 0 || age > 12) {
        errors.push('Child ages must be whole numbers from 0 to 12.');
      }
    });

    if (settings.publicBooking && normalized.adults < 1) {
      errors.push('At least one adult is required for public bookings.');
    }

    if (normalized.adults + normalized.kids === 0) {
      errors.push('At least one guest is required.');
    }

    return {
      valid: errors.length === 0,
      errors,
      adults: normalized.adults,
      kidsAges: normalized.kidsAges,
      kids: normalized.kids,
    };
  }

  function getUnitsNeeded(roomType, party) {
    const config = assertRoomType(roomType);
    const normalized = normalizeParty(party);
    const adultUnits = Math.ceil(normalized.adults / config.maxAdults);
    const kidUnits = Math.ceil(normalized.kids / config.maxKids);

    return Math.max(1, adultUnits, kidUnits);
  }

  function calculateBillableGuests(roomType, party, options) {
    const config = assertRoomType(roomType);
    const normalized = normalizeParty(party);
    const units = Number(options?.units || getUnitsNeeded(roomType, normalized));
    const minimumAdults = units * config.minimumAdults;
    const adultSlotsToFill = Math.max(0, minimumAdults - normalized.adults);
    const kidsChargedAsAdults = Math.min(normalized.kids, adultSlotsToFill);
    const emptyAdultSlots = Math.max(0, adultSlotsToFill - kidsChargedAsAdults);
    const billableAdults = normalized.adults + kidsChargedAsAdults + emptyAdultSlots;
    const billableKids = normalized.kids - kidsChargedAsAdults;

    return {
      actualAdults: normalized.adults,
      actualKids: normalized.kids,
      billableAdults,
      billableKids,
      kidsChargedAsAdults,
      emptyAdultSlots,
      units,
      minimumAdults,
    };
  }

  function toHolidaySet(holidays) {
    return new Set(
      (holidays || []).map((holiday) => toISODate(typeof holiday === 'string' ? holiday : holiday.date)),
    );
  }

  function getDayType(date, holidays, options) {
    const isoDate = toISODate(date);
    const premiumDate = addDays(isoDate, 1);
    const holidaySet = holidays instanceof Set ? holidays : toHolidaySet(holidays);
    const premiumNextDays =
      options?.premiumNextDays || options?.weekendDays || DEFAULT_PREMIUM_NEXT_DAYS;
    const day = parseISODate(premiumDate).getUTCDay();

    return holidaySet.has(premiumDate) || premiumNextDays.includes(day) ? 'holiday' : 'weekday';
  }

  function findPricingRow(pricingTiers, lookup) {
    const createdOn = toISODate(lookup.createdOn || todayISO());
    const matches = (pricingTiers || [])
      .filter((row) => {
        return (
          Number(row.nights_tier) === Number(lookup.nightsTier) &&
          row.day_type === lookup.dayType &&
          toISODate(row.effective_from) <= createdOn
        );
      })
      .sort((left, right) => compareDates(right.effective_from, left.effective_from));

    if (!matches.length) {
      throw new Error(
        `No pricing row found for tier ${lookup.nightsTier}, ${lookup.dayType}, effective on ${createdOn}.`,
      );
    }

    return matches[0];
  }

  function calculateStayPrice(input) {
    const checkIn = toISODate(input.checkIn);
    const checkOut = toISODate(input.checkOut);
    const nightsList = enumerateNights(checkIn, checkOut);
    const nightsTier = getNightsTier(nightsList.length);
    const party = {
      adults: input.adults,
      kidsAges: input.kidsAges || [],
    };
    const units = input.units || getUnitsNeeded(input.roomType, party);
    const billable = calculateBillableGuests(input.roomType, party, { units });
    const holidaySet = toHolidaySet(input.holidays || []);
    const createdOn = input.createdOn || todayISO();

    const nightlyBreakdown = nightsList.map((date) => {
      const dayType = getDayType(date, holidaySet, {
        premiumNextDays: input.premiumNextDays,
        weekendDays: input.weekendDays,
      });
      const row = findPricingRow(input.pricingTiers, { nightsTier, dayType, createdOn });
      const adultPrice = Number(row.adult_price);
      const kidPrice = Number(row.kid_price);
      const subtotal = billable.billableAdults * adultPrice + billable.billableKids * kidPrice;

      return {
        date,
        dayType,
        adultPrice,
        kidPrice,
        billableAdults: billable.billableAdults,
        billableKids: billable.billableKids,
        subtotal,
      };
    });

    return {
      roomType: input.roomType,
      checkIn,
      checkOut,
      nights: nightsList.length,
      nightsTier,
      units,
      billable,
      nightlyBreakdown,
      total: nightlyBreakdown.reduce((sum, night) => sum + night.subtotal, 0),
    };
  }

  function getFittingRoomTypes(party) {
    return Object.keys(ROOM_TYPES).map((roomType) => ({
      type: roomType,
      units: getUnitsNeeded(roomType, party),
      capacity: ROOM_TYPES[roomType],
    }));
  }

  function formatMDL(amount) {
    return `${Number(amount || 0).toLocaleString('ro-MD')} MDL`;
  }

  return {
    ROOM_TYPES,
    DEFAULT_PREMIUM_NEXT_DAYS: Object.freeze(DEFAULT_PREMIUM_NEXT_DAYS.slice()),
    DEFAULT_WEEKEND_DAYS: Object.freeze(DEFAULT_PREMIUM_NEXT_DAYS.slice()),
    addDays,
    calculateBillableGuests,
    calculateStayPrice,
    compareDates,
    enumerateNights,
    findPricingRow,
    formatMDL,
    getDayType,
    getFittingRoomTypes,
    getNightsTier,
    getUnitsNeeded,
    parseISODate,
    toISODate,
    validateParty,
  };
});
