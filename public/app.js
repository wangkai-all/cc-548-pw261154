'use strict';

const STATUS_LABELS = {
  MATCHED: '已对单',
  PENDING_MATCH: '待处理',
  BACKFILL_REQUESTED: '已请求补登记',
  DUPLICATE: '重复回执',
  RETURNED: '已退回',
  WAITING_RECEIPT: '待回执',
  REVOKED: '已撤销',
};

const STATUS_PILL = {
  MATCHED: 'pill-matched',
  PENDING_MATCH: 'pill-pending',
  BACKFILL_REQUESTED: 'pill-backfill',
  DUPLICATE: 'pill-duplicate',
  RETURNED: 'pill-returned',
  WAITING_RECEIPT: 'pill-waiting',
  REVOKED: 'pill-revoked',
};

const COUNTER_LABELS = {
  matchedSamples: '已对单样本',
  pendingReports: '待处理回执',
  backfillRequested: '已请求补登记',
  duplicateReports: '重复回执',
  returnedReports: '已退回回执',
  waitingRegistrations: '待回执登记',
  matchedRegistrations: '已对单登记',
  activeRegistrations: '有效登记',
  revokedRegistrations: '已撤销登记',
  registrations: '登记总数',
  reports: '回执总数',
};

const ACTION_LABELS = {
  RECEIVE_REPORT: '接收回执',
  REGISTER_SAMPLE: '建立登记',
  REVOKE_REGISTRATION: '撤销登记',
  RESTORE_REGISTRATION: '恢复登记',
  REQUEST_BACKFILL: '请求补登记',
  RETURN_REPORT: '退回回执',
  VIEW_RECONCILIATION: '查看对单',
  RESET_DEMO: '恢复演示数据',
};

