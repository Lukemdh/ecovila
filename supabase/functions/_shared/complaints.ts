export const COMPLAINT_CATEGORIES = ['casuta', 'facilitati', 'personal', 'altceva'] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_DESCRIPTION_MAX = 2000;

export function isComplaintCategory(value: unknown): value is ComplaintCategory {
  return COMPLAINT_CATEGORIES.includes(String(value || '') as ComplaintCategory);
}

export function assertValidComplaintCategory(value: unknown): ComplaintCategory {
  if (!isComplaintCategory(value)) {
    throw new Error('Invalid complaint category.');
  }
  return value;
}

/**
 * Trims the guest's text and enforces the 1..2000 char bound the table also
 * checks. Collapses nothing else — the description is shown verbatim to staff.
 */
export function normalizeComplaintDescription(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.length < 1 || text.length > COMPLAINT_DESCRIPTION_MAX) {
    throw new Error('Complaint description must be between 1 and 2000 characters.');
  }
  return text;
}

export function normalizeComplaintLanguage(value: unknown): 'ro' | 'ru' | 'en' {
  const language = String(value || '').trim().toLowerCase();
  return language === 'ru' || language === 'en' ? language : 'ro';
}

export const COMPLAINT_ROOM_MAX = 40;

/**
 * Cabin number/label for a "casuta" complaint. Single line, trimmed, capped.
 * Returns '' when nothing usable was provided so the caller can reject it.
 */
export function normalizeComplaintRoom(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, COMPLAINT_ROOM_MAX);
}

/**
 * Staff triage complaints in Romanian, so a casuta report bakes the cabin number
 * straight into the description ("Căsuța <n> — …") instead of adding a column.
 * The result is capped to the table's 2000-char bound; an extreme guest body is
 * trimmed at the tail so the prefix always survives.
 */
export function composeCasutaDescription(room: string, description: string): string {
  const composed = `Căsuța ${room} — ${description}`;
  return composed.length > COMPLAINT_DESCRIPTION_MAX
    ? composed.slice(0, COMPLAINT_DESCRIPTION_MAX)
    : composed;
}

/**
 * Optional follow-up phone left on the (now auth-free) complaint form. Returns a
 * normalized +E.164-ish number, or null when blank/invalid — a bad value never
 * blocks the complaint, it just means staff get no number to call back.
 */
export function normalizeOptionalPhone(value: unknown): string | null {
  const phone = String(value ?? '').replace(/[\s().-]/g, '');
  return /^\+\d{8,15}$/.test(phone) ? phone : null;
}
