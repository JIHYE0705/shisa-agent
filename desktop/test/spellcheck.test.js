import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('main.js 배선: 세션 맞춤법 검사기를 꺼서 첫 실행에 사전(bdic)을 받지 않는다', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /^import \{[^}]*\bsession\b[^}]*\} from 'electron';/m);
  // 기본 세션: 준비되자마자, 창을 만들기 전에
  const ready = main.indexOf('app.whenReady().then(() => {');
  const off = main.indexOf('session.defaultSession.setSpellCheckerEnabled(false)');
  assert.ok(ready > 0 && off > ready, 'whenReady 안에서 끈다');
  assert.ok(off < main.indexOf('createWindow();', ready), '창보다 먼저');
  // 나중에 생기는 세션(fromPartition 등)도
  assert.match(main, /app\.on\('session-created', \(s\) => s\.setSpellCheckerEnabled\(false\)\);/);
  assert.ok(main.indexOf("app.on('session-created'") < ready);
  // 창은 모두 spellcheck:false
  const wins = main.match(/new BrowserWindow\(/g) ?? [];
  const offs = main.match(/spellcheck: false/g) ?? [];
  assert.ok(wins.length > 0 && offs.length >= wins.length, `창 ${wins.length}개, spellcheck:false ${offs.length}개`);
});
