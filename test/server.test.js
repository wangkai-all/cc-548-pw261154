'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer, resolvePort } = require('../server');
const domain = require('../src/domain');

async function withServer(fn, options = {}) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({ base, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function json(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}

test('resolvePort 读取 PORT 并拒绝非法值', () => {
  assert.equal(resolvePort({}), 3000);
  assert.equal(resolvePort({ PORT: '4321' }), 4321);
  assert.equal(resolvePort({ PORT: '0' }), 0);
  assert.throws(() => resolvePort({ PORT: 'abc' }), /PORT/);
  assert.throws(() => resolvePort({ PORT: '70000' }), /PORT/);
});

test('GET /api/board 返回演示看板与对单摘要', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await json(base, '/api/board');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.board.counts.matchedSamples, 4);
    assert.equal(body.board.counts.pendingReports, 3);
    assert.equal(body.board.reconciliation.factories.length, 2);
    assert.equal(body.board.reports.length, 8);
    assert.equal(body.board.registrations.length, 8);
  });
});

test('接收早到回执接口：未登记时保存为待处理并返回证据', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await json(base, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华东一厂',
        batch: 'B-2405',
        sampleNo: 'S-7777',
        result: '待复检',
      }),
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.report.status, domain.CREDIT.PENDING_MATCH);
    assert.equal(body.evidence.before.matchedSamples, 4);
    assert.equal(body.evidence.after.matchedSamples, 4);
    assert.equal(body.evidence.after.pendingReports, 4);
    assert.ok(body.board, '写接口应带回刷新后的看板');
  });
});

test('接收回执接口：同键已有回执返回 201 且标记重复', async () => {
  await withServer(async ({ base }) => {
    const { body } = await json(base, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华南二厂',
        batch: 'B-2405',
        sampleNo: 'S-1001',
        result: '合格',
      }),
    });
    assert.equal(body.ok, true);
    assert.equal(body.report.status, domain.CREDIT.DUPLICATE);
    assert.equal(body.evidence.before.matchedSamples, 4);
    assert.equal(body.evidence.after.matchedSamples, 4);
    assert.equal(body.evidence.after.duplicateReports, 2);
  });
});

test('接收回执接口：相同 messageId 幂等返回 200 且不新增', async () => {
  await withServer(async ({ base }) => {
    const first = await json(base, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华东一厂',
        batch: 'B-2405',
        sampleNo: 'S-1005',
        result: '合格',
        messageId: 'idem-1',
      }),
    });
    assert.equal(first.status, 201);

    const second = await json(base, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华东一厂',
        batch: 'B-2405',
        sampleNo: 'S-1005',
        result: '合格',
        messageId: 'idem-1',
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.deduped, true);
    assert.equal(second.body.report.id, first.body.report.id);
    assert.equal(second.body.evidence.before.reports, second.body.evidence.after.reports);
  });
});

test('登记样本接口可认领早到回执', async () => {
  await withServer(async ({ base }) => {
    const received = await json(base, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华北三厂',
        batch: 'B-2407',
        sampleNo: 'S-3001',
        result: '合格',
      }),
    });
    assert.equal(received.status, 201);
    assert.equal(received.body.report.status, domain.CREDIT.PENDING_MATCH);

    const registration = await json(base, '/api/registrations', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华北三厂',
        batch: 'B-2407',
        sampleNo: 'S-3001',
      }),
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.body.registration.matchedReportId, received.body.report.id);
    assert.equal(registration.body.evidence.before.pendingReports, 4);
    assert.equal(registration.body.evidence.after.pendingReports, 3);
    assert.equal(registration.body.evidence.after.matchedSamples, 5);
  });
});

test('重复登记已有有效登记的样本返回 409', async () => {
  await withServer(async ({ base }) => {
    const duplicate = await json(base, '/api/registrations', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华东一厂',
        batch: 'B-2406',
        sampleNo: 'S-1001',
      }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.ok, false);
    assert.equal(duplicate.body.error.code, 'CONFLICT');
    assert.ok(duplicate.body.evidence);
  });
});