const state = {
  board: null,
  view: 'board',
  filter: '',
  evidence: null,
  trail: [],
  lastChangeKeys: new Set(),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function esc(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function pill(status) {
  const cls = STATUS_PILL[status] || 'pill-neutral';
  return `<span class="pill ${cls}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function fmtClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: { code: 'BAD_RESPONSE', message: '服务返回内容无法解析' } };
  }
  return { status: response.status, payload };
}

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('is-visible'), 4200);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderStats(counts) {
  const items = [
    {
      label: '已对单样本',
      value: counts.matchedSamples,
      foot: '结论已汇入抽样看板',
      accent: 'var(--teal)',
    },
    {
      label: '待处理回执',
      value: counts.pendingReports,
      foot: `其中 ${counts.backfillRequested} 份已请求补登记`,
      accent: 'var(--amber)',
    },
    {
      label: '重复回执',
      value: counts.duplicateReports,
      foot: '不计入新增样本',
      accent: 'var(--slate)',
    },
    {
      label: '待回执登记',
      value: counts.waitingRegistrations,
      foot: `${counts.matchedRegistrations} 份登记已对单`,
      accent: 'var(--blue)',
    },
    {
      label: '已撤销登记',
      value: counts.revokedRegistrations,
      foot: `${counts.registrations} 份登记 · ${counts.reports} 份回执`,
      accent: 'var(--rose)',
    },
  ];
  const cards = items
    .map(
      (item) => `
      <div class="stat" style="--accent:${item.accent}">
        <div class="stat-label">${esc(item.label)}</div>
        <div class="stat-value">${item.value}</div>
        <div class="stat-foot">${esc(item.foot)}</div>
      </div>`,
    )
    .join('');
  $('#stat-strip').innerHTML = cards;
}

function sampleRowHtml(sample, changed) {
  const reg = sample.registrationId
    ? `<span class="mono">${esc(sample.registrationId)}</span><span class="sample-sub">${pill(
        sample.registrationStatus,
      )}</span>`
    : '<span class="muted">未登记</span>';
  const report = sample.reportId
    ? `<span class="mono">${esc(sample.reportId)}</span><span class="sample-sub">${pill(
        sample.reportStatus,
      )}</span>`
    : '<span class="muted">无回执</span>';

  const notes = [];
  if (sample.reportStatus === 'DUPLICATE') notes.push('重复回执未计数');
  if (sample.reportStatus === 'PENDING_MATCH') notes.push('等待补登记');
  if (sample.reportStatus === 'BACKFILL_REQUESTED') notes.push('已请求补登记');
  if (sample.reportStatus === 'RETURNED') notes.push('回执已人工退回');
  if (sample.registrationStatus === 'REVOKED') notes.push('登记已撤销');
  if (!sample.registrationId && sample.reportId) notes.push('孤立回执');

  const flash =
    changed.has(`registration:${sample.registrationId}`) ||
    changed.has(`report:${sample.reportId}`)
      ? ' class="flash"'
      : '';

  return `
    <tr${flash}>
      <td class="sample-no">${esc(sample.sampleNo)}${
        sample.receipts > 1
          ? `<span class="sample-sub">收信 ${sample.receipts} 次 · 重复 ${sample.duplicates} 份</span>`
          : ''
      }</td>
      <td>${reg}</td>
      <td>${report}</td>
      <td>${sample.result ? esc(sample.result) : '<span class="muted">—</span>'}</td>
      <td class="nowrap mono">${fmtTime(sample.lastReceivedAt)}</td>
      <td class="muted">${notes.join(' · ') || '—'}</td>
    </tr>`;
}

function noteChipClass(note) {
  if (/撤销|退回|重复/.test(note)) return 'note-chip is-alert';
  if (/已对单/.test(note)) return 'note-chip is-good';
  return 'note-chip';
}

function renderBoard(reconciliation) {
  const host = $('#reconciliation');
  $('#reconcile-stamp').textContent = reconciliation.generatedAt
    ? `对单快照 ${fmtClock(reconciliation.generatedAt)}${
        state.filter ? ` · ${state.filter}` : ''
      }`
    : '—';

  const factories = state.filter
    ? reconciliation.factories.filter((group) => group.factory === state.filter)
    : reconciliation.factories;

  if (!factories.length) {
    host.innerHTML = `
      <div class="board-empty">
        <strong>当前筛选范围内没有对单数据</strong>
        可点击「接收早到回执」录入一份本地样例，或清空工厂筛选。
      </div>`;
    return;
  }

  // 汇总口径始终以筛选范围为准，避免子项相加与顶部计数对不上。
  const totals = factories.reduce(
    (acc, group) => {
      acc.matchedSamples += group.matchedSamples;
      acc.pendingReports += group.pendingReports;
      acc.duplicateReports += group.duplicateReports;
      acc.waitingRegistrations += group.waitingRegistrations;
      acc.revokedRegistrations += group.revokedRegistrations;
      acc.samples += group.batches.reduce((sum, batch) => sum + batch.samples.length, 0);
      return acc;
    },
    {
      matchedSamples: 0,
      pendingReports: 0,
      duplicateReports: 0,
      waitingRegistrations: 0,
      revokedRegistrations: 0,
      samples: 0,
    },
  );

  const summaryBar = `
    <div class="summary-bar">
      <span class="summary-title">${state.filter ? esc(state.filter) : '全部工厂'}</span>
      <span class="summary-item">对单样本 <b>${totals.samples}</b> 个</span>
      <span class="summary-item">已对单 <b>${totals.matchedSamples}</b></span>
      <span class="summary-item">待处理回执 <b>${totals.pendingReports}</b></span>
      <span class="summary-item">重复回执 <b>${totals.duplicateReports}</b></span>
      <span class="summary-item">待回执登记 <b>${totals.waitingRegistrations}</b></span>
      ${
        totals.revokedRegistrations
          ? `<span class="summary-item is-alert">已撤销登记 <b>${totals.revokedRegistrations}</b></span>`
          : ''
      }
    </div>`;

  const changed = state.lastChangeKeys;
  host.innerHTML =
    summaryBar +
    factories
    .map((group) => {
      const batchesHtml = group.batches
        .map((batch) => {
          const notesHtml = batch.notes.length
            ? batch.notes
                .map((note) => `<span class="${noteChipClass(note)}">${esc(note)}</span>`)
                .join('')
            : '<span class="note-chip">无异常</span>';
          const rows = batch.samples.length
            ? batch.samples.map((sample) => sampleRowHtml(sample, changed)).join('')
            : '<tr><td colspan="6" class="empty-inline">批次内没有样本</td></tr>';
          return `
            <div class="batch-block">
              <div class="batch-head">
                <span class="batch-name">批次 ${esc(batch.batch)}</span>
                <span class="batch-notes">${notesHtml}</span>
              </div>
              <div class="table-wrap">
                <table class="data compact">
                  <thead>
                    <tr>
                      <th>样本号</th>
                      <th>采样登记</th>
                      <th>回执</th>
                      <th>结论</th>
                      <th>最近收信</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            </div>`;
        })
        .join('');

      return `
        <div class="factory-card">
          <div class="factory-head">
            <span class="factory-name">${esc(group.factory)}</span>
            <span class="factory-meta">
              <span>已对单 <b>${group.matchedSamples}</b></span>
              <span>待处理回执 <b>${group.pendingReports}</b></span>
              <span>重复 <b>${group.duplicateReports}</b></span>
              <span>待回执登记 <b>${group.waitingRegistrations}</b></span>
              <span>已撤销 <b>${group.revokedRegistrations}</b></span>
            </span>
          </div>
          ${batchesHtml}
        </div>`;
    })
    .join('');
}

function reportActions(report) {
  const buttons = [];
  if (report.status === 'PENDING_MATCH' || report.status === 'BACKFILL_REQUESTED') {
    if (report.status !== 'BACKFILL_REQUESTED') {
      buttons.push(
        `<button class="btn btn-small btn-outline" type="button" data-action="backfill" data-id="${esc(
          report.id,
        )}">请求补登记</button>`,
      );
    }
    buttons.push(
      `<button class="btn btn-small btn-ghost" type="button" data-action="return-report" data-id="${esc(
        report.id,
      )}">确认退回</button>`,
    );
  }
  return `<span class="row-actions">${buttons.join('') || '<span class="muted">—</span>'}</span>`;
}

