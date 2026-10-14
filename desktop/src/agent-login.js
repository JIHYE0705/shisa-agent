// Claude Code / Codex 가 이 맥에 로그인돼 있는지. 토큰 값은 밖으로 내지 않는다.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function parseClaudeAuth(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  try {
    return JSON.parse(text.slice(start, end + 1))?.loggedIn === true;
  } catch {
    return false;
  }
}

export function codexAuthLoggedIn(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const token = j?.tokens?.access_token;
    return typeof token === 'string' && token.length > 20;
  } catch {
    return false;
  }
}

export function findBin(name, { home = os.homedir(), pathEnv = process.env.PATH || '', exists = fs.existsSync, readdir = fs.readdirSync } = {}) {
  const dirs = [];
  try {
    const root = path.join(home, '.nvm', 'versions', 'node');
    for (const n of readdir(root)) dirs.push(path.join(root, n, 'bin'));
  } catch { /* nvm 없음 */ }
  dirs.push(path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...String(pathEnv).split(':').filter(Boolean));
  for (const d of dirs) {
    const p = path.join(d, name);
    if (exists(p)) return p;
  }
  return null;
}

export function readCodexLoggedIn(home = os.homedir(), readFile = fs.readFileSync) {
  try {
    return codexAuthLoggedIn(readFile(path.join(home, '.codex', 'auth.json'), 'utf8'));
  } catch {
    return false;
  }
}

function runStatus(bin, args, read) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve(read(err, stdout));
    });
  });
}

export async function agentLogin(agent, deps = {}) {
  const locate = deps.findBin ?? findBin;
  if (agent === 'claude') {
    const bin = locate('claude');
    if (!bin) return { installed: false, loggedIn: false };
    const loggedIn = await runStatus(bin, ['auth', 'status'], (_err, stdout) => parseClaudeAuth(stdout));
    return { installed: true, loggedIn };
  }
  if (agent === 'codex') {
    if ((deps.readCodexLoggedIn ?? readCodexLoggedIn)()) return { installed: !!locate('codex'), loggedIn: true };
    const bin = locate('codex');
    if (!bin) return { installed: false, loggedIn: false };
    const loggedIn = await runStatus(bin, ['login', 'status'], (_err, stdout) => {
      const text = String(stdout ?? '');
      return /logged in/i.test(text) && !/not logged in/i.test(text);
    });
    return { installed: true, loggedIn };
  }
  return { installed: false, loggedIn: false };
}