test('撤销登记接口把已对单回执退回待处理', async () => {
  await withServer(async ({ base }) => {
    const board = await json(base, '/api/board');
    const registration = board.body.board.registrations.find(
      (item) => item.status === 'MATCHED',
    );

    const revoked = await json(base, `/api/registrations/${registration.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: '接口测试：撤销后重录' }),
    });
    assert.equal(revoked.status, 201);
    assert.equal(revoked.body.ok, true);
    assert.equal(revoked.body.affectedReports.length, 1);
    assert.equal(revoked.body.affectedReports[0].status, domain.CREDIT.PENDING_MATCH);
    assert.equal(revoked.body.evidence.before.matchedSamples, 4);
    assert.equal(revoked.body.evidence.after.matchedSamples, 3);
    assert.equal(revoked.body.evidence.after.pendingReports, 4);

    const reportId = revoked.body.affectedReports[0].id;
    const afterBoard = await json(base, '/api/board');
    const report = afterBoard.body.board.reports.find((item) => item.id === reportId);
    assert.equal(report.status, domain.CREDIT.PENDING_MATCH);
    assert.equal(report.registration, null);
  });
});

test('撤销登记接口校验：缺原因返回 400，重复撤销返回 409', async () => {
  await withServer(async ({ base }) => {
    const board = await json(base, '/api/board');
    const registration = board.body.board.registrations[0];

    const missingReason = await json(base, `/api/registrations/${registration.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(missingReason.status, 400);
    assert.equal(missingReason.body.error.code, 'VALIDATION_ERROR');

    const first = await json(base, `/api/registrations/${registration.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: '第一次' }),
    });
    assert.equal(first.status, 201);

    const second = await json(base, `/api/registrations/${registration.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: '第二次' }),
    });
    assert.equal(second.status, 409);

    const missing = await json(base, '/api/registrations/REG-9999/revoke', {
      method: 'POST',
      body: JSON.stringify({ reason: '不存在' }),
    });
    assert.equal(missing.status, 404);
  });
});

test('孤立回执请求补登记与人工退回接口', async () => {
  await withServer(async ({ base }) => {
    const board = await json(base, '/api/board');
    const pending = board.body.board.reports.find(
      (report) => report.status === domain.CREDIT.PENDING_MATCH,
    );

    const backfill = await json(base, `/api/reports/${pending.id}/backfill`, {
      method: 'POST',
      body: JSON.stringify({ note: '请补录采样登记' }),
    });
    assert.equal(backfill.status, 201);
    assert.equal(backfill.body.report.status, domain.CREDIT.BACKFILL_REQUESTED);
    assert.equal(backfill.body.evidence.after.backfillRequested, 2);

    const returned = await json(base, `/api/reports/${pending.id}/return`, {
      method: 'POST',
      body: JSON.stringify({ reason: '不纳入本次抽样' }),
    });
    assert.equal(returned.status, 201);
    assert.equal(returned.body.report.status, domain.CREDIT.RETURNED);
    assert.equal(returned.body.evidence.after.returnedReports, 1);
  });
});

test('查看抽样对单接口按工厂筛选并返回证据', async () => {
  await withServer(async ({ base }) => {
    const all = await json(base, '/api/reconciliation');
    assert.equal(all.status, 200);
    assert.equal(all.body.reconciliation.totals.samples, 11);
    assert.equal(all.body.reconciliation.totals.matchedSamples, 4);
    assert.equal(all.body.evidence.action, 'VIEW_RECONCILIATION');
    assert.deepEqual(all.body.evidence.before, all.body.evidence.after);
    assert.equal(all.body.evidence.changes.length, 0);

    const filtered = await json(
      base,
      `/api/reconciliation?factory=${encodeURIComponent('华南二厂')}`,
    );
    assert.equal(filtered.body.reconciliation.factories.length, 1);
    assert.equal(filtered.body.reconciliation.factories[0].factory, '华南二厂');
    assert.ok(filtered.body.evidence.summary.includes('华南二厂'));
    assert.equal(filtered.body.reconciliation.totals.matchedSamples, 1);
    assert.equal(filtered.body.reconciliation.totals.pendingReports, 1);
    assert.equal(filtered.body.reconciliation.totals.factory, '华南二厂');
  });
});

