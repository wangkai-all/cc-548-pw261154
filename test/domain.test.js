'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../src/domain');

function receive(state, overrides = {}) {
  return domain.receiveLabReport(state, {
    factory: '华东一厂',
    batch: 'B-2405',
    sampleNo: 'S-2001',
    result: '合格',
    ...overrides,
  });
}

function register(state, overrides = {}) {
  return domain.registerSample(state, {
    factory: '华东一厂',
    batch: 'B-2405',
    sampleNo: 'S-2001',
    ...overrides,
  });
}

function freshState() {
  return domain.createState();
}

test('回执早于登记到达：先存为待处理，登记后自动对单', () => {
  const state = freshState();

  const received = receive(state, { messageId: 'msg-1' });
  assert.equal(received.ok, true);
  assert.equal(received.report.status, domain.CREDIT.PENDING_MATCH);
  assert.equal(received.evidence.before.matchedSamples, 0);
  assert.equal(received.evidence.after.matchedSamples, 0);
  assert.equal(received.evidence.after.pendingReports, 1);
  assert.equal(received.evidence.changes[0].to, domain.CREDIT.PENDING_MATCH);

  const registration = register(state);
  assert.equal(registration.ok, true);
  assert.equal(registration.registration.matchedReportId, received.report.id);
  assert.equal(registration.report.status, domain.CREDIT.MATCHED);
  assert.equal(registration.evidence.before.pendingReports, 1);
  assert.equal(registration.evidence.after.pendingReports, 0);
  assert.equal(registration.evidence.after.matchedSamples, 1);

  const counts = domain.countState(state);
  assert.equal(counts.matchedSamples, 1);
  assert.equal(counts.pendingReports, 0);
  assert.equal(counts.matchedRegistrations, 1);
  assert.equal(counts.waitingRegistrations, 0);
});

test('回执晚于登记到达：按工厂 + 批次 + 样本号直接对单', () => {
  const state = freshState();
  const registration = register(state);
  assert.equal(registration.registration.matchedReportId, null);

  const received = receive(state);
  assert.equal(received.ok, true);
  assert.equal(received.report.status, domain.CREDIT.MATCHED);
  assert.equal(received.report.matchedRegId, registration.registration.id);
  assert.equal(received.evidence.after.matchedSamples, 1);

  const counts = domain.countState(state);
  assert.equal(counts.matchedSamples, 1);
  assert.equal(counts.waitingRegistrations, 0);
});

test('不同工厂可复用同一样本号，互不影响', () => {
  const state = freshState();
  const east = register(state, { factory: '华东一厂', sampleNo: 'S-1001' });
  const south = register(state, { factory: '华南二厂', sampleNo: 'S-1001' });
  assert.equal(east.ok, true);
  assert.equal(south.ok, true);

  const southReceipt = receive(state, { factory: '华南二厂', sampleNo: 'S-1001' });
  assert.equal(southReceipt.report.matchedRegId, south.registration.id);
  assert.equal(southReceipt.evidence.after.matchedSamples, 1);

  const counts = domain.countState(state);
  assert.equal(counts.registrations, 2);
  assert.equal(counts.matchedSamples, 1);
  assert.equal(counts.waitingRegistrations, 1);

  const reconciliation = domain.reconciliationFor(state);
  assert.equal(reconciliation.factories.length, 2);
  for (const group of reconciliation.factories) {
    assert.equal(group.batches[0].samples[0].sampleNo, 'S-1001');
  }
  const eastGroup = reconciliation.factories.find((group) => group.factory === '华东一厂');
  const southGroup = reconciliation.factories.find((group) => group.factory === '华南二厂');
  assert.equal(eastGroup.matchedSamples, 0);
  assert.equal(southGroup.matchedSamples, 1);
});

test('同厂不同批次同样本号互不影响', () => {
  const state = freshState();
  register(state, { batch: 'B-2405', sampleNo: 'S-1001' });
  register(state, { batch: 'B-2406', sampleNo: 'S-1001' });

  const receipt = receive(state, { batch: 'B-2406', sampleNo: 'S-1001' });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.evidence.after.matchedSamples, 1);
  assert.equal(receipt.evidence.after.waitingRegistrations, 1);
});