function renderReports(reports) {
  const host = $('#reports-list');
  const filtered = state.filter ? reports.filter((r) => r.factory === state.filter) : reports;
  $('#reports-count').textContent = `${filtered.length} 份`;

  if (!filtered.length) {
    host.innerHTML = `
      <div class="empty">
        <strong>暂无回执</strong>
        点击「接收早到回执」可录入本地样例；早到回执会先进入待处理队列。
      </div>`;
    return;
  }

  const rows = filtered
    .map((report) => {
      const flash = state.lastChangeKeys.has(`report:${report.id}`) ? ' class="flash"' : '';
      return `
        <tr${flash}>
          <td class="mono nowrap">${esc(report.id)}</td>
          <td>
            <span class="sample-no">${esc(report.sampleNo)}</span>
            <span class="sample-sub">${esc(report.factory)} · ${esc(report.batch)}</span>
          </td>
          <td>${esc(report.result)}</td>
          <td class="nowrap mono">${fmtTime(report.receivedAt)}</td>
          <td>${pill(report.status)}${
            report.duplicateOf
              ? `<span class="sample-sub">重复于 ${esc(report.duplicateOf)}</span>`
              : ''
          }${
            report.status === 'BACKFILL_REQUESTED' && report.backfill
              ? `<span class="sample-sub">${esc(report.backfill.note)}</span>`
              : ''
          }</td>
          <td>${
            report.registration
              ? `<span class="mono">${esc(report.registration.id)}</span><span class="sample-sub">${pill(
                  report.registration.status,
                )}</span>`
              : '<span class="muted">—</span>'
          }</td>
          <td>${reportActions(report)}</td>
        </tr>`;
    })
    .join('');

  host.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>回执号</th>
          <th>工厂 / 批次 / 样本号</th>
          <th>结论</th>
          <th>收信时间</th>
          <th>状态</th>
          <th>关联登记</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRegistrations(registrations) {
  const host = $('#registrations-list');
  const filtered = state.filter
    ? registrations.filter((registration) => registration.factory === state.filter)
    : registrations;

  if (!filtered.length) {
    host.innerHTML = `
      <div class="empty">
        <strong>暂无登记</strong>
        可在此登记新样本，用来认领同工厂、同批次的早到回执。
      </div>`;
    return;
  }

  const rows = filtered
    .map((registration) => {
      const flash = state.lastChangeKeys.has(`registration:${registration.id}`)
        ? ' class="flash"'
        : '';
      const canRevoke = registration.status !== 'REVOKED';
      return `
        <tr${flash}>
          <td class="mono nowrap">${esc(registration.id)}</td>
          <td>
            <span class="sample-no">${esc(registration.sampleNo)}</span>
            <span class="sample-sub">${esc(registration.factory)} · ${esc(registration.batch)}</span>
          </td>
          <td class="nowrap mono">${fmtTime(registration.registeredAt)}</td>
          <td>${pill(registration.status)}${
            registration.revokeReason
              ? `<span class="sample-sub">${esc(registration.revokeReason)}</span>`
              : ''
          }</td>
          <td>${
            registration.matchedReport
              ? `<span class="mono">${esc(registration.matchedReport.id)}</span><span class="sample-sub">${esc(
                  registration.matchedReport.result,
                )}</span>`
              : '<span class="muted">—</span>'
          }</td>
          <td>
            <span class="row-actions">
              ${
                canRevoke
                  ? `<button class="btn btn-small btn-danger-ghost" type="button" data-action="revoke" data-id="${esc(
                      registration.id,
                    )}">撤销</button>`
                  : `<button class="btn btn-small btn-outline" type="button" data-action="restore" data-id="${esc(
                      registration.id,
                    )}">恢复</button>`
              }
            </span>
          </td>
        </tr>`;
    })
    .join('');

  host.innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th>登记号</th>
          <th>工厂 / 批次 / 样本号</th>
          <th>采样时间</th>
          <th>状态</th>
          <th>关联回执</th>
          <th style="text-align:right">操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function pushTrail(evidence) {
  if (!evidence) return;
  const last = state.trail[state.trail.length - 1];
  if (last && last.at === evidence.at && last.action === evidence.action) return;
  state.trail.push({
    at: evidence.at,
    action: evidence.action,
    ok: evidence.ok,
    summary: evidence.summary,
  });
  if (state.trail.length > 12) state.trail.shift();
}

function renderTrail() {
  const trailHost = $('#trail-list');
  trailHost.innerHTML = state.trail.length
    ? state.trail
        .slice()
        .reverse()
        .map(
          (item, index) => `
          <li${index === 0 ? ' class="is-latest"' : ''}>
            <span class="trail-seq">${fmtClock(item.at)}</span>
            <span>${item.ok === false ? '⚠ ' : ''}${esc(item.summary)}</span>
          </li>`,
        )
        .join('')
    : '<li class="trail-empty">尚未进行业务操作。</li>';
}

function renderEvidence(evidence) {
  if (!evidence) return;
  state.evidence = evidence;
  pushTrail(evidence);
  const action = evidence.action || '—';
  $('#evidence-card').classList.toggle('is-error', evidence.ok === false);
  $('#evidence-action').textContent = ACTION_LABELS[action] || action;
  $('#evidence-summary').textContent = evidence.summary || '—';
  $('#evidence-time').textContent = evidence.at
    ? `记录于 ${evidence.at.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`
    : '';
  $('#evidence-json').textContent = JSON.stringify(evidence, null, 2);

  // 业务结果区同时暴露机器可读的前后计数，便于直接核对操作前后内容。
  const resultArea = $('#business-result');
  if (resultArea) {
    resultArea.dataset.evidenceAction = action;
    resultArea.dataset.evidenceOk = String(evidence.ok !== false);
    resultArea.dataset.evidenceBefore = JSON.stringify(evidence.before || {});
    resultArea.dataset.evidenceAfter = JSON.stringify(evidence.after || {});
    resultArea.dataset.evidenceChanges = JSON.stringify(evidence.changes || []);
  }

  const before = evidence.before || {};
  const after = evidence.after || {};
  const keys = Object.keys(COUNTER_LABELS);
  const changed = keys.filter((key) => (before[key] || 0) !== (after[key] || 0));
  const shown = changed.length
    ? changed
    : ['matchedSamples', 'pendingReports', 'duplicateReports'];

  if (!evidence.before || !evidence.after) {
    $('#counter-diff').innerHTML =
      '<div class="counter-row"><span class="counter-name">操作未生效，业务计数未变化</span></div>';
  } else {
    $('#counter-diff').innerHTML = shown
      .map((key) => {
        const from = before[key] === undefined ? '—' : before[key];
        const to = after[key] === undefined ? '—' : after[key];
        const delta = Number(after[key] || 0) - Number(before[key] || 0);
        const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'zero';
        const text = delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '±0';
        return `
        <div class="counter-row">
          <span class="counter-name">${esc(COUNTER_LABELS[key])}</span>
          <span class="counter-values">${esc(from)} → ${esc(to)}</span>
          <span class="delta ${cls}">${text}</span>
        </div>`;
      })
      .join('');
  }

  const changes = evidence.changes || [];
  $('#change-list').innerHTML = changes.length
    ? changes
        .map(
          (change) => `
          <li>
            <div class="change-top">
              <span class="change-entity">${change.entity === 'registration' ? '登记' : '回执'}</span>
              <span class="change-id">${esc(change.id)}</span>
              ${change.from ? `<span class="status-chip">${esc(STATUS_LABELS[change.from] || change.from)}</span>` : ''}
              <span class="status-chip">→</span>
              <span class="status-chip">${esc(STATUS_LABELS[change.to] || change.to)}</span>
            </div>
            <div class="change-note">${esc(change.note || '')}</div>
          </li>`,
        )
        .join('')
    : '<li><span class="change-note">本次操作未改变业务状态。</span></li>';

  renderTrail();
}

function renderCases() {
  if (!state.board) return;
  const reports = state.board.reports;
  const caseload = {
    early: reports.filter(
      (report) =>
        report.status === 'MATCHED' &&
        report.registration &&
        Date.parse(report.receivedAt) < Date.parse(report.registration.registeredAt),
    ).length,
    duplicate: reports.filter((report) => report.status === 'DUPLICATE').length,
    pending: reports.filter(
      (report) => report.status === 'PENDING_MATCH' || report.status === 'BACKFILL_REQUESTED',
    ).length,
    crossFactory: 0,
    revokedReturns: reports.filter((report) => report.statusReason === 'REGISTRATION_REVOKED')
      .length,
  };

  const factoriesOfSample = new Map();
  for (const report of reports) {
    const key = `${report.batch}\u0000${report.sampleNo.toLowerCase()}`;
    if (!factoriesOfSample.has(key)) factoriesOfSample.set(key, new Set());
    factoriesOfSample.get(key).add(report.factory);
  }
  for (const factories of factoriesOfSample.values()) {
    if (factories.size > 1) caseload.crossFactory += 1;
  }

  const items = [
    { label: '早于登记到达', value: caseload.early, cls: 'case-good' },
    { label: '重复回执未计数', value: caseload.duplicate, cls: 'case-warn' },
    { label: '待处理回执', value: caseload.pending, cls: 'case-warn' },
    { label: '跨厂同号样本', value: caseload.crossFactory, cls: 'case-info' },
    { label: '撤销后退回', value: caseload.revokedReturns, cls: 'case-bad' },
  ];
  $('#case-strip').innerHTML = items
    .map(
      (item) => `
      <div class="case ${item.cls}">
        <span class="case-value">${item.value}</span>
        <span class="case-label">${esc(item.label)}</span>
      </div>`,
    )
    .join('');
}

function renderAll() {
  if (!state.board) return;
  renderStats(state.board.counts);
  renderBoard(state.board.reconciliation);
  renderReports(state.board.reports);
  renderRegistrations(state.board.registrations);
  renderFilterOptions();
  renderCases();
  $('#board-clock').textContent = `本地演示数据 · 更新于 ${fmtClock(state.board.generatedAt)}`;
}

function renderFilterOptions() {
  const select = $('#factory-filter');
  // 工厂清单始终取自完整看板，避免筛选后下拉框丢失其它工厂。
  const factories = new Set();
  state.board.registrations.forEach((registration) => factories.add(registration.factory));
  state.board.reports.forEach((report) => factories.add(report.factory));
  const options = ['<option value="">全部工厂</option>']
    .concat(
      Array.from(factories)
        .sort((a, b) => a.localeCompare(b, 'zh-CN'))
        .map(
          (factory) =>
            `<option value="${esc(factory)}"${
              state.filter === factory ? ' selected' : ''
            }>${esc(factory)}</option>`,
        ),
    )
    .join('');
  const previous = select.value;
  select.innerHTML = options;
  const target = state.filter || (previous && factories.has(previous) ? previous : '');
  select.value = target;

  const datalist = $('#factory-options');
  if (datalist) {
    datalist.innerHTML = Array.from(factories)
      .map((factory) => `<option value="${esc(factory)}"></option>`)
      .join('');
  }
}

function applyChangeKeys(evidence) {
  state.lastChangeKeys = new Set(
    (evidence && evidence.changes ? evidence.changes : []).map(
      (change) => `${change.entity}:${change.id}`,
    ),
  );
}

function setView(view) {
  state.view = view;
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === view));
  $$('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== view;
  });
}

function showBoardView() {
  setView('board');
}

/* ------------------------------------------------------------------ */
/* 数据操作                                                            */
/* ------------------------------------------------------------------ */

async function loadBoard() {
  const { payload } = await api('/api/board');
  if (!payload || !payload.ok) {
    toast((payload && payload.error && payload.error.message) || '载入看板失败', true);
    return;
  }
  state.board = payload.board;
  renderAll();
}

async function viewReconciliation({ silent = false } = {}) {
  const query = state.filter ? `?factory=${encodeURIComponent(state.filter)}` : '';
  const { payload } = await api(`/api/reconciliation${query}`);
  if (!payload || !payload.ok) {
    toast((payload && payload.error && payload.error.message) || '查看对单失败', true);
    return null;
  }
  state.board.reconciliation = payload.reconciliation;
  showBoardView();
  applyChangeKeys(payload.evidence);
  renderBoard(payload.reconciliation);
  renderEvidence(payload.evidence);
  if (!silent) {
    toast(payload.evidence.summary);
  }
  return payload;
}

function handleWriteResult(result, { successMessage } = {}) {
  const { payload } = result;
  if (!payload) {
    toast('服务未返回结果', true);
    return { ok: false, message: '服务未返回结果' };
  }
  if (!payload.ok) {
    const message =
      (payload.error && payload.error.message) || `操作失败（HTTP ${result.status}）`;
    if (payload.evidence) {
      // 失败证据的 before/after 为空，页面会显示「操作未生效」；成功轨迹仍保留在会话轨迹里。
      renderEvidence(payload.evidence);
    }
    toast(message, true);
    return { ok: false, message };
  }
  state.board = payload.board;
  applyChangeKeys(payload.evidence);
  renderAll();
  renderEvidence(payload.evidence);
  const message = successMessage || payload.evidence.summary;
  toast(message);
  return { ok: true, payload };
}

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

let modalSubmit = null;

function openModal({ title, sub, templateId, submitLabel, onOpen, onSubmit }) {
  const dialog = $('#modal');
  const template = document.getElementById(templateId);
  const body = $('#modal-body');
  body.innerHTML = '';
  body.appendChild(template.content.cloneNode(true));
  $('#modal-title').textContent = title;
  $('#modal-sub').textContent = sub || '';
  $('#modal-submit').textContent = submitLabel || '确认';
  $('#modal-submit').disabled = false;
  $('#form-error').hidden = true;
  $('#form-error').textContent = '';
  modalSubmit = onSubmit;
  if (onOpen) onOpen(body);
  if (!dialog.open) dialog.showModal();
  const firstInput = body.querySelector('input');
  if (firstInput) firstInput.focus();
}

function closeModal() {
  const dialog = $('#modal');
  if (dialog.open) dialog.close();
  modalSubmit = null;
}

function formValues(form) {
  const data = new FormData(form);
  const values = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string' && value.trim() !== '') values[key] = value.trim();
  }
  return values;
}

function toIso(datetimeLocal) {
  if (!datetimeLocal) return undefined;
  const date = new Date(datetimeLocal);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/* ------------------------------------------------------------------ */
/* 具体操作                                                            */
/* ------------------------------------------------------------------ */

function receiveQuickPicks(body) {
  const picks = [
    {
      label: '早到孤立回执 · 华东一厂 / B-2405 / S-1005',
      data: {
        factory: '华东一厂',
        batch: 'B-2405',
        sampleNo: 'S-1005',
        result: '合格',
      },
    },
    {
      label: '重复投递 · 华东一厂 / B-2405 / S-1003',
      data: {
        factory: '华东一厂',
        batch: 'B-2405',
        sampleNo: 'S-1003',
        result: '待复检',
      },
    },
    {
      label: '跨厂同号隔离 · 华东一厂 / B-2405 / S-1009',
      data: {
        factory: '华东一厂',
        batch: 'B-2405',
        sampleNo: 'S-1009',
        result: '待复检',
      },
    },
    {
      label: '回执对单 · 华南二厂 / B-2405 / S-1002',
      data: {
        factory: '华南二厂',
        batch: 'B-2405',
        sampleNo: 'S-1002',
        result: '合格',
      },
    },
  ];
  const host = body.querySelector('#quick-picks');
  host.innerHTML = picks
    .map(
      (pick, index) =>
        `<button class="quick-pick" type="button" data-pick="${index}">${esc(pick.label)}</button>`,
    )
    .join('');
  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pick]');
    if (!button) return;
    const pick = picks[Number(button.dataset.pick)];
    const form = $('#modal-form');
    for (const [key, value] of Object.entries(pick.data)) {
      const input = form.elements.namedItem(key);
      if (input) input.value = value;
    }
  });
}

function openReceive() {
  openModal({
    title: '接收早到回执',
    sub: '来信先保存；能匹配到登记就立即对单，找不到登记则保留等待。',
    templateId: 'tpl-receive',
    submitLabel: '接收并保存',
    onOpen: receiveQuickPicks,
    onSubmit: async (values) => {
      const result = await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      const handled = handleWriteResult(result);
      if (!handled.ok) return handled;
      showBoardView();
      return handled;
    },
  });
}

function openRegister(prefill = {}) {
  openModal({
    title: '登记样本',
    sub: '登记建立时会自动认领同工厂、同批次、同样本号的早到回执。',
    templateId: 'tpl-register',
    submitLabel: '建立登记',
    onOpen: (body) => {
      const form = $('#modal-form');
      if (prefill.factory) form.elements.namedItem('factory').value = prefill.factory;
      if (prefill.batch) form.elements.namedItem('batch').value = prefill.batch;
      if (prefill.sampleNo) form.elements.namedItem('sampleNo').value = prefill.sampleNo;
      const hint = body.querySelector('#register-hint');
      const updateHint = () => {
        const factory = form.elements.namedItem('factory').value.trim().toLowerCase();
        const batch = form.elements.namedItem('batch').value.trim().toLowerCase();
        const sampleNo = form.elements.namedItem('sampleNo').value.trim().toLowerCase();
        const match = (state.board ? state.board.reports : []).find(
          (report) =>
            report.factory.toLowerCase() === factory &&
            report.batch.toLowerCase() === batch &&
            report.sampleNo.toLowerCase() === sampleNo &&
            (report.status === 'PENDING_MATCH' || report.status === 'BACKFILL_REQUESTED'),
        );
        hint.textContent = match
          ? `同键存在早到回执 ${match.id}（${STATUS_LABELS[match.status]}），登记后会立即对单。`
          : '同键暂无待处理回执，登记后将等待回执。';
      };
      ['factory', 'batch', 'sampleNo'].forEach((name) => {
        form.elements.namedItem(name).addEventListener('input', updateHint);
      });
      updateHint();
    },
    onSubmit: async (values) => {
      const result = await api('/api/registrations', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      return handleWriteResult(result);
    },
  });
}

function openRevoke(prefillId = null) {
  const active = (state.board ? state.board.registrations : []).filter(
    (registration) => registration.status !== 'REVOKED',
  );
  const ordered = active.slice().sort((a, b) => {
    const aMatched = a.status === 'MATCHED' ? 0 : 1;
    const bMatched = b.status === 'MATCHED' ? 0 : 1;
    return aMatched - bMatched || a.id.localeCompare(b.id);
  });

  openModal({
    title: '撤销一份登记',
    sub: '撤销后，与它已对单的回执会退回「待处理」，可被重新登记认领。',
    templateId: 'tpl-revoke',
    submitLabel: '确认撤销',
    onOpen: (body) => {
      const list = body.querySelector('#revoke-list');
      const hint = body.querySelector('#revoke-hint');
      const submit = $('#modal-submit');
      if (!ordered.length) {
        hint.textContent = '当前没有可撤销的有效登记。';
        list.innerHTML = '<div class="empty-inline">没有有效登记。</div>';
        submit.disabled = true;
        return;
      }
      hint.textContent = `共 ${ordered.length} 份有效登记；标记「已对单」的登记撤销后会触发回执退回。`;
      list.innerHTML = ordered
        .map((registration, index) => {
          const checked = prefillId
            ? registration.id === prefillId
            : index === 0;
          return `
            <label class="radio-item${registration.status === 'MATCHED' ? ' is-highlight' : ''}">
              <input type="radio" name="registrationId" value="${esc(registration.id)}"${
                checked ? ' checked' : ''
              } />
              <span class="radio-main">
                <span class="radio-title">
                  <span class="mono">${esc(registration.id)}</span>
                  <span class="sample-no">${esc(registration.sampleNo)}</span>
                  ${pill(registration.status)}
                </span>
                <span class="radio-sub">${esc(registration.factory)} · 批次 ${esc(
                  registration.batch,
                )} · 采样 ${fmtTime(registration.registeredAt)}${
                  registration.matchedReport
                    ? ` · 回执 ${esc(registration.matchedReport.id)}（${esc(
                        registration.matchedReport.result,
                      )}）`
                    : ' · 无匹配回执'
                }</span>
              </span>
            </label>`;
        })
        .join('');
    },
    onSubmit: async (values, form) => {
      const selected = form.querySelector('input[name="registrationId"]:checked');
      if (!selected) {
        return { ok: false, message: '请选择要撤销的登记' };
      }
      const result = await api(
        `/api/registrations/${encodeURIComponent(selected.value)}/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: values.reason }),
        },
      );
      const handled = handleWriteResult(result);
      if (handled.ok) showBoardView();
      return handled;
    },
  });
}

