(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaPayments = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  /**
   * Live browser handoff for Maib ePay.
   *
   * Maib technicians can replace the placeholder return value with the hosted
   * Maib payment URL once the final browser-side integration details are known.
   * Until then, checkout intentionally receives an empty value and uses its
   * existing confirmation-page fallback.
   */
  function startCardPayment() {
    return '';
  }

  return {
    startCardPayment,
  };
});
