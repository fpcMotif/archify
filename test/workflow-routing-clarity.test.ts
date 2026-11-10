import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileWorkflow, type WorkflowCompileResult } from '../schematics/packages/workflow/workflow-compiler.ts';
import type { WorkflowDocument } from '../schematics/packages/workflow/workflow-document.ts';
import type { Point } from '../schematics/packages/geometry/geometry.ts';

function workflowFixture(): WorkflowDocument {
  return JSON.parse(fs.readFileSync(
    new URL('./fixtures/workflow-routing-clarity.workflow.json', import.meta.url),
    'utf8',
  ));
}

function failureDiagnostics(result: WorkflowCompileResult) {
  return result.ok ? undefined : result.diagnostics;
}

function placedReceipt(result: WorkflowCompileResult) {
  const { nodes, edges, labels } = result.receipt;
  assert.ok(nodes && edges && labels, 'expected a placed receipt');
  return { ...result.receipt, nodes, edges, labels };
}

function edgeTag(svg: string, from: string, to: string) {
  const tag = (svg.match(/<path\b[^>]*>/g) || []).find((candidate) => (
    candidate.includes(`data-edge-from="${from}"`) && candidate.includes(`data-edge-to="${to}"`)
  ));
  assert.ok(tag, `expected rendered ${from}->${to}`);
  return tag;
}

test('readable-v2 separates unrelated automatic branches that meet at a bend', () => {
  const workflow: WorkflowDocument = {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Independent failure branches', locale: 'zh-CN', output: 'branches.html' },
    lanes: [{ id: 'sender', label: '请求处理' }, { id: 'stop', label: '失败处理', variant: 'exception' }],
    nodes: [
      { id: 'request', lane: 'sender', col: 0, type: 'external', label: '提交请求', sublabel: '待处理业务任务' },
      { id: 'resolve', lane: 'sender', col: 1, type: 'security', label: '验证并选择目标', sublabel: '检查请求目标 · 排除自身' },
      { id: 'dispatch', lane: 'sender', col: 3, type: 'messagebus', label: '发送任务卡', sublabel: '新 ID · 当前协议' },
      { id: 'targetStop', lane: 'stop', col: 0, type: 'security', label: '目标不明确', sublabel: '无目标 / 多目标 / 当前未知' },
      { id: 'deliveryFail', lane: 'stop', col: 1, type: 'security', label: '发送失败', sublabel: '未完成 · 保留记录' },
      { id: 'invalid', lane: 'stop', col: 2, type: 'security', label: '拒绝错误请求', sublabel: '不执行 invalid 操作' },
    ],
    edges: [
      { id: 'resolve-targetStop', from: 'resolve', to: 'targetStop', label: '不明确', role: 'error' },
      { id: 'dispatch-deliveryFail', from: 'dispatch', to: 'deliveryFail', label: '拒绝', role: 'error' },
    ],
  };
  const before = structuredClone(workflow);
  const result = compileWorkflow({ workflow, qualityProfile: 'showcase' });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
  const receipt = placedReceipt(result);
  const [left, right] = receipt.edges;
  // For orthogonal segments, disjoint bounding boxes prove no crossing or
  // touching. This independently checks the visible paths, not router scores.
  const boxes = (route: { points: Point[] }) => route.points.slice(1).map((end, i) => {
    const start = route.points[i];
    assert.ok(start[0] === end[0] || start[1] === end[1]);
    return { minX: Math.min(start[0], end[0]), maxX: Math.max(start[0], end[0]),
      minY: Math.min(start[1], end[1]), maxY: Math.max(start[1], end[1]) };
  });
  for (const a of boxes(left)) for (const b of boxes(right)) {
    assert.ok(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY,
      'two unrelated conditions must not acquire a false visual junction');
  }
  assert.deepEqual(receipt.nodes.map(n => n.id), workflow.nodes.map(n => n.id));
  assert.deepEqual(receipt.edges.map(e => [e.id, e.from, e.to]).sort(),
    workflow.edges.map(e => [e.id, e.from, e.to]).sort());
  assert.deepEqual(receipt.labels.map(l => l.label).sort(), ['不明确', '拒绝'].sort());
  assert.deepEqual(workflow, before);
});

