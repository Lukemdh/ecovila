const BUSINESS_TIME_ZONE = 'Europe/Chisinau';

/**
 * Local hour (Europe/Chisinau) at or after which the "see you tomorrow" arrival
 * reminders are allowed to go out. The cron runs roughly every minute, so the
 * batch fires on the first tick of this hour instead of at the UTC-midnight
 * rollover (which lands at 03:00 EEST).
 */
export const ARRIVAL_REMINDER_LOCAL_HOUR = 10;

type BusinessDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
};

export function businessDateParts(now: Date): BusinessDateParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(now);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
  };
}

/**
 * Arrival reminders are held until the local business hour reaches
 * ARRIVAL_REMINDER_LOCAL_HOUR so guests no longer receive them overnight.
 */
export function shouldSendArrivalReminders(
  now: Date,
  hour = ARRIVAL_REMINDER_LOCAL_HOUR,
): boolean {
  return businessDateParts(now).hour >= hour;
}

/**
 * The check-in date (YYYY-MM-DD) that "tomorrow" reminders target, computed from
 * the Europe/Chisinau local date so the window matches the local calendar day.
 */
export function arrivalReminderTargetDate(now: Date): string {
  const { year, month, day } = businessDateParts(now);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
