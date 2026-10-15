import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeAuth, codexAuthLoggedIn, findBin, winExts } from '../src/agent-login.js';

test('Claude 로그인 상태만 읽는다', () => {
  assert.equal(parseClaudeAuth('{"loggedIn": false, "authMethod": "none"}'), false);
  assert.equal(parseClaudeAuth('잡음\n{"loggedIn": true}\n'), true);
  assert.equal(parseClaudeAuth('not json'), false);
});

test('Codex 는 액세스 토큰이 있을 때만 로그인', () => {
  assert.equal(codexAuthLoggedIn({ tokens: { access_token: 'x'.repeat(21) } }), true);
  assert.equal(codexAuthLoggedIn({ tokens: { access_token: 'short' } }), false);
  assert.equal(codexAuthLoggedIn('{'), false);
});

test('실행 파일은 nvm 과 PATH 에서 찾는다', () => {
  const hit = findBin('claude', {
    home: '/home',
    pathEnv: '/usr/bin',
    platform: 'darwin',
    readdir: () => ['v22'],
    exists: (p) => p === '/home/.nvm/versions/node/v22/bin/claude',
  });
  assert.equal(hit, '/home/.nvm/versions/node/v22/bin/claude');
  assert.equal(findBin('codex', { home: '/home', pathEnv: '', platform: 'darwin', readdir: () => [], exists: () => false }), null);
  assert.equal(findBin('gh', { home: '/home', pathEnv: '/a:/b', platform: 'linux', readdir: () => [], exists: (p) => p === '/b/gh' }), '/b/gh');
});

test('윈도우: ~/.local/bin · %APPDATA%\\npm · PATH(;) 에서 PATHEXT 확장자를 붙여 찾고, 확장자 없는 sh 스크립트는 안 고른다', () => {
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' };
  const base = { home: 'C:\\Users\\me', platform: 'win32', env, readdir: () => { throw new Error('nvm 안 봄'); } };
  // Claude Code 설치 스크립트 자리
  assert.equal(findBin('claude', { ...base, pathEnv: '', exists: (p) => p === 'C:\\Users\\me\\.local\\bin\\claude.exe' }), 'C:\\Users\\me\\.local\\bin\\claude.exe');
  // npm 전역: codex(sh)·codex.cmd 가 같이 있으면 .cmd
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  assert.equal(findBin('codex', { ...base, pathEnv: '', exists: (p) => p === `${npm}\\codex` || p === `${npm}\\codex.cmd` }), `${npm}\\codex.cmd`);
  // PATH 는 ; 로 나누고 따옴표·빈 칸은 걸러 낸다. .exe 가 .cmd 보다 먼저(PATHEXT 순서)
  const seen = [];
  const hit = findBin('gh', { ...base, pathEnv: 'C:\\Windows;;"C:\\Program Files\\GitHub CLI"', exists: (p) => { seen.push(p); return /^C:\\Program Files\\GitHub CLI\\gh\.(exe|cmd)$/.test(p); } });
  assert.equal(hit, 'C:\\Program Files\\GitHub CLI\\gh.exe');
  assert.ok(seen.includes('C:\\Windows\\gh.exe'));
  assert.ok(!seen.some((p) => /\.(vbs|js)$/i.test(p))); // 띄울 수 없는 확장자는 안 본다
  assert.ok(!seen.some((p) => /\\gh$/.test(p)));
  // 이미 확장자가 있으면 그대로
  assert.equal(findBin('claude.exe', { ...base, pathEnv: 'D:\\t', exists: (p) => p === 'D:\\t\\claude.exe' }), 'D:\\t\\claude.exe');
  assert.equal(findBin('codex', { ...base, pathEnv: 'C:\\x', exists: () => false }), null);
  assert.deepEqual(winExts(''), ['.com', '.exe', '.bat', '.cmd']);
  assert.deepEqual(winExts('.EXE;.CMD;.exe'), ['.exe', '.cmd']);
});
