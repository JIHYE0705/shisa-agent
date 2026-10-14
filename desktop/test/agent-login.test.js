import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeAuth, codexAuthLoggedIn, findBin } from '../src/agent-login.js';

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
    readdir: () => ['v22'],
    exists: (p) => p === '/home/.nvm/versions/node/v22/bin/claude',
  });
  assert.equal(hit, '/home/.nvm/versions/node/v22/bin/claude');
  assert.equal(findBin('codex', { home: '/home', pathEnv: '', readdir: () => [], exists: () => false }), null);
});
