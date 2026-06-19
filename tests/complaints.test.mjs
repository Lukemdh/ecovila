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
  it('ships the four functions with verify_jwt', () => {
    for (const fn of [
      'complaint-login-start',
      'complaint-login-verify',
      'complaint-submit',
      'send-checkin-welcome',
    ]) {
      assert.equal(exists(`supabase/functions/${fn}/index.ts`), true, `${fn} should exist`);
    }

    const config = read('supabase/config.toml');
    for (const fn of [
      'complaint-login-start',
      'complaint-login-verify',
      'complaint-submit',
      'send-checkin-welcome',
    ]) {
      assert.match(config, new RegExp(`\\[functions\\.${fn}\\]\\nverify_jwt = true`));
    }
  });

  it('gates login on a paid reservation and sends a localized lookup-code SMS', () => {
    const start = read('supabase/functions/complaint-login-start/index.ts');
    assert.match(start, /payment_status'?,?\s*'paid'/);
    assert.match(start, /composeLookupCodeSms\(code, language\)/);
    assert.match(start, /complaintLoginStartIp/);
  });

  it('localizes the OTP SMS for the reservation lookup flow too', () => {
    const lookup = read('supabase/functions/reservation-lookup-start/index.ts');
    assert.match(lookup, /composeLookupCodeSms\(code, language\)/);
    const supabase = read('js/supabase.js');
    assert.match(supabase, /reservation-lookup-start'[\s\S]*?language: language \|\| 'ro'/);
    assert.match(supabase, /complaint-login-start'[\s\S]*?language: language \|\| 'ro'/);
  });

  it('mints a complaint session only after a matching code', () => {
    const verify = read('supabase/functions/complaint-login-verify/index.ts');
    assert.match(verify, /hashComplaintCode/);
    assert.match(verify, /complaint_sessions/);
    assert.match(verify, /createComplaintSessionToken/);
  });

  it('drops identity for anonymous submissions', () => {
    const submit = read('supabase/functions/complaint-submit/index.ts');
    assert.match(submit, /isAnonymous/);
    assert.match(submit, /guest_phone: null, guest_first_name: null, reservation_id: null/);
  });

  it('only welcomes paid, non-cancelled arrivals and dedups per group', () => {
    const welcome = read('supabase/functions/send-checkin-welcome/index.ts');
    assert.match(welcome, /requireStaffRole\(request, \['diana', 'angela'\]\)/);
    assert.match(welcome, /payment_status !== 'paid' \|\| reservation\.cancelled_at/);
    assert.match(welcome, /mapNotificationOwners/);
    assert.match(welcome, /'checkin_welcome'/);
  });

  it('registers complaint rate-limit buckets', () => {
    const rate = read('supabase/functions/_shared/rateLimit.ts');
    assert.match(rate, /complaintLoginStartIp/);
    assert.match(rate, /complaintLoginVerifyIp/);
    assert.match(rate, /complaintSubmitIp/);
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

  it('offers the four categories, a description and the anonymous toggle', () => {
    for (const category of ['casuta', 'facilitati', 'personal', 'altceva']) {
      assert.match(html, new RegExp(`data-cmp-category="${category}"`));
    }
    assert.match(html, /data-cmp-description/);
    assert.match(html, /data-cmp-anonymous/);
    assert.match(html, /data-cmp-submit/);
  });

  it('stamps every local asset reference', () => {
    assert.deepEqual(findUnversionedAssetRefs(html), []);
  });

  it('wires the front-end script to the edge-function helpers', () => {
    const js = read('js/complaints.js');
    assert.match(js, /startComplaintLogin/);
    assert.match(js, /verifyComplaintLogin/);
    assert.match(js, /submitComplaint/);
    assert.match(js, /hasReservations === false/);
  });

  it('exposes the helper functions from the Supabase wrapper', () => {
    const supabase = read('js/supabase.js');
    for (const fn of [
      'startComplaintLogin',
      'verifyComplaintLogin',
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
    assert.match(translations, /'complaints\.anonymous': 'Vreau anonim'/);
    assert.match(translations, /'complaints\.anonymous': 'Анонимно'/);
    assert.match(translations, /'complaints\.anonymous': 'Stay anonymous'/);
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