test('readable-v2 keeps a clear vertical main step straight when its source also branches', () => {
  const workflow: WorkflowDocument = {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Payment and timeout', output: 'payment.html' },
    lanes: [{ id: 'checkout', label: 'Checkout' }, { id: 'expiry', label: 'Expiry' }],
    mainPath: ['pending', 'pay'],
    nodes: [
      { id: 'pending', lane: 'checkout', col: 2, yOffset: 0, type: 'backend', label: 'Pending order' },
      { id: 'pay', lane: 'checkout', col: 2, yOffset: 80, type: 'cloud', label: 'Payment' },
      { id: 'timeout', lane: 'expiry', col: 2, type: 'security', label: 'Timeout' },
    ],
    edges: [
      { id: 'pending-pay', from: 'pending', to: 'pay', role: 'main' },
      { id: 'pending-timeout', from: 'pending', to: 'timeout', role: 'branch', label: 'Still unpaid', variant: 'dashed' },
    ],
  };
  const original = structuredClone(workflow);
  const result = compileWorkflow({ workflow, qualityProfile: 'showcase' });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
  const receipt = placedReceipt(result);
  const route = receipt.edges.find(edge => edge.id === 'pending-pay');
  const from = receipt.nodes.find(node => node.id === 'pending');
  const to = receipt.nodes.find(node => node.id === 'pay');
  assert.ok(route && from && to);
  assert.deepEqual(route.points, [
    [from.x + from.width / 2, from.y + from.height],
    [to.x + to.width / 2, to.y],
  ], 'a clear vertical gap must not acquire a side detour from provisional port spreading');
  assert.equal(receipt.edges.length, 2, 'the timeout branch must remain present');
  assert.equal(receipt.labels.find(label => label.edge === 'pending-timeout')?.label, 'Still unpaid');
  assert.deepEqual(workflow, original);
});

test('readable-v2 uses a clear internal corridor for a long same-column branch', () => {
  const workflow: WorkflowDocument = {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'Payment and expiry', locale: 'zh-CN', output: 'expiry.html' },
    lanes: [
      { id: 'checkout', label: '下单与支付' },
      { id: 'fulfillment', label: '支付成功后履约' },
      { id: 'exceptions', label: '库存不足 / 支付失败', variant: 'exception' },
      { id: 'expiry', label: '超时关闭与回收', variant: 'exception' },
    ],
    nodes: [
      { id: 'pending', lane: 'checkout', col: 2, type: 'backend', label: '创建待支付订单', sublabel: '订单服务' },
      { id: 'pay', lane: 'checkout', col: 2, yOffset: 80, type: 'cloud', label: '发起支付', sublabel: '支付服务', icon: 'decision' },
      { id: 'failed', lane: 'exceptions', col: 2, type: 'external', label: '支付失败，可重试', sublabel: '买家重试支付', icon: 'failure' },
      { id: 'event', lane: 'fulfillment', col: 3, type: 'messagebus', label: '投递 OrderPaid', sublabel: '订单服务' },
      { id: 'timeout', lane: 'expiry', col: 2, type: 'security', label: '超过 15 分钟？', sublabel: '订单服务检查未支付订单', icon: 'decision' },
      { id: 'close', lane: 'expiry', col: 1, type: 'backend', label: '超时关闭订单', sublabel: '订单服务', icon: 'stop' },
    ],
    edges: [
      { id: 'pending-pay', from: 'pending', to: 'pay', role: 'main' },
      { id: 'pay-failed', from: 'pay', to: 'failed', role: 'error', label: '支付失败', variant: 'security' },
      { id: 'retry-pay', from: 'failed', to: 'pay', role: 'return', label: '未超时，重试', variant: 'dashed' },
      { id: 'pending-timeout', from: 'pending', to: 'timeout', role: 'branch', label: '持续未支付', variant: 'dashed' },
      { id: 'timeout-close', from: 'timeout', to: 'close', role: 'error', label: '是，仍未支付', variant: 'security' },
    ],
  };
  const original = structuredClone(workflow);
  const result = compileWorkflow({ workflow, qualityProfile: 'showcase' });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
  const receipt = placedReceipt(result);
  const route = receipt.edges.find(edge => edge.id === 'pending-timeout');
  const from = receipt.nodes.find(node => node.id === 'pending');
  const to = receipt.nodes.find(node => node.id === 'timeout');
  assert.ok(route && from && to);
  const length = route.points.slice(1).reduce((sum, point, index) => sum
    + Math.abs(point[0] - route.points[index][0]) + Math.abs(point[1] - route.points[index][1]), 0);
  assert.ok(length < 2 * Math.abs(to.y - from.y),
    'this unobstructed internal corridor should avoid a trip around the whole diagram');
  assert.deepEqual(receipt.edges.map(edge => edge.id).sort(), workflow.edges.map(edge => edge.id).sort());
  assert.deepEqual(receipt.labels.map(label => label.label).sort(), workflow.edges.filter(edge => edge.label).map(edge => edge.label).sort());
  assert.deepEqual(workflow, original);
});

