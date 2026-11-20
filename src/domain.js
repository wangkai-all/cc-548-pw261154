'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 抽样回执对单领域模型。
 *
 * 核心规则：
 * 1. 回执可能在登记之前到达，先存为孤立回执（PENDING_MATCH），不占样本数。
 * 2. 样本号只在 工厂 + 批次 内唯一，跨厂同号互不影响。
 * 3. 同一支样本的重复回执记为 DUPLICATE，不增加已对单样本数。
 * 4. 登记被撤销时，匹配到它的回执退回待处理（PENDING_MATCH），可被更正后的登记再次匹配。
 * 5. 所有写操作都返回 evidence：操作前后计数与逐条状态迁移，供页面核对。
 */

const CREDIT = Object.freeze({
  PENDING_MATCH: 'PENDING_MATCH',
  BACKFILL_REQUESTED: 'BACKFILL_REQUESTED',
  MATCHED: 'MATCHED',
  DUPLICATE: 'DUPLICATE',
  RETURNED: 'RETURNED',
});

const REGISTRATION = Object.freeze({
  WAITING_RECEIPT: 'WAITING_RECEIPT',
  MATCHED: 'MATCHED',
  REVOKED: 'REVOKED',
});

const REPORT_STATUSES = Object.freeze(Object.values(CREDIT));
const REGISTRATION_STATUSES = Object.freeze(Object.values(REGISTRATION));

const COUNTER_KEYS = Object.freeze([
  'registrations',
  'activeRegistrations',
  'revokedRegistrations',
  'matchedRegistrations',
  'waitingRegistrations',
  'reports',
  'matchedSamples',
  'pendingReports',
  'backfillRequested',
  'duplicateReports',
  'returnedReports',
]);

const MAX_TEXT = 80;
const MAX_RESULT = 120;
const MAX_NOTE = 300;
const MAX_MESSAGE_ID = 120;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createState() {
  return {
    registrations: [],
    reports: [],
    events: [],
    counters: { registration: 0, report: 0, event: 0 },
    seededAt: null,
  };
}

function normalizeKeyPart(value) {
  return value.trim().toLowerCase();
}

function sampleKey(factory, batch, sampleNo) {
  return [factory, batch, sampleNo].map(normalizeKeyPart).join('\u0000');
}

function sampleLabel(record) {
  return `${record.factory} / ${record.batch} / ${record.sampleNo}`;
}

function validationError(field, message) {
  return {
    ok: false,
    error: {
      code: 'VALIDATION_ERROR',
      field,
      message,
    },
  };
}

function conflictError(message, code = 'CONFLICT') {
  return { ok: false, error: { code, message } };
}

function notFoundError(message) {
  return { ok: false, error: { code: 'NOT_FOUND', message } };
}

function readText(input, field, { required = true, max = MAX_TEXT } = {}) {
  const raw = input ? input[field] : undefined;
  if (raw === undefined || raw === null) {
    if (required) return validationError(field, `${field} 不能为空`);
    return { ok: true, value: '' };
  }
  if (typeof raw !== 'string') {
    return validationError(field, `${field} 必须是字符串`);
  }
  const value = raw.trim();
  if (required && value === '') {
    return validationError(field, `${field} 不能为空`);
  }
  if (value.length > max) {
    return validationError(field, `${field} 不能超过 ${max} 个字符`);
  }
  return { ok: true, value };
}

function readTimestamp(input, field, fallback) {
  const raw = input ? input[field] : undefined;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: fallback, provided: false };
  }
  if (typeof raw !== 'string') {
    return validationError(field, `${field} 必须是 ISO 时间字符串`);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return validationError(field, `${field} 不是有效时间`);
  }
  return { ok: true, value: new Date(parsed).toISOString(), provided: true };
}

function readOptionalId(input, field) {
  const raw = input ? input[field] : undefined;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw.trim())) {
    return validationError(field, `${field} 只能包含字母、数字及 . _ : -，最长 64 位`);
  }
  return { ok: true, value: raw.trim() };
}

function readSampleFields(input) {
  const factory = readText(input, 'factory');
  if (!factory.ok) return factory;
  const batch = readText(input, 'batch');
  if (!batch.ok) return batch;
  const sampleNo = readText(input, 'sampleNo');
  if (!sampleNo.ok) return sampleNo;
  return {
    ok: true,
    factory: factory.value,
    batch: batch.value,
    sampleNo: sampleNo.value,
  };
}

function nextId(state, kind) {
  const key = kind === 'report' ? 'report' : 'registration';
  state.counters[key] += 1;
  const prefix = kind === 'report' ? 'LR' : 'REG';
  return `${prefix}-${String(state.counters[key]).padStart(4, '0')}`;
}

function pushHistory(record, entry) {
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push({ at: entry.at || nowIso(), ...entry });
  if (record.history.length > 20) {
    record.history.splice(0, record.history.length - 20);
  }
}

