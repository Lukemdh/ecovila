(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const HOLIDAY_KEY_PATTERN = /^(\d{2})-(\d{2})$/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_PREMIUM_NEXT_DAYS = [6, 0];
  const CHILD_MIN_AGE = 1;
  const CHILD_MAX_AGE = 17;
  const FREE_CHILD_MAX_AGE = 3;
  const CHILD_FEE_MAX_AGE = 11;

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

  function toHolidayKey(value) {
    if (value && typeof value === 'object') {
      if ('date' in value) {
        return toHolidayKey(value.date);
      }

      if ('month' in value && 'day' in value) {
        return toHolidayKey(`${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`);
      }
    }

    const raw = String(value || '').trim();
    const isoMatch = raw.match(ISO_DATE_PATTERN);
    if (isoMatch) {
      return toISODate(raw).slice(5);
    }

    const monthDayMatch = raw.match(HOLIDAY_KEY_PATTERN);
    if (!monthDayMatch) {
      throw new Error(`Expected holiday in YYYY-MM-DD or MM-DD format, received: ${value}`);
    }

    const canonicalDate = `2000-${monthDayMatch[1]}-${monthDayMatch[2]}`;
    return toISODate(canonicalDate).slice(5);
  }

  function todayISO() {
    const date = new Date();
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
    return localDate.toISOString().slice(0, 10);
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
    const freeChildAges = kidsAges.filter((age) => Number.isInteger(age) && age >= CHILD_MIN_AGE && age <= FREE_CHILD_MAX_AGE);
    const chargeableKidAges = kidsAges.filter((age) => Number.isInteger(age) && age > FREE_CHILD_MAX_AGE && age <= CHILD_FEE_MAX_AGE);
    const teenAges = kidsAges.filter((age) => Number.isInteger(age) && age > CHILD_FEE_MAX_AGE && age <= CHILD_MAX_AGE);

    return {
      adults,
      kidsAges,
      freeChildAges,
      chargeableKidAges,
      teenAges,
      kids: kidsAges.length,
      freeKids: freeChildAges.length,
      chargeableKids: chargeableKidAges.length,
      teensAsAdults: teenAges.length,
      overflowKids: 0,
      effectiveAdults: adults,
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
      if (!Number.isInteger(age) || age < CHILD_MIN_AGE || age > CHILD_MAX_AGE) {
        errors.push('Child ages must be whole numbers from 1 to 17.');
      }
    });

    if (settings.publicBooking && normalized.adults < 1) {
      errors.push('At least one adult is required for public bookings.');
    }

    if (normalized.adults + normalized.kidsAges.length === 0) {
      errors.push('At least one guest is required.');
    }

    return {
      valid: errors.length === 0,
      errors,
      adults: normalized.adults,
      kidsAges: normalized.kidsAges,
      kids: normalized.kids,
      freeKids: normalized.freeKids,
      chargeableKids: normalized.chargeableKids,
      teensAsAdults: normalized.teensAsAdults,
      effectiveAdults: normalized.effectiveAdults,
    };
  }

  function getUnitsNeeded(roomType, party) {
    const config = assertRoomType(roomType);
    const normalized = normalizeParty(party);
    let units = 1;

    while (
      normalized.adults > units * config.maxAdults ||
      normalized.kids > units * config.maxKids + Math.max(0, units * config.maxAdults - normalized.adults)
    ) {
      units += 1;
    }

    return units;
  }

  function isTypeAvailableForParty(roomType, party) {
    const normalized = normalizeParty(party);
    const neededUnits = getUnitsNeeded(roomType, normalized);

    return normalized.adults >= neededUnits;
  }

  function calculateBillableGuests(roomType, party, options) {
    const config = assertRoomType(roomType);
    const normalized = normalizeParty(party);
    const units = Number(options?.units || getUnitsNeeded(roomType, normalized));
    const minimumAdults = units * config.minimumAdults;
    const sortedChildAges = normalized.kidsAges
      .filter((age) => Number.isInteger(age) && age >= CHILD_MIN_AGE && age <= CHILD_MAX_AGE)
      .slice()
      .sort((left, right) => right - left);
    const minimumAdultFeeChildren = Math.max(0, minimumAdults - normalized.adults);
    const adultFeeChildCount = Math.min(
      sortedChildAges.length,
      Math.max(normalized.teensAsAdults, minimumAdultFeeChildren),
    );
    const childFeeAges = sortedChildAges.slice(adultFeeChildCount);
    const kidsChargedAsAdults = adultFeeChildCount;
    const emptyAdultSlots = Math.max(0, minimumAdults - normalized.adults - kidsChargedAsAdults);
    const billableAdults = normalized.adults + kidsChargedAsAdults + emptyAdultSlots;
    const billableKids = childFeeAges.filter((age) => age > FREE_CHILD_MAX_AGE && age <= CHILD_FEE_MAX_AGE).length;
    const freeKids = childFeeAges.filter((age) => age >= CHILD_MIN_AGE && age <= FREE_CHILD_MAX_AGE).length;

    return {
      actualAdults: normalized.adults,
      actualKids: normalized.kidsAges.length,
      capacityKids: normalized.kids,
      freeKids,
      chargeableKids: normalized.chargeableKids,
      teensAsAdults: normalized.teensAsAdults,
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
      (holidays || []).map((holiday) => toHolidayKey(holiday)),
    );
  }

  function getDayType(date, holidays, options) {
    const isoDate = toISODate(date);
    const premiumDate = addDays(isoDate, 1);
    const holidaySet = holidays instanceof Set ? toHolidaySet(Array.from(holidays)) : toHolidaySet(holidays);
    const premiumNextDays =
      options?.premiumNextDays || options?.weekendDays || DEFAULT_PREMIUM_NEXT_DAYS;
    const day = parseISODate(premiumDate).getUTCDay();

    return holidaySet.has(toHolidayKey(premiumDate)) || premiumNextDays.includes(day) ? 'holiday' : 'weekday';
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
      .sort((left, right) => {
        const effectiveCompare = compareDates(right.effective_from, left.effective_from);
        if (effectiveCompare !== 0) {
          return effectiveCompare;
        }

        return String(right.created_at || '').localeCompare(String(left.created_at || ''));
      });

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
    isTypeAvailableForParty,
    normalizeParty,
    parseISODate,
    toHolidayKey,
    toISODate,
    validateParty,
  };
});