test('readable-v2 keeps clear backward branches straight after provisional port spreading', () => {
  for (const role of ['error', 'return', undefined]) {
    const workflow: WorkflowDocument = {
      schema_version: 2, diagram_type: 'workflow',
      meta: { title: 'Timeout branch', locale: 'zh-CN', output: 'timeout.html' },
      lanes: ['checkout', 'fulfillment', 'expiry'].map(id => ({ id, label: id })),
      nodes: [
        { id: 'pending', lane: 'checkout', col: 3, type: 'backend', label: '创建待支付订单' },
        { id: 'pick', lane: 'fulfillment', col: 4, type: 'backend', label: '拣货' },
        { id: 'timeout', lane: 'expiry', col: 4, type: 'security', label: '超过 15 分钟？' },
        { id: 'close', lane: 'expiry', col: 3, type: 'backend', label: '超时关闭订单' },
      ],
      edges: [
        { id: 'pending-timeout', from: 'pending', to: 'timeout', role: 'branch', label: '持续未支付', variant: 'dashed' },
        { id: 'timeout-close', from: 'timeout', to: 'close', role, label: '是，仍未支付', variant: 'security' },
      ],
    };
    const before = structuredClone(workflow);
    const result = compileWorkflow({ workflow, qualityProfile: 'showcase' });
    assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result)));
    const receipt = placedReceipt(result);
    const edge = receipt.edges.find(entry => entry.id === 'timeout-close');
    assert.ok(edge);
    assert.equal(edge.points.length, 2, 'a clear backward branch must not loop below the lane');
    assert.equal(edge.points[0][1], edge.points[1][1], 'keep the facing route horizontal');
    assert.ok(edge.points[0][0] > edge.points[1][0], 'preserve the backward relationship');
    assert.equal(receipt.labels.find(entry => entry.edge === edge.id)?.label, '是，仍未支付');
    assert.equal(receipt.nodes.length, workflow.nodes.length);
    assert.equal(receipt.edges.length, workflow.edges.length);
    assert.deepEqual(workflow, before, 'routing must preserve the authored document');
  }
});

test('readable-v2 keeps clear adjacent routes straight without moving nodes or enlarging the canvas', () => {
  const result = compileWorkflow({ workflow: workflowFixture(), qualityProfile: 'showcase' });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result), null, 2));
  const receipt = placedReceipt(result);

  // The reproduction already has sufficient room; routing must preserve its layout.
  assert.deepEqual(result.receipt.viewBox, [949, 528]);
  assert.deepEqual(receipt.nodes.map(({ id, x, y, width, height }) => (
    [id, x, y, width, height]
  )), [
    ['request', 48, 93, 92, 52],
    ['admit', 225.2, 93, 92, 52],
    ['graph', 498.4, 93, 92, 52],
    ['start', 345.2, 217, 92, 52],
    ['turn', 498.4, 217, 92, 52],
    ['tool', 670.8, 217, 92, 52],
    ['resume', 828.8, 217, 92, 52],
    ['commit', 670.8, 341, 92, 52],
    ['project', 828.8, 341, 92, 52],
  ]);

  const adjacentRoutes = [['turn', 'tool'], ['commit', 'project']].map(([from, to]) => {
    const edge = receipt.edges.find((candidate) => candidate.from === from && candidate.to === to);
    assert.ok(edge, `expected the authored ${from}->${to} relationship`);
    return { from, to, pointCount: edge.points.length };
  });
  assert.deepEqual(adjacentRoutes, [
    { from: 'turn', to: 'tool', pointCount: 2 },
    { from: 'commit', to: 'project', pointCount: 2 },
  ], 'clear adjacent forward relationships should not take channel detours');
});

test('readable-v2 separates opposing routes that meet at a shared node', () => {
  const result = compileWorkflow({ workflow: workflowFixture(), qualityProfile: 'showcase' });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result), null, 2));
  const receipt = placedReceipt(result);

  const edges = receipt.edges;
  const opposingCorridors = [];
  for (let firstIndex = 0; firstIndex < edges.length; firstIndex += 1) {
    const first = edges[firstIndex];
    for (const second of edges.slice(firstIndex + 1)) {
      if (![first.from, first.to].some((id) => id === second.from || id === second.to)) continue;
      for (let firstSegment = 0; firstSegment < first.points.length - 1; firstSegment += 1) {
        const [a, b] = first.points.slice(firstSegment, firstSegment + 2);
        for (let secondSegment = 0; secondSegment < second.points.length - 1; secondSegment += 1) {
          const [c, d] = second.points.slice(secondSegment, secondSegment + 2);
          for (const axis of [0, 1]) {
            const fixedAxis = 1 - axis;
            if (a[fixedAxis] !== b[fixedAxis] || c[fixedAxis] !== d[fixedAxis]
                || a[fixedAxis] !== c[fixedAxis]) continue;
            if ((b[axis] - a[axis]) * (d[axis] - c[axis]) >= 0) continue;
            const overlapPx = Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
              - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
            if (overlapPx >= 8) {
              opposingCorridors.push({
                first: `${first.from}->${first.to}`,
                second: `${second.from}->${second.to}`,
                overlapPx,
              });
            }
          }
        }
      }
    }
  }

  assert.deepEqual(opposingCorridors, [], 'incoming and outgoing arrows must remain distinguishable at shared nodes');
});