test('同一支样本的重复回执不增加已对单样本数', () => {
  const state = freshState();
  register(state);
  const first = receive(state, { messageId: 'msg-a' });
  assert.equal(first.evidence.after.matchedSamples, 1);

  const second = receive(state, { messageId: 'msg-b' });
  assert.equal(second.ok, true);
  assert.equal(second.report.status, domain.CREDIT.DUPLICATE);
  assert.equal(second.report.duplicateOf, first.report.id);
  assert.equal(second.evidence.after.matchedSamples, 1);
  assert.equal(second.evidence.after.duplicateReports, 1);
  assert.equal(second.evidence.after.pendingReports, 0);
  assert.equal(second.evidence.changes[0].to, domain.CREDIT.DUPLICATE);
});

test('重复回执早于登记到达时也只算一支样本', () => {
  const state = freshState();
  const first = receive(state, { messageId: 'msg-a' });
  const second = receive(state, { messageId: 'msg-b' });
  assert.equal(second.report.status, domain.CREDIT.DUPLICATE);

  const registration = register(state);
  assert.equal(registration.ok, true);
  assert.equal(registration.registration.matchedReportId, first.report.id);
  assert.equal(registration.report.status, domain.CREDIT.MATCHED);

  const counts = domain.countState(state);
  assert.equal(counts.matchedSamples, 1);
  assert.equal(counts.duplicateReports, 1);
  assert.equal(counts.pendingReports, 0);
});

test('相同消息编号重复投递是幂等的，不新增回执', () => {
  const state = freshState();
  const first = receive(state, { messageId: 'same-message' });
  assert.equal(first.deduped, false);

  const second = receive(state, { messageId: 'same-message' });
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true);
  assert.equal(second.report.id, first.report.id);
  assert.equal(second.evidence.before.reports, 1);
  assert.equal(second.evidence.after.reports, 1);
  assert.equal(domain.countState(state).reports, 1);
});

