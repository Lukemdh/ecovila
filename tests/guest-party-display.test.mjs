// Regression guard for ADR-063: the headline guest count on the confirmation
// page and the manage page must reflect the booking's real party, never a sum
// across the booking-group rooms.
//
// Data model: every room row in a booking group stores the *same* full party
// (the server enforces this — pricingGuard rejects rows whose party differs
// from the first, and applyBookingChange rewrites every row identically). Only
// the price is partitioned across rooms. So the party must be read from a
// single row; summing it across N rooms multiplies the party by N (a 2-room
// booking of 3 adults · 4 children was shown as "6 adulți · 8 copii").
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// formatGuests/formatManagedGuests resolve copy through t(), which reads
// globalThis.EcoVilaTranslations at call time and falls back to the 'ro' bundle
// (getLanguage() returns 'ro' with no document). Provide just the party keys.
globalThis.EcoVilaTranslations = {
  ro: {
    'checkout.oneAdult': '1 adult',
    'checkout.adultsCount': '{count} adulți',
    'checkout.oneChild': '1 copil',
    'checkout.childrenCount': '{count} copii',
  },
};

let confirmare;
let gestionare;

before(() => {
  confirmare = require('../js/confirmare.js');
  gestionare = require('../js/gestionare.js');
});

// The exact scenario from the bug report: a 2-room hotel booking for a family
// of 3 adults + 4 children (ages 7, 11, 11, 11). Both rooms carry the full party.
const party = { adults: 3, kids_ages: [7, 11, 11, 11] };
const twoRoomGroup = [{ ...party }, { ...party }];
const oneRoom = [{ ...party }];

describe('confirmare.formatGuests — party is never summed across rooms (ADR-063)', () => {
  it('reports the real party for a multi-room booking, not the doubled count', () => {
    assert.equal(confirmare.formatGuests(twoRoomGroup), '3 adulți · 4 copii');
  });

  it('matches the single-room result regardless of how many rooms are in the group', () => {
    assert.equal(confirmare.formatGuests(twoRoomGroup), confirmare.formatGuests(oneRoom));
  });

  it('never produces the old doubled output', () => {
    const result = confirmare.formatGuests(twoRoomGroup);
    assert.doesNotMatch(result, /6 adulți/);
    assert.doesNotMatch(result, /8 copii/);
  });

  it('omits the children clause when there are none', () => {
    assert.equal(confirmare.formatGuests([{ adults: 1, kids_ages: [] }]), '1 adult');
  });

  it('handles an empty reservation list without throwing', () => {
    assert.equal(confirmare.formatGuests([]), '0 adulți');
  });
});

describe('gestionare.formatManagedGuests — party is never summed across rooms (ADR-063)', () => {
  it('reports the real party and child ages for a multi-room booking', () => {
    assert.equal(gestionare.formatManagedGuests(twoRoomGroup), '3 adulți · 4 copii (7, 11, 11, 11)');
  });

  it('matches the single-room result regardless of how many rooms are in the group', () => {
    assert.equal(
      gestionare.formatManagedGuests(twoRoomGroup),
      gestionare.formatManagedGuests(oneRoom),
    );
  });

  it('never doubles the adults, children, or the listed ages', () => {
    const result = gestionare.formatManagedGuests(twoRoomGroup);
    assert.doesNotMatch(result, /6 adulți/);
    assert.doesNotMatch(result, /8 copii/);
    assert.doesNotMatch(result, /11, 11, 11, 7/); // ages list would repeat if flat-mapped
  });
});