test('readable-v2 routing remains deterministic and preserves every authored relationship', () => {
  const workflow = workflowFixture();
  const before = JSON.stringify(workflow);
  const first = compileWorkflow({ workflow, qualityProfile: 'showcase' });
  assert.equal(first.ok, true, JSON.stringify(failureDiagnostics(first), null, 2));
  assert.equal(JSON.stringify(workflow), before, 'compilation must not mutate its input');
  const firstReceipt = placedReceipt(first);
  assert.equal(firstReceipt.nodes.length, 9);
  assert.deepEqual(
    firstReceipt.edges.map(({ from, to }) => `${from}->${to}`).sort(),
    workflow.edges.map(({ from, to }) => `${from}->${to}`).sort(),
  );

  const reordered = workflowFixture();
  reordered.nodes.reverse();
  reordered.edges.reverse();
  for (const document of [workflow, reordered]) {
    const repeated = compileWorkflow({ workflow: document, qualityProfile: 'showcase' });
    assert.equal(repeated.ok, true, JSON.stringify(failureDiagnostics(repeated), null, 2));
    assert.deepEqual(repeated.receipt, first.receipt);
    assert.equal(repeated.svg, first.svg);
  }
});

test('readable-v2 preserves authored sides, routes, channels, vias, and label positions', () => {
  const cases = [
    { fromSide: 'right', toSide: 'left' },
    { route: 'straight' },
    { route: 'bottom-channel' },
    { channelY: 425 },
    { via: [[716.8, 425], [836.8, 425]], fromSide: 'bottom', toSide: 'bottom' },
    { labelAt: [776.8, 415] },
  ];
  for (const authored of cases) {
    const workflow = workflowFixture();
    const authoredEdge = workflow.edges.find(({ from, to }) => from === 'commit' && to === 'project');
    assert.ok(authoredEdge);
    Object.assign(authoredEdge, authored);
    const result = compileWorkflow({ workflow, qualityProfile: 'showcase' });
    assert.equal(result.ok, true, JSON.stringify({ authored, diagnostics: failureDiagnostics(result) }, null, 2));
    const receipt = placedReceipt(result);
    const edge = receipt.edges.find(({ from, to }) => from === 'commit' && to === 'project');
    const source = receipt.nodes.find(({ id }) => id === 'commit');
    const target = receipt.nodes.find(({ id }) => id === 'project');
    assert.ok(edge && source && target);
    assert.doesNotMatch(edgeTag(result.svg, 'commit', 'project'), /data-composition-routing=/);
    assert.match(edgeTag(result.svg, 'request', 'admit'), /data-composition-routing="workflow-v2-auto"/);
    if (authored.fromSide === 'right') assert.equal(edge.points[0][0], source.x + source.width);
    if (authored.toSide === 'left') assert.equal(edge.points.at(-1)?.[0], target.x);
    if (authored.fromSide === 'bottom') assert.equal(edge.points[0][1], source.y + source.height);
    if (authored.toSide === 'bottom') assert.equal(edge.points.at(-1)?.[1], target.y + target.height);
    if (authored.route === 'straight') assert.equal(edge.points.length, 2);
    if (authored.route === 'bottom-channel') {
      assert.ok(edge.points.slice(1, -1).every(([, y]) => y > Math.max(source.y + source.height, target.y + target.height)));
    }
    if (authored.channelY !== undefined) {
      assert.ok(edge.points.some((point, index) => index > 0 && point[1] === authored.channelY
        && edge.points[index - 1][1] === authored.channelY));
    }
    if (authored.via) assert.deepEqual(edge.points.slice(1, -1), authored.via);
    if (authored.labelAt) {
      const label = receipt.labels.find(({ label: text }) => text === 'projection');
      assert.deepEqual([label?.x, label?.y], authored.labelAt);
    }
  }
});

