/* ONE ERA visitor registration — one page.
   Language, sales office and role sit at the top (§III, §IV, §V). Choosing a role
   reveals that role's own form below, laid out as on the existing ONE ERA pages:
   a two-column field grid and one grouped panel for guests, date and time slot
   (§VI, §VII, §VIII, §IX, §XI–§XVI). Review (§X / §XVII) and the confirmation
   (§XIX) is a dialog over the page. There is no separate review step: every
   detail is already visible on the one page, so the confirm button registers. */
(function () {
  'use strict';

  const i18n = window.KineraI18n.createI18n('vi');

  const state = {
    config: null,
    // One draft the whole page writes into; nothing is cleared by navigating (§Rule 2).
    draft: {
      language: 'vi', salesOfficeId: '', visitorType: '',
      fullName: '', cccd: '', phone: '', email: '',
      agencyId: '', agencyName: '', salesStaffName: '', salesStaffCccd: '', salesStaffPhone: '',
      customerShortName: '', customerPhoneLast4: '',
      numberOfVisitors: 1, visitDate: '', timeSlotId: '', notes: '',
    },
    availability: [],
    result: null,
    submitting: false,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

  // -------------------------------------------------------------------- client

  async function api(path, options) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, options));
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error((body && body.error && body.error.message) || 'Request failed');
      err.code = body && body.error && body.error.code;
      err.details = body && body.error && body.error.details;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ------------------------------------------------------------------ notices

  function applyStaticText() {
    $$('[data-i18n]').forEach((el) => { el.textContent = i18n.t(el.dataset.i18n); });
    document.title = i18n.t('app.title');
    renderGuide();
  }

  // ------------------------------------------------------------- guidelines
  //
  // The steps quote the booking window and the slot capacity from /api/config
  // rather than repeating them in the text, so the guidance cannot drift away
  // from the rules the backend actually enforces.

  function renderGuide() {
    const steps = $('#guide-steps');
    if (!steps) return;
    const rules = (state.config && state.config.rules) || {};
    const vars = {
      days: rules.maxAdvanceDays ?? 10,
      capacity: rules.slotCapacity ?? 30,
    };

    steps.innerHTML = ['s1', 's2', 's3', 's4', 's5'].map((k) => `
      <li><div>
        <strong>${esc(i18n.t(`guide.${k}.t`))}</strong>
        <span>${esc(i18n.t(`guide.${k}.d`, vars))}</span>
      </div></li>`).join('');

    $('#guide-notes').innerHTML = ['n1', 'n2', 'n3', 'n4', 'n5']
      .map((k) => `<li>${esc(i18n.t(`guide.${k}`, vars))}</li>`).join('');
  }

  function bindGuide() {
    const modal = $('#guide-modal');
    if (!modal) return;
    const open = () => { renderGuide(); modal.classList.add('show'); };
    const close = () => modal.classList.remove('show');
    $('#guide-btn').addEventListener('click', open);
    $('#guide-close').addEventListener('click', close);
    // Clicking the backdrop or pressing Escape closes it — a kiosk visitor
    // should never be able to get stuck behind a dialog.
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('show')) close();
    });
  }

  function globalNotice(html, kind) {
    const el = $('#global-notice');
    el.className = `notice notice--${kind || 'danger'}`;
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  const clearGlobalNotice = () => $('#global-notice').classList.add('hidden');

  function setFieldError(field, message) {
    const wrap = $(`[data-field="${field}"]`);
    if (!wrap) return;
    wrap.dataset.invalid = message ? 'true' : 'false';
    const err = $(`[data-error-for="${field}"]`, wrap);
    if (err) err.textContent = message || '';
  }

  function clearAllFieldErrors() {
    $$('[data-field]').forEach((w) => { w.dataset.invalid = 'false'; });
    $$('[data-error-for]').forEach((e) => { e.textContent = ''; });
  }

  /** Drops the page-level notice once nothing on the page is flagged. */
  function dismissNoticeWhenClean() {
    if ($$('[data-invalid="true"]').length === 0) clearGlobalNotice();
  }

  /** Renders backend validation onto the exact fields (§Step 7 UI States). */
  function applyServerErrors(err) {
    clearAllFieldErrors();
    const details = Array.isArray(err.details) ? err.details : [];
    details.forEach((d) => setFieldError(d.field, d.message));
    const key = `server.${err.code}`;
    const localized = i18n.t(key);
    const headline = localized === key ? err.message : localized;
    const list = details.length
      ? `<ul>${details.map((d) => `<li>${esc(i18n.t(`field.${d.field}`))}: ${esc(d.message)}</li>`).join('')}</ul>`
      : '';
    globalNotice(`<strong>${esc(i18n.t('err.title'))}</strong>${esc(headline)}${list}`, 'danger');
    const firstBad = $('[data-invalid="true"]');
    if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // =========================================================== selection row

  function renderSelects() {
    const cfg = state.config;
    if (!cfg) return;

    $('#sel-language').value = state.draft.language;

    $('#sel-office').innerHTML = `<option value="">${esc(i18n.t('office.placeholder'))}</option>${
      cfg.salesOffices.map((o) => `<option value="${esc(o.id)}" ${
        state.draft.salesOfficeId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}`;

    $('#sel-type').innerHTML = `<option value="">${esc(i18n.t('type.placeholder'))}</option>${
      cfg.visitorTypes.map((t) => `<option value="${esc(t)}" ${
        state.draft.visitorType === t ? 'selected' : ''}>${esc(i18n.t(`type.${t}`))}</option>`).join('')}`;

    renderSelectHints();
  }

  /** Address and hours (§IV), and what the chosen role is for (§V). */
  function renderSelectHints() {
    const office = state.config.salesOffices.find((o) => o.id === state.draft.salesOfficeId);
    // Address, hours and contact are shown on the success screen only.
    $('#office-detail').textContent = '';

    const type = state.draft.visitorType;
    $('#type-detail').textContent = type ? i18n.t(`type.${type}.desc`) : '';
  }

  function bindSelects() {
    $('#sel-language').addEventListener('change', (e) => {
      state.draft.language = e.target.value;
      i18n.set(e.target.value);
    });
    $('#sel-office').addEventListener('change', async (e) => {
      state.draft.salesOfficeId = e.target.value;
      state.availability = [];              // availability is per office
      setFieldError('salesOfficeId', '');
      dismissNoticeWhenClean();
      renderSelectHints();
      await loadAvailability();
    });
    $('#sel-type').addEventListener('change', async (e) => {
      state.draft.visitorType = e.target.value;
      setFieldError('visitorType', '');
      dismissNoticeWhenClean();
      renderSelectHints();
      await revealRoleForm();
    });
  }

  // ============================================================== role form

  /**
   * §V — the chosen role decides which form appears. Selecting a role builds that
   * role's fields in place; clearing it hides the form again.
   */
  async function revealRoleForm() {
    const form = $('#role-form');
    const isVisitor = state.draft.visitorType === 'VISITOR';

    if (!state.draft.visitorType) {
      form.classList.add('hidden');
      updateStaffShortcut();
      return;
    }

    $('#form-title').textContent = i18n.t(isVisitor ? 'form.visitor.title' : 'form.agency.title');
    $('#submit-btn').textContent = i18n.t(isVisitor ? 'btn.submit' : 'btn.submitAgency');
    renderRoleFields();
    renderDateField();

    form.classList.remove('hidden');
    form.style.animation = 'none';
    void form.offsetWidth;                  // restart the reveal animation
    form.style.animation = '';
    updateStaffShortcut();

    await loadAvailability();
  }

  function field(name, labelKey, opts) {
    const o = opts || {};
    return `
      <div class="field ${o.span ? 'span-2' : ''}" data-field="${name}">
        <label for="f-${name}">${esc(i18n.t(labelKey))}${
          o.required ? '<span class="field__req"> *</span>'
            : ` <span class="field__opt">${esc(i18n.t('f.optional'))}</span>`}</label>
        <input id="f-${name}" name="${name}" type="${o.type || 'text'}"
               ${o.inputmode ? `inputmode="${o.inputmode}"` : ''}
               ${o.maxlength ? `maxlength="${o.maxlength}"` : ''}
               ${o.placeholder ? `placeholder="${esc(i18n.t(o.placeholder))}"` : ''}
               value="${esc(state.draft[name] ?? '')}"
               autocomplete="${o.autocomplete || 'off'}">
        ${o.helpKey ? `<div class="field__help">${esc(i18n.t(o.helpKey))}</div>` : ''}
        <div class="field__error" data-error-for="${name}"></div>
      </div>`;
  }

  /** §VI for a visitor; §XI–§XIII for an agency. Two fields per row. */
  function renderRoleFields() {
    const isVisitor = state.draft.visitorType === 'VISITOR';
    const box = $('#role-fields');

    if (isVisitor) {
      box.innerHTML = `<div class="form-grid">
        ${field('fullName', 'f.fullName', { required: true, autocomplete: 'name' })}
        ${field('cccd', 'f.cccd', { required: true, inputmode: 'numeric', maxlength: 12 })}
        ${field('phone', 'f.phone', { required: true, type: 'tel', inputmode: 'tel', maxlength: 15 })}
        ${field('email', 'f.email', { type: 'email', autocomplete: 'email' })}
      </div>`;
    } else {
      const agencies = state.config.agencies;
      box.innerHTML = `<div class="form-grid">
        <div class="field span-2" data-field="agencyId">
          <label for="f-agencyId">${esc(i18n.t('f.agency'))}<span class="field__req"> *</span></label>
          <input id="agency-search" type="search" placeholder="${esc(i18n.t('f.agency.search'))}"
                 style="margin-bottom:.6rem">
          <select id="f-agencyId" name="agencyId"></select>
          <div class="field__error" data-error-for="agencyId"></div>
        </div>

        <div class="field span-2 hidden" data-field="agencyName" id="agency-other-field">
          <label for="f-agencyName">${esc(i18n.t('f.agencyOther'))}<span class="field__req"> *</span></label>
          <input id="f-agencyName" name="agencyName" type="text" maxlength="120"
                 placeholder="${esc(i18n.t('f.agencyOther.ph'))}"
                 value="${esc(state.draft.agencyName ?? '')}" autocomplete="off">
          <div class="field__help">${esc(i18n.t('f.agencyOther.help'))}</div>
          <div class="field__error" data-error-for="agencyName"></div>
        </div>

        <div class="form-section">${esc(i18n.t('f.section.staff'))}</div>
        ${field('salesStaffName', 'f.salesStaffName', { required: true })}
        ${field('salesStaffCccd', 'f.salesStaffCccd', { required: true, inputmode: 'numeric', maxlength: 12 })}
        ${field('salesStaffPhone', 'f.salesStaffPhone', { required: true, type: 'tel', inputmode: 'tel', maxlength: 15, span: true })}

        <div class="form-section">${esc(i18n.t('f.section.customer'))}</div>
        ${field('customerShortName', 'f.customerShortName', { required: true, placeholder: 'f.ph.shortName' })}
        ${field('customerPhoneLast4', 'f.customerPhoneLast4', { required: true, inputmode: 'numeric', maxlength: 4, placeholder: 'f.ph.last4' })}
      </div>`;

      renderAgencyOptions(agencies);
      $('#agency-search').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        // "Khác" always stays reachable: it is the way out when the search finds
        // nothing, which is exactly when someone needs it.
        renderAgencyOptions(agencies.filter(
          (a) => a.allowsCustomName || a.name.toLowerCase().includes(q)));
      });
      $('#f-agencyId').addEventListener('change', toggleAgencyOther);
      toggleAgencyOther();
    }

    // Every keystroke goes into the draft, so nothing is lost switching role.
    $$('#role-fields input, #role-fields select').forEach((el) => {
      if (el.id === 'agency-search') return;
      el.addEventListener('input', () => {
        state.draft[el.name] = el.value;
        setFieldError(el.name, '');
        dismissNoticeWhenClean();
      });
      el.addEventListener('change', () => {
        state.draft[el.name] = el.value;
        setFieldError(el.name, '');
        dismissNoticeWhenClean();
      });
    });
  }

  /** §XXII — picking "Khác" asks for the agency's name instead. */
  function isOtherAgency(id) {
    const agency = (state.config.agencies || []).find((a) => a.id === id);
    return Boolean(agency && agency.allowsCustomName);
  }

  function toggleAgencyOther() {
    const box = $('#agency-other-field');
    if (!box) return;
    const show = isOtherAgency(state.draft.agencyId);
    box.classList.toggle('hidden', !show);
    if (show) $('#f-agencyName').focus();
    else setFieldError('agencyName', '');
  }

  function renderAgencyOptions(list) {
    $('#f-agencyId').innerHTML = `<option value="">${esc(i18n.t('f.agency.placeholder'))}</option>${
      list.map((a) => `<option value="${esc(a.id)}" ${
        state.draft.agencyId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}`;
  }

  // ------------------------------------------------- date, slot, availability

  /** §VII — the picker itself is limited to the booking window, and so is the API. */
  function renderDateField() {
    const dates = state.config.selectableDates;
    const input = $('#f-visitDate');
    input.min = dates[0];
    input.max = dates[dates.length - 1];
    if (!state.draft.visitDate) state.draft.visitDate = dates[0];
    input.value = state.draft.visitDate;

    $('#visit-window').textContent = i18n.t('visit.window', {
      days: state.config.rules.maxAdvanceDays,
      from: fmtDate(dates[0]),
      to: fmtDate(dates[dates.length - 1]),
    });
  }

  async function loadAvailability() {
    const { salesOfficeId, visitDate } = state.draft;
    if (!salesOfficeId || !visitDate || !state.draft.visitorType) { renderSlotOptions(); return; }
    const sel = $('#f-timeSlot');
    if (sel) sel.innerHTML = `<option>${esc(i18n.t('visit.loadingSlots'))}</option>`;
    try {
      const data = await api(`/api/availability?salesOfficeId=${encodeURIComponent(salesOfficeId)}&visitDate=${encodeURIComponent(visitDate)}`);
      state.availability = data.slots;
    } catch {
      state.availability = [];
      globalNotice(esc(i18n.t('err.network')), 'danger');
    }
    renderSlotOptions();
  }

  /**
   * §VIII — each slot shows how many places are left. A slot that is full, or that
   * cannot fit this party, cannot be chosen; the backend refuses it as well.
   */
  function renderSlotOptions() {
    const sel = $('#f-timeSlot');
    if (!sel) return;
    if (!state.availability.length) {
      sel.innerHTML = `<option value="">${esc(i18n.t('visit.slotPlaceholder'))}</option>`;
      return;
    }
    const need = Number(state.draft.numberOfVisitors) || 1;
    sel.innerHTML = `<option value="">${esc(i18n.t('visit.slotPlaceholder'))}</option>${
      state.availability.map((s) => {
        const unavailable = s.passed || s.blocked || s.fullyBooked || s.remaining < need;
        // "Closed" and "fully booked" are different answers: one sends the
        // visitor to another date, the other to another time on the same day.
        let suffix;
        if (s.passed) suffix = i18n.t('visit.passed');
        else if (s.blocked) suffix = s.blockReason || i18n.t('visit.closed');
        else if (s.fullyBooked) suffix = i18n.t('visit.fullyBooked');
        else suffix = i18n.t('visit.remaining', { n: s.remaining });
        return `<option value="${esc(s.slotId)}" ${unavailable ? 'disabled' : ''} ${
          s.passed ? 'class="slot--passed"' : ''} ${
          state.draft.timeSlotId === s.slotId ? 'selected' : ''}>${esc(s.label)} — ${esc(suffix)}</option>`;
      }).join('')}`;

    // Every slot closed means the whole day is shut; say so once, under the field.
    const allBlocked = state.availability.length > 0 && state.availability.every((s) => s.blocked);
    const dayNote = $('#visit-window');
    if (dayNote) {
      dayNote.classList.toggle('field__help--warn', allBlocked);
      if (allBlocked) {
        const reason = (state.availability.find((s) => s.blockReason) || {}).blockReason;
        dayNote.textContent = reason
          ? i18n.t('visit.dayClosedReason', { reason })
          : i18n.t('visit.dayClosed');
      }
    }

    // A slot chosen earlier may have filled up, or no longer fit the party size.
    if (state.draft.timeSlotId && sel.value !== state.draft.timeSlotId) {
      state.draft.timeSlotId = '';
      sel.value = '';
    }
  }

  function bindVisitPanel() {
    $('#f-visitDate').addEventListener('change', async (e) => {
      state.draft.visitDate = e.target.value;
      setFieldError('visitDate', '');
      dismissNoticeWhenClean();
      await loadAvailability();
    });
    $('#f-timeSlot').addEventListener('change', (e) => {
      state.draft.timeSlotId = e.target.value;
      setFieldError('timeSlotId', '');
      dismissNoticeWhenClean();
    });
    $('#f-numberOfVisitors').addEventListener('input', (e) => {
      state.draft.numberOfVisitors = e.target.value;
      setFieldError('numberOfVisitors', '');
      dismissNoticeWhenClean();
      renderSlotOptions();               // a bigger party may no longer fit
    });
    $('#notes').addEventListener('input', (e) => { state.draft.notes = e.target.value; });
  }

  // ================================================================ validation

  /** Client-side pre-check only; the backend stays authoritative (§Rule 4). */
  function validatePage() {
    clearAllFieldErrors();
    const d = state.draft;
    let ok = true;
    const flag = (f, msgKey) => { setFieldError(f, i18n.t(msgKey)); ok = false; };

    if (!d.salesOfficeId) flag('salesOfficeId', 'err.selectOffice');
    if (!d.visitorType) flag('visitorType', 'err.selectType');
    if (!ok) {
      globalNotice(esc(i18n.t('err.fixFields')), 'danger');
      return false;
    }

    const required = d.visitorType === 'VISITOR'
      ? ['fullName', 'cccd', 'phone']
      : ['agencyId', 'salesStaffName', 'salesStaffCccd', 'salesStaffPhone',
        'customerShortName', 'customerPhoneLast4'];
    if (d.visitorType === 'AGENCY' && isOtherAgency(d.agencyId)) required.push('agencyName');
    required.forEach((f) => { if (!String(d[f] ?? '').trim()) flag(f, 'err.required'); });

    if (!Number(d.numberOfVisitors) || Number(d.numberOfVisitors) < 1) {
      flag('numberOfVisitors', 'err.required');
    }
    if (!d.visitDate) flag('visitDate', 'err.selectDate');
    if (!d.timeSlotId) flag('timeSlotId', 'err.selectSlot');

    if (!ok) {
      globalNotice(esc(i18n.t('err.fixFields')), 'danger');
      const firstBad = $('[data-invalid="true"]');
      if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return ok;
  }

  // ==================================================================== modals

  function openModal(id) {
    $(id).classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    $(id).classList.remove('show');
    document.body.style.overflow = '';
  }

  const kv = (k, v) => `<div class="kv"><span class="kv__k">${esc(k)}</span><span class="kv__v">${esc(v)}</span></div>`;
  const group = (title, rows) => `<div class="review__group">${
    title ? `<h4>${esc(title)}</h4>` : ''}${rows.join('')}</div>`;

  // ==================================================================== submit

  async function submit() {
    if (state.submitting) return;
    state.submitting = true;
    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(i18n.t('btn.submitting'))}`;
    clearGlobalNotice();

    const d = state.draft;
    const payload = {
      language: d.language,
      salesOfficeId: d.salesOfficeId,
      visitorType: d.visitorType,
      visitDate: d.visitDate,
      timeSlotId: d.timeSlotId,
      numberOfVisitors: Number(d.numberOfVisitors),
      notes: d.notes || null,
    };
    if (d.visitorType === 'VISITOR') {
      Object.assign(payload, { fullName: d.fullName, cccd: d.cccd, phone: d.phone, email: d.email || null });
    } else {
      Object.assign(payload, {
        agencyId: d.agencyId,
        // Only meaningful for "Khác"; the backend ignores it otherwise.
        agencyName: isOtherAgency(d.agencyId) ? d.agencyName : null,
        salesStaffName: d.salesStaffName,
        salesStaffCccd: d.salesStaffCccd,
        salesStaffPhone: d.salesStaffPhone,
        customerShortName: d.customerShortName,
        customerPhoneLast4: d.customerPhoneLast4,
      });
    }

    try {
      state.result = await api('/api/registrations', { method: 'POST', body: JSON.stringify(payload) });
      renderSuccess();
      openModal('#success-modal');
    } catch (err) {
      if (err.code === 'VALIDATION_FAILED') applyServerErrors(err);
      else {
        const key = `server.${err.code}`;
        const localized = i18n.t(key);
        globalNotice(`<strong>${esc(i18n.t('err.title'))}</strong>${
          esc(localized === key ? (err.message || i18n.t('err.network')) : localized)}`, 'danger');
        if (err.code === 'TIME_SLOT_FULLY_BOOKED' || err.code === 'TIME_SLOT_INSUFFICIENT_CAPACITY') {
          state.draft.timeSlotId = '';
          await loadAvailability();
          setFieldError('timeSlotId', i18n.t('err.slotFull'));
        }
        $('#global-notice').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } finally {
      state.submitting = false;
      btn.disabled = false;
      btn.textContent = i18n.t(
        state.draft.visitorType === 'VISITOR' ? 'btn.submit' : 'btn.submitAgency');
    }
  }

  function renderSuccess() {
    const r = state.result;
    $('#success-code').textContent = r.confirmationCode;
    $('#success-qr').src = r.qrImageUrl;
    $('#success-qr').alt = `QR ${r.confirmationCode}`;
    const s = r.summary;
    $('#success-summary').innerHTML = group('', [
      kv(s.visitorType === 'VISITOR' ? i18n.t('f.fullName') : i18n.t('f.agency'), s.displayName),
      kv(i18n.t('review.office'), s.salesOffice.name),
      kv(i18n.t('visit.dateLabel'), fmtDate(s.visitDate)),
      kv(i18n.t('visit.slotLabel'), s.timeSlot.label),
      kv(i18n.t('f.guests'), `${s.numberOfVisitors} ${i18n.t('unit.people')}`),
    ]);
    const office = state.config.salesOffices.find((o) => o.id === s.salesOffice.id)
      || state.config.salesOffices.find((o) => o.id === state.draft.salesOfficeId);
    $('#success-office').innerHTML = office
      ? `${esc(office.address)}<br>${esc(i18n.t('office.hours'))}: ${esc(office.openingHours)}
         &nbsp;·&nbsp; ${esc(i18n.t('office.contact'))}: ${esc(office.contact)}`
      : '';
  }

  // ----------------------------------------------------------------- bootstrap

  /** The staff shortcut belongs to the empty page, before a form is open. */
  function updateStaffShortcut() {
    const link = $('#staff-access');
    if (link) link.classList.toggle('hidden', Boolean(state.draft.visitorType));
  }

  function bindActions() {
    $('#registration-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!validatePage()) return;
      submit();
    });

    $('#qr-print').addEventListener('click', () => window.print());
    $('#qr-download').addEventListener('click', async () => {
      const res = await fetch(state.result.qrImageUrl);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ONE-ERA-${state.result.confirmationCode}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('#go-home').addEventListener('click', () => window.location.reload());
  }

  async function boot() {
    applyStaticText();
    try {
      state.config = await api('/api/config');
    } catch {
      globalNotice(esc(i18n.t('err.network')), 'danger');
      return;
    }

    i18n.onChange(async () => {
      applyStaticText();
      renderSelects();
      if (state.draft.visitorType) {
        $('#form-title').textContent = i18n.t(
          state.draft.visitorType === 'VISITOR' ? 'form.visitor.title' : 'form.agency.title');
        $('#submit-btn').textContent = i18n.t(
          state.draft.visitorType === 'VISITOR' ? 'btn.submit' : 'btn.submitAgency');
        renderRoleFields();
        renderDateField();
        renderSlotOptions();
      }
    });

    renderSelects();
    bindSelects();
    bindVisitPanel();
    bindActions();
    bindGuide();
    updateStaffShortcut();
  }

  document.addEventListener('DOMContentLoaded', boot);
}());
