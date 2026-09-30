import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function normPolicyExpr(expr) {
  if (!expr) return '';
  return expr
    .replace(/public\.ecovila_app_role/g, 'ecovila_app_role')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripOneOuterParens(text) {
  if (!text) return text;
  const trimmed = text.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    let depth = 0;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '(') depth++;
      else if (trimmed[i] === ')') depth--;
      if (depth === 0) {
        if (i === trimmed.length - 1) {
          return trimmed.slice(1, -1).trim();
        }
        break;
      }
    }
  }
  return trimmed;
}

function unwrap(expr) {
  let res = expr.replace(/\(\s*select\s+public\.ecovila_app_role\(\)\s*\)/gi, 'ecovila_app_role()');
  res = res.replace(/\(\s*select\s+auth\.uid\(\)\s*\)/gi, 'auth.uid()');
  return res;
}

function takeParenthesised(sql, start) {
  if (sql[start] !== '(') {
    throw new Error(`Expected '(' at position ${start}, got: ${sql.slice(start, start + 30)}`);
  }
  let depth = 0;
  let inStr = false;
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    if (inStr) {
      if (ch === "'") {
        if (i + 1 < sql.length && sql[i + 1] === "'") {
          i++;
        } else {
          inStr = false;
        }
      }
    } else if (ch === "'") {
      inStr = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return [sql.slice(start + 1, i), i + 1];
      }
    }
    i++;
  }
  throw new Error('Unbalanced parentheses');
}

function parseAlters(sql) {
  const sqlNc = sql.replace(/--[^\n]*/g, '');
  const pattern = /alter\s+policy\s+"([^"]+)"\s+on\s+([a-z_]+)\.([a-z_]+)/gi;
  const out = [];
  let m;
  while ((m = pattern.exec(sqlNc)) !== null) {
    const name = m[1];
    const schema = m[2];
    const table = m[3];
    let pos = pattern.lastIndex;
    let using = null;
    let check = null;

    while (pos < sqlNc.length) {
      const rest = sqlNc.slice(pos);
      const stripped = rest.trimStart();
      pos += rest.length - stripped.length;
      const low = stripped.toLowerCase();
      if (low.startsWith('using')) {
        let p = pos + 5;
        while (p < sqlNc.length && /\s/.test(sqlNc[p])) p++;
        const [expr, nextPos] = takeParenthesised(sqlNc, p);
        using = expr;
        pos = nextPos;
      } else if (low.startsWith('with')) {
        let p = pos + 4;
        while (p < sqlNc.length && /\s/.test(sqlNc[p])) p++;
        assert.ok(
          sqlNc.slice(p, p + 5).toLowerCase().startsWith('check'),
          `Expected 'check' after 'with' at ${p}`,
        );
        p += 5;
        while (p < sqlNc.length && /\s/.test(sqlNc[p])) p++;
        const [expr, nextPos] = takeParenthesised(sqlNc, p);
        check = expr;
        pos = nextPos;
      } else {
        break;
      }
    }
    out.push({ name, schema, table, using, check });
  }
  return out;
}