test('fixed-v1 stays outside the automatic workflow routing contract', () => {
  const workflow = JSON.parse(fs.readFileSync(
    new URL('./fixtures/v1-baseline/agent-tool-call.workflow.json', import.meta.url),
    'utf8',
  ));
  const result = compileWorkflow({ workflow, qualityProfile: 'standard' });
  assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result), null, 2));
  assert.equal(result.receipt.contract, 'fixed-v1');
  assert.deepEqual(result.receipt.viewBox, [720, 900]);
  assert.equal(result.receipt.edges?.length, workflow.edges.length);
  assert.doesNotMatch(result.svg, /data-composition-routing="workflow-v2-auto"/);
});

test('readable-v2 keeps emphasis and wide-arrow fan-in marker bounds disjoint', () => {
  for (const width of [undefined, 6]) {
    const workflow: WorkflowDocument = {
      schema_version: 2,
      diagram_type: 'workflow',
      meta: { title: 'Shared destination', output: 'shared-destination.html', legend: { mode: 'hidden' } },
      lanes: ['a', 'b', 'c'].map((id) => ({ id, label: id.toUpperCase() })),
      nodes: ['a', 'b', 'c'].map((id) => ({
        id, lane: id, col: id === 'c' ? 2 : 0, type: 'backend', label: id.toUpperCase(),
      })),
      edges: ['a', 'b'].map((from) => ({
        from, to: 'c', variant: 'emphasis', ...(width === undefined ? {} : { width }),
      })),
    };
    const result = compileWorkflow({ workflow, qualityProfile: 'showcase' });
    assert.equal(result.ok, true, JSON.stringify(failureDiagnostics(result), null, 2));
    const receipt = placedReceipt(result);
    const destination = receipt.nodes.find(({ id }) => id === 'c');
    const topEdge = receipt.edges.find(({ from }) => from === 'a');
    const leftEdge = receipt.edges.find(({ from }) => from === 'b');
    assert.ok(destination && topEdge && leftEdge);
    const topRoute = topEdge.points;
    const leftRoute = leftEdge.points;
    const topTip = topRoute.at(-1);
    const leftTip = leftRoute.at(-1);
    const beforeTopTip = topRoute.at(-2);
    const beforeLeftTip = leftRoute.at(-2);
    assert.ok(topTip && leftTip && beforeTopTip && beforeLeftTip);
    assert.deepEqual(topTip, [destination.x + destination.width / 2, destination.y]);
    assert.equal(beforeTopTip[0], topTip[0]);
    assert.ok(beforeTopTip[1] < topTip[1], 'the top arrow arrives downward');
    // The bundled 10x7 marker has refX=9: these perpendicular marker bounds
    // remain disjoint even with a 6px stroke, without relying on router helpers.
    const strokeWidth = width ?? 1.8;
    if (leftTip[1] === destination.y) {
      assert.equal(beforeLeftTip[0], leftTip[0]);
      assert.ok(beforeLeftTip[1] < leftTip[1]);
      assert.ok(Math.abs(topTip[0] - leftTip[0]) >= 7 * strokeWidth,
        'parallel arrivals must have non-overlapping marker bounds');
    } else {
      assert.deepEqual(leftTip, [destination.x, destination.y + destination.height / 2]);
      assert.equal(beforeLeftTip[1], leftTip[1]);
      assert.ok(beforeLeftTip[0] < leftTip[0]);
      assert.ok(topTip[0] - 3.5 * strokeWidth > leftTip[0] + strokeWidth,
        'the top marker must remain to the right of the left marker');
    }
  }
});

test('public validate and rendered HTML agree on automatic workflow routing', (t) => {
  const cli = fileURLToPath(new URL('../schematics/bin/schematics.ts', import.meta.url));
  const input = fileURLToPath(new URL('./fixtures/workflow-routing-clarity.workflow.json', import.meta.url));
  const validation = spawnSync(process.execPath, [cli, 'validate', 'workflow', input, '--quality', 'showcase', '--json'], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  const receipt = JSON.parse(validation.stdout);
  assert.equal(receipt.ok, true);
  assert.ok(receipt.checks.length > 0);
  assert.ok(receipt.checks.every(({ ok }: { ok: boolean }) => ok));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schematics-routing-clarity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'workflow.html');
  const rendered = spawnSync(process.execPath, [cli, 'render', 'workflow', input, output, '--quality', 'showcase'], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const html = fs.readFileSync(output, 'utf8');
  assert.equal((html.match(/data-composition-routing="workflow-v2-auto"/g) || []).length, 11);
  const checked = spawnSync(process.execPath, [cli, 'check', output, '--json'], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(JSON.parse(checked.stdout).ok, true);
});
