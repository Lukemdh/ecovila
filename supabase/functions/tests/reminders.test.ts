import { assertEquals } from 'std/assert';
import {
  ARRIVAL_REMINDER_LOCAL_HOUR,
  arrivalReminderTargetDate,
  businessDateParts,
  shouldSendArrivalReminders,
} from '../_shared/reminders.ts';

Deno.test('arrival reminders are held overnight and released at 10:00 Europe/Chisinau', () => {
  // 00:00 UTC == 03:00 EEST (summer): previously the reminder fired here.
  const overnight = new Date('2026-07-01T00:00:00Z');
  assertEquals(shouldSendArrivalReminders(overnight), false);

  // 06:59 UTC == 09:59 EEST: still held.
  const beforeTen = new Date('2026-07-01T06:59:00Z');
  assertEquals(shouldSendArrivalReminders(beforeTen), false);

  // 07:00 UTC == 10:00 EEST: released.
  const atTen = new Date('2026-07-01T07:00:00Z');
  assertEquals(shouldSendArrivalReminders(atTen), true);

  // Later in the day stays released so late bookings are still reminded.
  const afternoon = new Date('2026-07-01T15:30:00Z');
  assertEquals(shouldSendArrivalReminders(afternoon), true);
});

Deno.test('arrival reminder target date is tomorrow in Europe/Chisinau time', () => {
  // 10:00 EEST on 2026-07-01 targets arrivals on 2026-07-02.
  assertEquals(arrivalReminderTargetDate(new Date('2026-07-01T07:00:00Z')), '2026-07-02');

  // End-of-month rollover.
  assertEquals(arrivalReminderTargetDate(new Date('2026-07-31T12:00:00Z')), '2026-08-01');
});

Deno.test('business date parts reflect Europe/Chisinau local time', () => {
  const parts = businessDateParts(new Date('2026-07-01T07:00:00Z'));
  assertEquals(parts.hour, ARRIVAL_REMINDER_LOCAL_HOUR);
  assertEquals(parts, { year: 2026, month: 7, day: 1, hour: 10 });
});
