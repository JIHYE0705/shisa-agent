import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARACTERS, CHARACTER_IDS, characterAssets, okCharacter, VIDEOS } from '../src/character.js';
import { resolveAsset } from '../src/assets.js';
import { sanitizeSettingsPatch } from '../src/settings.js';
import { cannedReply, resetCanned, CANNED_KEYS } from '../src/canned.js';
import { CHARACTER_CANNED } from '../src/character-canned.js';
import { personaFor, systemFor, isStockPersona, SISA_BASE, CHARACTER_BASES } from '../src/persona.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const fileOf = (url) => path.join(ASSETS, resolveAsset(url).rel);

test('캐릭터: 넷, 모르는 id 는 시사', () => {
  assert.deepEqual(CHARACTER_IDS, ['shisa', 'hachi', 'rakko', 'momonga']);
  for (const bad of [undefined, null, '', 'nope', '__proto__', 'constructor', 'Hachi', 3]) assert.equal(okCharacter(bad), 'shisa', String(bad));
  assert.equal(characterAssets('nope').id, 'shisa');
});

test('캐릭터 그림·영상: 주소가 다 허용 목록에 있고 레포 assets 에 실제 파일이 있다(배포에 같이 들어간다)', () => {
  for (const id of CHARACTER_IDS) {
    const a = characterAssets(id);
    const urls = [a.open, ...(a.closed ? [a.closed] : []), ...Object.values(a.videos).flatMap((v) => [v.src, v.poster])];
    for (const u of urls) {
      assert.ok(resolveAsset(u), `${id}: ${u} 허용 목록에 없음`);
      assert.ok(fs.existsSync(fileOf(u)), `${id}: ${u} 파일 없음`);
    }
    assert.equal(a.stills[0], a.open);
  }
  // 시사는 예전 자리 그대로
  assert.deepEqual(characterAssets('shisa').videos, VIDEOS);
  // 셋 다 눈 감은 그림이 있어 시사처럼 깜빡인다, 장면 영상은 카드로
  for (const id of ['hachi', 'rakko', 'momonga']) assert.ok(characterAssets(id).closed, id);
  assert.equal(characterAssets('rakko').videos.dancing.scene, true);
  assert.equal(characterAssets('hachi').videos.dancing.scene, false);
});

test('캐릭터 영상: 알파 캐릭터는 VP9 알파, 장면은 정사각형 512', () => {
  for (const id of ['hachi', 'rakko', 'momonga']) {
    const meta = JSON.parse(fs.readFileSync(path.join(ASSETS, 'characters', id, 'video.json'), 'utf8'));
    for (const [name, view] of [['study', 'studying'], ['plan', 'dancing']]) {
      assert.equal(meta[name].size, 512, `${id}/${name}`);
      assert.equal(meta[name].scene, CHARACTERS[id].scenes[view] === true, `${id}/${name} scene`);
      assert.ok(meta[name].frames > 0);
    }
  }
});

test('설정 저장 본문: character 는 아는 id 만', () => {
  assert.deepEqual(sanitizeSettingsPatch({ character: 'hachi' }), { character: 'hachi' });
  assert.deepEqual(sanitizeSettingsPatch({ character: 'shisa' }), { character: 'shisa' });
  for (const bad of ['nope', '', 1, null, ['hachi'], '__proto__']) assert.equal(sanitizeSettingsPatch({ character: bad }), null, String(bad));
});

test('정해진 말: 캐릭터마다 다르고, 고친 말은 캐릭터와 상관없이 이긴다', () => {
  const ctx = { open: 2, done: 1, next: '보고서', hour: 9 };
  for (const id of ['hachi', 'rakko', 'momonga']) {
    resetCanned();
    const pool = new Set();
    for (let i = 0; i < 12; i++) pool.add(cannedReply('who', ctx, { character: id }));
    for (const t of pool) {
      assert.ok(CHARACTER_CANNED[id].who.some((l) => l === t), `${id}: ${t}`);
      assert.doesNotMatch(t, /시사|스이시/);
    }
  }
  resetCanned();
  assert.match(cannedReply('who', ctx, { character: 'shisa' }), /시사/);
  assert.equal(cannedReply('who', ctx, { character: 'hachi', override: { who: ['내 말'] } }), '내 말');
  // 캐릭터에 없는 키는 시사 말로(빈 답이 나오지 않는다)
  assert.ok(cannedReply('hello', ctx, { character: 'nope' }).length > 0);
});