async function requestBackfill(reportId) {
  const report = state.board.reports.find((item) => item.id === reportId);
  if (!report) return;
  const note = window.prompt(
    `向采样端请求补登记：${report.factory} / ${report.batch} / ${report.sampleNo}`,
    '请补录该样本的采样登记',
  );
  if (note === null) return;
  const result = await api(`/api/reports/${encodeURIComponent(reportId)}/backfill`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
  handleWriteResult(result);
  setView('reports');
}

async function returnReport(reportId) {
  const report = state.board.reports.find((item) => item.id === reportId);
  if (!report) return;
  if (!window.confirm(`确认退回回执 ${report.id}（${report.sampleNo}）？退回后不再计入对单。`)) {
    return;
  }
  const result = await api(`/api/reports/${encodeURIComponent(reportId)}/return`, {
    method: 'POST',
    body: JSON.stringify({ reason: '人工确认不纳入本次抽样' }),
  });
  handleWriteResult(result);
  setView('reports');
}

async function restoreRegistration(registrationId) {
  const registration = state.board.registrations.find((item) => item.id === registrationId);
  if (!registration) return;
  if (
    !window.confirm(
      `恢复登记 ${registration.id}（${registration.factory} / ${registration.sampleNo}）？恢复后将重新认领待处理回执。`,
    )
  ) {
    return;
  }
  const result = await api(
    `/api/registrations/${encodeURIComponent(registrationId)}/restore`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  handleWriteResult(result);
  setView('registrations');
}

async function resetDemo() {
  if (!window.confirm('恢复本地演示数据？当前页面上的操作结果会被清空。')) return;
  const result = await api('/api/reset', { method: 'POST', body: '{}' });
  if (!result.payload || !result.payload.ok) {
    toast('恢复演示数据失败', true);
    return;
  }
  state.board = result.payload.board;
  state.filter = '';
  state.trail = [];
  state.evidence = null;
  state.lastChangeKeys = new Set();
  applyChangeKeys(result.payload.evidence);
  renderAll();
  renderEvidence(result.payload.evidence);
  showBoardView();
  toast(result.payload.evidence.summary);
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#btn-receive').addEventListener('click', openReceive);
  $('#btn-revoke').addEventListener('click', () => {
    setView('registrations');
    openRevoke();
  });
  $('#btn-reconcile').addEventListener('click', () => {
    // 查看抽样对单：重新拉取快照，证据区展示本次查看的证据。
    viewReconciliation();
  });
  $('#btn-register').addEventListener('click', () => openRegister());
  $('#btn-reset').addEventListener('click', resetDemo);

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.tab));
  });

  $('#factory-filter').addEventListener('change', async (event) => {
    state.filter = event.target.value;
    await viewReconciliation();
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'backfill') requestBackfill(id);
    if (action === 'return-report') returnReport(id);
    if (action === 'revoke') {
      setView('registrations');
      openRevoke(id);
    }
    if (action === 'restore') restoreRegistration(id);
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });

  const dialog = $('#modal');
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeModal();
  });

  const form = $('#modal-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!modalSubmit) return;
    const errorBox = $('#form-error');
    errorBox.hidden = true;
    const submit = $('#modal-submit');
    if (!form.reportValidity()) return;
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = '处理中…';
    try {
      const values = formValues(form);
      if (values.receivedAt) values.receivedAt = toIso(values.receivedAt);
      if (values.registeredAt) values.registeredAt = toIso(values.registeredAt);
      const result = await modalSubmit(values, form);
      if (result && result.ok) {
        closeModal();
      } else {
        errorBox.textContent = (result && result.message) || '操作失败';
        errorBox.hidden = false;
      }
    } catch (error) {
      errorBox.textContent = `操作失败：${error.message}`;
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  });
}

async function init() {
  bindEvents();
  await loadBoard();
  if (state.board) {
    await viewReconciliation({ silent: true });
  }
}

document.addEventListener('DOMContentLoaded', init);
