'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../src/domain');

test('演示样例文件可独立载入，且每步都可执行', () => {
  const scenario = domain.loadDemoScenario();
  assert.equal(typeof scenario.seedTime, 'string');
  assert.ok(Array.isArray(scenario.steps));
  assert.ok(scenario.steps.length > 0);
  for (const step of scenario.steps) {
    assert.ok(['receive', 'register', 'backfill', 'revoke'].includes(step.op), step.op);
    assert.equal(typeof step.factory, 'string');
    assert.equal(typeof step.batch, 'string');
    assert.equal(typeof step.sampleNo, 'string');
  }
  const state = domain.createDemoState(scenario);
  assert.ok(domain.getBoard(state).counts.registrations > 0);
});

test('演示样例包含早到、跨厂同号、重复回执与孤立回执四类情形', () => {
  const state = domain.createDemoState();
  const groups = domain.reconciliationFor(state).factories;

  const east = groups.find((group) => group.factory === '华东一厂');
  const south = groups.find((group) => group.factory === '华南二厂');
  assert.ok(east && south);

  const eastS1001 = east.batches
    .find((batch) => batch.batch === 'B-2405')
    .samples.find((sample) => sample.sampleNo === 'S-1001');
  const southS1001 = south.batches
    .find((batch) => batch.batch === 'B-2405')
    .samples.find((sample) => sample.sampleNo === 'S-1001');
  assert.equal(eastS1001.reportStatus, domain.CREDIT.MATCHED);
  assert.equal(southS1001.reportStatus, domain.CREDIT.MATCHED);

  const duplicate = state.reports.find((report) => report.status === domain.CREDIT.DUPLICATE);
  assert.ok(duplicate);
  assert.ok(duplicate.duplicateOf);

  const pending = state.reports.find((report) => report.status === domain.CREDIT.PENDING_MATCH);
  assert.ok(pending);
  assert.equal(pending.matchedRegId, null);

  const backfill = state.reports.find(
    (report) => report.status === domain.CREDIT.BACKFILL_REQUESTED,
  );
  assert.ok(backfill && backfill.backfill);
});

test('演示样例可完整走一遍撤销登记退回待处理再恢复', () => {
  const state = domain.createDemoState();
  const target = state.registrations.find(
    (registration) =>
      registration.factory === '华东一厂' &&
      registration.batch === 'B-2406' &&
      registration.sampleNo === 'S-1001',
  );
  assert.ok(target);
  assert.equal(domain.registrationStatus(target), domain.REGISTRATION.MATCHED);

  const revoked = domain.revokeRegistration(state, target.id, { reason: '演示撤回' });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.affectedReports.length, 1);

  const pending = revoked.affectedReports[0];
  assert.equal(pending.status, domain.CREDIT.PENDING_MATCH);
  const board = domain.getBoard(state);
  assert.equal(board.counts.matchedSamples, 3);
  assert.equal(board.counts.pendingReports, 4);
  const showedBack = board.reconciliation.factories
    .flatMap((group) => group.batches)
    .flatMap((batch) => batch.notes)
    .some((note) => note.includes('退回待处理'));
  assert.equal(showedBack, true);

  const restored = domain.restoreRegistration(state, target.id);
  assert.equal(restored.ok, true);
  assert.equal(restored.report.id, pending.id);
  assert.equal(domain.countState(state).matchedSamples, 4);
});