test('정해진 말 카탈로그: 아는 키만, 아는 자리표시만, 반말 캐릭터는 존댓말 끝(~요)이 없다', () => {
  for (const [id, cat] of Object.entries(CHARACTER_CANNED)) {
    assert.ok(CHARACTER_IDS.includes(id));
    for (const [key, lines] of Object.entries(cat)) {
      assert.ok(CANNED_KEYS.includes(key), `${id}: 모르는 키 ${key}`);
      assert.ok(lines.length > 0);
      for (const l of lines) {
        for (const m of l.matchAll(/\{(\w+)\}/g)) assert.ok(['next', 'open', 'done', 'total', 'rest'].includes(m[1]), `${id}/${key}: {${m[1]}}`);
        assert.doesNotMatch(l.replace(/\*\*/g, ''), /(어|에|해|세|게|죠)요[.!?\s]*$|요\.\n|요!\n/m, `${id}/${key}: ${l}`);
      }
    }
  }
});

test('말투 글(persona): 캐릭터마다, 기본 글은 다 「안 고친 것」으로 본다', () => {
  assert.equal(personaFor('gemini'), personaFor('gemini', 'shisa'));
  assert.ok(personaFor('gemini').startsWith(SISA_BASE));
  for (const id of ['hachi', 'rakko', 'momonga']) {
    const p = personaFor('claude', id);
    assert.ok(p.startsWith(CHARACTER_BASES[id]), id);
    assert.match(p, new RegExp(CHARACTERS[id].name));
    assert.ok(isStockPersona(CHARACTER_BASES[id]), id);
    assert.equal(systemFor('claude', '', id), p);
    assert.ok(systemFor('claude', '내 말투', id).startsWith('내 말투'));
  }
  assert.equal(personaFor('gemini', 'nope'), personaFor('gemini'));
});

test('이름: 「하치와레 비서」처럼, 모르는 id 는 시사', async () => {
  const { appName, characterName } = await import('../src/character.js');
  assert.equal(appName('shisa'), '시사 비서');
  assert.equal(appName('hachi'), '하치와레 비서');
  assert.equal(appName('rakko'), '랏코 비서');
  assert.equal(appName('momonga'), '모몽가 비서');
  assert.equal(characterName('nope'), '시사');
});

test('설치 화면·둘러보기·오버레이 짧은 말: 캐릭터마다 모든 키, 반말 캐릭터는 존댓말·시사 이름이 없다', async () => {
  const { sayFor, SISA_SAY } = await import('../src/ai-onboard.js');
  const { tourSteps } = await import('../src/tour.js');
  const { quickBubble } = await import('../src/quick-ask.js');
  const { LOCAL_SAY } = await import('../src/character.js');
  const keys = Object.keys(SISA_SAY);
  assert.equal(sayFor('shisa'), SISA_SAY);
  assert.equal(sayFor('nope'), SISA_SAY);
  const shisaTour = tourSteps({ ready: true, connected: ['calendar'] }).map((s) => s.text);
  assert.deepEqual(tourSteps({ ready: true, connected: ['calendar'] }, 'shisa').map((s) => s.text), shisaTour);
  const honorific = /(어|에|해|세|게|죠|예)요[.!?\s]|(어|에|해|세|게|죠|예)요$|습니다|시사|스이시/m;
  for (const id of ['hachi', 'rakko', 'momonga']) {
    const say = sayFor(id);
    for (const k of keys) {
      assert.ok(say[k] && say[k] !== SISA_SAY[k], `${id}: 설치 말 ${k} 이 시사 말 그대로`);
      assert.doesNotMatch(say[k], honorific, `${id}/${k}: ${say[k]}`);
    }
    for (const ready of [true, false]) for (const connected of [[], ['calendar', 'slack']]) {
      const steps = tourSteps({ ready, connected }, id);
      assert.equal(steps.length, shisaTour.length);
      for (const s of steps) assert.doesNotMatch(s.text, honorific, `${id}/${s.id}: ${s.text}`);
    }
    for (const t of Object.values(LOCAL_SAY[id])) assert.doesNotMatch(t, honorific, `${id}: ${t}`);
    assert.equal(quickBubble({}, id).text, LOCAL_SAY[id].quick);
    assert.equal(quickBubble({ provider: 'claude-code', known: true }, id).text, LOCAL_SAY[id].quickLogin);
  }
  assert.equal(quickBubble({}).text, LOCAL_SAY.shisa.quick);
});