function splitStatements(sql) {
  let inSingleQuote = false;
  let inDollarQuote = false;
  let dollarTag = '';
  let inLineComment = false;
  let inBlockComment = false;
  const statements = [];
  let current = '';

  let i = 0;
  while (i < sql.length) {
    if (inLineComment) {
      if (sql[i] === '\n') {
        inLineComment = false;
        current += ' ';
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (sql[i] === '*' && sql[i + 1] === '/') {
        inBlockComment = false;
        i += 2;
        current += ' ';
        continue;
      }
      i++;
      continue;
    }
    if (inSingleQuote) {
      current += sql[i];
      if (sql[i] === "'" && sql[i + 1] === "'") {
        current += sql[i + 1];
        i += 2;
        continue;
      } else if (sql[i] === "'") {
        inSingleQuote = false;
      }
      i++;
      continue;
    }
    if (inDollarQuote) {
      if (sql.startsWith('$' + dollarTag + '$', i)) {
        current += '$' + dollarTag + '$';
        i += dollarTag.length + 2;
        inDollarQuote = false;
        continue;
      }
      current += sql[i];
      i++;
      continue;
    }

    if (sql[i] === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (sql[i] === "'") {
      inSingleQuote = true;
      current += sql[i];
      i++;
      continue;
    }
    if (sql[i] === '$') {
      const m = sql.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
      if (m) {
        inDollarQuote = true;
        dollarTag = m[1];
        current += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (sql[i] === ';') {
      const stmt = current.trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
      current = '';
      i++;
      continue;
    }

    current += sql[i];
    i++;
  }

  const remainder = current.trim();
  if (remainder.length > 0) {
    statements.push(remainder);
  }

  return statements;
}

function parseCronScheduleCalls(sqlText) {
  const pattern = /select\s+cron\.schedule\s*\(/gi;
  const calls = [];
  let match;
  while ((match = pattern.exec(sqlText)) !== null) {
    const startPos = pattern.lastIndex;
    let depth = 1;
    let i = startPos;
    let inSingleQuote = false;
    let inDollarQuote = false;
    let dollarTag = '';
    const args = [];
    let currentArgStart = i;

    while (i < sqlText.length && depth > 0) {
      if (inSingleQuote) {
        if (sqlText[i] === "'" && sqlText[i + 1] === "'") {
          i += 2;
          continue;
        } else if (sqlText[i] === "'") {
          inSingleQuote = false;
        }
      } else if (inDollarQuote) {
        if (sqlText.startsWith('$' + dollarTag + '$', i)) {
          i += dollarTag.length + 2;
          inDollarQuote = false;
          continue;
        }
      } else {
        if (sqlText[i] === "'") {
          inSingleQuote = true;
        } else if (sqlText[i] === '$') {
          const dollarMatch = sqlText.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
          if (dollarMatch) {
            inDollarQuote = true;
            dollarTag = dollarMatch[1];
            i += dollarMatch[0].length;
            continue;
          }
        } else if (sqlText[i] === '(') {
          depth++;
        } else if (sqlText[i] === ')') {
          depth--;
          if (depth === 0) {
            args.push(sqlText.slice(currentArgStart, i).trim());
            break;
          }
        } else if (sqlText[i] === ',' && depth === 1) {
          args.push(sqlText.slice(currentArgStart, i).trim());
          currentArgStart = i + 1;
        }
      }
      i++;
    }

    const cleanArgs = args.map((arg) => {
      if (arg.startsWith("'") && arg.endsWith("'")) {
        return arg.slice(1, -1).replace(/''/g, "'");
      }
      const dollarMatch = arg.match(/^\$([a-zA-Z0-9_]*)\$([\s\S]*)\$\1\$$/);
      if (dollarMatch) {
        return dollarMatch[2].trim();
      }
      return arg.trim();
    });

    calls.push({
      name: cleanArgs[0],
      schedule: cleanArgs[1],
      command: cleanArgs[2],
    });
  }
  return calls;
}

describe('RLS role helper InitPlan migration and live policy parity', () => {
  const fixturePath = 'tests/fixtures/live-rls-policies-2026-09-29.json';
  const migrationPath = 'supabase/migrations/20260929130000_rls_role_helper_initplan.sql';
  const rollbackPath = 'supabase/ops/20260929_rls_role_helper_initplan_rollback.sql';
  const maintenancePath = 'supabase/migrations/20260929120000_bookkeeping_table_maintenance.sql';
  const runbookPath = 'supabase/ops/20260929_reclaim_bookkeeping_tables.sql';

  it('provides the live policy fixture holding all 32 policies and isolates storage.objects', () => {
    assert.ok(exists(fixturePath), `${fixturePath} should exist`);
    const fixture = JSON.parse(read(fixturePath));

    assert.equal(Array.isArray(fixture), true, 'fixture should be an array of policy rows');
    assert.equal(fixture.length, 32, 'fixture should contain exactly 32 live policies');

    // Verify ordering by schemaname, tablename, policyname
    for (let i = 0; i < fixture.length - 1; i++) {
      const a = fixture[i];
      const b = fixture[i + 1];
      const keyA = `${a.schemaname}.${a.tablename}.${a.policyname}`;
      const keyB = `${b.schemaname}.${b.tablename}.${b.policyname}`;
      assert.ok(keyA < keyB, `fixture not sorted: ${keyA} should precede ${keyB}`);
    }

    const publicPolicies = fixture.filter((r) => r.schemaname === 'public');
    const storagePolicies = fixture.filter((r) => r.schemaname === 'storage');

    assert.equal(publicPolicies.length, 29, 'exactly 29 policies should be on public schema');
    assert.equal(storagePolicies.length, 3, 'exactly 3 policies should be on storage schema');
    for (const p of storagePolicies) {
      assert.equal(p.tablename, 'objects', 'all storage policies should target storage.objects');
    }
  });

  it('migration contains exactly 29 ALTER POLICY statements and deliberately excludes storage.objects', () => {
    assert.ok(exists(migrationPath), `${migrationPath} should exist`);
    const sql = read(migrationPath);
    const alters = parseAlters(sql);

    assert.equal(alters.length, 29, 'migration must contain exactly 29 ALTER POLICY statements');

    for (const a of alters) {
      assert.equal(a.schema, 'public', `policy ${a.name} must target public, not ${a.schema}`);
      assert.notEqual(a.schema, 'storage', 'storage policies must not be altered');
    }

    // Header comment mentions why storage.objects is excluded and cites measured facts
    assert.match(sql, /storage\.objects/i, 'migration header should explain why storage.objects is excluded');
    assert.match(sql, /supabase_storage_admin/i, 'migration header should note storage.objects ownership');
    assert.match(sql, /48\s*ms\s*->\s*24\s*ms/i, 'migration header should cite measured latency improvements');
    assert.match(sql, /26\s*(?:->|to)\s*2,?639/i, 'migration header should cite corrected row estimate');
  });

  it('encloses the migration in transaction and timeout guards including transaction_timeout', () => {
    const sql = read(migrationPath);
    assert.match(sql, /^\s*begin;/m, 'migration should start with begin;');
    assert.match(sql, /set\s+local\s+lock_timeout\s*=\s*'2s';/i, 'lock_timeout should be 2s');
    assert.match(sql, /set\s+local\s+statement_timeout\s*=\s*'30s';/i, 'statement_timeout should be 30s');
    assert.match(sql, /set\s+local\s+transaction_timeout\s*=\s*'15s';/i, 'transaction_timeout should be 15s');
    assert.match(
      sql,
      /on\s+timeout\s+or\s+deadlock\s+the\s+transaction\s+rolls\s+back\s+automatically/i,
      'migration header should state automatic rollback on timeout or deadlock',
    );
    assert.match(sql, /commit;\s*$/m, 'migration should end with commit;');
  });

  it('mirrors USING / WITH CHECK presence and targets each fixture policy', () => {
    const fixture = JSON.parse(read(fixturePath));
    const publicMap = new Map();
    for (const r of fixture) {
      if (r.schemaname === 'public') {
        publicMap.set(`${r.tablename}.${r.policyname}`, r);
      }
    }

    const alters = parseAlters(read(migrationPath));
    const seen = new Set();

    for (const a of alters) {
      const key = `${a.table}.${a.name}`;
      assert.equal(seen.has(key), false, `duplicate alter policy for ${key}`);
      seen.add(key);

      const live = publicMap.get(key);
      assert.ok(live, `migration targets unknown policy: ${key}`);

      assert.equal(
        a.using !== null,
        live.qual !== null,
        `${key} USING presence mismatch (mig=${a.using !== null}, live=${live.qual !== null})`,
      );
      assert.equal(
        a.check !== null,
        live.with_check !== null,
        `${key} WITH CHECK presence mismatch (mig=${a.check !== null}, live=${live.with_check !== null})`,
      );
    }

    assert.equal(seen.size, 29, 'all 29 public policies must have an ALTER POLICY statement');
  });

  it('unwrapping each migration policy expression reproduces the fixture expression preserving grouping', () => {
    const fixture = JSON.parse(read(fixturePath));
    const publicMap = new Map();
    for (const r of fixture) {
      if (r.schemaname === 'public') {
        publicMap.set(`${r.tablename}.${r.policyname}`, r);
      }
    }

    const alters = parseAlters(read(migrationPath));

    for (const a of alters) {
      const key = `${a.table}.${a.name}`;
      const live = publicMap.get(key);

      for (const [clause, newExpr, liveExpr] of [
        ['using', a.using, live.qual],
        ['check', a.check, live.with_check],
      ]) {
        if (!liveExpr) continue;

        // Verify no unwrapped ecovila_app_role() or auth.uid() remains
        const stripped = newExpr
          .replace(/\(\s*select\s+public\.ecovila_app_role\(\)\s*\)/gi, '')
          .replace(/\(\s*select\s+auth\.uid\(\)\s*\)/gi, '');
        assert.equal(
          /ecovila_app_role\(\)|auth\.uid\(\)/i.test(stripped),
          false,
          `${key} ${clause} still contains unwrapped helper calls: ${newExpr}`,
        );

        // Verify unwrapping reproduces live expression preserving grouping
        // (normalising whitespace and public. prefix on helper only, stripping exactly ONE outer paren pair from live expression)
        const unwrapped = normPolicyExpr(unwrap(newExpr));
        const expected = normPolicyExpr(stripOneOuterParens(liveExpr));
        assert.equal(
          unwrapped,
          expected,
          `${key} ${clause} unwrap does not match live expression\n  new: ${newExpr}\n live: ${liveExpr}`,
        );
      }
    }
  });

  it('rollback script restores live policy expressions verbatim with identical transaction guards and ledger repair docs', () => {
    assert.ok(exists(rollbackPath), `${rollbackPath} should exist`);
    const sql = read(rollbackPath);

    assert.match(sql, /^\s*begin;/m, 'rollback should start with begin;');
    assert.match(sql, /set\s+local\s+lock_timeout\s*=\s*'2s';/i, 'rollback lock_timeout should be 2s');
    assert.match(sql, /set\s+local\s+statement_timeout\s*=\s*'30s';/i, 'rollback statement_timeout should be 30s');
    assert.match(sql, /set\s+local\s+transaction_timeout\s*=\s*'15s';/i, 'rollback transaction_timeout should be 15s');
    assert.match(
      sql,
      /on\s+timeout\s+or\s+deadlock\s+the\s+transaction\s+rolls\s+back\s+automatically/i,
      'rollback header should state automatic rollback on timeout or deadlock',
    );
    assert.match(
      sql,
      /supabase\s+migration\s+repair\s+--status\s+reverted\s+20260929130000/i,
      'rollback runbook must document migration repair ledger command',
    );
    assert.match(
      sql,
      /remove\s+that\s+migration\s+file\s+from\s+the\s+repository/i,
      'rollback runbook must document removing or superseding migration file',
    );
    assert.match(sql, /commit;\s*$/m, 'rollback should end with commit;');

    const fixture = JSON.parse(read(fixturePath));
    const publicMap = new Map();
    for (const r of fixture) {
      if (r.schemaname === 'public') {
        publicMap.set(`${r.tablename}.${r.policyname}`, r);
      }
    }

    const alters = parseAlters(sql);
    assert.equal(alters.length, 29, 'rollback must contain exactly 29 ALTER POLICY statements');

    for (const a of alters) {
      const key = `${a.table}.${a.name}`;
      const live = publicMap.get(key);
      assert.ok(live, `rollback targets unknown policy: ${key}`);

      for (const [clause, restoredExpr, liveExpr] of [
        ['using', a.using, live.qual],
        ['check', a.check, live.with_check],
      ]) {
        if (!liveExpr) {
          assert.equal(restoredExpr, null, `${key} ${clause} should be null in rollback`);
          continue;
        }

        // Verify rollback does NOT contain wrapped selects
        assert.equal(
          /select\s+(public\.)?ecovila_app_role|select\s+auth\.uid/i.test(restoredExpr),
          false,
          `${key} ${clause} rollback expression is still wrapped: ${restoredExpr}`,
        );

        // Verify every call to ecovila_app_role is schema-qualified as public.ecovila_app_role()
        assert.doesNotMatch(
          restoredExpr.replace(/public\.ecovila_app_role/g, ''),
          /ecovila_app_role/i,
          `${key} ${clause} rollback expression has unqualified ecovila_app_role: ${restoredExpr}`,
        );

        // Verify verbatim match preserving grouping
        const normRestored = normPolicyExpr(restoredExpr);
        const normLive = normPolicyExpr(stripOneOuterParens(liveExpr));
        assert.equal(
          normRestored,
          normLive,
          `${key} ${clause} rollback does not match live verbatim\n  rollback: ${restoredExpr}\n      live: ${liveExpr}`,
        );
      }
    }
  });

  it('enforces strict statement allowlists on RLS migration and maintenance migration', () => {
    // Helper validators
    function isAllowedRlsStatement(stmt) {
      if (/^begin$/i.test(stmt)) return true;
      if (/^commit$/i.test(stmt)) return true;
      if (/^set\s+local\s+(lock_timeout|statement_timeout|transaction_timeout)\s*=\s*'[^']+'$/i.test(stmt)) return true;
      if (/^alter\s+policy\s+"[^"]+"\s+on\s+public\.[a-z_]+(?:\s+using\s*\([\s\S]*?\)\s+with\s+check\s*\([\s\S]*?\)\s*|\s+using\s*\([\s\S]*?\)\s*|\s+with\s+check\s*\([\s\S]*?\)\s*)$/i.test(stmt)) return true;
      return false;
    }

    function isAllowedMaintenanceStatement(stmt) {
      const isGuardedUnschedule =
        /^select\s+cron\.unschedule\('ecovila-review-backfill'\)\s+where\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'ecovila-review-backfill'\s*\)$/i.test(stmt);
      const isSchedule = /^select\s+cron\.schedule\s*\([\s\S]*?\)$/i.test(stmt);
      return isGuardedUnschedule || isSchedule;
    }

    // 1. RLS migration allowlist
    const rlsSql = read(migrationPath);
    const rlsStatements = splitStatements(rlsSql);

    assert.equal(rlsStatements.length, 34, 'RLS migration must contain exactly 34 statements (begin, 3 timeouts, 29 alters, commit)');
    for (const stmt of rlsStatements) {
      assert.ok(isAllowedRlsStatement(stmt), `RLS statement not in allowlist: ${stmt.slice(0, 80)}`);
    }

    // 2. Maintenance migration allowlist
    const maintSql = read(maintenancePath);
    const maintStatements = splitStatements(maintSql);
    assert.equal(maintStatements.length, 4, 'maintenance migration must contain exactly 4 statements');

    for (const stmt of maintStatements) {
      assert.ok(
        isAllowedMaintenanceStatement(stmt),
        `maintenance migration statement not in allowlist: ${stmt.slice(0, 80)}`,
      );
    }

    // 3. Any other SQL statement (grant, revoke, drop, create, alter table, delete, update, insert, truncate...) must fail
    const disallowedStatements = [
      'grant select on all tables in schema public to anon',
      'revoke all on public.reservations from diana',
      'drop table public.reservations',
      'create table test_table (id int)',
      'alter table public.reservations drop column notes',
      'delete from public.reservations',
      'update public.reservations set notes = null',
      'insert into public.reservations default values',
      'truncate public.reservations',
    ];
    for (const stmt of disallowedStatements) {
      assert.equal(isAllowedRlsStatement(stmt), false, `RLS allowlist must reject: ${stmt}`);
      assert.equal(isAllowedMaintenanceStatement(stmt), false, `Maintenance allowlist must reject: ${stmt}`);
    }
  });

  it('maintenance migration parses each cron.schedule call as one unit and asserts per call', () => {
    assert.ok(exists(maintenancePath), `${maintenancePath} should exist`);
    const sql = read(maintenancePath);

    // Guarded unschedule of review backfill
    assert.match(
      sql,
      /select\s+cron\.unschedule\('ecovila-review-backfill'\)\s+where\s+exists\s*\(\s*select\s+1\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'ecovila-review-backfill'\s*\);/i,
      'backfill unschedule must be guarded with exists check',
    );

    // Parse cron.schedule(...) calls as unit objects (name, schedule, command)
    const calls = parseCronScheduleCalls(sql);
    assert.equal(calls.length, 3, 'must schedule exactly 3 cron jobs');

    const byName = new Map(calls.map((c) => [c.name, c]));

    // ecovila-prune-cron-history
    const prune = byName.get('ecovila-prune-cron-history');
    assert.ok(prune, 'must schedule ecovila-prune-cron-history');
    assert.equal(prune.schedule, '17 3 * * *');
    assert.match(
      prune.command,
      /^delete\s+from\s+cron\.job_run_details\s+where\s+coalesce\(end_time,\s*start_time\)\s*<\s*now\(\)\s*-\s*interval\s*'7 days'$/i,
      'prune job command must match expected SQL',
    );

    // ecovila-vacuum-cron-history
    const vacCron = byName.get('ecovila-vacuum-cron-history');
    assert.ok(vacCron, 'must schedule ecovila-vacuum-cron-history');
    assert.equal(vacCron.schedule, '27 3 * * *');
    assert.match(
      vacCron.command,
      /^vacuum\s+\(analyze\)\s+cron\.job_run_details$/i,
      'vacuum cron history command must match expected SQL',
    );

    // ecovila-vacuum-pgnet-responses
    const vacPgnet = byName.get('ecovila-vacuum-pgnet-responses');
    assert.ok(vacPgnet, 'must schedule ecovila-vacuum-pgnet-responses');
    assert.equal(vacPgnet.schedule, '7 * * * *');
    assert.match(
      vacPgnet.command,
      /^vacuum\s+\(analyze\)\s+net\._http_response$/i,
      'vacuum pgnet responses command must match expected SQL',
    );

    // Header comment facts
    assert.match(sql, /cron\.job_run_details[\s\S]*?1\.4\s*GB/i, 'migration header should cite cron.job_run_details bloat');
    assert.match(sql, /net\._http_response[\s\S]*?290\s*MB/i, 'migration header should cite net._http_response bloat');
    assert.match(sql, /autovacuum/i, 'migration header should explain autovacuum limitation');
  });

  it('reclaim runbook lives outside migrations, sets operating rules, separates read-only steps, sets timeouts per block, and verifies post-checks', () => {
    assert.ok(exists(runbookPath), `${runbookPath} should exist`);
    assert.equal(
      exists('supabase/migrations/20260929_reclaim_bookkeeping_tables.sql'),
      false,
      'runbook must not live in supabase/migrations/',
    );

    const sql = read(runbookPath);

    // Runbook header operating rules
    assert.match(
      sql,
      /03:00[–-]05:00\s+Europe\/Chisinau/i,
      'runbook header must specify quiet hour 03:00–05:00 Europe/Chisinau',
    );
    assert.match(
      sql,
      /verify\s+Block\s+1\s+succeeded\s*\([^)]*Step\s+3a[^)]*\)\s*before\s+running\s+Block\s+2/i,
      'runbook header must instruct verifying Block 1 before running Block 2',
    );
    assert.match(
      sql,
      /inspect\s+blockers\s+with[\s\S]*?'net\._http_response'::regclass/i,
      'runbook header must provide blocker inspection query on pg_stat_activity/pg_locks for net._http_response',
    );

    // Separated read-only steps (0a, 0b, 0c, 0d, 0e, 3a, 3b, 3c, 4a, 4b)
    for (const step of ['0a', '0b', '0c', '0d', '0e', '3a', '3b', '3c', '4a', '4b']) {
      assert.match(
        sql,
        new RegExp(`Step\\s+${step}\\b`, 'i'),
        `runbook must contain Step ${step} as a separated step`,
      );
    }

    // Verify read-only steps are single statements with no begin/commit wrappers;
    // only Block 1 and Block 2 are enclosed in begin/commit with their own lock_timeouts
    const sqlWithoutComments = sql.replace(/--[^\n]*/g, '');
    const begins = [...sqlWithoutComments.matchAll(/\bbegin\s*;/gi)];
    const commits = [...sqlWithoutComments.matchAll(/\bcommit\s*;/gi)];
    assert.equal(begins.length, 2, 'only Block 1 and Block 2 must have begin;');
    assert.equal(commits.length, 2, 'only Block 1 and Block 2 must have commit;');

    // Block 1 timeouts (110s lock_timeout, 115s statement_timeout) and Block 2 (10s)
    const lockTimeouts = [...sql.matchAll(/set\s+local\s+lock_timeout\s*=\s*'([^']+)'/gi)].map((m) => m[1]);
    assert.equal(lockTimeouts.length, 2, 'Block 1 and Block 2 must each set their own lock_timeout');
    assert.ok(lockTimeouts.includes('110s'), 'Block 1 lock_timeout must be 110s');
    assert.ok(lockTimeouts.includes('10s'), 'Block 2 lock_timeout must be 10s');
    assert.match(
      sql,
      /set\s+local\s+statement_timeout\s*=\s*'115s';/i,
      'Block 1 statement_timeout must be 115s',
    );

    // Block 1 comment must state FULL lock effect
    assert.match(
      sql,
      /full\s+lock\s+effect[\s\S]*?while\s+truncate\s+waits\s+for\s+its\s+access\s+exclusive\s+lock[\s\S]*?pg_net's[\s\S]*?worker\s+is\s+also\s+blocked/i,
      'Block 1 comment must state the full lock effect on pg_net worker',
    );
    assert.match(
      sql,
      /expire-cash[\s\S]*?send-reminders[\s\S]*?guest-flag-alerts/i,
      'Block 1 comment must name affected cron HTTP calls',
    );
    assert.match(
      sql,
      /delayed\s+by\s+up\s+to\s+~?2\s+minutes/i,
      'Block 1 comment must note delay up to ~2 minutes',
    );

    // Step 0b: return one row per status code: status_code, count(*), min(created), max(created) grouped by status_code
    assert.match(
      sql,
      /select\s+status_code,\s*count\(\*\),\s*min\(created\),\s*max\(created\)\s+from\s+net\._http_response\s+where\s+created\s*>\s*now\(\)\s*-\s*interval\s*'7 hours'\s+group\s+by\s+status_code/i,
      'Step 0b must return status_code, count(*), min(created), max(created) with 7h bound',
    );

    // Step 0c inspects failed/timed out/error responses with 7h bound
    assert.match(
      sql,
      /status_code\s+is\s+null\s+or\s+status_code\s*>=\s*300\s+or\s+timed_out\s+or\s+error_msg\s+is\s+not\s+null/i,
      'Step 0c must inspect failed/timed out/error responses before truncating',
    );

    // Step 0d: count responses older than 7 hours
    assert.match(
      sql,
      /select\s+count\(\*\)\s+from\s+net\._http_response\s+where\s+created\s*<=\s*now\(\)\s*-\s*interval\s*'7 hours'/i,
      'Step 0d must count rows where created <= now() - interval 7 hours',
    );

    // Step 0e: pending cash reservations expiring within 15 minutes
    assert.match(
      sql,
      /from\s+public\.reservations\s+where\s+payment_status\s*=\s*'pending'\s+and\s+cancelled_at\s+is\s+null\s+and\s+cash_expires_at\s+between\s+now\(\)\s+and\s+now\(\)\s*\+\s*interval\s*'15 minutes'/i,
      'Step 0e must query reservations expiring within 15 minutes',
    );

    // Block 1 & 2 truncates
    assert.match(sql, /truncate\s+net\._http_response/i, 'Block 1 must truncate net._http_response');
    assert.match(sql, /truncate\s+cron\.job_run_details/i, 'Block 2 must truncate cron.job_run_details');

    // No RESTART IDENTITY in SQL commands
    assert.doesNotMatch(
      sqlWithoutComments,
      /restart\s+identity/i,
      'neither truncate statement may use RESTART IDENTITY (response IDs must not be reused)',
    );

    // Step 3c: verify fresh responses after truncate
    assert.match(
      sql,
      /select\s+count\(\*\),\s*max\(created\)\s+from\s+net\._http_response\s+where\s+created\s*>\s*now\(\)\s*-\s*interval\s*'10 minutes'/i,
      'Step 3c must verify fresh responses within last 10 minutes',
    );

    // Step 4a: list the four maintenance jobs
    assert.match(
      sql,
      /from\s+cron\.job\s+where\s+jobname\s+in\s*\(\s*'ecovila-review-backfill',\s*'ecovila-prune-cron-history',\s*'ecovila-vacuum-cron-history',\s*'ecovila-vacuum-pgnet-responses'\s*\)/i,
      'Step 4a must list the four maintenance jobs from cron.job',
    );

    // Step 4b: verify recent runs succeeded
    assert.match(
      sql,
      /select\s+j\.jobname,\s*d\.status,\s*d\.return_message,\s*d\.start_time\s+from\s+cron\.job_run_details\s+d\s+join\s+cron\.job\s+j\s+using\s*\(\s*jobid\s*\)\s+where\s+j\.jobname\s+in\s*\(\s*'ecovila-prune-cron-history',\s*'ecovila-vacuum-cron-history',\s*'ecovila-vacuum-pgnet-responses'\s*\)\s+order\s+by\s+d\.start_time\s+desc\s+limit\s+10/i,
      'Step 4b must query recent runs for the three maintenance jobs',
    );
  });
});