function recordEvent(state, action, summary, meta = {}) {
  state.counters.event += 1;
  state.events.push({
    seq: state.counters.event,
    at: nowIso(),
    action,
    summary,
    ...meta,
  });
  if (state.events.length > 200) {
    state.events.splice(0, state.events.length - 200);
  }
}

function findRegistration(state, id) {
  return state.registrations.find((registration) => registration.id === id) || null;
}

function findReport(state, id) {
  return state.reports.find((report) => report.id === id) || null;
}

function registrationStatus(registration) {
  if (registration.revokedAt) return REGISTRATION.REVOKED;
  if (registration.matchedReportId) return REGISTRATION.MATCHED;
  return REGISTRATION.WAITING_RECEIPT;
}

function countState(state) {
  const reports = state.reports;
  const registrations = state.registrations;
  const counts = {
    registrations: registrations.length,
    activeRegistrations: 0,
    revokedRegistrations: 0,
    matchedRegistrations: 0,
    waitingRegistrations: 0,
    reports: reports.length,
    matchedSamples: 0,
    pendingReports: 0,
    backfillRequested: 0,
    duplicateReports: 0,
    returnedReports: 0,
  };

  for (const registration of registrations) {
    if (registration.revokedAt) {
      counts.revokedRegistrations += 1;
    } else {
      counts.activeRegistrations += 1;
      if (registration.matchedReportId) counts.matchedRegistrations += 1;
      else counts.waitingRegistrations += 1;
    }
  }

  for (const report of reports) {
    switch (report.status) {
      case CREDIT.MATCHED:
        counts.matchedSamples += 1;
        break;
      case CREDIT.PENDING_MATCH:
        counts.pendingReports += 1;
        break;
      case CREDIT.BACKFILL_REQUESTED:
        counts.pendingReports += 1;
        counts.backfillRequested += 1;
        break;
      case CREDIT.DUPLICATE:
        counts.duplicateReports += 1;
        break;
      case CREDIT.RETURNED:
        counts.returnedReports += 1;
        break;
      default:
        break;
    }
  }

  return counts;
}

function emptyCounts() {
  const counts = {};
  for (const key of COUNTER_KEYS) counts[key] = 0;
  return counts;
}

function makeEvidence(action, summary, { changes = [], before, after, entities = {}, deduped = false } = {}) {
  const beforeCounts = before ? clone(before) : null;
  const afterCounts = after ? clone(after) : null;
  return {
    action,
    ok: true,
    summary,
    deduped,
    changes: changes.map((change) => ({ ...change })),
    before: beforeCounts,
    after: afterCounts,
    entities: clone(entities),
    at: nowIso(),
  };
}

function failure(action, result) {
  return {
    ok: false,
    error: result.error,
    evidence: {
      action,
      ok: false,
      summary: result.error.message,
      error: clone(result.error),
      changes: [],
      before: null,
      after: null,
      entities: {},
      at: nowIso(),
    },
  };
}

