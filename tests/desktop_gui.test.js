import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillRegistry } from '../dist/skills/index.js';
import { escapeSendKeysText, mapHotkeyToSendKeys } from '../dist/skills/desktop.js';

test('Desktop GUI skills are registered in SkillRegistry', () => {
  const reg = new SkillRegistry();
  const names = reg.list().map((s) => s.name);
  for (const expected of [
    'screen_capture',
    'list_windows',
    'desktop_click',
    'desktop_type',
    'desktop_hotkey'
  ]) {
    assert.ok(names.includes(expected), `Missing skill: ${expected}`);
  }
});

test('Desktop GUI tools enforce approval gates and format SendKeys safely', async () => {
  const reg = new SkillRegistry();

  for (const [tool, args] of [
    ['desktop_click', { x: 100, y: 200 }],
    ['desktop_type', { text: 'hello' }],
    ['desktop_hotkey', { keys: ['ctrl', 's'] }]
  ]) {
    const noHandler = await reg.execute(tool, args, {});
    assert.equal(noHandler.success, false);
    assert.match(noHandler.error, /requires human approval/i);

    const blocked = await reg.execute(tool, args, { confirmCommand: async () => false });
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /rejected by user/i);
  }

  assert.equal(escapeSendKeysText('a+b^c%d(e)'), 'a{+}b{^}c{%}d{(}e{)}');
  assert.equal(mapHotkeyToSendKeys(['ctrl', 'shift', 's']), '^+s');
  assert.equal(mapHotkeyToSendKeys(['alt', 'tab']), '%{TAB}');
});
