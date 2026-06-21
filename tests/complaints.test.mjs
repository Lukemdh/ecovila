import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { findUnversionedAssetRefs } from '../scripts/stamp-asset-versions.mjs';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

describe('EcoVila complaints — database migration (ADR-068)', () => {
  const migration = read('supabase/migrations/20260619170000_complaints.sql');

  it('creates the complaints, read-state and session tables', () => {
    assert.match(migration, /create table if not exists public\.complaints/);
    assert.match(migration, /create table if not exists public\.complaint_read_state/);
    assert.match(migration, /create table if not exists public\.complaint_sessions/);
  });

  it('retires the orphaned complaint_sessions table in ADR-080', () => {
    const drop = read('supabase/migrations/20260621120000_drop_complaint_sessions.sql');
    assert.match(drop, /drop table if exists public\.complaint_sessions/);
  });

  it('restricts categories and enforces true anonymity', () => {
    assert.match(migration, /category in \('casuta', 'facilitati', 'personal', 'altceva'\)/);
    assert.match(migration, /complaints_anonymous_identity_check/);
    assert.match(migration, /guest_phone is null and guest_first_name is null and reservation_id is null/);
  });

  it('locks the table to CRM staff and keeps inserts service-role only', () => {
    assert.match(migration, /enable row level security/);
    assert.match(migration, /CRM staff can read complaints/);
    assert.match(migration, /CRM staff can update complaints/);
    // No insert policy on complaints => only the service-role edge function writes.
    assert.equal(/for insert[\s\S]*?on public\.complaints/.test(migration), false);
  });

  it('adds the checkin_welcome notification event type and realtime', () => {
    assert.match(migration, /'checkin_welcome'/);
    assert.match(migration, /alter publication supabase_realtime add table public\.complaints/);
  });
});

