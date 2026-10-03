/* KINERA staff area — reception check-in, registration management, dashboard,
   calendar. All data comes from the Registration record via the API (§Rule 8,
   §XLVI.13/14) and every view refreshes on the 1-minute cadence (§XXXVII). */
(function () {
  'use strict';

  const i18n = window.KineraI18n.createI18n('vi');
  const STATUS_ORDER = ['REGISTERED', 'CONFIRMED', 'EXPECTED', 'CHECKED_IN', 'IN_VISIT',
    'COMPLETED', 'CANCELLED', 'NO_SHOW'];

  const TABS = [
    { id: 'checkin', label: 'Check-in', permission: 'checkin:perform' },
    { id: 'registrations', label: 'Đăng ký', permission: 'registration:view' },
    { id: 'dashboard', label: 'Dashboard', permission: 'dashboard:view' },
    // Management information: the tab only exists for a role that holds the
    // permission, and the API refuses it for anyone else regardless (§Rule 4).
    { id: 'stats', label: 'Thống kê khách', permission: 'customer-stats:view' },
    { id: 'calendar', label: 'Calendar', permission: 'calendar:view' },
    { id: 'guide', label: 'Hướng dẫn', permission: 'guide:view' },
    // Administrator only — the whole of that role's screen.
    { id: 'accounts', label: 'Tài khoản', permission: 'user:manage' },
    { id: 'blocks', label: 'Lịch & sức chứa', permission: 'schedule:block' },
    { id: 'audit', label: 'Nhật ký', permission: 'audit:view' },
  ];

  const state = {
    token: sessionStorage.getItem('kinera.token') || null,
    session: null,
    config: null,
    tab: null,
    selected: null,
    regQuery: { page: 1, pageSize: 20, sortBy: 'visit_date', sortDir: 'asc' },
    // §XXXV calendar navigation: which period is on screen right now.
    calendar: { view: 'month', date: null, data: null },
    stats: null,
    accounts: [],
    blocks: [],
    auditQuery: { page: 1, pageSize: 50 },
    slots: [],
    timer: null,
    stream: null,
    detector: null,
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—');
  const nowLabel = () => `Cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;

  // ---------------------------------------------------------------- api client

  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    if (state.token) opts.headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      // A 401 means an existing session expired — sign out and start over. It must
      // NOT fire for the sign-in call itself: reloading there would wipe the
      // "wrong username or password" message before anyone could read it.
      if (res.status === 401 && state.token) { signOut(); }
      if (body && body.error && body.error.code === 'PASSWORD_CHANGE_REQUIRED'
        && !path.startsWith('/api/auth/')) { signOut(); }
      const err = new Error((body && body.error && body.error.message) || 'Request failed');
      err.code = body && body.error && body.error.code;
      err.details = body && body.error && body.error.details;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /**
   * Downloads a file from an authenticated endpoint.
   *
   * The API is bearer-authenticated, so a plain link would arrive without the
   * token — and putting the token in the URL would leave it in history and in
   * every log along the way. So the file is fetched like any other request and
   * handed to the browser as a blob.
   */
  async function download(path, button) {
    const label = button ? button.innerHTML : null;
    if (button) {
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span>Đang xuất…';
    }
    try {
      const res = await fetch(path, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      });
      if (!res.ok) {
        let message = 'Không xuất được tệp.';
        try {
          const body = await res.json();
          message = (body && body.error && body.error.message) || message;
        } catch { /* not a JSON error body */ }
        if (res.status === 401 && state.token) signOut();
        throw new Error(message);
      }
      const disposition = res.headers.get('content-disposition') || '';
      const match = /filename="?([^"]+)"?/.exec(disposition);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : 'kinera-export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick: the click has already started the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      notice(`Đã xuất ${a.download}`, 'ok');
    } catch (err) {
      notice(err.message || 'Không xuất được tệp.', 'danger');
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = label;
      }
    }
  }

  function notice(msg, kind) {
    const el = $('#staff-notice');
    el.className = `notice notice--${kind || 'danger'}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(notice.t);
    notice.t = setTimeout(() => el.classList.add('hidden'), 6000);
  }

  const statusBadge = (s) => {
    const kind = ({
      CHECKED_IN: 'ok', IN_VISIT: 'ok', COMPLETED: 'brand',
      CANCELLED: 'danger', NO_SHOW: 'danger', EXPECTED: 'warn',
    })[s] || '';
    return `<span class="badge ${kind ? `badge--${kind}` : ''}">${esc(i18n.status(s))}</span>`;
  };

  // -------------------------------------------------------------------- session

  async function boot() {
    $('#login-form').addEventListener('submit', login);
    $('#pwchange-form').addEventListener('submit', submitPasswordChange);
    $('#pwchange-cancel').addEventListener('click', () => signOut());
    if (state.token) {
      try {
        const me = await api('/api/auth/me');
        // A session that still owes a password change starts again at sign-in:
        // the change needs the current password, which is not kept anywhere.
        if (me.user && me.user.mustChangePassword) throw new Error('password change pending');
        state.session = me;
        await afterLogin();
        return;
      } catch { signOut(false); }
    }
    showLogin();
  }

  /** Sign-in sits on the brand backdrop; the app itself on flat slate. */
  function showLogin() {
    document.body.classList.add('on-backdrop');
    document.body.classList.remove('app-shell');
    $('#login-view').classList.remove('hidden');
    $('#staff-view').classList.add('hidden');
    $('#session-box').innerHTML = '';
  }

  async function login(ev) {
    ev.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Đang đăng nhập…';
    $('#login-error').classList.add('hidden');
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: $('#login-username').value, password: $('#login-password').value }),
      });
      state.token = res.token;
      sessionStorage.setItem('kinera.token', res.token);
      state.session = { user: res.user, permissions: res.permissions, scopeOfficeId: res.user.salesOfficeId };
      if (res.mustChangePassword) {
        // Kept only in memory, and only until the change is made: the API asks
        // for the current password again when setting the new one.
        showPasswordChange($('#login-password').value);
        return;
      }
      await afterLogin();
    } catch (err) {
      const el = $('#login-error');
      const messages = {
        UNAUTHENTICATED: 'Sai tài khoản hoặc mật khẩu. Vui lòng thử lại.',
        CREDENTIALS_REQUIRED: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu.',
      };
      el.innerHTML = `<strong>Không thể đăng nhập</strong>${
        esc(messages[err.code] || err.message || 'Đăng nhập thất bại.')}`;
      el.classList.remove('hidden');
      $('#login-password').value = '';
      $('#login-password').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Đăng nhập';
    }
  }

  // ------------------------------------------------- first-login password change

  let assignedPassword = null;

  function showPasswordChange(currentPassword) {
    assignedPassword = currentPassword;
    $('#login-form').classList.add('hidden');
    $('#login-error').classList.add('hidden');
    $('#pwchange-form').classList.remove('hidden');
    $('#pwchange-new').value = '';
    $('#pwchange-confirm').value = '';
    $('#pwchange-new').focus();
  }

  async function submitPasswordChange(ev) {
    ev.preventDefault();
    const err = $('#pwchange-error');
    err.classList.add('hidden');
    const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
    const next = $('#pwchange-new').value;
    if (next.length < 8) return fail('Mật khẩu mới phải có ít nhất 8 ký tự.');
    if (next !== $('#pwchange-confirm').value) return fail('Hai lần nhập mật khẩu mới không khớp.');
    if (next === assignedPassword) return fail('Mật khẩu mới phải khác mật khẩu được cấp.');

    const btn = $('#pwchange-btn');
    btn.disabled = true;
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: assignedPassword, newPassword: next }),
      });
      assignedPassword = null;
      $('#pwchange-form').classList.add('hidden');
      $('#login-form').classList.remove('hidden');
      await afterLogin();
      notice('Đã đổi mật khẩu.', 'ok');
    } catch (e) {
      fail({
        WEAK_PASSWORD: 'Mật khẩu mới phải có ít nhất 8 ký tự.',
        PASSWORD_UNCHANGED: 'Mật khẩu mới phải khác mật khẩu được cấp.',
      }[e.code] || e.message);
    } finally {
      btn.disabled = false;
    }
    return undefined;
  }

  /** Anyone signed in can change their own password from the header. */
  function openOwnPasswordForm() {
    modal('Đổi mật khẩu', `
      <div class="field"><label for="m-cur">Mật khẩu hiện tại</label>
        <input id="m-cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="m-new">Mật khẩu mới</label>
        <input id="m-new" type="password" autocomplete="new-password">
        <div class="field__help">Tối thiểu 8 ký tự.</div></div>
      <div class="field"><label for="m-new2">Nhập lại mật khẩu mới</label>
        <input id="m-new2" type="password" autocomplete="new-password"></div>`,
    async () => {
      if ($('#m-new').value !== $('#m-new2').value) throw new Error('Hai lần nhập mật khẩu mới không khớp.');
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: $('#m-cur').value, newPassword: $('#m-new').value }),
      });
      notice('Đã đổi mật khẩu.', 'ok');
    });
  }

  function signOut(reload) {
    state.token = null;
    state.session = null;
    sessionStorage.removeItem('kinera.token');
    stopTimer();
    if (reload !== false) window.location.reload();
  }

  const has = (permission) => Boolean(state.session && state.session.permissions.includes(permission));

  async function afterLogin() {
    state.config = await api('/api/config');
    const u = state.session.user;
    $('#session-box').innerHTML = `
      <span>${esc(u.fullName)}</span>
      <span class="badge badge--brand">${esc(u.role)}</span>
      ${u.salesOffice ? `<span class="badge">${esc(u.salesOffice.name)}</span>` : '<span class="badge">Tất cả văn phòng</span>'}
      <button class="btn btn--ghost btn--sm" id="ownpass-btn">Đổi mật khẩu</button>
      <button class="btn btn--ghost btn--sm" id="logout-btn">Đăng xuất</button>`;
    $('#logout-btn').addEventListener('click', () => signOut());
    $('#ownpass-btn').addEventListener('click', openOwnPasswordForm);

    document.body.classList.remove('on-backdrop');
    document.body.classList.add('app-shell');
    $('#login-view').classList.add('hidden');
    $('#staff-view').classList.remove('hidden');

    renderTabs();
    fillSelects();
    fillAccountFilters();
    fillBlockFilters();
    bindCheckin();
    bindRegistrations();
    bindDashboard();
    bindStats();
    bindCalendar();
    bindGuide();
    bindAccounts();
    bindBlocks();
    bindAudit();

    const first = TABS.find((t) => has(t.permission));
    selectTab(first ? first.id : 'registrations');
    startTimer();
  }

  // ----------------------------------------------------------------- navigation

  function renderTabs() {
    $('#tabs').innerHTML = TABS.filter((t) => has(t.permission))
      .map((t) => `<button class="tab" role="tab" data-tab="${t.id}" aria-selected="false">${esc(t.label)}</button>`)
      .join('');
    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  }

  function selectTab(id) {
    state.tab = id;
    $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    ['checkin', 'registrations', 'dashboard', 'stats', 'calendar', 'guide',
      'accounts', 'blocks', 'audit', 'detail'].forEach((p) => {
      const el = $(`#panel-${p}`);
      if (el) el.classList.toggle('hidden', p !== id);
    });
    refresh();
  }

  function fillSelects() {
    const offices = state.config.salesOffices;
    const scoped = state.session.user.salesOfficeId;
    const officeOpts = (all) => {
      const list = scoped ? offices.filter((o) => o.id === scoped) : offices;
      return `${scoped ? '' : `<option value="">${all}</option>`}${
        list.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}`;
    };
    ['#flt-office', '#dash-office', '#stats-office', '#cal-office'].forEach((sel) => {
      const el = $(sel);
      if (el) el.innerHTML = officeOpts('Tất cả văn phòng');
    });
    ['#flt-type', '#dash-type', '#stats-type', '#cal-type'].forEach((sel) => {
      const el = $(sel);
      if (el) {
        el.innerHTML = `<option value="">Tất cả</option>
          <option value="VISITOR">Khách Tham Quan</option>
          <option value="AGENCY">Đại Lý</option>`;
      }
    });
    $('#flt-status').innerHTML = `<option value="">Tất cả</option>${
      STATUS_ORDER.map((s) => `<option value="${s}">${esc(i18n.status(s))}</option>`).join('')}`;
    const agencySelect = $('#stats-agency');
    if (agencySelect) {
      agencySelect.innerHTML = `<option value="">Tất cả đại lý</option>${
        (state.config.agencies || []).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}`;
    }
    state.calendar.date = state.config.today;
  }

  // ------------------------------------------------------- §XXXVII auto refresh

  function startTimer() {
    stopTimer();
    state.timer = setInterval(refresh, state.config.rules.autoRefreshMs);
  }

  function stopTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function refresh() {
    if (!state.session) return;
    try {
      if (state.tab === 'checkin') await loadOfficeSummary();
      if (state.tab === 'registrations') await loadRegistrations();
      if (state.tab === 'dashboard') await loadDashboard();
      if (state.tab === 'stats') await loadStats();
      if (state.tab === 'calendar') await loadCalendar();
      if (state.tab === 'guide') renderGuide();
      if (state.tab === 'accounts') await loadAccounts();
      if (state.tab === 'blocks') { await loadBlocks(); await loadCapacity(); }
      if (state.tab === 'audit') await loadAudit();
    } catch (err) {
      if (err.status !== 401) notice(err.message, 'danger');
    }
  }

  // ================================================================== CHECK-IN

  function bindCheckin() {
    $('#resolve-btn').addEventListener('click', resolve);
    $('#scan-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') resolve(); });
    $('#camera-btn').addEventListener('click', toggleCamera);
    const picker = $('#camera-device');
    if (picker) picker.addEventListener('change', switchCamera);
    // Plugging in or unplugging a USB webcam should update the list, not require
    // a page reload.
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { fillCameraPicker(); });
    }
    fillCameraPicker();
  }

  /**
   * §XXVI — one search box. Whatever the receptionist types or scans goes to the
   * backend as a single query: confirmation code, QR payload, visitor name,
   * phone, CCCD, agency or sales staff name.
   */
  async function resolve(rawInput) {
    const query = String(typeof rawInput === 'string' ? rawInput : $('#scan-input').value || '').trim();
    if (!query) {
      notice('Nhập mã xác nhận, tên, số điện thoại, CCCD, đại lý hoặc nhân viên Sales.', 'warn');
      return;
    }
    const box = $('#checkin-detail');
    box.innerHTML = `<div class="table-empty"><span class="spinner spinner--dark"></span> Đang tìm…</div>`;
    try {
      const res = await api('/api/staff/checkin/lookup', {
        method: 'POST', body: JSON.stringify({ query }),
      });
      if (res.mode === 'single') {
        state.selected = { registration: res.registration, readiness: res.readiness, method: res.method };
        renderCheckinDetail();
      } else if (res.mode === 'multiple') {
        state.selected = null;
        renderMatches(res);
      } else {
        state.selected = null;
        box.innerHTML = `
          <div class="notice notice--warn" style="margin:0">
            <strong>Không tìm thấy đăng ký</strong>
            Không có kết quả cho "${esc(res.query)}".
            Thử mã xác nhận (OE-XXXXX), tên khách, số điện thoại, CCCD, đại lý hoặc tên nhân viên Sales.
          </div>`;
      }
    } catch (err) {
      box.innerHTML = `<div class="notice notice--danger" style="margin:0">${esc(err.message)}</div>`;
    }
  }

  /** Several registrations matched — let the receptionist pick the right one. */
  function renderMatches(res) {
    const rows = res.matches.map((m) => {
      const r = m.registration;
      const who = r.visitorType === 'VISITOR'
        ? esc(r.visitor.fullName)
        : `${esc(r.agency.agencyName)} · ${esc(r.agency.salesStaffName)}`;
      const sub = r.visitorType === 'VISITOR'
        ? esc(r.visitor.phone)
        : `${esc(r.agency.customerShortName)} (…${esc(r.agency.customerPhoneLast4)})`;
      const isToday = r.visitDate === state.config.today;
      return `<button class="cal-list__item" data-pick="${esc(r.id)}"
                style="${isToday ? 'border-left-color:var(--color-sunset)' : ''}">
          <div class="mono nowrap" style="font-weight:800">${esc(fmtDate(r.visitDate))}
            <div class="dim" style="font-weight:600">${esc(r.timeSlot.label)}</div></div>
          <div><div style="font-weight:700">${who}</div>
            <div class="muted" style="font-size:12px">${sub} · ${esc(r.salesOffice.name)} ·
              <span class="mono">${esc(r.confirmationCode)}</span></div></div>
          <div>${statusBadge(r.status)}</div>
        </button>`;
    }).join('');

    $('#checkin-detail').innerHTML = `
      <div class="card__head" style="margin-bottom:.9rem">
        <div>
          <div class="card__title">${res.matches.length} kết quả</div>
          <div class="card__hint" style="margin:.2rem 0 0">Cho "${esc(res.query)}" — chọn đúng đăng ký.</div>
        </div>
      </div>
      <div class="cal-list">${rows}</div>
      ${res.total > res.matches.length
        ? `<div class="field__help">Hiển thị ${res.matches.length} trong ${res.total} kết quả. Nhập cụ thể hơn để thu hẹp.</div>`
        : ''}`;

    $$('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const picked = res.matches.find((m) => m.registration.id === b.dataset.pick);
      if (!picked) return;
      state.selected = { registration: picked.registration, readiness: picked.readiness, method: res.method };
      renderCheckinDetail();
    }));
  }

  function renderCheckinDetail() {
    const box = $('#checkin-detail');
    if (!state.selected) { box.innerHTML = '<div class="table-empty">Chưa có đăng ký nào được chọn.</div>'; return; }
    const r = state.selected.registration;
    const ready = state.selected.readiness;
    const isVisitor = r.visitorType === 'VISITOR';

    const rows = isVisitor ? [
      ['Họ tên', r.visitor.fullName], ['CCCD', r.visitor.cccd],
      ['Điện thoại', r.visitor.phone], ['Email', r.visitor.email || '—'],
      ['Số lượng khách', `${r.numberOfVisitors}`],
    ] : [
      ['Đại lý', r.agency.agencyName], ['Nhân viên Sales', r.agency.salesStaffName],
      ['CCCD nhân viên', r.agency.salesStaffCccd], ['SĐT nhân viên', r.agency.salesStaffPhone],
      ['Tên khách (viết tắt)', r.agency.customerShortName],
      ['4 số cuối SĐT khách', r.agency.customerPhoneLast4],
      ['Số lượng khách', `${r.numberOfVisitors}`],
    ];

    // A visitor who has already arrived is a completed outcome, not an error;
    // only a genuine problem is shown in red (§Step 7 UI States).
    const codes = ready.reasons.map((x) => x.code);
    const isError = codes.some((c) => ['CANCELLED', 'NO_SHOW', 'WRONG_OFFICE'].includes(c));
    const onlyArrived = codes.length > 0 && codes.every((c) => c === 'ALREADY_CHECKED_IN');
    const kind = isError ? 'danger' : (onlyArrived ? 'ok' : 'warn');
    const heading = onlyArrived ? 'Khách đã check-in' : 'Không thể check-in ngay:';
    const blockers = ready.canCheckIn ? '' : `
      <div class="notice notice--${kind}">
        <strong>${esc(heading)}</strong>
        <ul>${ready.reasons.map((x) => `<li>${esc(reasonText(x, ready))}</li>`).join('')}</ul>
      </div>`;

    // Wrong day, or outside the booked slot: the desk may still let the group in,
    // but has to say so deliberately — and the backend writes that down. A full
    // slot is never overridable.
    const OVERRIDABLE = ['FUTURE_VISIT_DATE', 'PAST_VISIT_DATE', 'ARRIVED_EARLY', 'ARRIVED_AFTER_SLOT'];
    const overridable = !ready.canCheckIn
      && ready.reasons.every((x) => OVERRIDABLE.includes(x.code));
    const overrideLabel = codes.some((c) => c.endsWith('VISIT_DATE'))
      ? 'CHECK IN (khác ngày — ghi nhận)'
      : (codes.includes('ARRIVED_EARLY')
        ? 'CHECK IN SỚM (lễ tân xác nhận)'
        : 'CHECK IN TRỄ KHUNG GIỜ (lễ tân xác nhận)');

    box.innerHTML = `
      <h2 class="card__title">Registration Found</h2>
      <div class="review">
        <div class="review__group"><h4>Registration</h4>
          <div class="kv"><span class="kv__k">Mã xác nhận</span><span class="kv__v mono">${esc(r.confirmationCode)}</span></div>
          <div class="kv"><span class="kv__k">Đối tượng</span><span class="kv__v">${esc(isVisitor ? 'Khách Tham Quan' : 'Đại Lý')}</span></div>
          <div class="kv"><span class="kv__k">Văn phòng</span><span class="kv__v">${esc(r.salesOffice.name)}</span></div>
          <div class="kv"><span class="kv__k">Ngày tham quan</span><span class="kv__v">${esc(fmtDate(r.visitDate))}</span></div>
          <div class="kv"><span class="kv__k">Khung giờ</span><span class="kv__v">${esc(r.timeSlot.label)}</span></div>
          <div class="kv"><span class="kv__k">Trạng thái</span><span class="kv__v">${statusBadge(r.status)}</span></div>
          ${r.checkin ? `<div class="kv"><span class="kv__k">Đã check-in</span><span class="kv__v">${esc(fmtTime(r.checkin.checkinTime))} · ${esc(r.checkin.receptionistName)}</span></div>` : ''}
        </div>
        <div class="review__group"><h4>${isVisitor ? 'Visitor' : 'Agency'}</h4>
          ${rows.map(([k, v]) => `<div class="kv"><span class="kv__k">${esc(k)}</span><span class="kv__v">${esc(v)}</span></div>`).join('')}
        </div>
        <div class="review__group"><h4>Ghi chú</h4>
          <div class="kv"><span class="kv__v" style="text-align:left;font-weight:400">${esc(r.notes || '—')}</span></div>
        </div>
      </div>
      ${blockers}
      ${renderTiming(ready)}
      ${(ready.canCheckIn || overridable) ? renderGuestCheck(r, ready) : ''}
      <div class="actions">
        ${ready.canCheckIn
          ? `<button class="btn btn--ok btn--block btn--lg" id="do-checkin">CHECK IN</button>`
          : overridable
            ? `<button class="btn btn--accent btn--block btn--lg" id="do-checkin-override">${esc(overrideLabel)}</button>`
            : ''}
      </div>
      ${r.parkingTicketApplicable ? renderParkingControls(r) : ''}
      ${renderStatusControls(r)}
      <div class="section-title">Lịch sử trạng thái</div>
      <div class="table-wrap"><table><tbody>
        ${r.statusHistory.map((h) => `<tr><td>${esc(fmtTime(h.changedAt))}</td>
          <td>${esc(h.fromStatus || '—')} → ${esc(h.toStatus)}</td>
          <td>${esc(h.changedByName)}</td><td class="muted">${esc(h.note || '')}</td></tr>`).join('')}
      </tbody></table></div>`;

    const btn = $('#do-checkin') || $('#do-checkin-override');
    if (btn) {
      btn.addEventListener('click', () => doCheckin(r.id, Boolean($('#do-checkin-override'))));
    }
    bindGuestCheck(r, ready);
    bindParkingControls(r);
    bindStatusControls(r);
  }

  /**
   * §XXVIII step 5 — before anyone is checked in, the receptionist confirms how
   * many people actually turned up. It is pre-filled with the booked number, so
   * the common case is one glance and one click; a different number is recorded
   * against the booking rather than silently overwriting it.
   */
  /** The reasons come from the API in English; the desk reads Vietnamese. */
  function reasonText(reason, ready) {
    const t = ready.timing || {};
    const c = ready.capacity || {};
    switch (reason.code) {
      case 'ARRIVED_EARLY':
        return `Khách đến sớm ${-t.minutesFromSlotStart} phút so với khung giờ ${t.bookedSlotLabel}.`;
      case 'ARRIVED_AFTER_SLOT':
        return `Khung giờ đã đăng ký (${t.bookedSlotLabel}) đã kết thúc.`;
      case 'SLOT_FULL':
        return `Khung giờ ${c.slotLabel} đã đủ ${c.capacity} khách — không thể nhận thêm. Mời khách đăng ký khung giờ khác.`;
      case 'FUTURE_VISIT_DATE':
      case 'PAST_VISIT_DATE':
        return 'Đăng ký này không phải cho ngày hôm nay.';
      case 'CANCELLED': return 'Đăng ký này đã bị huỷ.';
      case 'NO_SHOW': return 'Đăng ký này đã được ghi nhận là không đến.';
      case 'WRONG_OFFICE': return 'Đăng ký thuộc văn phòng khác.';
      case 'ALREADY_CHECKED_IN': return 'Khách đã được check-in.';
      default: return reason.message;
    }
  }

  const ARRIVAL_LABELS = {
    ON_TIME: ['Đúng giờ', 'ok'],
    LATE: ['Đến trễ', 'warn'],
    EARLY: ['Đến sớm', 'warn'],
    AFTER_SLOT: ['Sau khung giờ', 'danger'],
    OTHER_DAY: ['Khác ngày', 'warn'],
  };

  /**
   * How the arrival compares with the booking, and which slot the group will be
   * counted in — shown before CHECK IN so the desk decides with the facts.
   */
  function renderTiming(ready) {
    const t = ready.timing;
    const c = ready.capacity;
    if (!t || !c) return '';
    const [label, kind] = ARRIVAL_LABELS[t.status] || [t.status, ''];
    const minutes = t.minutesFromSlotStart;
    const detail = t.status === 'LATE' ? `trễ ${minutes} phút`
      : (t.status === 'EARLY' ? `sớm ${-minutes} phút` : '');
    const elsewhere = t.admittedSlotId && t.admittedSlotId !== t.bookedSlotId;
    return `
      <div class="timing">
        <span class="badge badge--${kind}">${esc(label)}${detail ? ` · ${esc(detail)}` : ''}</span>
        <span class="dim">Khung giờ ${esc(c.slotLabel || '—')}: đã có ${c.occupiedByOthers}/${c.capacity} khách của các đoàn khác
          — đoàn này được vào tối đa <b>${c.maxGuests}</b> người.</span>
        ${elsewhere ? `<span class="dim">Đoàn đăng ký ${esc(t.bookedSlotLabel)} nhưng sẽ được tính vào khung giờ đang diễn ra (${esc(t.admittedSlotLabel)}).</span>` : ''}
      </div>`;
  }

  function renderGuestCheck(r, ready) {
    const booked = r.numberOfVisitors;
    // The hard limit: never more than the slot still has room for.
    const cap = ready && ready.capacity ? ready.capacity.maxGuests : null;
    const max = Math.max(1, Math.min(
      booked + (state.config.rules.maxGuestOverage || 10),
      cap === null ? Infinity : cap,
    ));
    const start = Math.min(booked, max);
    return `
      <div class="guest-check" id="guest-check">
        <div class="guest-check__head">
          <div>
            <div class="guest-check__label">Số khách thực tế đến</div>
            <div class="guest-check__hint">Đã đăng ký <b>${booked}</b> khách — xác nhận số khách có mặt.</div>
          </div>
          <div class="guest-check__stepper">
            <button type="button" class="btn btn--ghost btn--icon" id="guest-minus" aria-label="Giảm">−</button>
            <input id="guest-count" type="number" inputmode="numeric" min="1"
                   max="${max}" value="${start}">
            <button type="button" class="btn btn--ghost btn--icon" id="guest-plus" aria-label="Tăng">+</button>
          </div>
        </div>
        <div class="guest-check__verdict" id="guest-verdict"></div>
      </div>`;
  }

  function bindGuestCheck(r, ready) {
    const input = $('#guest-count');
    if (!input) return;
    const booked = r.numberOfVisitors;
    const max = Number(input.max) || Infinity;
    const cap = ready && ready.capacity ? ready.capacity : null;

    const paint = () => {
      const n = Number(input.value);
      const v = $('#guest-verdict');
      const go = $('#do-checkin') || $('#do-checkin-override');
      if (go) go.disabled = false;
      if (!Number.isInteger(n) || n < 1) {
        v.innerHTML = '<span class="badge badge--danger">Nhập số khách hợp lệ</span>';
        if (go) go.disabled = true;
        return;
      }
      // Over the slot's limit: say so here, before the server has to refuse it.
      if (cap && n > cap.maxGuests) {
        v.innerHTML = `<span class="badge badge--danger">Vượt sức chứa</span>
          <span class="dim">Khung giờ ${esc(cap.slotLabel)} chỉ còn chỗ cho ${cap.maxGuests} người của đoàn này
          (${cap.occupiedByOthers}/${cap.capacity} đã có). Số khách còn lại cần đăng ký khung giờ khác.</span>`;
        if (go) go.disabled = true;
        return;
      }
      const diff = n - booked;
      if (diff === 0) {
        v.innerHTML = `<span class="badge badge--ok">✓ Khớp với đăng ký (${booked})</span>`;
      } else {
        v.innerHTML = `<span class="badge badge--warn">Lệch ${diff > 0 ? `+${diff}` : diff}</span>
          <span class="dim">Đến ${n} / đăng ký ${booked} — ghi nhận cùng lượt check-in.</span>`;
      }
    };

    input.addEventListener('input', paint);
    $('#guest-minus').addEventListener('click', () => {
      input.value = Math.max(1, (Number(input.value) || 1) - 1); paint();
    });
    $('#guest-plus').addEventListener('click', () => {
      input.value = Math.min(max, (Number(input.value) || 0) + 1); paint();
    });
    paint();
  }

  async function doCheckin(id, allowDateOverride) {
    const btn = $('#do-checkin') || $('#do-checkin-override');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Đang xử lý…'; }
    try {
      const res = await api(`/api/staff/registrations/${encodeURIComponent(id)}/checkin`, {
        method: 'POST',
        body: JSON.stringify({
          method: state.selected.method || 'SEARCH',
          // One button confirms whichever exception applies — the wrong day or
          // the wrong time — and the backend records which it was.
          allowDateOverride,
          allowTimeOverride: allowDateOverride,
          actualGuests: Number($('#guest-count') ? $('#guest-count').value : 0) || null,
        }),
      });
      notice(res.guests && !res.guests.matches
        ? `✓ Check-in Successful — ${res.guests.actual}/${res.guests.expected} khách (lệch ${
          res.guests.variance > 0 ? '+' : ''}${res.guests.variance})`
        : '✓ Check-in Successful', res.guests && !res.guests.matches ? 'warn' : 'ok');
      state.selected = { registration: res.registration, readiness: { canCheckIn: false, reasons: [{ code: 'ALREADY_CHECKED_IN', message: 'Đã check-in.' }] }, method: state.selected.method };
      renderCheckinDetail();
      loadOfficeSummary();
    } catch (err) {
      const d = err.details || {};
      const text = {
        SLOT_CAPACITY_EXCEEDED: d.maxGuests > 0
          ? `Vượt sức chứa: khung giờ này chỉ còn nhận được ${d.maxGuests} người của đoàn (đã có ${d.occupiedByOthers}/${d.capacity}). Số khách còn lại cần đăng ký khung giờ khác.`
          : `Khung giờ đã đủ ${d.capacity} khách — không thể nhận thêm.`,
        ARRIVAL_OUTSIDE_SLOT: 'Khách đến ngoài khung giờ đã đăng ký — cần lễ tân xác nhận.',
        GUEST_COUNT_TOO_HIGH: 'Số khách cao bất thường so với đăng ký — vui lòng kiểm tra lại.',
      }[err.code] || err.message;
      notice(text, 'danger');
      // The situation may have changed while the card was open (another group
      // checked in, the slot ended), so the card is refreshed with live figures.
      if (['SLOT_CAPACITY_EXCEEDED', 'ARRIVAL_OUTSIDE_SLOT'].includes(err.code)) {
        try { await resolve(state.selected.registration.confirmationCode); } catch { /* keep the notice */ }
        return;
      }
      if (btn) { btn.disabled = false; btn.textContent = 'CHECK IN'; }
    }
  }

  // §XXIX — parking tickets, kept separately for cars and motorbikes.

  const VEHICLES = [
    { type: 'CAR', label: 'Ô tô', icon: '🚗' },
    { type: 'MOTORBIKE', label: 'Xe máy', icon: '🏍️' },
  ];

  function renderParkingControls(r) {
    if (!has('parking:update') && !has('registration:view')) return '';
    const canEdit = has('parking:update')
      && ['CHECKED_IN', 'IN_VISIT', 'COMPLETED'].includes(r.status);
    const p = r.parking || { total: 0, byVehicleType: {}, tickets: [] };

    const counters = VEHICLES.map((v) => {
      const c = p.byVehicleType[v.type] || { issued: 0, returned: 0, outstanding: 0 };
      return `
        <div class="vehicle-card">
          <div class="vehicle-card__head">
            <span class="vehicle-card__icon">${v.icon}</span>
            <span class="vehicle-card__label">${esc(v.label)}</span>
            <span class="vehicle-card__count">${c.issued}</span>
          </div>
          <div class="vehicle-card__meta">
            đang giữ: <b>${c.outstanding}</b> · đã trả: ${c.returned}
          </div>
          ${canEdit ? `
            <div class="vehicle-card__issue">
              <input id="pt-num-${v.type}" placeholder="Số phiếu (tuỳ chọn)" autocomplete="off">
              <button class="btn btn--sm btn--primary" data-issue="${v.type}">Cấp phiếu</button>
            </div>` : ''}
        </div>`;
    }).join('');

    const list = p.tickets.length ? `
      <div class="table-wrap" style="margin-top:.9rem">
        <table><thead><tr>
          <th>Loại xe</th><th>Số phiếu</th><th>Cấp lúc</th><th>Trạng thái</th><th></th>
        </tr></thead><tbody>
          ${p.tickets.map((t) => {
            const v = VEHICLES.find((x) => x.type === t.vehicleType) || { icon: '', label: t.vehicleType };
            return `<tr>
              <td>${v.icon} ${esc(v.label)}</td>
              <td class="mono">${esc(t.ticketNumber || '—')}</td>
              <td>${esc(fmtTime(t.issuedAt))}</td>
              <td>${t.returnedAt
                ? `<span class="badge badge--brand">Đã trả ${esc(fmtTime(t.returnedAt))}</span>`
                : '<span class="badge badge--ok">Đang giữ</span>'}</td>
              <td>${canEdit ? (t.returnedAt
                ? `<button class="btn btn--sm btn--ghost" data-del="${esc(t.id)}">Xoá</button>`
                : `<button class="btn btn--sm btn--ghost" data-return="${esc(t.id)}">Nhận lại</button>`) : ''}</td>
            </tr>`;
          }).join('')}
        </tbody></table>
      </div>` : '<div class="field__help" style="margin-top:.6rem">Chưa cấp phiếu xe nào.</div>';

    return `
      <div class="section-title">Phiếu xe</div>
      ${canEdit ? '' : '<div class="field__help">Chỉ cấp phiếu xe sau khi khách đã check-in.</div>'}
      <div class="vehicle-grid">${counters}</div>
      ${list}`;
  }

  function bindParkingControls(r) {
    const refresh = async (result) => {
      state.selected.registration = { ...state.selected.registration, parking: result.parking };
      renderCheckinDetail();
      loadOfficeSummary();
    };

    $$('[data-issue]').forEach((b) => b.addEventListener('click', async () => {
      const type = b.dataset.issue;
      const numInput = $(`#pt-num-${type}`);
      b.disabled = true;
      try {
        const res = await api(`/api/staff/registrations/${encodeURIComponent(r.id)}/parking-tickets`, {
          method: 'POST',
          body: JSON.stringify({ vehicleType: type, ticketNumber: numInput ? numInput.value : null }),
        });
        await refresh(res);
      } catch (err) { notice(err.message, 'danger'); b.disabled = false; }
    }));

    $$('[data-return]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await api(`/api/staff/parking-tickets/${encodeURIComponent(b.dataset.return)}/return`,
          { method: 'POST' });
        await refresh(res);
      } catch (err) { notice(err.message, 'danger'); b.disabled = false; }
    }));

    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await api(`/api/staff/parking-tickets/${encodeURIComponent(b.dataset.del)}`,
          { method: 'DELETE' });
        await refresh(res);
      } catch (err) { notice(err.message, 'danger'); b.disabled = false; }
    }));
  }

  // §XXIII — status transitions available to the current user.
  const NEXT_STATUSES = {
    REGISTERED: ['CONFIRMED', 'EXPECTED', 'CANCELLED', 'NO_SHOW'],
    CONFIRMED: ['EXPECTED', 'CANCELLED', 'NO_SHOW'],
    EXPECTED: ['CANCELLED', 'NO_SHOW'],
    CHECKED_IN: ['IN_VISIT', 'COMPLETED'],
    IN_VISIT: ['COMPLETED'],
    COMPLETED: [], CANCELLED: [], NO_SHOW: [],
  };

  function renderStatusControls(r) {
    if (!has('status:update')) return '';
    const next = NEXT_STATUSES[r.status] || [];
    if (!next.length) return '';
    return `<div class="section-title">Cập nhật trạng thái</div><div class="actions" style="flex-wrap:wrap">${
      next.map((s) => `<button class="btn btn--sm btn--ghost" data-status="${s}">${esc(i18n.status(s))}</button>`).join('')}</div>`;
  }

  function bindStatusControls(r) {
    $$('[data-status]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const updated = await api(`/api/staff/registrations/${encodeURIComponent(r.id)}/status`, {
          method: 'POST', body: JSON.stringify({ status: b.dataset.status }),
        });
        state.selected.registration = updated;
        state.selected.readiness = { canCheckIn: false, reasons: [] };
        renderCheckinDetail();
        notice(`Trạng thái đã cập nhật: ${i18n.status(updated.status)}`, 'ok');
      } catch (err) { notice(err.message, 'danger'); }
    }));
  }

  async function loadOfficeSummary() {
    const data = await api('/api/staff/office-summary');
    const k = data.kpis;
    $('#office-kpis').innerHTML = [
      ['Khách hôm nay', k.todaysVisitors], ['Chưa đến', k.pending],
      ['Đã check-in', k.checkedIn], ['Hoàn tất', k.completed],
      ['Không đến', k.noShow], ['Đã hủy', k.cancelled],
    ].map(([label, v], i) => `<div class="kpi ${i === 2 ? 'kpi--accent' : ''}">
        <div class="kpi__label">${esc(label)}</div><div class="kpi__value">${v}</div></div>`).join('');

    $('#office-parking').innerHTML = data.parkingTickets.length ? `
      <div class="section-title">Phiếu xe hôm nay</div>
      <div class="kpis">${data.parkingTickets.map((p) => `
        <div class="kpi"><div class="kpi__label">🚗 Ô tô</div>
          <div class="kpi__value">${p.byVehicleType.CAR.issued}</div>
          <div class="kpi__sub">đang giữ: ${p.byVehicleType.CAR.outstanding}</div></div>
        <div class="kpi"><div class="kpi__label">🏍️ Xe máy</div>
          <div class="kpi__value">${p.byVehicleType.MOTORBIKE.issued}</div>
          <div class="kpi__sub">đang giữ: ${p.byVehicleType.MOTORBIKE.outstanding}</div></div>`).join('')}</div>` : '';
  }

  // ------------------------------------------------------------ QR scanning
  //
  // Two things the first version got wrong, both of which show up on a laptop at
  // a reception desk rather than on a phone:
  //
  //   1. It demanded a rear-facing camera. A laptop has no rear camera,
  //      and an external USB webcam reports no facing mode at all, so the request
  //      either failed outright or picked the wrong device with no way to change it.
  //   2. It relied on `BarcodeDetector`, which Safari and Firefox do not implement
  //      — the button simply said "not supported" and the desk was stuck typing
  //      codes by hand. jsQR is bundled as the fallback, so every browser scans.

  /** Lists the cameras attached to this machine, built-in and USB alike. */
  async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch { return []; }
  }

  async function fillCameraPicker(selectedId) {
    const cameras = await listCameras();
    const pick = $('#camera-pick');
    const select = $('#camera-device');
    if (!pick || !select) return cameras;
    // Labels are blank until permission has been granted once — that is a browser
    // privacy rule, not a bug, so the entries are numbered as a fallback.
    select.innerHTML = cameras.map((c, i) =>
      `<option value="${esc(c.deviceId)}"${c.deviceId === selectedId ? ' selected' : ''}>${
        esc(c.label || `Camera ${i + 1}`)}</option>`).join('');
    pick.classList.toggle('hidden', cameras.length < 2);
    return cameras;
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    const video = $('#scan-video');
    if (video) { video.srcObject = null; video.classList.add('hidden'); }
    $('#camera-btn').textContent = 'Quét camera';
  }

  /** Turns a getUserMedia failure into something a receptionist can act on. */
  function cameraError(err) {
    const name = err && err.name;
    if (!window.isSecureContext) {
      return 'Trình duyệt chỉ cho phép dùng camera trên kết nối HTTPS.';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Trình duyệt đã chặn camera. Bấm vào biểu tượng khoá trên thanh địa chỉ và cho phép camera, sau đó thử lại.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'Không tìm thấy camera nào trên máy này. Hãy cắm webcam hoặc nhập mã xác nhận.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Camera đang được ứng dụng khác sử dụng (Zoom, Teams, FaceTime…). Hãy đóng ứng dụng đó rồi thử lại.';
    }
    return `Không thể mở camera: ${(err && err.message) || name || 'lỗi không xác định'}`;
  }

  /**
   * Opens a camera stream. `deviceId` picks a specific one; otherwise a rear
   * camera is *preferred* (a phone at the door) but never required, so a laptop
   * falls back to whatever it has.
   */
  async function openStream(deviceId) {
    const attempts = deviceId
      ? [{ video: { deviceId: { exact: deviceId } } }]
      : [{ video: { facingMode: { ideal: 'environment' } } }, { video: true }];
    let lastError = null;
    for (const constraints of attempts) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) { lastError = err; }
    }
    throw lastError;
  }

  /** Native detector where it exists, bundled jsQR everywhere else. */
  function makeDecoder() {
    if ('BarcodeDetector' in window) {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      return {
        kind: 'native',
        async read(video) {
          const codes = await detector.detect(video);
          return codes.length ? codes[0].rawValue : null;
        },
      };
    }
    if (typeof window.jsQR !== 'function') return null;
    const canvas = $('#scan-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return {
      kind: 'jsQR',
      async read(video) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return null;
        // Downscale: a QR fills enough of the frame that full resolution only
        // costs frame rate, and the desk camera is often 1080p.
        const scale = Math.min(1, 640 / w);
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = window.jsQR(image.data, image.width, image.height,
          { inversionAttempts: 'dontInvert' });
        return found ? found.data : null;
      },
    };
  }

  async function startCamera(deviceId) {
    const video = $('#scan-video');
    const note = $('#camera-note');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      note.textContent = window.isSecureContext
        ? 'Trình duyệt này không hỗ trợ camera. Hãy dùng máy quét QR hoặc nhập mã xác nhận.'
        : 'Trình duyệt chỉ cho phép dùng camera trên kết nối HTTPS.';
      return;
    }

    const decoder = makeDecoder();
    if (!decoder) {
      note.textContent = 'Không tải được bộ giải mã QR. Hãy tải lại trang hoặc nhập mã xác nhận.';
      return;
    }

    try {
      state.stream = await openStream(deviceId);
    } catch (err) {
      note.textContent = cameraError(err);
      await fillCameraPicker();
      return;
    }

    // Labels only become readable once permission is granted, so the picker is
    // filled again here — the first fill, before permission, shows blank names.
    const track = state.stream.getVideoTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    await fillCameraPicker(settings.deviceId);

    video.srcObject = state.stream;
    video.classList.remove('hidden');
    try {
      await video.play();
    } catch (err) {
      stopCamera();
      note.textContent = cameraError(err);
      return;
    }

    $('#camera-btn').textContent = 'Dừng quét';
    // The picker above already names the camera in use, so the note stays short.
    note.textContent = 'Đưa mã QR của khách vào khung hình.';

    const tick = async () => {
      if (!state.stream) return;
      try {
        const value = await decoder.read(video);
        if (value) {
          $('#scan-input').value = value;
          stopCamera();
          $('#camera-note').textContent = '';
          await resolve(value);
          return;
        }
      } catch { /* a frame that will not decode is normal; keep going */ }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async function toggleCamera() {
    if (state.stream) {
      stopCamera();
      $('#camera-note').textContent = '';
      return;
    }
    await startCamera($('#camera-device') && $('#camera-device').value ? $('#camera-device').value : null);
  }

  /** Switching camera mid-scan reopens the stream on the chosen device. */
  async function switchCamera() {
    if (!state.stream) return;
    stopCamera();
    await startCamera($('#camera-device').value || null);
  }

  // ========================================================= REGISTRATION LIST

  function bindRegistrations() {
    const rerun = () => { state.regQuery.page = 1; loadRegistrations(); };
    ['#flt-search', '#flt-from', '#flt-to', '#flt-office', '#flt-type', '#flt-status', '#flt-parking']
      .forEach((sel) => {
        const el = $(sel);
        if (!el) return;
        el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', debounce(rerun, 300));
      });
    $('#flt-reset').addEventListener('click', () => {
      ['#flt-search', '#flt-from', '#flt-to', '#flt-office', '#flt-type', '#flt-status', '#flt-parking']
        .forEach((s) => { const el = $(s); if (el) el.value = ''; });
      rerun();
    });
    $('#reg-prev').addEventListener('click', () => {
      if (state.regQuery.page > 1) { state.regQuery.page -= 1; loadRegistrations(); }
    });
    $('#reg-next').addEventListener('click', () => { state.regQuery.page += 1; loadRegistrations(); });
    const exportBtn = $('#reg-export');
    if (exportBtn) {
      // §XXXVIII — the file holds the same rows and columns as the table, so the
      // button simply follows the permission to export.
      exportBtn.classList.toggle('hidden', !has('registration:export'));
      exportBtn.addEventListener('click', () =>
        download(`/api/staff/registrations/export.xlsx?${registrationQuery().toString()}`, exportBtn));
    }
    $$('#reg-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const col = th.dataset.sort;
      state.regQuery.sortDir = state.regQuery.sortBy === col && state.regQuery.sortDir === 'asc' ? 'desc' : 'asc';
      state.regQuery.sortBy = col;
      loadRegistrations();
    }));
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /** The filters on screen, as a query string — used by the table and the export
   *  alike, so the spreadsheet always covers exactly what the table is showing. */
  function registrationQuery() {
    const q = new URLSearchParams();
    const map = {
      search: '#flt-search', dateFrom: '#flt-from', dateTo: '#flt-to',
      salesOfficeId: '#flt-office', visitorType: '#flt-type', status: '#flt-status',
      parkingTicket: '#flt-parking',
    };
    Object.entries(map).forEach(([key, sel]) => {
      const el = $(sel);
      if (el && el.value) q.set(key, el.value);
    });
    q.set('sortBy', state.regQuery.sortBy);
    q.set('sortDir', state.regQuery.sortDir);
    return q;
  }

  async function loadRegistrations() {
    const q = registrationQuery();
    q.set('page', state.regQuery.page);
    q.set('pageSize', state.regQuery.pageSize);

    const data = await api(`/api/staff/registrations?${q.toString()}`);
    const body = $('#reg-tbody');
    if (!data.items.length) {
      body.innerHTML = '<tr><td colspan="13"><div class="table-empty">Không có đăng ký nào khớp bộ lọc.</div></td></tr>';
    } else {
      body.innerHTML = data.items.map((r) => {
        // Escaped at the point each value is read, so the row template below
        // interpolates HTML that is already safe.
        const whoHtml = r.visitorType === 'VISITOR'
          ? esc(r.visitor.fullName)
          : `${esc(r.agency.agencyName)} · ${esc(r.agency.customerShortName)} (…${esc(r.agency.customerPhoneLast4)})`;
        const staffHtml = r.visitorType === 'AGENCY' ? esc(r.agency.salesStaffName) : '—';
        const pk = r.parking || { total: 0, byVehicleType: {} };
        const car = (pk.byVehicleType.CAR || {}).issued || 0;
        const moto = (pk.byVehicleType.MOTORBIKE || {}).issued || 0;
        const pt = r.parkingTicketApplicable
          ? (pk.total
            ? `<span class="badge badge--ok">${car ? `🚗${car}` : ''}${car && moto ? ' ' : ''}${moto ? `🏍️${moto}` : ''}</span>`
            : '<span class="badge">Chưa lấy</span>')
          : '<span class="muted">n/a</span>';
        return `<tr>
          <td class="mono">${esc(r.confirmationCode)}</td>
          <td>${esc(r.visitorType === 'VISITOR' ? 'Khách' : 'Đại lý')}</td>
          <td>${whoHtml}</td><td>${staffHtml}</td>
          <td>${esc(r.salesOffice.name)}</td>
          <td>${esc(fmtDate(r.visitDate))}</td>
          <td>${esc(r.timeSlot.label)}</td>
          <td>${r.numberOfVisitors}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${esc(r.checkin ? fmtTime(r.checkin.checkinTime) : '—')}</td>
          <td>${pt}</td>
          <td>${esc(r.checkin ? r.checkin.receptionistName : '—')}</td>
          <td><button class="btn btn--sm btn--ghost" data-open="${esc(r.id)}">Mở</button></td>
        </tr>`;
      }).join('');
      $$('[data-open]').forEach((b) => b.addEventListener('click', () => openRegistration(b.dataset.open)));
    }
    $('#reg-count').textContent = `${data.total} bản ghi`;
    $('#reg-updated').textContent = nowLabel();
    $('#reg-page').textContent = `${data.page} / ${data.totalPages}`;
    $('#reg-prev').disabled = data.page <= 1;
    $('#reg-next').disabled = data.page >= data.totalPages;
  }

  /** §XXXVI — a calendar event or list row opens the Registration detail. */
  async function openRegistration(id) {
    try {
      const r = await api(`/api/staff/registrations/${encodeURIComponent(id)}`);
      state.selected = {
        registration: r,
        readiness: { canCheckIn: false, reasons: [] },
        method: 'SEARCH',
      };
      if (has('checkin:perform')) {
        const res = await api('/api/staff/checkin/resolve', {
          method: 'POST', body: JSON.stringify({ confirmationCode: r.confirmationCode }),
        });
        state.selected = { ...res, method: 'SEARCH' };
        selectTab('checkin');
        renderCheckinDetail();
      } else {
        selectTab('detail');
        $('#detail-body').innerHTML = renderReadonlyDetail(r);
      }
    } catch (err) { notice(err.message, 'danger'); }
  }

  function renderReadonlyDetail(r) {
    const isVisitor = r.visitorType === 'VISITOR';
    // Values are escaped here, once, so the row template interpolates safe HTML.
    const rows = isVisitor
      ? [['Họ tên', esc(r.visitor.fullName)], ['CCCD', esc(r.visitor.cccd)],
        ['Điện thoại', esc(r.visitor.phone)], ['Email', esc(r.visitor.email || '—')]]
      : [['Đại lý', esc(r.agency.agencyName)], ['Nhân viên Sales', esc(r.agency.salesStaffName)],
        ['Khách', `${esc(r.agency.customerShortName)} (…${esc(r.agency.customerPhoneLast4)})`]];
    return `<h2 class="card__title">${esc(r.confirmationCode)}</h2>
      <div class="review"><div class="review__group"><h4>Registration</h4>
        <div class="kv"><span class="kv__k">Văn phòng</span><span class="kv__v">${esc(r.salesOffice.name)}</span></div>
        <div class="kv"><span class="kv__k">Ngày</span><span class="kv__v">${esc(fmtDate(r.visitDate))}</span></div>
        <div class="kv"><span class="kv__k">Khung giờ</span><span class="kv__v">${esc(r.timeSlot.label)}</span></div>
        <div class="kv"><span class="kv__k">Số lượng</span><span class="kv__v">${r.numberOfVisitors}</span></div>
        <div class="kv"><span class="kv__k">Trạng thái</span><span class="kv__v">${statusBadge(r.status)}</span></div>
      </div><div class="review__group"><h4>${isVisitor ? 'Visitor' : 'Agency'}</h4>
        ${rows.map(([k, v]) => `<div class="kv"><span class="kv__k">${esc(k)}</span><span class="kv__v">${v}</span></div>`).join('')}
      </div></div>
      <div class="actions"><button class="btn btn--ghost" id="detail-back">← Danh sách</button></div>`;
  }

  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'detail-back') selectTab('registrations');
  });

  // ================================================================= DASHBOARD

  function bindDashboard() {
    ['#dash-from', '#dash-to', '#dash-office', '#dash-type'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', loadDashboard);
    });
  }

  async function loadDashboard() {
    const q = new URLSearchParams();
    if ($('#dash-from').value) q.set('dateFrom', $('#dash-from').value);
    if ($('#dash-to').value) q.set('dateTo', $('#dash-to').value);
    if ($('#dash-office').value) q.set('salesOfficeId', $('#dash-office').value);
    if ($('#dash-type').value) q.set('visitorType', $('#dash-type').value);

    const d = await api(`/api/staff/dashboard?${q.toString()}`);
    const k = d.kpis;
    $('#dash-updated').textContent = nowLabel();

    $('#dash-kpis').innerHTML = [
      ['Total Registration', k.totalRegistration, `${k.totalPeople} ${i18n.t('unit.people')}`],
      ["Today's Visitors", k.todaysVisitors, `${k.todaysPeople} ${i18n.t('unit.people')}`],
      ['Expected', k.expected, `chưa đến: ${k.pending}`], ['Checked-in', k.checkedIn, ''],
      ['Completed', k.completed, ''], ['No Show', k.noShow, ''], ['Cancelled', k.cancelled, ''],
    ].map(([label, v, sub], i) => `<div class="kpi ${i === 0 ? 'kpi--brand' : (i === 3 ? 'kpi--accent' : '')}">
        <div class="kpi__label">${esc(label)}</div>
        <div class="kpi__value">${v}</div>${sub ? `<div class="kpi__sub">${esc(sub)}</div>` : ''}</div>`).join('');

    const max = Math.max(1, ...d.funnel.stages.map((s) => s.count));
    $('#dash-funnel').innerHTML = `${d.funnel.stages.map((s) => `
      <div class="funnel__row"><div>${esc(i18n.status(s.stage))}</div>
        <div class="funnel__bar"><div class="funnel__fill" style="width:${(s.count / max) * 100}%"></div></div>
        <div class="funnel__n">${s.count}</div></div>`).join('')}
      <div class="funnel__row"><div class="muted">No Show</div>
        <div class="funnel__bar"><div class="funnel__fill" style="width:${(d.funnel.noShow / max) * 100}%;background:var(--danger)"></div></div>
        <div class="funnel__n">${d.funnel.noShow}</div></div>
      <div class="funnel__row"><div class="muted">Cancelled</div>
        <div class="funnel__bar"><div class="funnel__fill" style="width:${(d.funnel.cancelled / max) * 100}%;background:var(--muted)"></div></div>
        <div class="funnel__n">${d.funnel.cancelled}</div></div>`;

    $('#dash-office-table').innerHTML = `
      <thead><tr><th>Văn phòng</th><th>Registration</th><th>Expected</th><th>Checked-in</th>
      <th>Completed</th><th>No-show</th><th>Cancelled</th></tr></thead>
      <tbody>${d.byOffice.map((o) => `<tr><td>${esc(o.salesOfficeName)}</td><td>${o.registration}</td>
        <td>${o.expected}</td><td>${o.checkedIn}</td><td>${o.completed}</td>
        <td>${o.noShow}</td><td>${o.cancelled}</td></tr>`).join('')}</tbody>`;

    const p = d.periods;
    $('#dash-type-table').innerHTML = `
      <thead><tr><th>Kỳ</th><th>Khách Tham Quan</th><th>Đại Lý</th></tr></thead>
      <tbody>${[['Ngày', p.day], ['Tuần', p.week], ['Tháng', p.month]].map(([label, blk]) => `
        <tr><td>${esc(label)} <span class="muted">(${esc(blk.range.from)} → ${esc(blk.range.to)})</span></td>
        <td>${blk.byVisitorType.VISITOR.registrations} <span class="muted">(${blk.byVisitorType.VISITOR.people} người)</span></td>
        <td>${blk.byVisitorType.AGENCY.registrations} <span class="muted">(${blk.byVisitorType.AGENCY.people} người)</span></td></tr>`).join('')}</tbody>`;

    $('#dash-slot-table').innerHTML = `
      <thead><tr><th>Khung giờ</th><th>Sức chứa</th><th>Đăng ký</th><th>Số người</th><th>Checked-in</th><th>No-show</th></tr></thead>
      <tbody>${d.byTimeSlot.map((s) => `<tr>
        <td style="font-weight:700">${esc(s.label)}</td>
        <td class="dim">${esc(s.capacity)} khách</td>
        <td>${s.registrations}</td><td>${s.people}</td><td>${s.checkedIn}</td><td>${s.noShow}</td></tr>`).join('')}</tbody>`;

    const ga = d.guestAccuracy;
    $('#dash-guests').innerHTML = `
      <div class="kpi kpi--brand"><div class="kpi__label">Khách đã đến (thực tế)</div>
        <div class="kpi__value">${ga.actualGuests}</div>
        <div class="kpi__sub">đăng ký: ${ga.expectedGuests}</div></div>
      <div class="kpi ${ga.variance === 0 ? '' : 'kpi--accent'}"><div class="kpi__label">Chênh lệch</div>
        <div class="kpi__value">${ga.variance > 0 ? '+' : ''}${ga.variance}</div></div>
      <div class="kpi"><div class="kpi__label">Khớp đăng ký</div>
        <div class="kpi__value">${Math.round(ga.matchRate * 100)}%</div>
        <div class="kpi__sub">${ga.matched}/${ga.checkins} lượt</div></div>
      <div class="kpi"><div class="kpi__label">Đến nhiều hơn</div><div class="kpi__value">${ga.arrivedWithMore}</div></div>
      <div class="kpi"><div class="kpi__label">Đến ít hơn</div><div class="kpi__value">${ga.arrivedWithFewer}</div></div>`;
    const pu = ga.punctuality || {};
    $('#dash-punctuality').innerHTML = [
      ['Đúng giờ', pu.onTime], ['Đến trễ', pu.late], ['Đến sớm', pu.early],
      ['Sau khung giờ', pu.afterSlot], ['Khác ngày', pu.otherDay],
    ].map(([label, v]) => `<div class="kpi"><div class="kpi__label">${esc(label)}</div>
        <div class="kpi__value">${esc(v || 0)}</div></div>`).join('');
    $('#dash-guests-card').classList.toggle('hidden', ga.checkins === 0);

    $('#dash-parking-card').classList.toggle('hidden', d.parkingTickets.length === 0);
    $('#dash-parking').innerHTML = d.parkingTickets.map((t) => `
      <div class="kpi"><div class="kpi__label">${esc(t.salesOfficeName)} — Tổng khách đến</div><div class="kpi__value">${t.totalVisitors}</div></div>
      <div class="kpi kpi--brand"><div class="kpi__label">🚗 Phiếu ô tô</div>
        <div class="kpi__value">${t.byVehicleType.CAR.issued}</div>
        <div class="kpi__sub">đã trả: ${t.byVehicleType.CAR.returned} · đang giữ: ${t.byVehicleType.CAR.outstanding}</div></div>
      <div class="kpi kpi--accent"><div class="kpi__label">🏍️ Phiếu xe máy</div>
        <div class="kpi__value">${t.byVehicleType.MOTORBIKE.issued}</div>
        <div class="kpi__sub">đã trả: ${t.byVehicleType.MOTORBIKE.returned} · đang giữ: ${t.byVehicleType.MOTORBIKE.outstanding}</div></div>
      <div class="kpi"><div class="kpi__label">Khách có phiếu</div><div class="kpi__value">${t.registrationsWithTicket}</div>
        <div class="kpi__sub">chưa lấy: ${t.registrationsWithoutTicket}</div></div>
      <div class="kpi"><div class="kpi__label">Còn đang giữ</div><div class="kpi__value">${t.parkingTicketOutstanding}</div></div>
      <div class="kpi"><div class="kpi__label">Tỷ lệ lấy phiếu</div><div class="kpi__value">${Math.round(t.issueRate * 100)}%</div></div>`).join('');
  }

  // ====================================================== CUSTOMER STATISTICS

  const STATS_FILTERS = ['#stats-from', '#stats-to', '#stats-office', '#stats-type', '#stats-agency'];

  function bindStats() {
    if (!$('#panel-stats')) return;
    STATS_FILTERS.forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', loadStats);
    });
    $('#stats-reset').addEventListener('click', () => {
      STATS_FILTERS.forEach((sel) => { const el = $(sel); if (el) el.value = ''; });
      loadStats();
    });
    $('#stats-export').addEventListener('click', (e) =>
      download(`/api/staff/customer-stats/export.xlsx?${statsQuery().toString()}`, e.currentTarget));
  }

  function statsQuery() {
    const q = new URLSearchParams();
    const map = {
      dateFrom: '#stats-from', dateTo: '#stats-to', salesOfficeId: '#stats-office',
      visitorType: '#stats-type', agencyId: '#stats-agency',
    };
    Object.entries(map).forEach(([key, sel]) => {
      const el = $(sel);
      if (el && el.value) q.set(key, el.value);
    });
    return q;
  }

  const pct = (v) => `${(v * 100).toFixed(1).replace('.', ',')}%`;
  const typeLabel = (t) => (t === 'VISITOR' ? 'Khách tham quan' : 'Đại lý');

  /** A horizontal bar row, reusing the funnel styling. */
  function bars(rows, { color } = {}) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return rows.map((r) => `
      <div class="funnel__row">
        <div>${esc(r.label)}</div>
        <div class="funnel__bar"><div class="funnel__fill" style="width:${(r.value / max) * 100}%${
      color ? `;background:${color}` : ''}"></div></div>
        <div class="funnel__n">${esc(r.value)}</div>
      </div>`).join('');
  }

  function table(el, headers, rows, emptyText) {
    const node = $(el);
    if (!node) return;
    if (!rows.length) {
      node.innerHTML = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody><tr><td colspan="${headers.length}">
          <div class="table-empty">${esc(emptyText)}</div></td></tr></tbody>`;
      return;
    }
    node.innerHTML = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
  }

  async function loadStats() {
    const d = await api(`/api/staff/customer-stats?${statsQuery().toString()}`);
    state.stats = d;
    const o = d.overview;
    $('#stats-updated').textContent = nowLabel();

    $('#stats-kpis').innerHTML = [
      ['Khách hàng', o.customers, `${o.registrations} lượt đăng ký`, 'kpi--brand'],
      ['Khách mới', o.newCustomers, '', ''],
      ['Khách quay lại', o.returningCustomers, `tỷ lệ ${pct(o.repeatRate)}`, 'kpi--accent'],
      ['Lượt / khách hàng', o.visitsPerCustomer, '', ''],
      ['Người đã đến', o.arrivedPeople, `đăng ký ${o.people} người`, ''],
      ['Tỷ lệ đến', pct(o.showUpRate), `${o.arrivedRegistrations}/${o.registrations - o.cancelled} lượt`, ''],
      ['Quy mô đoàn TB', o.averagePartySize, 'khách/đăng ký', ''],
      ['Đăng ký trước', o.averageLeadDays, 'ngày (trung bình)', ''],
      ['Không đến', o.noShow, '', ''],
      ['Đã huỷ', o.cancelled, '', ''],
    ].map(([label, value, sub, cls]) => `<div class="kpi ${cls}">
        <div class="kpi__label">${esc(label)}</div>
        <div class="kpi__value">${esc(value)}</div>
        ${sub ? `<div class="kpi__sub">${esc(sub)}</div>` : ''}</div>`).join('');

    // What the desk actually counted, as opposed to what was typed into the form.
    const att = d.attendance;
    $('#stats-attendance').innerHTML = [
      ['Người thực đến', att.actualPeople, `${att.checkins} lượt check-in`, 'kpi--brand'],
      ['Đăng ký của các lượt đó', att.bookedPeople, 'người', ''],
      ['Chênh lệch', `${att.variance > 0 ? '+' : ''}${att.variance}`, 'thực đến − đăng ký', att.variance === 0 ? '' : 'kpi--accent'],
      ['Đến nhiều hơn đăng ký', att.arrivedWithMore, 'lượt', ''],
      ['Đến ít hơn đăng ký', att.arrivedWithFewer, 'lượt', ''],
      ['Đúng giờ', pct(att.onTimeRate), `${att.punctuality.onTime}/${att.checkins} lượt`, ''],
      ['Trễ trung bình', att.averageLateMinutes, 'phút (các lượt đến trễ)', ''],
      ['Lễ tân xác nhận ngoài khung', att.confirmedOutsideSlot, 'lượt', ''],
    ].map(([label, value, sub, cls]) => `<div class="kpi ${cls}">
        <div class="kpi__label">${esc(label)}</div>
        <div class="kpi__value">${esc(value)}</div>
        ${sub ? `<div class="kpi__sub">${esc(sub)}</div>` : ''}</div>`).join('');
    $('#stats-punctuality').innerHTML = bars([
      { label: 'Đúng giờ', value: att.punctuality.onTime },
      { label: 'Đến trễ', value: att.punctuality.late },
      { label: 'Đến sớm', value: att.punctuality.early },
      { label: 'Sau khung giờ', value: att.punctuality.afterSlot },
      { label: 'Khác ngày', value: att.punctuality.otherDay },
    ]);

    const slotName = (id) => ((state.config.timeSlots || []).find((t) => t.id === id) || {}).label || id || '—';
    table('#stats-checkin-table',
      ['Thời điểm', 'Mã', 'Văn phòng', 'Khung đăng ký', 'Khung thực vào', 'Đại lý',
        'Đăng ký', 'Thực đến', 'Lệch', 'Đúng giờ?', 'Lệch giờ', 'Lễ tân'],
      d.checkinRecords.slice(0, 200).map((r) => {
        const [label, kind] = ARRIVAL_LABELS[r.arrivalStatus] || ['—', ''];
        return [
          esc(fmtStamp(r.checkinTime)), `<span class="mono">${esc(r.confirmationCode)}</span>`,
          esc(officeName(r.salesOfficeId)), esc(slotName(r.timeSlotId)),
          esc(r.admittedSlotId ? slotName(r.admittedSlotId) : '—'), esc(r.agencyName || '—'),
          r.expectedGuests, `<b>${r.actualGuests}</b>`,
          r.variance === 0 ? '0' : `<span class="badge badge--warn">${r.variance > 0 ? '+' : ''}${r.variance}</span>`,
          `<span class="badge ${kind ? `badge--${kind}` : ''}">${esc(label)}</span>`,
          r.minutesFromSlotStart === null ? '—' : `${r.minutesFromSlotStart > 0 ? '+' : ''}${r.minutesFromSlotStart}′`,
          esc(r.receptionistName),
        ];
      }), 'Chưa có lượt check-in nào.');

    $('#stats-retention').innerHTML = bars([
      { label: 'Khách mới', value: o.newCustomers },
      { label: 'Khách quay lại', value: o.returningCustomers },
    ]);

    table('#stats-source-table',
      ['Loại khách', 'Lượt đăng ký', 'Khách hàng', 'Khách mới', 'Khách quay lại',
        'Người đăng ký', 'Người thực đến', 'Không đến', 'Tỷ lệ đến'],
      d.bySource.map((r) => [
        esc(typeLabel(r.visitorType)), r.registrations, r.customers, r.newCustomers,
        r.returningCustomers, r.people, r.arrivedPeople, r.noShow, pct(r.showUpRate),
      ]), 'Chưa có dữ liệu.');

    table('#stats-office-table',
      ['Văn phòng', 'Lượt đăng ký', 'Khách hàng', 'Khách mới', 'Khách quay lại',
        'Người thực đến', 'Không đến', 'Tỷ lệ đến'],
      d.byOffice.map((r) => [
        esc(r.salesOfficeName), r.registrations, r.customers, r.newCustomers,
        r.returningCustomers, r.arrivedPeople, r.noShow, pct(r.showUpRate),
      ]), 'Chưa có dữ liệu.');

    table('#stats-agency-table',
      ['Đại lý', 'Lượt đăng ký', 'Khách hàng', 'Người đăng ký', 'Nhân viên', 'Lượt đã đến',
        'Người thực đến', 'Không đến', 'Đã huỷ', 'Tỷ lệ đến'],
      d.byAgency.map((r) => [
        esc(r.agencyName), r.registrations, r.customers, r.people, r.salesStaff,
        r.arrived, `<b>${r.arrivedPeople}</b>`, r.noShow, r.cancelled, pct(r.showUpRate),
      ]), 'Chưa có đăng ký nào từ đại lý.');

    table('#stats-staff-table',
      ['Nhân viên', 'Đại lý', 'Lượt đăng ký', 'Khách hàng', 'Số người', 'Đã đến'],
      d.topSalesStaff.map((r) => [
        esc(r.salesStaffName), esc(r.agencyName), r.registrations, r.customers, r.people, r.arrived,
      ]), 'Chưa có đăng ký nào từ đại lý.');

    table('#stats-customer-table',
      ['Khách hàng', 'Loại khách', 'Đại lý', 'Số lượt', 'Số người', 'Đã đến', 'Lần đầu', 'Gần nhất'],
      d.topCustomers.map((r) => [
        esc(r.name), esc(typeLabel(r.visitorType)), esc(r.agencyName || '—'), r.visits,
        r.people, r.arrived, esc(fmtDate(r.firstVisit)), esc(fmtDate(r.lastVisit)),
      ]), 'Chưa có khách hàng nào.');

    $('#stats-slots').innerHTML = bars(d.byTimeSlot.map((r) => ({ label: r.label, value: r.registrations })));
    $('#stats-weekdays').innerHTML = bars(
      d.byWeekday.map((r) => ({ label: r.label, value: r.registrations })),
      { color: 'linear-gradient(90deg,var(--color-lavender),var(--color-sky))' },
    );

    table('#stats-party-table',
      ['Số khách / đăng ký', 'Lượt đăng ký', 'Tổng số người', 'Tỷ trọng'],
      d.partySizes.map((r) => [`${esc(r.size)} khách`, r.registrations, r.people, pct(r.share)]),
      'Chưa có dữ liệu.');

    table('#stats-trend-table',
      ['Ngày tham quan', 'Lượt đăng ký', 'Khách hàng', 'Người đăng ký', 'Lượt đã đến',
        'Người thực đến', 'Không đến', 'Đã huỷ'],
      d.dailyTrend.map((r) => [
        esc(fmtDate(r.date)), r.registrations, r.customers, r.people, r.arrived,
        `<b>${r.arrivedPeople}</b>`, r.noShow, r.cancelled,
      ]), 'Chưa có lịch tham quan nào.');
  }

  // =========================================================== FLOOR GUIDELINES
  //
  // The operating procedure for the sales floor, written for the people standing
  // on it. It is kept here rather than in a separate document so it cannot drift
  // away from the app: every step below names a control that exists on screen.

  const GUIDE = [
    {
      role: 'RECEPTIONIST',
      title: 'Lễ tân — tiếp đón và check-in',
      intro: 'Mỗi ca trực đăng nhập bằng tài khoản riêng. Mọi check-in đều ghi lại tên người thực hiện và thời điểm, nên không dùng chung tài khoản.',
      steps: [
        ['Tìm đăng ký của khách',
          'Dùng ô tìm kiếm ở tab Check-in. Quét mã QR, hoặc gõ mã xác nhận, họ tên, số điện thoại, CCCD, tên đại lý hoặc tên nhân viên đại lý — một ô duy nhất cho tất cả.'],
        ['Đối chiếu thông tin',
          'So sánh họ tên và CCCD trên màn hình với giấy tờ của khách. Nếu kết quả tìm được nhiều đăng ký, chọn đúng dòng trước khi tiếp tục.'],
        ['Đếm số khách thực tế',
          'Nhập số người thực sự có mặt. Hệ thống điền sẵn số đã đăng ký — chỉ sửa khi khác. Mỗi khung giờ chỉ nhận tối đa 30 khách: nếu đoàn đến đông hơn số đã đăng ký, hệ thống chỉ cho vào đúng số chỗ còn trống, phần còn lại phải đăng ký khung giờ khác.'],
        ['Khách đến sớm hoặc trễ',
          'Màn hình hiện rõ đoàn đến đúng giờ, trễ hay sớm bao nhiêu phút. Đến trong khung giờ của mình (kể cả trễ) thì check-in bình thường. Đến trước khung giờ hơn 15 phút, hoặc sau khi khung giờ đã kết thúc, lễ tân phải bấm nút xác nhận riêng — đoàn sẽ được tính vào khung giờ đang diễn ra, và chỉ vào được nếu khung đó còn chỗ.'],
        ['Xác nhận check-in',
          'Bấm CHECK IN. Trạng thái chuyển sang "Đã check-in" và Dashboard cập nhật ngay.'],
        ['Phát phiếu giữ xe (CII Bình Thạnh)',
          'Chọn đúng loại xe — 🚗 Ô tô hoặc 🏍️ Xe máy — và nhập số phiếu. Một đoàn có thể nhận nhiều phiếu. Khi khách ra về, bấm "Đã trả" cho từng phiếu.'],
        ['Kết thúc lượt tham quan',
          'Khi khách ra về, chuyển trạng thái sang "Hoàn thành". Khách đã đăng ký nhưng không đến thì chuyển "Không đến" vào cuối ngày.'],
      ],
      notes: [
        'Khách đến sai ngày: hệ thống sẽ cảnh báo. Vẫn có thể cho check-in bằng tuỳ chọn bỏ qua, và việc bỏ qua này được ghi lại.',
        'Khung giờ đã đủ 30 khách thì không có nút bỏ qua. Đây là giới hạn cứng — mời khách đăng ký khung giờ kế tiếp.',
        'Lần đăng nhập đầu tiên, hệ thống yêu cầu bạn đổi mật khẩu được cấp. Có thể đổi lại bất cứ lúc nào bằng nút "Đổi mật khẩu" ở góc trên.',
        'Khách chưa đăng ký: nhờ khách quét mã tại quầy đăng ký, hoặc báo Sales tạo đăng ký hộ.',
        'Mã QR không chứa thông tin cá nhân — không dùng ảnh QR thay cho giấy tờ tuỳ thân.',
        'Chỉ nhìn thấy đăng ký của văn phòng mình. Đây là giới hạn của hệ thống, không phải lỗi.',
      ],
    },
    {
      role: 'SALES',
      title: 'Sales — đăng ký hộ khách',
      intro: 'Sales tạo và tra cứu đăng ký, không thực hiện check-in.',
      steps: [
        ['Tạo đăng ký hộ khách',
          'Mở trang đăng ký, chọn đúng văn phòng và vai trò, điền thông tin khách rồi chọn ngày và khung giờ.'],
        ['Gửi mã xác nhận cho khách',
          'Tải mã QR về và gửi cho khách qua Zalo hoặc email. Khách chỉ cần mã QR hoặc mã xác nhận khi đến.'],
        ['Theo dõi lịch',
          'Tab Calendar hiển thị lịch tham quan theo ngày, tuần và tháng. Bấm vào một đăng ký để xem nhanh thông tin.'],
      ],
      notes: [
        'Không tạo trùng: nếu khách đã có đăng ký còn hiệu lực cho cùng văn phòng, ngày và khung giờ, hệ thống sẽ báo trùng.',
        'Mỗi khung giờ nhận tối đa 30 khách. Khung đã đầy hoặc đã qua giờ sẽ không chọn được.',
        'Khai đúng số khách. Số người lễ tân đếm được khi check-in mới là số được tính vào sức chứa — khai ít hơn rồi dẫn đông hơn sẽ không vào được nếu khung giờ đã đủ.',
        'Đặt trước tối đa 10 ngày.',
      ],
    },
    {
      role: 'MANAGER',
      title: 'Quản lý — theo dõi và báo cáo',
      intro: 'Toàn bộ dữ liệu của cả hai văn phòng, không giới hạn theo sàn.',
      steps: [
        ['Dashboard trong ngày',
          'Số lượt dự kiến, đã check-in, hoàn thành, không đến và phiếu xe còn đang giữ. Tự động làm mới mỗi phút.'],
        ['Thống kê khách hàng',
          'Khách mới và khách quay lại, nguồn khách, xếp hạng đại lý và nhân viên đại lý, khung giờ và ngày khách hay chọn.'],
        ['Số người thực đến',
          'Tab Thống kê khách có khối "Thực tế tại quầy lễ tân": số người lễ tân đếm được, chênh lệch so với đăng ký, tỷ lệ đúng giờ, và nhật ký từng lượt check-in. Bảng theo đại lý có cột "Người thực đến".'],
        ['Xuất Excel',
          'Nút "Xuất Excel" ở tab Đăng ký xuất đúng những dòng đang lọc. Ở tab Thống kê khách, mỗi nhóm số liệu là một sheet riêng.'],
      ],
      notes: [
        'Chênh lệch giữa số khách đăng ký và số khách thực đến nằm ở cuối Dashboard. Chênh lệch kéo dài nghĩa là số đăng ký không còn đáng tin để tính sức chứa.',
        'Tỷ lệ đến thấp ở một đại lý là dấu hiệu cần trao đổi lại với đại lý đó.',
      ],
    },
    {
      role: 'ADMINISTRATOR',
      title: 'Quản trị hệ thống',
      intro: 'Quản lý tài khoản, dữ liệu nền và lịch mở cửa. Quản trị không xem danh sách đăng ký, Dashboard hay thống kê khách — những màn hình đó chứa họ tên, CCCD và số điện thoại của khách, thuộc về bộ phận trực tiếp tiếp đón.',
      steps: [
        ['Tạo tài khoản', 'Tab Tài khoản → "+ Tài khoản mới". Lễ tân và Sales bắt buộc phải gán văn phòng; Quản lý và Quản trị thì không. Mật khẩu bạn cấp chỉ dùng được một lần: người dùng phải đổi ngay khi đăng nhập lần đầu.'],
        ['Theo dõi hoạt động', 'Bảng tài khoản hiện ai đang trực tuyến, ai đã đăng nhập hôm nay, ai chưa từng đăng nhập, lần đăng nhập gần nhất, số lần đăng nhập và tài khoản nào còn chờ đổi mật khẩu.'],
        ['Sửa và đổi mật khẩu', 'Nút Sửa đổi họ tên, tên đăng nhập, vai trò và văn phòng. Nút Đổi mật khẩu đặt mật khẩu mới mà không cần biết mật khẩu cũ (tối thiểu 8 ký tự).'],
        ['Khoá hoặc xoá tài khoản', 'Khoá là cách thường dùng khi nhân sự nghỉ: tài khoản không đăng nhập được nữa nhưng lịch sử check-in vẫn giữ nguyên. Chỉ xoá được tài khoản chưa từng check-in cho khách nào.'],
        ['Khoá lịch tiếp khách', 'Tab Khoá lịch: chọn ngày (hoặc khoảng ngày), văn phòng và khung giờ rồi bấm Khoá. Khách sẽ không đăng ký được vào thời gian đó và lịch sẽ hiện màu đỏ kèm lý do.'],
        ['Sức chứa khung giờ', 'Tab Lịch & sức chứa → bảng Sức chứa: đổi số khách tối đa cho từng khung giờ, hoặc tạm ngưng một khung giờ mà không cần khoá cả ngày.'],
        ['Nhật ký hệ thống', 'Tab Nhật ký ghi lại mọi thay đổi về tài khoản, sức chứa và lịch khoá — ai làm, lúc nào, nội dung gì. Có thể lọc theo hành động và theo ngày.'],
        ['Dữ liệu nền', 'Bổ sung đại lý mới. Đại lý không còn hợp tác thì ngưng kích hoạt, không xoá — đăng ký cũ vẫn tham chiếu đến.'],
      ],
      notes: [
        'Đổi toàn bộ mật khẩu mặc định trước khi mở cho người dùng thật.',
        'Khoá lịch KHÔNG tự huỷ các đăng ký đã có trong khoảng thời gian đó. Hệ thống báo số đăng ký bị ảnh hưởng để bộ phận kinh doanh chủ động liên hệ khách.',
        'Hệ thống không cho phép khoá, hạ vai trò hoặc xoá tài khoản Quản trị cuối cùng còn hoạt động.',
        'Giảm sức chứa KHÔNG huỷ các đăng ký đã vượt mức. Hệ thống liệt kê những ngày bị vượt để bộ phận kinh doanh xử lý.',
        'Nhật ký không bao giờ lưu mật khẩu — chỉ ghi nhận việc mật khẩu đã được đặt lại.',
        'Khi khách chọn "Khác" ở ô đại lý và gõ tên trùng với một đại lý đã có, hệ thống tự gộp về đại lý đó để số liệu không bị tách đôi.',
      ],
    },
  ];

  function bindGuide() {
    const print = $('#guide-print');
    if (print) print.addEventListener('click', () => window.print());
  }

  function renderGuide() {
    const host = $('#guide-sections');
    if (!host) return;
    const myRole = state.session && state.session.user.role;

    host.innerHTML = GUIDE.map((section) => {
      const mine = section.role === myRole;
      return `<div class="card${mine ? ' card--mine' : ''}">
        <div class="card__head">
          <div>
            <div class="card__title">${esc(section.title)}</div>
            <div class="card__hint">${esc(section.intro)}</div>
          </div>
          ${mine ? '<div class="toolbar__spacer"></div><span class="badge badge--brand">Vai trò của bạn</span>' : ''}
        </div>
        <ol class="guide-steps" style="margin-top:1rem">
          ${section.steps.map(([title, detail]) => `<li><div>
            <strong>${esc(title)}</strong><span>${esc(detail)}</span>
          </div></li>`).join('')}
        </ol>
        <div class="section-title">Lưu ý</div>
        <ul class="guide-notes">${section.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>`;
    }).join('');
  }

  // ============================================================ ACCOUNTS (admin)

  const ROLE_LABELS = {
    RECEPTIONIST: 'Lễ tân', SALES: 'Sales', MANAGER: 'Quản lý', ADMINISTRATOR: 'Quản trị',
  };

  function bindAccounts() {
    if (!$('#panel-accounts')) return;
    ['#acct-role', '#acct-office'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', loadAccounts);
    });
    $('#acct-new').addEventListener('click', () => openAccountForm(null));
  }

  function fillAccountFilters() {
    const role = $('#acct-role');
    if (!role) return;
    role.innerHTML = `<option value="">Tất cả vai trò</option>${
      Object.entries(ROLE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}`;
    $('#acct-office').innerHTML = `<option value="">Tất cả văn phòng</option>${
      state.config.salesOffices.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}`;
  }

  async function loadAccounts() {
    const q = new URLSearchParams();
    if ($('#acct-role').value) q.set('role', $('#acct-role').value);
    if ($('#acct-office').value) q.set('salesOfficeId', $('#acct-office').value);
    const data = await api(`/api/admin/users?${q.toString()}`);
    state.accounts = data.items;
    $('#acct-updated').textContent = nowLabel();

    const me = state.session.user.id;
    $('#acct-table').innerHTML = `
      <thead><tr><th>Tài khoản</th><th>Họ tên</th><th>Vai trò</th><th>Văn phòng</th>
        <th>Trạng thái</th><th>Hoạt động</th><th>Đăng nhập gần nhất</th><th>Số lần</th>
        <th>Thao tác</th></tr></thead>
      <tbody>${data.items.map((u) => `<tr>
        <td class="mono">${esc(u.username)}${u.id === me ? ' <span class="badge badge--brand">bạn</span>' : ''}</td>
        <td>${esc(u.fullName)}</td>
        <td>${esc(ROLE_LABELS[u.role] || u.role)}</td>
        <td>${esc(officeName(u.salesOfficeId))}</td>
        <td>${u.active
          ? '<span class="badge badge--ok">Đang hoạt động</span>'
          : '<span class="badge badge--danger">Đã khoá</span>'}${u.mustChangePassword
          ? ' <span class="badge badge--warn" title="Chưa đổi mật khẩu được cấp">Chờ đổi mật khẩu</span>' : ''}</td>
        <td>${activityBadge(u)}</td>
        <td class="dim">${u.lastLoginAt ? esc(fmtStamp(u.lastLoginAt)) : '—'}</td>
        <td class="dim">${esc(u.loginCount || 0)}</td>
        <td class="actions actions--row">
          <button class="btn btn--ghost btn--sm" data-acct-edit="${esc(u.id)}">Sửa</button>
          <button class="btn btn--ghost btn--sm" data-acct-pass="${esc(u.id)}">Đổi mật khẩu</button>
          <button class="btn btn--ghost btn--sm" data-acct-active="${esc(u.id)}">${
  u.active ? 'Khoá' : 'Mở khoá'}</button>
          <button class="btn btn--ghost btn--sm" data-acct-del="${esc(u.id)}">Xoá</button>
        </td></tr>`).join('')}</tbody>`;
  }

  const ACTIVITY = {
    ONLINE: ['Đang trực tuyến', 'ok'],
    TODAY: ['Hôm nay', 'brand'],
    RECENT: ['Trong 7 ngày', ''],
    DORMANT: ['Không hoạt động > 7 ngày', 'warn'],
    NEVER: ['Chưa từng đăng nhập', 'danger'],
  };
  function activityBadge(u) {
    const [label, kind] = ACTIVITY[u.activity] || [u.activity || '—', ''];
    const seen = u.lastSeenAt ? ` title="Hoạt động gần nhất: ${esc(fmtStamp(u.lastSeenAt))}"` : '';
    return `<span class="badge ${kind ? `badge--${kind}` : ''}"${seen}>${esc(label)}</span>`;
  }
  /** A timestamp as the desk would say it: 02/10/2026 10:54. */
  const fmtStamp = (iso) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString('vi-VN')} ${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
  };

  const officeName = (id) => {
    if (!id) return '—';
    const o = (state.config.salesOffices || []).find((x) => x.id === id);
    return o ? o.name : id;
  };

  const findAccount = (id) => (state.accounts || []).find((u) => u.id === id);

  /** One modal serves creating and editing: the fields are the same. */
  function openAccountForm(user) {
    const offices = state.config.salesOffices;
    modal(user ? `Sửa tài khoản ${user.username}` : 'Tạo tài khoản mới', `
      <div class="form-grid">
        <div class="field"><label for="m-username">Tên đăng nhập <span class="field__req">*</span></label>
          <input id="m-username" type="text" autocomplete="off" value="${esc(user ? user.username : '')}"></div>
        <div class="field"><label for="m-fullname">Họ và tên <span class="field__req">*</span></label>
          <input id="m-fullname" type="text" autocomplete="off" value="${esc(user ? user.fullName : '')}"></div>
        <div class="field"><label for="m-role">Vai trò <span class="field__req">*</span></label>
          <select id="m-role">${Object.entries(ROLE_LABELS).map(([k, v]) =>
    `<option value="${k}"${user && user.role === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <div class="field"><label for="m-office">Văn phòng</label>
          <select id="m-office"><option value="">— Không gán —</option>${offices.map((o) =>
    `<option value="${esc(o.id)}"${user && user.salesOfficeId === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
          <div class="field__help">Lễ tân và Sales bắt buộc phải có văn phòng.</div></div>
        ${user ? '' : `<div class="field span-2"><label for="m-password">Mật khẩu <span class="field__req">*</span></label>
          <input id="m-password" type="password" autocomplete="new-password">
          <div class="field__help">Tối thiểu 8 ký tự. Người dùng sẽ phải đổi mật khẩu này ở lần đăng nhập đầu tiên.</div></div>`}
      </div>`, async () => {
      const body = {
        username: $('#m-username').value.trim(),
        fullName: $('#m-fullname').value.trim(),
        role: $('#m-role').value,
        salesOfficeId: $('#m-office').value || null,
      };
      if (user) {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        body.password = $('#m-password').value;
        await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
      }
      await loadAccounts();
      notice(user ? 'Đã cập nhật tài khoản.' : 'Đã tạo tài khoản.', 'ok');
    });
  }

  function openPasswordForm(user) {
    modal(`Đổi mật khẩu — ${user.username}`, `
      <div class="field"><label for="m-newpass">Mật khẩu mới <span class="field__req">*</span></label>
        <input id="m-newpass" type="password" autocomplete="new-password">
        <div class="field__help">Tối thiểu 8 ký tự. Người dùng sẽ phải đổi lại mật khẩu này ở lần đăng nhập kế tiếp.</div></div>`,
    async () => {
      await api(`/api/admin/users/${user.id}/password`, {
        method: 'POST', body: JSON.stringify({ password: $('#m-newpass').value }),
      });
      notice(`Đã đổi mật khẩu cho ${user.username}.`, 'ok');
    });
  }

  // Delegated so the buttons keep working after every re-render.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-acct-edit],[data-acct-pass],[data-acct-active],[data-acct-del]');
    if (!btn) return;
    const d = btn.dataset;
    const user = findAccount(d.acctEdit || d.acctPass || d.acctActive || d.acctDel);
    if (!user) return;
    try {
      if (d.acctEdit) openAccountForm(user);
      else if (d.acctPass) openPasswordForm(user);
      else if (d.acctActive) {
        await api(`/api/admin/users/${user.id}/active`, {
          method: 'POST', body: JSON.stringify({ active: !user.active }),
        });
        await loadAccounts();
        notice(user.active ? `Đã khoá ${user.username}.` : `Đã mở khoá ${user.username}.`, 'ok');
      } else if (d.acctDel) {
        // eslint-disable-next-line no-restricted-globals, no-alert
        if (!window.confirm(`Xoá vĩnh viễn tài khoản "${user.username}"? Thao tác này không thể hoàn tác.`)) return;
        await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
        await loadAccounts();
        notice(`Đã xoá ${user.username}.`, 'ok');
      }
    } catch (err) {
      notice(err.message, 'danger');
    }
  });

  // ====================================================== BLOCKED PERIODS (admin)

  function bindBlocks() {
    if (!$('#panel-blocks')) return;
    $('#blk-add').addEventListener('click', addBlock);
  }

  function fillBlockFilters() {
    const office = $('#blk-office');
    if (!office) return;
    office.innerHTML = `<option value="">Tất cả văn phòng</option>${
      state.config.salesOffices.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}`;
    $('#blk-slot').innerHTML = `<option value="">Cả ngày</option>${
      state.config.timeSlots.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')}`;
  }

  async function addBlock() {
    const err = $('#blk-error');
    err.classList.add('hidden');
    const startDate = $('#blk-from').value;
    if (!startDate) {
      err.textContent = 'Vui lòng chọn ngày bắt đầu.';
      err.classList.remove('hidden');
      return;
    }
    try {
      const created = await api('/api/admin/blocked-periods', {
        method: 'POST',
        body: JSON.stringify({
          startDate,
          endDate: $('#blk-to').value || null,
          salesOfficeId: $('#blk-office').value || null,
          timeSlotId: $('#blk-slot').value || null,
          reason: $('#blk-reason').value.trim() || null,
        }),
      });
      ['#blk-from', '#blk-to', '#blk-reason'].forEach((sel) => { $(sel).value = ''; });
      await loadBlocks();
      // Blocking does not cancel bookings already made inside the period — that
      // is a decision about real people, so it is reported rather than assumed.
      notice(created.affectedRegistrations
        ? `Đã khoá. Lưu ý: đã có ${created.affectedRegistrations} đăng ký trong khoảng thời gian này — vui lòng liên hệ khách để sắp xếp lại.`
        : 'Đã khoá thời gian này.',
      created.affectedRegistrations ? 'warn' : 'ok');
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  }

  async function loadBlocks() {
    const data = await api('/api/admin/blocked-periods');
    state.blocks = data.items;
    const slotLabel = (id) => {
      if (!id) return 'Cả ngày';
      const t = (state.config.timeSlots || []).find((x) => x.id === id);
      return t ? t.label : id;
    };
    $('#blk-table').innerHTML = `
      <thead><tr><th>Từ ngày</th><th>Đến ngày</th><th>Văn phòng</th><th>Khung giờ</th>
        <th>Lý do</th><th>Người khoá</th><th></th></tr></thead>
      <tbody>${data.items.length ? data.items.map((b) => `<tr>
        <td>${esc(fmtDate(b.startDate))}</td>
        <td>${esc(fmtDate(b.endDate))}</td>
        <td>${esc(b.salesOfficeId ? officeName(b.salesOfficeId) : 'Tất cả')}</td>
        <td>${esc(slotLabel(b.timeSlotId))}</td>
        <td>${esc(b.reason || '—')}</td>
        <td class="dim">${esc(b.createdByName)}</td>
        <td><button class="btn btn--ghost btn--sm" data-blk-del="${esc(b.id)}">Bỏ khoá</button></td>
      </tr>`).join('') : '<tr><td colspan="7"><div class="table-empty">Chưa khoá thời gian nào.</div></td></tr>'}</tbody>`;
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-blk-del]');
    if (!btn) return;
    try {
      await api(`/api/admin/blocked-periods/${btn.dataset.blkDel}`, { method: 'DELETE' });
      await loadBlocks();
      notice('Đã bỏ khoá.', 'ok');
    } catch (err) { notice(err.message, 'danger'); }
  });

  // ======================================================= SLOT CAPACITY (admin)

  async function loadCapacity() {
    const table = $('#cap-table');
    if (!table) return;
    // The admin endpoint, not /api/config: that one hides inactive slots from
    // visitors, and a slot switched off here must still be visible to switch on.
    const { items } = await api('/api/admin/time-slots');
    state.slots = items;
    table.innerHTML = `
      <thead><tr><th>Khung giờ</th><th>Sức chứa (khách)</th><th>Trạng thái</th><th></th></tr></thead>
      <tbody>${items.map((t) => `<tr>
        <td style="font-weight:700">${esc(t.label)}</td>
        <td><input class="cap-input" type="number" min="1" max="200" step="1"
                   value="${esc(t.capacity)}" data-cap-for="${esc(t.id)}"
                   aria-label="Sức chứa ${esc(t.label)}"></td>
        <td>${t.active
    ? '<span class="badge badge--ok">Đang mở</span>'
    : '<span class="badge badge--danger">Tạm ngưng</span>'}</td>
        <td class="actions actions--row">
          <button class="btn btn--sm" data-cap-save="${esc(t.id)}">Lưu</button>
          <button class="btn btn--ghost btn--sm" data-cap-toggle="${esc(t.id)}">${
  t.active ? 'Tạm ngưng' : 'Mở lại'}</button>
        </td></tr>`).join('')}</tbody>`;
  }

  async function saveCapacity(slotId, body) {
    const err = $('#cap-error');
    err.classList.add('hidden');
    try {
      const slot = await api(`/api/admin/time-slots/${slotId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      await loadCapacity();
      // Lowering capacity does not cancel anyone; say which dates are now over.
      if (slot.overbookedDates && slot.overbookedDates.length) {
        notice(`Đã lưu. Lưu ý: ${slot.overbookedDates.length} ngày đang có số khách vượt sức chứa mới (${
          slot.overbookedDates.map((d) => `${fmtDate(d.date)}: ${d.booked}/${d.capacity}`).join(', ')
        }). Các đăng ký cũ vẫn giữ nguyên.`, 'warn');
      } else {
        notice('Đã lưu khung giờ.', 'ok');
      }
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-cap-save],[data-cap-toggle]');
    if (!btn) return;
    const id = btn.dataset.capSave || btn.dataset.capToggle;
    if (btn.dataset.capSave) {
      const input = $(`[data-cap-for="${id}"]`);
      await saveCapacity(id, { capacity: Number(input.value) });
    } else {
      const slot = (state.slots || []).find((t) => t.id === id);
      await saveCapacity(id, { active: !(slot && slot.active) });
    }
  });

  // ========================================================== AUDIT LOG (admin)

  const AUDIT_LABELS = {
    USER_CREATED: 'Tạo tài khoản',
    USER_UPDATED: 'Sửa tài khoản',
    USER_DELETED: 'Xoá tài khoản',
    USER_ACTIVATED: 'Mở khoá tài khoản',
    USER_DEACTIVATED: 'Khoá tài khoản',
    USER_PASSWORD_RESET: 'Đặt lại mật khẩu',
    PASSWORD_CHANGED_SELF: 'Tự đổi mật khẩu',
    SLOT_CAPACITY_CHANGED: 'Đổi sức chứa',
    SLOT_UPDATED: 'Sửa khung giờ',
    AGENCY_SAVED: 'Lưu đại lý',
    PERIOD_BLOCKED: 'Khoá lịch',
    PERIOD_UNBLOCKED: 'Bỏ khoá lịch',
  };

  function bindAudit() {
    if (!$('#panel-audit')) return;
    ['#audit-action', '#audit-from', '#audit-to'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', () => { state.auditQuery.page = 1; loadAudit(); });
    });
    $('#audit-reset').addEventListener('click', () => {
      ['#audit-action', '#audit-from', '#audit-to'].forEach((sel) => { $(sel).value = ''; });
      state.auditQuery.page = 1;
      loadAudit();
    });
    $('#audit-prev').addEventListener('click', () => {
      if (state.auditQuery.page > 1) { state.auditQuery.page -= 1; loadAudit(); }
    });
    $('#audit-next').addEventListener('click', () => { state.auditQuery.page += 1; loadAudit(); });
  }

  async function loadAudit() {
    const q = new URLSearchParams();
    if ($('#audit-action').value) q.set('action', $('#audit-action').value);
    if ($('#audit-from').value) q.set('from', $('#audit-from').value);
    if ($('#audit-to').value) q.set('to', $('#audit-to').value);
    q.set('page', state.auditQuery.page);
    q.set('pageSize', state.auditQuery.pageSize);

    const data = await api(`/api/admin/audit-log?${q.toString()}`);
    $('#audit-updated').textContent = nowLabel();

    // The filter offers only actions that have actually happened.
    const sel = $('#audit-action');
    const keep = sel.value;
    sel.innerHTML = `<option value="">Tất cả hành động</option>${
      data.availableActions.map((a) =>
        `<option value="${esc(a)}"${a === keep ? ' selected' : ''}>${esc(AUDIT_LABELS[a] || a)}</option>`).join('')}`;

    $('#audit-table').innerHTML = `
      <thead><tr><th>Thời điểm</th><th>Người thực hiện</th><th>Hành động</th><th>Nội dung</th></tr></thead>
      <tbody>${data.items.length ? data.items.map((e) => `<tr>
        <td class="mono dim">${esc(fmtDate(e.at.slice(0, 10)))} ${esc(e.at.slice(11, 16))}</td>
        <td>${esc(e.actorName)} <span class="badge">${esc(e.actorRole)}</span></td>
        <td>${esc(AUDIT_LABELS[e.action] || e.action)}</td>
        <td>${esc(e.summary)}</td>
      </tr>`).join('') : '<tr><td colspan="4"><div class="table-empty">Chưa có thay đổi nào được ghi nhận.</div></td></tr>'}</tbody>`;

    $('#audit-count').textContent = `${data.total} thay đổi`;
    $('#audit-page').textContent = `${data.page} / ${data.totalPages}`;
    $('#audit-prev').disabled = data.page <= 1;
    $('#audit-next').disabled = data.page >= data.totalPages;
  }

  // ------------------------------------------------------------------- modal

  /** A small prompt dialog: body HTML, and what to do when Save is pressed. */
  function modal(title, bodyHtml, onSave) {
    const host = $('#admin-modal');
    host.innerHTML = `
      <div class="modal-content modal-content--wide">
        <h3 class="modal-title">${esc(title)}</h3>
        <div id="admin-modal-body">${bodyHtml}</div>
        <div id="admin-modal-error" class="notice notice--danger hidden"></div>
        <div class="actions" style="margin-top:1.2rem">
          <button class="btn btn--ghost" id="admin-modal-cancel">Huỷ</button>
          <button class="btn btn--primary" id="admin-modal-save">Lưu</button>
        </div>
      </div>`;
    host.classList.add('show');
    const close = () => { host.classList.remove('show'); host.innerHTML = ''; };
    $('#admin-modal-cancel').addEventListener('click', close);
    host.addEventListener('click', (e) => { if (e.target === host) close(); });
    $('#admin-modal-save').addEventListener('click', async () => {
      const save = $('#admin-modal-save');
      const errBox = $('#admin-modal-error');
      errBox.classList.add('hidden');
      save.disabled = true;
      try {
        await onSave();
        close();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
        save.disabled = false;
      }
    });
  }

  // ================================================================== CALENDAR

  const DAY_MS = 86400000;
  const toUtc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY_MS);

  function addMonths(iso, n) {
    const [y, m] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + n, 1));
    return dt.toISOString().slice(0, 10);
  }

  /** §XXXV — step the calendar one period in either direction. */
  function shiftCalendar(direction) {
    const { view, date } = state.calendar;
    if (view === 'day') state.calendar.date = addDays(date, direction);
    else if (view === 'week') state.calendar.date = addDays(date, 7 * direction);
    else state.calendar.date = addMonths(date, direction);
    closePopover();
    loadCalendar();
  }

  function bindCalendar() {
    $('#cal-prev').addEventListener('click', () => shiftCalendar(-1));
    $('#cal-next').addEventListener('click', () => shiftCalendar(1));
    $('#cal-today').addEventListener('click', () => {
      state.calendar.date = state.config.today;
      closePopover();
      loadCalendar();
    });
    $$('#cal-viewswitch [data-view]').forEach((b) => b.addEventListener('click', () => {
      state.calendar.view = b.dataset.view;
      $$('#cal-viewswitch [data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      closePopover();
      loadCalendar();
    }));
    ['#cal-office', '#cal-type'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', () => { closePopover(); loadCalendar(); });
    });
    // Arrow keys page through the calendar while the tab is open.
    document.addEventListener('keydown', (e) => {
      if (state.tab !== 'calendar' || /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') shiftCalendar(-1);
      if (e.key === 'ArrowRight') shiftCalendar(1);
      if (e.key === 'Escape') closePopover();
    });
  }

  function calendarLabel(data) {
    const months = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
      'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    const [y, m] = data.from.split('-').map(Number);
    if (data.view === 'month') return `${months[m - 1]} / ${y}`;
    if (data.view === 'day') return fmtDate(data.from);
    return `${fmtDate(data.from)} – ${fmtDate(data.to)}`;
  }

  async function loadCalendar() {
    const cal = state.calendar;
    if (!cal.date) cal.date = state.config.today;
    const q = new URLSearchParams({ view: cal.view, date: cal.date });
    if ($('#cal-office').value) q.set('salesOfficeId', $('#cal-office').value);
    if ($('#cal-type').value) q.set('visitorType', $('#cal-type').value);

    const data = await api(`/api/staff/calendar?${q.toString()}`);
    cal.data = data;
    $('#cal-updated').textContent = nowLabel();
    $('#cal-label').textContent = calendarLabel(data);

    const body = $('#cal-body');
    if (data.view === 'month') {
      const firstDow = (new Date(`${data.from}T00:00:00Z`).getUTCDay() + 6) % 7;
      const lead = Array.from({ length: firstDow }, () => '<div class="cal-day cal-day--out"></div>');
      const cells = lead.concat(data.days.map((day) => `
        <div class="cal-day ${day.date === state.config.today ? 'cal-day--today' : ''} ${
  day.fullyBlocked ? 'cal-day--blocked' : ''}">
          <div class="cal-day__n">${Number(day.date.slice(8))}</div>
          ${blockNote(day)}
          ${day.events.slice(0, 3).map(evButton).join('')}
          ${day.events.length > 3 ? `<div class="cal-more">+${day.events.length - 3} lịch</div>` : ''}
        </div>`));
      body.innerHTML = `<div class="cal-grid">${
        ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((d) => `<div class="cal-dow">${d}</div>`).join('')
      }${cells.join('')}</div>`;
    } else {
      body.innerHTML = data.days.map((day) => `
        <div class="cal-daygroup">
          <div class="cal-daygroup__head">
            <span class="cal-daygroup__date">${esc(fmtDate(day.date))}</span>
            <span class="dim">${day.events.length} lịch</span>
            ${blockNote(day)}
          </div>
          <div class="cal-list">${day.events.length
            ? day.events.map(evRow).join('')
            : '<div class="table-empty">Không có lịch tham quan.</div>'}</div>
        </div>`).join('');
    }

    // §XXXVI — clicking an event opens its detail right where it sits.
    $$('[data-ev]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      openEventPopover(b, b.dataset.ev);
    }));
  }

  /**
   * Why a day is closed. Shown on the calendar for every role that can see it —
   * the desk needs to know a day is shut as much as the administrator does.
   */
  function blockNote(day) {
    if (!day.blocks || !day.blocks.length) return '';
    const label = (b) => {
      const slot = b.timeSlotId
        ? ((state.config.timeSlots || []).find((t) => t.id === b.timeSlotId) || {}).label || b.timeSlotId
        : 'Cả ngày';
      return b.reason ? `${slot}: ${b.reason}` : `${slot} — đã khoá`;
    };
    return day.blocks.map((b) => `<span class="cal-blocked">⛔ ${esc(label(b))}</span>`).join('');
  }

  function evButton(ev) {
    const tooltip = esc([ev.timeLabel, ev.title, ev.salesOfficeName, ev.confirmationCode,
      i18n.status(ev.status)].join(' · '));
    return `<button class="cal-ev cal-ev--${esc(ev.status)}" data-ev="${esc(ev.registrationId)}"
      title="${tooltip}">${esc(ev.startTime)} ${esc(ev.title)}</button>`;
  }

  function evRow(ev) {
    return `<button class="cal-list__item" data-ev="${esc(ev.registrationId)}">
      <div class="mono nowrap" style="font-weight:800">${esc(ev.timeLabel)}</div>
      <div><div style="font-weight:700">${esc(ev.title)}</div>
        <div class="muted" style="font-size:12px">${esc(ev.subtitle)} · ${esc(ev.numberOfVisitors)} người ·
        ${esc(ev.salesOfficeName)} · <span class="mono">${esc(ev.confirmationCode)}</span></div></div>
      <div>${statusBadge(ev.status)}</div></button>`;
  }

  // ------------------------------------------------- §XXXVI event popover

  function closePopover() {
    $$('.popover, .popover__backdrop').forEach((el) => el.remove());
  }

  function findEvent(registrationId) {
    const data = state.calendar.data;
    if (!data) return null;
    return data.events.find((e) => e.registrationId === registrationId) || null;
  }

  async function openEventPopover(anchor, registrationId) {
    closePopover();
    const ev = findEvent(registrationId);
    if (!ev) return;

    const host = $('#cal-body');
    const backdrop = document.createElement('div');
    backdrop.className = 'popover__backdrop';
    backdrop.addEventListener('click', closePopover);
    document.body.appendChild(backdrop);

    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.innerHTML = `
      <button class="popover__close" aria-label="Đóng">×</button>
      <div class="popover__title">${esc(ev.title)}</div>
      <div class="popover__code mono">${esc(ev.confirmationCode)}</div>
      <div class="popover__rows">
        <div class="kv"><span class="kv__k">Khung giờ</span><span class="kv__v">${esc(ev.timeLabel)}</span></div>
        <div class="kv"><span class="kv__k">Ngày</span><span class="kv__v">${esc(fmtDate(ev.date))}</span></div>
        <div class="kv"><span class="kv__k">Đối tượng</span><span class="kv__v">${esc(ev.subtitle)}</span></div>
        <div class="kv"><span class="kv__k">Số khách</span><span class="kv__v">${esc(ev.numberOfVisitors)}</span></div>
        <div class="kv"><span class="kv__k">Văn phòng</span><span class="kv__v">${esc(ev.salesOfficeName)}</span></div>
        <div class="kv"><span class="kv__k">Trạng thái</span><span class="kv__v">${statusBadge(ev.status)}</span></div>
      </div>
      <div class="popover__extra dim" style="font-size:12px">Đang tải chi tiết…</div>
      <button class="btn btn--primary btn--block btn--sm" data-open-full="${esc(ev.registrationId)}"
        style="margin-top:.85rem">Mở đăng ký đầy đủ</button>`;
    host.appendChild(pop);

    // Position beside the clicked event, kept inside the calendar body.
    const a = anchor.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const width = pop.offsetWidth;
    let left = a.left - h.left;
    if (left + width > host.clientWidth) left = Math.max(0, host.clientWidth - width);
    pop.style.left = `${Math.max(0, left)}px`;
    let top = a.bottom - h.top + 6;
    if (top + pop.offsetHeight > host.clientHeight && a.top - h.top - pop.offsetHeight - 6 > 0) {
      top = a.top - h.top - pop.offsetHeight - 6;
    }
    pop.style.top = `${top}px`;

    pop.querySelector('.popover__close').addEventListener('click', closePopover);
    pop.querySelector('[data-open-full]').addEventListener('click', () => {
      closePopover();
      openRegistration(registrationId);
    });

    // Enrich in place with whatever this role is allowed to read.
    try {
      const full = await api(`/api/staff/registrations/${encodeURIComponent(registrationId)}`);
      const extra = pop.querySelector('.popover__extra');
      if (!extra) return;
      const who = full.visitorType === 'VISITOR'
        ? `${esc(full.visitor.phone)}`
        : `${esc(full.agency.salesStaffName)} · ${esc(full.agency.salesStaffPhone)}`;
      extra.innerHTML = `
        <div class="kv"><span class="kv__k">Liên hệ</span><span class="kv__v">${who}</span></div>
        ${full.checkin ? `<div class="kv"><span class="kv__k">Đã check-in</span><span class="kv__v">${
          esc(fmtTime(full.checkin.checkinTime))} · ${esc(full.checkin.receptionistName)}</span></div>` : ''}
        ${full.notes ? `<div class="kv"><span class="kv__k">Ghi chú</span><span class="kv__v">${esc(full.notes)}</span></div>` : ''}`;
    } catch {
      const extra = pop.querySelector('.popover__extra');
      if (extra) extra.remove();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
}());