test('撤销已对单的登记：回执退回待处理，结论从看板撤下', () => {
  const state = freshState();
  const registration = register(state);
  const report = receive(state);
  assert.equal(domain.countState(state).matchedSamples, 1);

  const revoked = domain.revokeRegistration(state, registration.registration.id, {
    reason: '采样登记录错',
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.affectedReports.length, 1);
  assert.equal(revoked.affectedReports[0].id, report.report.id);
  assert.equal(revoked.affectedReports[0].status, domain.CREDIT.PENDING_MATCH);
  assert.equal(revoked.evidence.before.matchedSamples, 1);
  assert.equal(revoked.evidence.after.matchedSamples, 0);
  assert.equal(revoked.evidence.after.pendingReports, 1);
  assert.equal(revoked.evidence.after.revokedRegistrations, 1);

  const stored = domain.findReport(state, report.report.id);
  assert.equal(stored.status, domain.CREDIT.PENDING_MATCH);
  assert.equal(stored.statusReason, 'REGISTRATION_REVOKED');
  assert.equal(stored.matchedRegId, null);

  const reconciliation = domain.reconciliationFor(state);
  assert.equal(reconciliation.totals.matchedSamples, 0);
  assert.equal(reconciliation.totals.pendingReports, 1);
  const batch = reconciliation.factories[0].batches[0];
  assert.ok(batch.notes.some((note) => note.includes('退回待处理')));
});

test('登记撤销后重新登记同一样本可重新认领回执', () => {
  const state = freshState();
  const firstRegistration = register(state);
  receive(state);
  domain.revokeRegistration(state, firstRegistration.registration.id, { reason: '录错重录' });

  const secondRegistration = register(state);
  assert.equal(secondRegistration.ok, true);
  assert.equal(secondRegistration.registration.matchedReportId, 'LR-0001');
  assert.equal(secondRegistration.evidence.after.matchedSamples, 1);
  assert.equal(secondRegistration.evidence.after.pendingReports, 0);

  const counts = domain.countState(state);
  assert.equal(counts.matchedSamples, 1);
  assert.equal(counts.revokedRegistrations, 1);
  assert.equal(counts.activeRegistrations, 1);
});

test('撤销无回执的登记不会凭空产生待处理回执', () => {
  const state = freshState();
  const registration = register(state);
  const revoked = domain.revokeRegistration(state, registration.registration.id, {
    reason: '未采样',
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.affectedReports.length, 0);
  assert.equal(revoked.evidence.before.matchedSamples, 0);
  assert.equal(revoked.evidence.after.matchedSamples, 0);
  assert.equal(revoked.evidence.after.pendingReports, 0);
  assert.equal(revoked.evidence.after.revokedRegistrations, 1);
  assert.equal(revoked.evidence.changes[0].from, domain.REGISTRATION.WAITING_RECEIPT);
});

test('重复撤销与撤销不存在的登记返回可解释错误', () => {
  const state = freshState();
  const registration = register(state);
  assert.equal(domain.revokeRegistration(state, registration.registration.id, { reason: '错' }).ok, true);

  const again = domain.revokeRegistration(state, registration.registration.id, { reason: '错' });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'CONFLICT');

  const missing = domain.revokeRegistration(state, 'REG-9999', { reason: '错' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.equal(missing.evidence.ok, false);
});

test('恢复撤销的登记会重新认领待处理回执', () => {
  const state = freshState();
  const registration = register(state);
  receive(state);
  domain.revokeRegistration(state, registration.registration.id, { reason: '录错' });

  const restored = domain.restoreRegistration(state, registration.registration.id);
  assert.equal(restored.ok, true);
  assert.equal(restored.report.status, domain.CREDIT.MATCHED);
  assert.equal(restored.evidence.before.matchedSamples, 0);
  assert.equal(restored.evidence.after.matchedSamples, 1);

  const counts = domain.countState(state);
  assert.equal(counts.revokedRegistrations, 0);
  assert.equal(counts.matchedSamples, 1);
});

test('孤立回执可请求补登记，重复请求只更新备注', () => {
  const state = freshState();
  const received = receive(state);
  assert.equal(received.report.status, domain.CREDIT.PENDING_MATCH);

  const requested = domain.requestBackfill(state, received.report.id, {
    note: '请补录 S-2001 的采样登记',
  });
  assert.equal(requested.ok, true);
  assert.equal(requested.report.status, domain.CREDIT.BACKFILL_REQUESTED);
  assert.equal(requested.evidence.before.pendingReports, 1);
  assert.equal(requested.evidence.after.pendingReports, 1);
  assert.equal(requested.evidence.after.backfillRequested, 1);

  const again = domain.requestBackfill(state, received.report.id, { note: '已再次催办' });
  assert.equal(again.ok, true);
  assert.equal(again.report.backfill.note, '已再次催办');
  assert.equal(domain.countState(state).backfillRequested, 1);
});

test('已对单或重复回执不能请求补登记', () => {
  const state = freshState();
  register(state);
  const matched = receive(state);
  const backfill = domain.requestBackfill(state, matched.report.id, { note: 'x' });
  assert.equal(backfill.ok, false);
  assert.equal(backfill.error.code, 'CONFLICT');

  const duplicate = receive(state);
  const duplicateBackfill = domain.requestBackfill(state, duplicate.report.id, { note: 'x' });
  assert.equal(duplicateBackfill.ok, false);
  assert.equal(duplicateBackfill.error.code, 'CONFLICT');
});

test('回执补登记请求后，登记建立时可直接认领', () => {
  const state = freshState();
  const received = receive(state);
  domain.requestBackfill(state, received.report.id, { note: '补录' });

  const registration = register(state);
  assert.equal(registration.report.status, domain.CREDIT.MATCHED);
  assert.equal(registration.evidence.after.backfillRequested, 0);
  assert.equal(registration.evidence.after.matchedSamples, 1);
});

test('人工退回待处理回执后不再计入对单', () => {
  const state = freshState();
  const received = receive(state);
  assert.equal(received.report.status, domain.CREDIT.PENDING_MATCH);

  const returned = domain.returnReport(state, received.report.id, { reason: '样本污染' });
  assert.equal(returned.ok, true);
  assert.equal(returned.report.status, domain.CREDIT.RETURNED);
  assert.equal(returned.evidence.before.pendingReports, 1);
  assert.equal(returned.evidence.after.pendingReports, 0);
  assert.equal(returned.evidence.after.returnedReports, 1);
  assert.equal(returned.evidence.after.matchedSamples, 0);
});

test('已对单回执不能直接退回，需先撤销登记；撤销后即可退回', () => {
  const state = freshState();
  const registration = register(state);
  const received = receive(state);

  const blocked = domain.returnReport(state, received.report.id, { reason: '仪器异常' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'CONFLICT');

  domain.revokeRegistration(state, registration.registration.id, { reason: '录错重录' });
  const returned = domain.returnReport(state, received.report.id, { reason: '仪器异常' });
  assert.equal(returned.ok, true);
  assert.equal(returned.evidence.before.pendingReports, 1);
  assert.equal(returned.evidence.after.pendingReports, 0);
  assert.equal(returned.evidence.after.returnedReports, 1);
});

test('退回的回执不参与重复判定，新到达回执可正常对单', () => {
  const state = freshState();
  const first = receive(state);
  domain.returnReport(state, first.report.id, { reason: '仪器异常' });

  register(state);
  const replacement = receive(state, { messageId: 'replacement' });
  assert.equal(replacement.report.status, domain.CREDIT.MATCHED);
  assert.equal(replacement.evidence.after.matchedSamples, 1);
  assert.equal(replacement.evidence.after.returnedReports, 1);
});

test('参数校验：缺字段、非法时间、超长文本均被拒绝且不改变状态', () => {
  const state = freshState();
  const before = domain.countState(state);

  const missing = domain.receiveLabReport(state, { factory: '华东一厂', batch: 'B-2405' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'VALIDATION_ERROR');
  assert.equal(missing.error.field, 'sampleNo');

  const blank = domain.registerSample(state, {
    factory: '  ',
    batch: 'B-2405',
    sampleNo: 'S-1',
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.error.field, 'factory');

  const badTime = domain.receiveLabReport(state, {
    factory: '华东一厂',
    batch: 'B-2405',
    sampleNo: 'S-1',
    result: '合格',
    receivedAt: '不是时间',
  });
  assert.equal(badTime.ok, false);
  assert.equal(badTime.error.field, 'receivedAt');

  const tooLong = domain.registerSample(state, {
    factory: '华'.repeat(81),
    batch: 'B-2405',
    sampleNo: 'S-1',
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.field, 'factory');

  assert.deepEqual(domain.countState(state), before);
});

test('同一样本存在有效登记时拒绝重复登记，撤销后允许重建', () => {
  const state = freshState();
  const first = register(state);
  const duplicate = register(state);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'CONFLICT');

  domain.revokeRegistration(state, first.registration.id, { reason: '录错' });
  const rebuilt = register(state);
  assert.equal(rebuilt.ok, true);
});

test('对单结论按工厂、批次聚合，并保留重复与待处理提示', () => {
  const state = domain.createDemoState();
  const reconciliation = domain.reconciliationFor(state);

  assert.equal(reconciliation.factories.length, 2);
  assert.equal(reconciliation.totals.matchedSamples, 4);
  assert.equal(reconciliation.totals.pendingReports, 3);
  assert.equal(reconciliation.totals.duplicateReports, 1);

  const east = reconciliation.factories.find((group) => group.factory === '华东一厂');
  const batch = east.batches.find((item) => item.batch === 'B-2405');
  assert.ok(batch);
  const s1003 = batch.samples.find((sample) => sample.sampleNo === 'S-1003');
  assert.equal(s1003.receipts, 2);
  assert.equal(s1003.duplicates, 1);
  assert.equal(s1003.reportStatus, domain.CREDIT.PENDING_MATCH);
  assert.ok(batch.notes.some((note) => note.includes('重复')));

  const filtered = domain.reconciliationFor(state, { factory: '华南二厂' });
  assert.equal(filtered.factories.length, 1);
  assert.equal(filtered.factories[0].factory, '华南二厂');
  assert.equal(filtered.factoryFilter, '华南二厂');
});

test('看板返回的登记与回执带有关联摘要，且不泄漏内部键', () => {
  const state = domain.createDemoState();
  const board = domain.getBoard(state);
  assert.ok(Array.isArray(board.reports));
  assert.ok(board.reports.length > 0);
  const matchedReport = board.reports.find((report) => report.status === domain.CREDIT.MATCHED);
  assert.ok(matchedReport.registration);
  assert.equal(typeof matchedReport.registration.id, 'string');
  assert.equal(JSON.stringify(board).includes('\u0000'), false);

  const matchedRegistration = board.registrations.find(
    (registration) => registration.status === domain.REGISTRATION.MATCHED,
  );
  assert.ok(matchedRegistration.matchedReport);
});

test('证据结构包含动作、前后计数与状态迁移', () => {
  const state = freshState();
  const received = receive(state);
  const evidence = received.evidence;
  assert.equal(evidence.action, 'RECEIVE_REPORT');
  assert.equal(evidence.ok, true);
  assert.deepEqual(Object.keys(evidence.before).sort(), Object.keys(evidence.after).sort());
  assert.ok(evidence.changes.length >= 1);
  assert.equal(evidence.changes[0].entity, 'report');
  assert.equal(evidence.changes[0].to, domain.CREDIT.PENDING_MATCH);
  assert.ok(evidence.at);
  assert.ok(evidence.summary.includes(received.report.id));
});