function activeRegistrationsForKey(state, key, { excludeId = null } = {}) {
  return state.registrations
    .filter(
      (registration) =>
        registration.key === key &&
        !registration.revokedAt &&
        (!excludeId || registration.id !== excludeId),
    )
    .sort((a, b) => {
      const delta = Date.parse(a.registeredAt) - Date.parse(b.registeredAt);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
}

function waitingReportsForKey(state, key) {
  return state.reports
    .filter(
      (report) =>
        report.key === key &&
        (report.status === CREDIT.PENDING_MATCH || report.status === CREDIT.BACKFILL_REQUESTED),
    )
    .sort((a, b) => {
      const delta = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
}

function attachReport(registration, report, at) {
  const from = report.status;
  report.status = CREDIT.MATCHED;
  report.statusReason = null;
  report.matchedRegId = registration.id;
  report.matchedAt = at;
  report.returnedFromRegId = null;
  registration.matchedReportId = report.id;
  registration.matchedAt = at;
  pushHistory(report, {
    at,
    action: 'MATCHED',
    from,
    to: CREDIT.MATCHED,
    note: `匹配登记 ${registration.id}`,
  });
  pushHistory(registration, {
    at,
    action: 'MATCHED',
    from: REGISTRATION.WAITING_RECEIPT,
    to: REGISTRATION.MATCHED,
    note: `匹配回执 ${report.id}`,
  });
}

/**
 * 尝试把一份回执匹配到同工厂、同批次的等待登记。
 * 已撤销的登记不会被匹配。
 */
function matchPendingReport(state, report, at) {
  const candidates = activeRegistrationsForKey(state, report.key).filter(
    (registration) => !registration.matchedReportId,
  );
  const registration = candidates[0];
  if (!registration) return null;
  attachReport(registration, report, at);
  return registration;
}

function receiveLabReport(state, input = {}) {
  const action = 'RECEIVE_REPORT';
  const sample = readSampleFields(input);
  if (!sample.ok) return failure(action, sample);

  const result = readText(input, 'result', { max: MAX_RESULT });
  if (!result.ok) return failure(action, result);

  const messageId = readText(input, 'messageId', { required: false, max: MAX_MESSAGE_ID });
  if (!messageId.ok) return failure(action, messageId);

  const explicitId = readOptionalId(input, 'id');
  if (!explicitId.ok) return failure(action, explicitId);

  const timestamp = readTimestamp(input, 'receivedAt', nowIso());
  if (!timestamp.ok) return failure(action, timestamp);

  const at = nowIso();

  if (messageId.value) {
    const existing = state.reports.find((report) => report.messageId === messageId.value);
    if (existing) {
      const counts = countState(state);
      return {
        ok: true,
        deduped: true,
        report: clone(existing),
        evidence: makeEvidence(
          action,
          `消息 ${messageId.value} 已接收过，沿用回执 ${existing.id}，未新增记录`,
          {
            before: counts,
            after: counts,
            deduped: true,
            entities: { report: clone(existing) },
          },
        ),
      };
    }
  }

  if (explicitId.value && findReport(state, explicitId.value)) {
    return failure(
      action,
      conflictError(`回执编号 ${explicitId.value} 已存在`, 'DUPLICATE_ID'),
    );
  }

  const before = countState(state);
  const key = sampleKey(sample.factory, sample.batch, sample.sampleNo);
  const sameSample = state.reports.filter(
    (report) =>
      report.key === key &&
      report.status !== CREDIT.RETURNED &&
      report.status !== CREDIT.DUPLICATE,
  );

  const report = {
    id: explicitId.value || nextId(state, 'report'),
    messageId: messageId.value || null,
    factory: sample.factory,
    batch: sample.batch,
    sampleNo: sample.sampleNo,
    key,
    result: result.value,
    receivedAt: timestamp.value,
    ingestedAt: at,
    status: CREDIT.PENDING_MATCH,
    statusReason: null,
    matchedRegId: null,
    matchedAt: null,
    duplicateOf: null,
    returnedFromRegId: null,
    backfill: null,
    history: [],
  };

  const changes = [];
  let matchedRegistration = null;
  let summary;

  if (sameSample.length > 0) {
    const canonical = sameSample.slice().sort((a, b) => {
      const delta = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    })[0];
    report.status = CREDIT.DUPLICATE;
    report.statusReason = 'DUPLICATE_RECEIPT';
    report.duplicateOf = canonical.id;
    report.matchedRegId = canonical.matchedRegId || null;
    changes.push({
      entity: 'report',
      id: report.id,
      from: null,
      to: CREDIT.DUPLICATE,
      note: `样本 ${sampleLabel(report)} 已有回执 ${canonical.id}，本回执不重复计数`,
    });
    summary = `回执 ${report.id} 已接收，但样本 ${sampleLabel(report)} 已有回执 ${canonical.id}，记为重复回执，样本数不增加`;
  } else {
    changes.push({
      entity: 'report',
      id: report.id,
      from: null,
      to: CREDIT.PENDING_MATCH,
      note: `样本 ${sampleLabel(report)} 暂无可用登记，先保存等待`,
    });
    matchedRegistration = matchPendingReport(state, report, at);
    if (matchedRegistration) {
      changes[0].to = CREDIT.MATCHED;
      changes[0].note = `按工厂 + 批次 + 样本号匹配到登记 ${matchedRegistration.id}`;
      changes.push({
        entity: 'registration',
        id: matchedRegistration.id,
        from: REGISTRATION.WAITING_RECEIPT,
        to: REGISTRATION.MATCHED,
        note: `匹配回执 ${report.id}`,
      });
      summary = `回执 ${report.id} 已接收，并匹配到登记 ${matchedRegistration.id}，样本 ${sampleLabel(report)} 计入已对单`;
    } else {
      summary = `回执 ${report.id} 已保存为孤立回执，等待样本 ${sampleLabel(report)} 的采样登记`;
    }
  }

  report.history.push({
    at,
    action: report.status === CREDIT.DUPLICATE ? 'RECEIVED_DUPLICATE' : 'RECEIVED',
    from: null,
    to: report.status,
    note: report.status === CREDIT.DUPLICATE ? `重复于 ${report.duplicateOf}` : '接收回执',
  });

  state.reports.push(report);
  recordEvent(state, action, summary, {
    reportId: report.id,
    registrationId: matchedRegistration ? matchedRegistration.id : null,
  });

  const after = countState(state);

  return {
    ok: true,
    deduped: false,
    report: clone(report),
    registration: matchedRegistration ? clone(matchedRegistration) : null,
    evidence: makeEvidence(action, summary, {
      before,
      after,
      changes,
      entities: {
        report: clone(report),
        registration: matchedRegistration ? clone(matchedRegistration) : null,
      },
    }),
  };
}

function registerSample(state, input = {}) {
  const action = 'REGISTER_SAMPLE';
  const sample = readSampleFields(input);
  if (!sample.ok) return failure(action, sample);

  const explicitId = readOptionalId(input, 'id');
  if (!explicitId.ok) return failure(action, explicitId);

  const timestamp = readTimestamp(input, 'registeredAt', nowIso());
  if (!timestamp.ok) return failure(action, timestamp);

  if (explicitId.value && findRegistration(state, explicitId.value)) {
    return failure(
      action,
      conflictError(`登记编号 ${explicitId.value} 已存在`, 'DUPLICATE_ID'),
    );
  }

  const key = sampleKey(sample.factory, sample.batch, sample.sampleNo);
  const sameKey = state.registrations.filter((registration) => registration.key === key);
  const active = sameKey.find((registration) => !registration.revokedAt);
  if (active) {
    return failure(
      action,
      conflictError(`样本 ${sampleLabel({ ...sample })} 已有有效登记 ${active.id}，请勿重复登记`),
    );
  }

  const before = countState(state);
  const at = nowIso();
  const registration = {
    id: explicitId.value || nextId(state, 'registration'),
    factory: sample.factory,
    batch: sample.batch,
    sampleNo: sample.sampleNo,
    key,
    registeredAt: timestamp.value,
    ingestedAt: at,
    revokedAt: null,
    revokeReason: null,
    matchedReportId: null,
    matchedAt: null,
    history: [],
  };

  const waiting = waitingReportsForKey(state, key);
  const report = waiting[0] || null;
  const changes = [
    {
      entity: 'registration',
      id: registration.id,
      from: null,
      to: REGISTRATION.WAITING_RECEIPT,
      note: `登记样本 ${sampleLabel(registration)}`,
    },
  ];

  if (report) {
    const previousStatus = report.status;
    attachReport(registration, report, at);
    changes[0].to = REGISTRATION.MATCHED;
    changes[0].note = `登记建立后匹配到早到回执 ${report.id}`;
    changes.push({
      entity: 'report',
      id: report.id,
      from: previousStatus,
      to: CREDIT.MATCHED,
      note: `匹配新登记 ${registration.id}`,
    });
  }

  registration.history.push({
    at,
    action: 'REGISTERED',
    from: null,
    to: registrationStatus(registration),
    note: report ? `登记并匹配回执 ${report.id}` : '登记建立，等待回执',
  });

  state.registrations.push(registration);
  recordEvent(
    state,
    action,
    report
      ? `登记 ${registration.id} 已建立，并匹配早到回执 ${report.id}`
      : `登记 ${registration.id} 已建立，等待样本 ${sampleLabel(registration)} 的回执`,
    { registrationId: registration.id, reportId: report ? report.id : null },
  );

  const after = countState(state);

  return {
    ok: true,
    registration: clone(registration),
    report: report ? clone(report) : null,
    evidence: makeEvidence(action, `登记 ${registration.id} 已建立`, {
      before,
      after,
      changes,
      entities: { registration: clone(registration), report: report ? clone(report) : null },
    }),
  };
}

function requestBackfill(state, reportId, input = {}) {
  const action = 'REQUEST_BACKFILL';
  const id = readOptionalId({ id: reportId }, 'id');
  if (!id.ok) return failure(action, id);
  const report = findReport(state, id.value);
  if (!report) return failure(action, notFoundError(`未找到回执 ${id.value}`));

  if (report.status === CREDIT.MATCHED) {
    return failure(action, conflictError(`回执 ${report.id} 已对单，无需再请求补登记`));
  }
  if (report.status === CREDIT.DUPLICATE) {
    return failure(action, conflictError(`回执 ${report.id} 是重复回执，不单独请求补登记`));
  }
  if (report.status === CREDIT.RETURNED) {
    return failure(action, conflictError(`回执 ${report.id} 已退回，不能请求补登记`));
  }

  const note = readText(input, 'note', { required: false, max: MAX_NOTE });
  if (!note.ok) return failure(action, note);

  const before = countState(state);
  const at = nowIso();
  const from = report.status;
  const already = Boolean(report.backfill);
  report.backfill = {
    requestedAt: already ? report.backfill.requestedAt : at,
    updatedAt: at,
    note: note.value || (already ? report.backfill.note : '请补录采样登记'),
  };
  report.status = CREDIT.BACKFILL_REQUESTED;
  report.statusReason = null;
  pushHistory(report, {
    at,
    action: already ? 'BACKFILL_UPDATED' : 'BACKFILL_REQUESTED',
    from,
    to: CREDIT.BACKFILL_REQUESTED,
    note: report.backfill.note,
  });
  recordEvent(state, action, `回执 ${report.id} 已请求补登记`, { reportId: report.id });
  const after = countState(state);

  return {
    ok: true,
    report: clone(report),
    evidence: makeEvidence(action, `已为回执 ${report.id}（${sampleLabel(report)}）请求补登记`, {
      before,
      after,
      changes: [
        {
          entity: 'report',
          id: report.id,
          from,
          to: CREDIT.BACKFILL_REQUESTED,
          note: report.backfill.note,
        },
      ],
      entities: { report: clone(report) },
    }),
  };
}

function returnReport(state, reportId, input = {}) {
  const action = 'RETURN_REPORT';
  const id = readOptionalId({ id: reportId }, 'id');
  if (!id.ok) return failure(action, id);
  const report = findReport(state, id.value);
  if (!report) return failure(action, notFoundError(`未找到回执 ${id.value}`));
  if (report.status === CREDIT.MATCHED) {
    return failure(action, conflictError(`回执 ${report.id} 已对单，请先撤销对应登记`));
  }
  if (report.status === CREDIT.RETURNED) {
    return failure(action, conflictError(`回执 ${report.id} 已经退回`));
  }

  const reason = readText(input, 'reason', { required: false, max: MAX_NOTE });
  if (!reason.ok) return failure(action, reason);

  const before = countState(state);
  const at = nowIso();
  const from = report.status;
  report.status = CREDIT.RETURNED;
  report.statusReason = 'MANUAL_RETURN';
  report.matchedRegId = null;
  report.matchedAt = null;
  report.returnedAt = at;
  report.returnReason = reason.value || '不纳入本次抽样';
  pushHistory(report, {
    at,
    action: 'RETURNED',
    from,
    to: CREDIT.RETURNED,
    note: report.returnReason,
  });
  recordEvent(state, action, `回执 ${report.id} 已退回：${report.returnReason}`, {
    reportId: report.id,
  });
  const after = countState(state);

  const changes = [
    { entity: 'report', id: report.id, from, to: CREDIT.RETURNED, note: report.returnReason },
  ];

  return {
    ok: true,
    report: clone(report),
    evidence: makeEvidence(action, `回执 ${report.id} 已退回，不再计入对单`, {
      before,
      after,
      changes,
      entities: { report: clone(report) },
    }),
  };
}

function revokeRegistration(state, registrationId, input = {}) {
  const action = 'REVOKE_REGISTRATION';
  const id = readOptionalId({ id: registrationId }, 'id');
  if (!id.ok) return failure(action, id);
  const registration = findRegistration(state, id.value);
  if (!registration) {
    return failure(action, notFoundError(`未找到登记 ${id.value}`));
  }
  if (registration.revokedAt) {
    return failure(action, conflictError(`登记 ${registration.id} 已撤销`));
  }

  const reason = readText(input, 'reason', { max: MAX_NOTE });
  if (!reason.ok) return failure(action, reason);

  const before = countState(state);
  const at = nowIso();
  const fromStatus = registrationStatus(registration);
  registration.revokedAt = at;
  registration.revokeReason = reason.value;
  registration.matchedReportId = null;
  registration.matchedAt = null;
  pushHistory(registration, {
    at,
    action: 'REVOKED',
    from: fromStatus,
    to: REGISTRATION.REVOKED,
    note: reason.value,
  });

  const changes = [
    {
      entity: 'registration',
      id: registration.id,
      from: fromStatus,
      to: REGISTRATION.REVOKED,
      note: reason.value,
    },
  ];

  const affected = [];
  for (const report of state.reports) {
    if (report.matchedRegId !== registration.id) continue;
    const from = report.status;
    if (from === CREDIT.MATCHED) {
      report.status = CREDIT.PENDING_MATCH;
      report.statusReason = 'REGISTRATION_REVOKED';
      report.returnedFromRegId = registration.id;
      report.matchedRegId = null;
      report.matchedAt = null;
      affected.push(clone(report));
      changes.push({
        entity: 'report',
        id: report.id,
        from,
        to: CREDIT.PENDING_MATCH,
        note: `登记 ${registration.id} 被撤销，回执退回待处理`,
      });
      pushHistory(report, {
        at,
        action: 'RETURNED_TO_PENDING',
        from,
        to: CREDIT.PENDING_MATCH,
        note: `登记 ${registration.id} 撤销：${reason.value}`,
      });
    } else if (from === CREDIT.DUPLICATE) {
      report.returnedFromRegId = registration.id;
      report.matchedRegId = null;
      report.matchedAt = null;
    }
  }

  recordEvent(
    state,
    action,
    `登记 ${registration.id} 已撤销，${affected.length} 份回执退回待处理`,
    { registrationId: registration.id, reportIds: affected.map((report) => report.id) },
  );
  const after = countState(state);

  return {
    ok: true,
    registration: clone(registration),
    affectedReports: affected,
    evidence: makeEvidence(
      action,
      affected.length > 0
        ? `登记 ${registration.id} 已撤销，${affected.length} 份回执退回待处理`
        : `登记 ${registration.id} 已撤销（无已对单回执）`,
      {
        before,
        after,
        changes,
        entities: { registration: clone(registration), affectedReports: clone(affected) },
      },
    ),
  };
}

function restoreRegistration(state, registrationId) {
  const action = 'RESTORE_REGISTRATION';
  const id = readOptionalId({ id: registrationId }, 'id');
  if (!id.ok) return failure(action, id);
  const registration = findRegistration(state, id.value);
  if (!registration) {
    return failure(action, notFoundError(`未找到登记 ${id.value}`));
  }
  if (!registration.revokedAt) {
    return failure(action, conflictError(`登记 ${registration.id} 未被撤销，无需恢复`));
  }

  const active = state.registrations.find(
    (item) => item.key === registration.key && !item.revokedAt && item.id !== registration.id,
  );
  if (active) {
    return failure(
      action,
      conflictError(`样本 ${sampleLabel(registration)} 已有有效登记 ${active.id}，无法恢复`),
    );
  }

  const before = countState(state);
  const at = nowIso();
  registration.revokedAt = null;
  registration.revokeReason = null;

  const waiting = waitingReportsForKey(state, registration.key);
  const report = waiting[0] || null;
  const changes = [
    {
      entity: 'registration',
      id: registration.id,
      from: REGISTRATION.REVOKED,
      to: report ? REGISTRATION.MATCHED : REGISTRATION.WAITING_RECEIPT,
      note: report ? `恢复登记并重新匹配回执 ${report.id}` : '恢复登记，等待回执',
    },
  ];

  if (report) {
    attachReport(registration, report, at);
    changes.push({
      entity: 'report',
      id: report.id,
      from: CREDIT.PENDING_MATCH,
      to: CREDIT.MATCHED,
      note: `重新匹配到恢复的登记 ${registration.id}`,
    });
  }

  pushHistory(registration, {
    at,
    action: 'RESTORED',
    from: REGISTRATION.REVOKED,
    to: registrationStatus(registration),
    note: report ? `恢复并匹配回执 ${report.id}` : '恢复登记',
  });
  recordEvent(
    state,
    action,
    report
      ? `登记 ${registration.id} 已恢复，并重新匹配回执 ${report.id}`
      : `登记 ${registration.id} 已恢复，等待回执`,
    { registrationId: registration.id, reportId: report ? report.id : null },
  );
  const after = countState(state);

  return {
    ok: true,
    registration: clone(registration),
    report: report ? clone(report) : null,
    evidence: makeEvidence(
      action,
      report
        ? `登记 ${registration.id} 已恢复，回执 ${report.id} 重新对单`
        : `登记 ${registration.id} 已恢复，等待回执`,
      {
        before,
        after,
        changes,
        entities: { registration: clone(registration), report: report ? clone(report) : null },
      },
    ),
  };
}

function viewRegistration(state, registration) {
  const report = registration.matchedReportId ? findReport(state, registration.matchedReportId) : null;
  const { key, ...rest } = clone(registration);
  return {
    ...rest,
    status: registrationStatus(registration),
    matchedReport: report
      ? {
          id: report.id,
          result: report.result,
          receivedAt: report.receivedAt,
          status: report.status,
        }
      : null,
  };
}

function viewReport(state, report) {
  const registration = report.matchedRegId ? findRegistration(state, report.matchedRegId) : null;
  const { key, ...rest } = clone(report);
  return {
    ...rest,
    registration: registration
      ? {
          id: registration.id,
          registeredAt: registration.registeredAt,
          status: registrationStatus(registration),
        }
      : null,
  };
}

function sortedRegistrations(state) {
  return state.registrations.slice().sort((a, b) => {
    const factory = a.factory.localeCompare(b.factory, 'zh-CN');
    if (factory !== 0) return factory;
    const batch = a.batch.localeCompare(b.batch, 'zh-CN');
    if (batch !== 0) return batch;
    const delta = Date.parse(a.registeredAt) - Date.parse(b.registeredAt);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

function sortedReports(state) {
  return state.reports.slice().sort((a, b) => {
    const delta = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

const REPORT_PRIORITY = {
  [CREDIT.MATCHED]: 5,
  [CREDIT.PENDING_MATCH]: 4,
  [CREDIT.BACKFILL_REQUESTED]: 3,
  [CREDIT.DUPLICATE]: 2,
  [CREDIT.RETURNED]: 1,
};

function reconciliationFor(state, { factory = null } = {}) {
  const groups = new Map();

  function ensureGroup(factoryName) {
    if (!groups.has(factoryName)) {
      groups.set(factoryName, {
        factory: factoryName,
        registrations: 0,
        activeRegistrations: 0,
        revokedRegistrations: 0,
        matchedRegistrations: 0,
        waitingRegistrations: 0,
        reports: 0,
        matchedSamples: 0,
        pendingReports: 0,
        backfillRequested: 0,
        duplicateReports: 0,
        returnedReports: 0,
        batches: new Map(),
      });
    }
    return groups.get(factoryName);
  }

  function ensureBatch(group, batchName) {
    if (!group.batches.has(batchName)) {
      group.batches.set(batchName, {
        batch: batchName,
        registrations: 0,
        activeRegistrations: 0,
        revokedRegistrations: 0,
        matchedRegistrations: 0,
        waitingRegistrations: 0,
        reports: 0,
        matchedSamples: 0,
        pendingReports: 0,
        backfillRequested: 0,
        duplicateReports: 0,
        returnedReports: 0,
        notes: [],
        samples: new Map(),
      });
    }
    return group.batches.get(batchName);
  }

  function ensureSample(batch, sampleNo) {
    const key = normalizeKeyPart(sampleNo);
    if (!batch.samples.has(key)) {
      batch.samples.set(key, {
        sampleNo,
        registrationId: null,
        registrationStatus: null,
        registeredAt: null,
        reportId: null,
        reportStatus: null,
        result: null,
        receipts: 0,
        duplicates: 0,
        lastReceivedAt: null,
      });
    }
    return batch.samples.get(key);
  }

  for (const registration of state.registrations) {
    const group = ensureGroup(registration.factory);
    const batch = ensureBatch(group, registration.batch);
    const sample = ensureSample(batch, registration.sampleNo);
    const status = registrationStatus(registration);
    group.registrations += 1;
    batch.registrations += 1;
    if (status === REGISTRATION.REVOKED) {
      group.revokedRegistrations += 1;
      batch.revokedRegistrations += 1;
    } else {
      group.activeRegistrations += 1;
      batch.activeRegistrations += 1;
      if (status === REGISTRATION.MATCHED) {
        group.matchedRegistrations += 1;
        batch.matchedRegistrations += 1;
      } else {
        group.waitingRegistrations += 1;
        batch.waitingRegistrations += 1;
      }
    }
    if (!sample.registrationId || status !== REGISTRATION.REVOKED) {
      sample.registrationId = registration.id;
      sample.registrationStatus = status;
      sample.registeredAt = registration.registeredAt;
    }
  }

  for (const report of state.reports) {
    const group = ensureGroup(report.factory);
    const batch = ensureBatch(group, report.batch);
    const sample = ensureSample(batch, report.sampleNo);
    group.reports += 1;
    batch.reports += 1;
    sample.receipts += 1;
    if (!sample.lastReceivedAt || Date.parse(report.receivedAt) > Date.parse(sample.lastReceivedAt)) {
      sample.lastReceivedAt = report.receivedAt;
    }

    switch (report.status) {
      case CREDIT.MATCHED:
        group.matchedSamples += 1;
        batch.matchedSamples += 1;
        break;
      case CREDIT.PENDING_MATCH:
        group.pendingReports += 1;
        batch.pendingReports += 1;
        break;
      case CREDIT.BACKFILL_REQUESTED:
        group.pendingReports += 1;
        batch.pendingReports += 1;
        group.backfillRequested += 1;
        batch.backfillRequested += 1;
        break;
      case CREDIT.DUPLICATE:
        group.duplicateReports += 1;
        batch.duplicateReports += 1;
        sample.duplicates += 1;
        break;      case CREDIT.RETURNED:
        group.returnedReports += 1;
        batch.returnedReports += 1;
        break;
      default:
        break;
    }

    const currentPriority = sample.reportStatus ? REPORT_PRIORITY[sample.reportStatus] : -1;
    const nextPriority = REPORT_PRIORITY[report.status] || 0;
    if (nextPriority > currentPriority) {
      sample.reportId = report.id;
      sample.reportStatus = report.status;
      sample.result = report.result;
    }
  }

  let items = Array.from(groups.values()).sort((a, b) =>
    a.factory.localeCompare(b.factory, 'zh-CN'),
  );
  if (factory) {
    items = items.filter((group) => group.factory === factory);
  }

  const total = {
    factory: factory || '全部工厂',
    registrations: 0,
    activeRegistrations: 0,
    revokedRegistrations: 0,
    matchedRegistrations: 0,
    waitingRegistrations: 0,
    reports: 0,
    matchedSamples: 0,
    pendingReports: 0,
    backfillRequested: 0,
    duplicateReports: 0,
    returnedReports: 0,
    batches: 0,
    samples: 0,
  };

  for (const group of items) {
    for (const key of [
      'registrations',
      'activeRegistrations',
      'revokedRegistrations',
      'matchedRegistrations',
      'waitingRegistrations',
      'reports',
      'matchedSamples',
      'pendingReports',
      'backfillRequested',
      'duplicateReports',
      'returnedReports',
    ]) {
      total[key] += group[key];
    }
    const batches = Array.from(group.batches.values())
      .sort((a, b) => a.batch.localeCompare(b.batch, 'zh-CN'))
      .map((batch) => {
        const notes = [];
        if (batch.matchedSamples > 0) notes.push(`${batch.matchedSamples} 份样本已对单`);
        if (batch.pendingReports > 0) {
          notes.push(`${batch.pendingReports} 份孤立回执等待登记`);
        }
        if (batch.backfillRequested > 0) {
          notes.push(`${batch.backfillRequested} 份已请求补登记`);
        }
        if (batch.duplicateReports > 0) {
          notes.push(`${batch.duplicateReports} 份重复回执未计数`);
        }
        if (batch.returnedReports > 0) {
          notes.push(`${batch.returnedReports} 份回执已人工退回`);
        }
        if (batch.waitingRegistrations > 0) {
          notes.push(`${batch.waitingRegistrations} 份登记等待回执`);
        }
        if (batch.revokedRegistrations > 0) {
          notes.push(`${batch.revokedRegistrations} 份登记已撤销`);
        }
        const samples = Array.from(batch.samples.values()).sort((a, b) =>
          a.sampleNo.localeCompare(b.sampleNo, 'zh-CN'),
        );
        // 撤销后回执退回待处理的情况，单独给出提示。
        const returnedToPending = state.reports.filter(
          (report) =>
            report.factory === group.factory &&
            report.batch === batch.batch &&
            report.status === CREDIT.PENDING_MATCH &&
            report.statusReason === 'REGISTRATION_REVOKED',
        ).length;
        if (returnedToPending > 0) {
          notes.push(`${returnedToPending} 份回执因登记撤销退回待处理`);
        }
        return { ...batch, notes, samples };
      });
    group.batches = batches;
    total.batches += batches.length;
    total.samples += batches.reduce((sum, batch) => sum + batch.samples.length, 0);
  }

  const notes = [];
  if (total.pendingReports > 0) {
    notes.push(`${total.pendingReports} 份回执仍待登记，可保留等待或请求补登记。`);
  }
  if (total.duplicateReports > 0) {
    notes.push(`${total.duplicateReports} 份重复回执未计入新增样本。`);
  }
  if (total.matchedSamples > 0) {
    notes.push(`已对单 ${total.matchedSamples} 份样本，结论已汇入抽样看板。`);
  }
  if (items.length === 0) {
    notes.push('当前筛选范围内没有登记或回执。');
  }

  return {
    generatedAt: nowIso(),
    factoryFilter: factory,
    factories: items,
    totals: total,
    notes,
  };
}

function getBoard(state) {
  return {
    generatedAt: nowIso(),
    counts: countState(state),
    registrations: sortedRegistrations(state).map((registration) =>
      viewRegistration(state, registration),
    ),
    reports: sortedReports(state).map((report) => viewReport(state, report)),
    reconciliation: reconciliationFor(state),
    events: clone(state.events.slice(-20)),
  };
}

function listFactories(state) {
  const names = new Set();
  for (const registration of state.registrations) names.add(registration.factory);
  for (const report of state.reports) names.add(report.factory);
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/**
 * 本地演示样例存放在 data/demo-scenario.json，按业务时间顺序执行。
 * 所有记录都通过领域操作建立，保证不变量一致，也不依赖外部服务。
 */
const DEMO_SCENARIO_PATH = path.join(__dirname, '..', 'data', 'demo-scenario.json');

function loadDemoScenario(filePath = DEMO_SCENARIO_PATH) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const scenario = JSON.parse(raw);
  if (!scenario || !Array.isArray(scenario.steps)) {
    throw new Error(`演示样例格式不正确：${filePath}`);
  }
  return scenario;
}

function findBySample(state, step, statuses) {
  const key = sampleKey(step.factory, step.batch, step.sampleNo);
  return (
    state.reports
      .filter((report) => report.key === key && statuses.includes(report.status))
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0] || null
  );
}

function createDemoState(scenario = null) {
  const data = scenario || loadDemoScenario();
  const state = createState();

  for (const step of data.steps) {
    let result;
    switch (step.op) {
      case 'receive':
        result = receiveLabReport(state, step);
        break;
      case 'register':
        result = registerSample(state, step);
        break;
      case 'backfill': {
        const target =
          findBySample(state, step, [CREDIT.PENDING_MATCH]) ||
          findBySample(state, step, [CREDIT.BACKFILL_REQUESTED]);
        result = target
          ? requestBackfill(state, target.id, { note: step.note })
          : { ok: false, error: { message: `补登记目标不存在：${sampleLabel(step)}` } };
        break;
      }
      case 'revoke': {
        const registration = state.registrations.find(
          (item) =>
            item.key === sampleKey(step.factory, step.batch, step.sampleNo) && !item.revokedAt,
        );
        result = registration
          ? revokeRegistration(state, registration.id, { reason: step.reason || '演示撤销' })
          : { ok: false, error: { message: `撤销目标不存在：${sampleLabel(step)}` } };
        break;
      }
      default:
        result = { ok: false, error: { message: `未知演示步骤：${step.op}` } };
        break;
    }
    if (!result.ok) {
      throw new Error(`演示样例步骤执行失败（${step.op}）：${result.error.message}`);
    }
  }

  state.events = [];
  state.counters.event = 0;
  state.seededAt = data.seedTime || '2026-11-20T07:00:00+08:00';
  const loadedAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(state.seededAt));
  recordEvent(state, 'DEMO_STATE_LOADED', `本地演示数据已载入（${loadedAt} 固定样例）`);

  return state;
}

module.exports = {
  CREDIT,
  REGISTRATION,
  REPORT_STATUSES,
  REGISTRATION_STATUSES,
  COUNTER_KEYS,
  createState,
  createDemoState,
  loadDemoScenario,
  receiveLabReport,
  registerSample,
  requestBackfill,
  returnReport,
  revokeRegistration,
  restoreRegistration,
  countState,
  reconciliationFor,
  getBoard,
  listFactories,
  sampleKey,
  sampleLabel,
  registrationStatus,
  findRegistration,
  findReport,
  emptyCounts,
};
