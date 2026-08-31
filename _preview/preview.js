(function () {
  'use strict';
  var C = window.EcoVilaCrmCalendar;

  var MARKERS = [
    { id: 'm1', guest_phone: '+37369000001', guest_email: null, severity: 'attention',
      created_at: '2026-08-28T10:00:00Z',
      body_preview: 'A făcut gălăgie după 23:00 la ultimul sejur și a refuzat inițial diferența pentru oaspeții suplimentari.' },
    { id: 'm2', guest_phone: null, guest_email: 'familia.rusu@mail.md', severity: 'vip',
      created_at: '2026-08-20T10:00:00Z',
      body_preview: 'Vin în fiecare an de 4 ani. Preferă căsuța 12, lângă lac.' },
    { id: 'm3', guest_phone: '+37369000003', guest_email: null, severity: 'attention',
      created_at: '2026-08-10T10:00:00Z',
      body_preview: 'A plecat cu două prosoape și o pătură. Verifică inventarul la plecare.' },
    { id: 'm4', guest_phone: '+37369000004', guest_email: 'ana.munteanu@mail.md', severity: 'vip',
      created_at: '2026-08-05T10:00:00Z', body_preview: 'Recomandă mereu resortul. A adus 3 grupuri anul acesta.' },
    { id: 'm5', guest_phone: '+37369000004', guest_email: null, severity: 'attention',
      created_at: '2026-08-27T10:00:00Z', body_preview: 'Atenție: alergie severă la pene. Fără perne de puf.' }
  ];
  var index = C.buildGuestFlagIndex(MARKERS);

  var ROOMS = [
    { n: 3,  label: 'Mică 3' }, { n: 7,  label: 'Mare 7' }, { n: 12, label: 'Mare 12' },
    { n: 15, label: 'Mică 15' }, { n: 21, label: 'Hotel 21' }
  ];
  var DATES = ['1 sep','2 sep','3 sep','4 sep','5 sep','6 sep','7 sep'];

  var BOOKINGS = [
    { row: 1, col: 1, span: 3, status: 'paid-card', total: '4 200 MDL', party: '2 adulți · 1 copil',
      phone: '+373 690 00 001', email: null, guestPhone: '+37369000001' },
    { row: 2, col: 2, span: 3, status: 'paid-cash', total: '9 800 MDL', party: '4 adulți · 2 copii',
      phone: '+373 690 00 002', email: 'familia.rusu@mail.md', guestPhone: '+37369000002' },
    { row: 3, col: 1, span: 2, status: 'pending', total: '3 100 MDL', party: '2 adulți',
      phone: '+373 690 00 003', email: null, guestPhone: '+37369000003' },
    { row: 4, col: 3, span: 3, status: 'paid-card', total: '6 400 MDL', party: '3 adulți · 1 copil',
      phone: '+373 690 00 004', email: 'ana.munteanu@mail.md', guestPhone: '+37369000004' },
    { row: 5, col: 3, span: 2, status: 'paid-card', total: '2 900 MDL', party: '2 adulți',
      phone: '+373 690 00 009', email: null, guestPhone: '+37369000009' }
  ];

  function cell(cls, text) {
    var el = document.createElement('div');
    el.className = 'crm-calendar-cell ' + (cls || '');
    if (text) el.textContent = text;
    return el;
  }

  var grid = document.getElementById('cal');
  grid.style.gridTemplateColumns = 'var(--crm-room-column-width) repeat(' + DATES.length + ', var(--crm-day-column-width))';
  grid.style.gridTemplateRows = '48px repeat(' + ROOMS.length + ', var(--crm-calendar-room-row-height))';
  grid.style.minWidth = 'calc(var(--crm-room-column-width) + ' + DATES.length + ' * var(--crm-day-column-width))';

  var corner = cell('crm-calendar-cell--head crm-calendar-cell--corner');
  corner.style.gridColumn = '1'; corner.style.gridRow = '1'; grid.appendChild(corner);
  DATES.forEach(function (d, i) {
    var c = cell('crm-calendar-cell--head', d);
    c.style.gridColumn = String(i + 2); c.style.gridRow = '1'; grid.appendChild(c);
  });
  ROOMS.forEach(function (room, ri) {
    var rc = cell('crm-calendar-cell--room', room.label);
    rc.style.gridColumn = '1'; rc.style.gridRow = String(ri + 2); grid.appendChild(rc);
    DATES.forEach(function (_, di) {
      var c = cell('');
      c.style.gridColumn = String(di + 2); c.style.gridRow = String(ri + 2); grid.appendChild(c);
    });
  });

  BOOKINGS.forEach(function (b) {
    var flag = C.guestFlagFor({ guest_phone: b.guestPhone, guest_email: b.email }, index);
    var card = document.createElement('article');
    card.className = ['crm-reservation-card', 'crm-reservation-card--block',
      'crm-reservation-card--' + b.status,
      flag && flag.hasAttention ? 'crm-reservation-card--flagged-attention' : '',
      flag && flag.hasVip ? 'crm-reservation-card--flagged-vip' : ''].filter(Boolean).join(' ');
    card.style.gridColumn = (b.col + 1) + ' / span ' + b.span;
    card.style.gridRow = String(b.row + 1);
    card.innerHTML = '<strong>' + b.total + '</strong><span>' + b.party +
      '</span><span class="crm-reservation-card__phone">' + b.phone + '</span>';
    if (flag) {
      ['attention', 'vip'].forEach(function (sev) {
        if (sev === 'attention' && !flag.hasAttention) return;
        if (sev === 'vip' && !flag.hasVip) return;
        var badge = document.createElement('button');
        badge.className = 'crm-flag crm-flag--' + sev;
        badge.type = 'button';
        badge.textContent = C.GUEST_FLAG_GLYPHS[sev];
        badge.setAttribute('aria-label', 'Client cu notă: ' + C.GUEST_FLAG_LABELS[sev]);
        badge.title = C.GUEST_FLAG_LABELS[sev] + ': ' + flag.preview;
        card.appendChild(badge);
      });
    }
    grid.appendChild(card);
  });

  var NOTES = [
    { severity: 'attention', body: 'A făcut gălăgie după 23:00 la ultimul sejur și a refuzat inițial diferența pentru oaspeții suplimentari.', role: 'diana', date: '28 aug 2026', stay: '24–28 aug 2026' },
    { severity: 'vip', body: 'Vin în fiecare an de 4 ani. Preferă căsuța 12, lângă lac.', role: 'diana', date: '20 aug 2026', stay: '17–20 aug 2026' },
    { severity: 'info', body: 'Cere mereu check-out mai târziu, la 12:00. De obicei e ok dacă nu urmează altă rezervare.', role: 'angela', date: '12 iul 2026', stay: '' },
    { severity: 'info', body: 'Copilul mic — au nevoie de pătuț suplimentar.', role: 'angela', date: '3 iul 2026', stay: '' }
  ];

  var panel = document.getElementById('panel');
  var list = panel.querySelector('[data-dossier-list]');
  panel.querySelector('[data-dossier-count]').textContent = NOTES.length + ' note';
  NOTES.forEach(function (n) {
    var li = document.createElement('li');
    li.className = 'crm-dossier__item crm-dossier__item--' + n.severity;
    var body = document.createElement('p');
    body.className = 'crm-dossier__body';
    body.textContent = n.body;
    li.appendChild(body);
    var meta = document.createElement('div');
    meta.className = 'crm-dossier__meta';
    var span = document.createElement('span');
    span.textContent = C.GUEST_FLAG_LABELS[n.severity] + ' · ' + n.role + ' · ' + n.date +
      (n.stay ? ' · sejur ' + n.stay : '');
    meta.appendChild(span);
    var arch = document.createElement('button');
    arch.className = 'crm-dossier__archive';
    arch.type = 'button';
    arch.textContent = 'Arhivează';
    meta.appendChild(arch);
    li.appendChild(meta);
    list.appendChild(li);
  });

  var DAILY = [
    { type: 'in',  room: 'Căsuța mare #12', name: 'Familia Rusu', phone: '+373 690 00 002', party: '4 adulți · 2 copii', paid: 'Achitat: 9 800 MDL', guestPhone: '+37369000002', email: 'familia.rusu@mail.md' },
    { type: 'in',  room: 'Căsuța mică #3',  name: 'Victor Cebotari', phone: '+373 690 00 001', party: '2 adulți · 1 copil', paid: 'Achitat: 4 200 MDL', guestPhone: '+37369000001', email: null },
    { type: 'out', room: 'Cameră în hotel #21', name: 'Ana Munteanu', phone: '+373 690 00 004', party: '3 adulți · 1 copil', paid: 'Achitat: 6 400 MDL', guestPhone: '+37369000004', email: 'ana.munteanu@mail.md' },
    { type: 'out', room: 'Căsuța mică #15', name: 'Sergiu Balan', phone: '+373 690 00 009', party: '2 adulți', paid: 'Achitat: 2 900 MDL', guestPhone: '+37369000009', email: null }
  ];

  var daily = document.getElementById('daily');
  DAILY.forEach(function (d) {
    var flag = C.guestFlagFor({ guest_phone: d.guestPhone, guest_email: d.email }, index);
    var card = document.createElement('article');
    card.className = 'crm-daily-card crm-daily-card--' + d.type;
    card.innerHTML = '<div class="crm-daily-card__details">' +
      '<span class="crm-daily-card__room">' + d.room + '</span>' +
      '<strong>' + d.name + '</strong>' +
      '<span>' + d.phone + '</span>' +
      '<span>' + d.party + '</span>' +
      '<span>' + d.paid + '</span>' +
      '</div>';
    if (flag) {
      var details = card.querySelector('.crm-daily-card__details');
      var pill = document.createElement('span');
      pill.className = 'crm-daily-card__flag crm-daily-card__flag--' + flag.severity;
      pill.title = flag.preview;
      var g = document.createElement('span');
      g.className = 'crm-daily-card__flag-glyph';
      g.textContent = C.GUEST_FLAG_GLYPHS[flag.severity];
      var t = document.createElement('span');
      t.className = 'crm-daily-card__flag-text';
      t.textContent = flag.preview;
      pill.appendChild(g); pill.appendChild(t);
      details.insertBefore(pill, details.firstChild);
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crm-daily-check';
    btn.setAttribute('aria-label', d.type === 'in' ? 'Marchează cazarea' : 'Marchează plecarea');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"/></svg>';
    card.appendChild(btn);
    daily.appendChild(card);
  });
})();
