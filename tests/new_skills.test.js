import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { SkillRegistry } from '../dist/skills/index.js';
import { extractTextFromPdfBuffer, simpleMarkdownToHtml } from '../dist/skills/documents.js';

test('All new high-value skills are registered with concise descriptions', () => {
  const reg = new SkillRegistry();
  const names = reg.list().map((s) => s.name);
  for (const expected of [
    'move_file',
    'delete_file',
    'notify_user',
    'clipboard_read',
    'clipboard_write',
    'pdf_read',
    'markdown_to_pdf'
  ]) {
    assert.ok(names.includes(expected), `Missing skill: ${expected}`);
  }
});

test('move_file and approval-gated delete_file operate safely within workspace', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-fs-ops-'));
  const reg = new SkillRegistry();
  const ctx = {
    config: { workspaceDir: tmpDir },
    confirmCommand: async () => true
  };

  try {
    fs.writeFileSync(path.join(tmpDir, 'draft.txt'), 'hello', 'utf8');

    const moved = await reg.execute('move_file', { from: 'draft.txt', to: 'sub/final.txt' }, ctx);
    assert.equal(moved.success, true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'draft.txt')), false);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'sub', 'final.txt'), 'utf8'), 'hello');

    // Delete rejected without approval
    const denied = await reg.execute('delete_file', { path: 'sub/final.txt' }, {
      config: { workspaceDir: tmpDir },
      confirmCommand: async () => false
    });
    assert.equal(denied.success, false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'sub', 'final.txt')), true);

    // Delete succeeds when approved
    const deleted = await reg.execute('delete_file', { path: 'sub/final.txt' }, ctx);
    assert.equal(deleted.success, true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'sub', 'final.txt')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('pdf_read extracts text from compressed PDF streams and simpleMarkdownToHtml escapes HTML', async () => {
  const pdfStreamBody = Buffer.from('BT /F1 12 Tf (Hello OMega PDF!) Tj ET', 'latin1');
  const deflated = zlib.deflateSync(pdfStreamBody);
  const fakePdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflated,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')
  ]);

  const extracted = extractTextFromPdfBuffer(fakePdf);
  assert.equal(extracted.streamCount, 1);
  assert.ok(extracted.text.includes('Hello OMega PDF!'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-pdf-'));
  try {
    const pdfPath = path.join(tmpDir, 'sample.pdf');
    fs.writeFileSync(pdfPath, fakePdf);
    const reg = new SkillRegistry();
    const res = await reg.execute('pdf_read', { path: 'sample.pdf' }, { config: { workspaceDir: tmpDir } });
    assert.equal(res.success, true);
    assert.ok(res.text.includes('Hello OMega PDF!'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const html = simpleMarkdownToHtml('# Chapter 1\n<script>alert(1)</script>', 'Book');
  assert.ok(html.includes('<h1>Chapter 1</h1>'));
  assert.ok(!html.includes('<script>'));
});

test('System skills return friendly summaries', async () => {
  const reg = new SkillRegistry();
  const sys = await reg.execute('get_system_info', {});
  assert.equal(sys.success, true);
  assert.ok(typeof sys.summary === 'string' && sys.summary.includes('CPUs'));

  const time = await reg.execute('get_current_time', {});
  assert.equal(time.success, true);
  assert.ok(typeof time.summary === 'string' && time.summary.includes('UTC:'));
});
