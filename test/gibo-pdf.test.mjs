import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeJpegPdf,
  giboColorLabel,
  giboFileName,
  giboGridPlan,
  giboMoveCaption,
  giboPageCount,
} from '../dist/replay/gibo-pdf.js';

const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes);
const fakeJpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);

test('filename + color/caption helpers', () => {
  assert.equal(giboFileName('gomoku', 'abc-123'), 'gibo-gomoku-abc-123.pdf');
  assert.equal(giboColorLabel('black'), '흑');
  assert.equal(giboColorLabel('white'), '백');
  assert.equal(giboMoveCaption(0, { type: 'move', color: 'black', x: 7, y: 7 }), '1수 · 흑 (8,8)');
  assert.equal(giboMoveCaption(12, { type: 'pass', color: 'white' }), '13수 · 백 패스');
});

test('giboPageCount accounts for the smaller first page', () => {
  assert.equal(giboPageCount(0, 9, 12), 1);
  assert.equal(giboPageCount(9, 9, 12), 1);
  assert.equal(giboPageCount(10, 9, 12), 2);
  assert.equal(giboPageCount(21, 9, 12), 2);
  assert.equal(giboPageCount(22, 9, 12), 3);
});

test('giboGridPlan lays tiles in a grid and wraps across pages', () => {
  const opts = { pageW: 595, pageH: 842, margin: 36, cols: 3, colGap: 14, rowGap: 16, headerHpt: 80, tileAspect: 1.14 };
  const plan = giboGridPlan(40, opts);
  assert.equal(plan.slots.length, 40);
  assert.ok(plan.tileW > 0 && plan.tileH > plan.tileW);
  assert.equal(plan.pages, giboPageCount(40, plan.cap1, plan.capRest));
  // first tile is at the left margin, below the header band
  assert.equal(plan.slots[0].page, 0);
  assert.equal(Math.round(plan.slots[0].xPt), 36);
  assert.ok(plan.slots[0].yTopPt >= 36 + opts.headerHpt);
  // tiles stay within the page horizontally
  for (const s of plan.slots) {
    assert.ok(s.xPt >= opts.margin - 0.01);
    assert.ok(s.xPt + plan.tileW <= opts.pageW - opts.margin + 0.01);
  }
  // the number of distinct pages equals the reported page count
  assert.equal(new Set(plan.slots.map((s) => s.page)).size, plan.pages);
});

test('encodeJpegPdf emits a valid single-page PDF with image XObjects', () => {
  const img = { jpeg: fakeJpeg(), wPx: 100, hPx: 100, xPt: 36, yPtBottom: 600, wPt: 150, hPt: 150 };
  const bytes = encodeJpegPdf(595, 842, [[img, { ...img, xPt: 200 }]]);
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4'), 'has PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'has EOF');
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 2);
  assert.equal((text.match(/\/Type \/Page[^s]/g) || []).length, 1);
  assert.match(text, /\/Type \/Pages \/Kids \[3 0 R? ?.*\] \/Count 1|\/Count 1/);
  assert.match(text, /startxref\n\d+\n%%EOF/);
});

test('encodeJpegPdf spans multiple pages with the right Count', () => {
  const img = { jpeg: fakeJpeg(), wPx: 50, hPx: 50, xPt: 36, yPtBottom: 600, wPt: 150, hPt: 150 };
  const bytes = encodeJpegPdf(595, 842, [[img], [img], [img]]);
  const text = latin1(bytes);
  assert.equal((text.match(/\/Type \/Page[^s]/g) || []).length, 3);
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 3);
  assert.match(text, /\/Count 3/);
});