describe('EcoVila complaints — edge functions', () => {
  it('ships complaint-submit + send-checkin-welcome with verify_jwt (login fns retired in ADR-080)', () => {
    for (const fn of ['complaint-submit', 'send-checkin-welcome']) {
      assert.equal(exists(`supabase/functions/${fn}/index.ts`), true, `${fn} should exist`);
    }
    // The OTP login functions were deleted when complaints went auth-free.
    assert.equal(exists('supabase/functions/complaint-login-start/index.ts'), false);
    assert.equal(exists('supabase/functions/complaint-login-verify/index.ts'), false);

    const config = read('supabase/config.toml');
    for (const fn of ['complaint-submit', 'send-checkin-welcome']) {
      assert.match(config, new RegExp(`\\[functions\\.${fn}\\]\\nverify_jwt = true`));
    }
    assert.equal(/\[functions\.complaint-login-/.test(config), false);
  });

  it('localizes the OTP SMS for the reservation lookup flow too', () => {
    const lookup = read('supabase/functions/reservation-lookup-start/index.ts');
    assert.match(lookup, /composeLookupCodeSms\(code, language\)/);
    const supabase = read('js/supabase.js');
    assert.match(supabase, /reservation-lookup-start'[\s\S]*?language: language \|\| 'ro'/);
  });

  it('is auth-free, prefixes the cabin number for casuta and keeps the phone optional', () => {
    const submit = read('supabase/functions/complaint-submit/index.ts');
    // The OTP session-token gate and the anonymity flag are both gone.
    assert.equal(/complaintToken/.test(submit), false);
    assert.equal(/isAnonymous/.test(submit), false);
    // Casuta reports bake "Căsuța <n> — …" straight into the description.
    assert.match(submit, /category === 'casuta'/);
    assert.match(submit, /composeCasutaDescription/);
    // An optional follow-up phone is the only identity a guest can leave.
    assert.match(submit, /normalizeOptionalPhone/);
    assert.match(submit, /guest_phone: null, guest_first_name: null, reservation_id: null/);
  });

  it('only welcomes paid, non-cancelled arrivals and dedups per group', () => {
    const welcome = read('supabase/functions/send-checkin-welcome/index.ts');
    assert.match(welcome, /requireStaffRole\(request, \['diana', 'angela'\]\)/);
    assert.match(welcome, /payment_status !== 'paid' \|\| reservation\.cancelled_at/);
    assert.match(welcome, /mapNotificationOwners/);
    assert.match(welcome, /'checkin_welcome'/);
  });

  it('registers the complaint-submit rate-limit bucket (login buckets retired in ADR-080)', () => {
    const rate = read('supabase/functions/_shared/rateLimit.ts');
    assert.match(rate, /complaintSubmitIp/);
    assert.equal(/complaintLoginStartIp|complaintLoginVerifyIp/.test(rate), false);
  });

  it('keeps the welcome SMS copy in the notifications module', () => {
    const notifications = read('supabase/functions/_shared/notifications.ts');
    assert.match(notifications, /composeCheckinWelcome/);
    assert.match(notifications, /ecovila\.md\/complaints/);
    assert.match(notifications, /Bun venit la EcoVila/);
    assert.match(notifications, /Добро пожаловать в EcoVila/);
    assert.match(notifications, /Welcome to EcoVila/);
  });
});

describe('EcoVila complaints — guest page', () => {
  const html = read('complaints.html');

  it('is noindex and links its dedicated stylesheet', () => {
    assert.match(html, /name="robots" content="noindex"/);
    assert.match(html, /css\/complaints\.css\?v=/);
  });

  it('offers the four categories, a cabin-number field, a description and an optional phone', () => {
    for (const category of ['casuta', 'facilitati', 'personal', 'altceva']) {
      assert.match(html, new RegExp(`data-cmp-category="${category}"`));
    }
    assert.match(html, /data-cmp-room-field/);
    assert.match(html, /data-cmp-room/);
    assert.match(html, /data-cmp-description/);
    assert.match(html, /data-cmp-phone/);
    assert.match(html, /data-cmp-submit/);
    // The OTP login card and the anonymity toggle are gone — complaints are auth-free.
    assert.equal(/data-cmp-anonymous/.test(html), false);
    assert.equal(/data-cmp-login/.test(html), false);
  });

  it('stamps every local asset reference', () => {
    assert.deepEqual(findUnversionedAssetRefs(html), []);
  });

  it('wires the front-end script to the auth-free submit helper', () => {
    const js = read('js/complaints.js');
    assert.match(js, /submitComplaint/);
    assert.match(js, /roomNumber:/);
    assert.match(js, /isCasuta\(\)/);
    // No OTP login flow anymore.
    assert.equal(/startComplaintLogin|verifyComplaintLogin/.test(js), false);
  });

  it('exposes the helper functions from the Supabase wrapper', () => {
    const supabase = read('js/supabase.js');
    for (const fn of [
      'submitComplaint',
      'fetchComplaints',
      'markComplaintSolved',
      'fetchComplaintReadState',
      'upsertComplaintReadState',
      'countUnreadComplaints',
      'sendCheckinWelcome',
    ]) {
      assert.match(supabase, new RegExp(`function ${fn}\\b`), `${fn} should be defined`);
    }
  });

  it('translates the complaints UI into all three languages', () => {
    const translations = read('js/translations.js');
    assert.match(translations, /'complaints\.cat\.casuta': 'Căsuța'/);
    assert.match(translations, /'complaints\.cat\.casuta': 'Домик'/);
    assert.match(translations, /'complaints\.cat\.casuta': 'Villa'/);
    assert.match(translations, /'complaints\.roomLabel': 'Numărul căsuței'/);
    assert.match(translations, /'complaints\.roomLabel': 'Номер домика'/);
    assert.match(translations, /'complaints\.roomLabel': 'Villa number'/);
  });

  it('serves the clean /complaints URL', () => {
    assert.match(read('.htaccess'), /RewriteRule \^complaints\/\?\$ \/complaints\.html \[L\]/);
  });
});

describe('EcoVila complaints — admin Probleme tab', () => {
  it('adds the badged tab and panel to the dashboard', () => {
    const dashboard = read('admin/dashboard.html');
    assert.match(dashboard, /data-tab="probleme"/);
    assert.match(dashboard, /data-complaints-badge/);
    assert.match(dashboard, /data-panel="probleme"/);
    assert.match(dashboard, /data-complaints-list/);
    assert.match(dashboard, /data-complaints-view="current"/);
    assert.match(dashboard, /data-complaints-view="archive"/);
    assert.match(dashboard, /js\/crm-complaints\.js\?v=/);
  });

  it('makes the tab visible to both Diana and Angela', () => {
    const app = read('admin/js/crm-app.js');
    assert.match(app, /TAB_NAMES = \[[^\]]*'probleme'/);
    assert.match(app, /angela: \[[^\]]*'probleme'/);
    assert.match(app, /EcoVilaCrmComplaints\?\.showPanel/);
    assert.match(app, /EcoVilaCrmComplaints\?\.init/);
  });

  it('reads complaints and marks them solved in the module', () => {
    const module = read('admin/js/crm-complaints.js');
    assert.match(module, /fetchComplaints/);
    assert.match(module, /markComplaintSolved/);
    assert.match(module, /upsertComplaintReadState/);
    assert.match(module, /countUnreadComplaints/);
    // Description rendered via textContent (never innerHTML) to block injection.
    assert.match(module, /text\.textContent = complaint\.description/);
  });

  it('fires the welcome SMS from the daily check-in action', () => {
    const daily = read('admin/js/crm-daily.js');
    assert.match(daily, /sendCheckinWelcome\?\.\(context\.client, reservation\.id\)/);
  });
});