test('恢复演示数据接口重置所有状态', async () => {
  await withServer(async ({ base }) => {
    const board = await json(base, '/api/board');
    const registration = board.body.board.registrations[0];
    await json(base, `/api/registrations/${registration.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: '临时撤销' }),
    });
    const afterRevoke = await json(base, '/api/board');
    assert.equal(afterRevoke.body.board.counts.revokedRegistrations, 1);

    const reset = await json(base, '/api/reset', { method: 'POST', body: '{}' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.board.counts.revokedRegistrations, 0);
    assert.equal(reset.body.board.counts.matchedSamples, 4);
  });
});

test('错误处理：非法 JSON、错误方法、未知接口、路径穿越', async () => {
  await withServer(async ({ base }) => {
    const badJson = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    const badBody = await badJson.json();
    assert.equal(badBody.error.code, 'BAD_JSON');

    const wrongMethod = await json(base, '/api/reports');
    assert.equal(wrongMethod.status, 405);

    const unknown = await json(base, '/api/nope');
    assert.equal(unknown.status, 404);

    const traversal = await fetch(`${base}/..%2Fserver.js`);
    assert.equal(traversal.status, 403);

    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const page = await html.text();
    assert.ok(page.includes('data-evidence-result'));

    const traversalAsset = await fetch(`${base}/%2e%2e%2fserver.js`);
    assert.equal(traversalAsset.status, 403);
  });
});

test('页面包含三个入口按钮与 data-evidence-result 业务结果区', async () => {
  await withServer(async ({ base }) => {
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /data-evidence-result/);
    assert.match(page, /id="btn-receive"/);
    assert.match(page, /id="btn-revoke"/);
    assert.match(page, /id="btn-reconcile"/);
    assert.match(page, /接收早到回执/);
    assert.match(page, /撤销一份登记/);
    assert.match(page, /查看抽样对单/);

    const script = await (await fetch(`${base}/app.js`)).text();
    assert.match(script, /\/api\/reports/);
    assert.match(script, /\/revoke/);
    assert.match(script, /\/api\/reconciliation/);
    assert.match(script, /data-evidence-before|dataset\.evidenceBefore/);
    assert.match(script, /dataset\.evidenceAfter/);

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  });
});

test('静态资源缺失时返回 404，不支持的方法返回 405', async () => {
  await withServer(async ({ base }) => {
    const missing = await fetch(`${base}/missing.js`);
    assert.equal(missing.status, 404);

    const postPage = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(postPage.status, 405);

    const postBoard = await fetch(`${base}/api/board`, { method: 'POST' });
    assert.equal(postBoard.status, 405);
  });
});

test('页面内三个动作可在同一次会话中依次完成并核对前后结果', async () => {
  await withServer(async ({ base }) => {
    const initial = await json(base, '/api/board');
    assert.equal(initial.body.board.counts.matchedSamples, 4);

    // 1. 接收早到回执（华南二厂 / B-2405 / S-1002 已有登记）
    const receive = await json(base, '/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        factory: '华南二厂',
        batch: 'B-2405',
        sampleNo: 'S-1003',
        result: '合格',
      }),
    });
    assert.equal(receive.status, 201);
    assert.equal(receive.body.report.status, domain.CREDIT.PENDING_MATCH);
    assert.equal(receive.body.evidence.after.pendingReports, 4);

    // 2. 撤销一份已对单登记（华南二厂 / B-2405 / S-1001）
    const target = receive.body.board.registrations.find(
      (item) =>
        item.factory === '华南二厂' && item.batch === 'B-2405' && item.sampleNo === 'S-1001',
    );
    const revoke = await json(base, `/api/registrations/${target.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: '同一次操作演示：撤销登记' }),
    });
    assert.equal(revoke.status, 201);
    assert.equal(revoke.body.evidence.before.matchedSamples, 4);
    assert.equal(revoke.body.evidence.after.matchedSamples, 3);
    assert.equal(revoke.body.evidence.after.pendingReports, 5);

    // 3. 查看抽样对单，核对最终结论
    const reconciliation = await json(base, '/api/reconciliation');
    assert.equal(reconciliation.status, 200);
    const totals = reconciliation.body.reconciliation.totals;
    assert.equal(totals.matchedSamples, 3);
    assert.equal(totals.pendingReports, 5);
    assert.equal(totals.duplicateReports, 1);
  });
});
