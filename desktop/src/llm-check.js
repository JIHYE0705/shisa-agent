// 공급자 API 키 확인과 짧은 대화. 키는 오류 문구에 남기지 않는다.
// 'claudecode'·'codexcli' 는 키 없이, 이 맥에 로그인된 Claude Code(claude -p)·Codex(codex exec)로 말한다.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBin } from './agent-login.js';

// gemini 는 모델이 자주 바뀌어(옛 모델은 새 사용자에게 막힌다) 키로 목록을 받아 가장 새 flash 를 쓴다.
// 목록을 못 받으면 아래 값을 쓴다.
const MODELS = {
  gemini: 'gemini-3.8-flash',
  claude: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
};

function clip(text, key) {
  return String(text ?? '').replaceAll(key, '…').slice(0, 280);
}

async function readBody(res, key) {
  const text = await res.text();
  if (res.ok) return { ok: true, text };
  return { ok: false, error: clip(text, key) || `HTTP ${res.status}` };
}

export async function checkLlm(provider, apiKey, fetchImpl = globalThis.fetch) {
  const key = String(apiKey ?? '').trim();
  if (!key) return { ok: false, error: '키가 비어 있습니다.' };
  try {
    if (provider === 'gemini') {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      const body = await readBody(res, key);
      return body.ok ? { ok: true } : { ok: false, error: body.error };
    }
    if (provider === 'openai') {
      const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      const body = await readBody(res, key);
      if (!body.ok && /quota|billing|insufficient/i.test(body.error)) {
        return { ok: false, error: '키는 맞을 수 있지만 크레딧이 없습니다. 플랫폼 결제에서 크레딧을 사야 합니다.' };
      }
      return body.ok ? { ok: true } : { ok: false, error: body.error };
    }
    if (provider === 'claude') {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODELS.claude,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const body = await readBody(res, key);
      return body.ok ? { ok: true } : { ok: false, error: body.error };
    }
  } catch (e) {
    return { ok: false, error: clip(e?.message, key) || '확인에 실패했습니다.' };
  }
  return { ok: false, error: '알 수 없는 AI입니다.' };
}

// 'gemini-3.8-flash' 같은 일반 flash 중 가장 새 것. lite·preview·image·tts 등은 뺀다.
export function bestGeminiModel(models) {
  const ver = (id) => (/^gemini-(\d+(?:\.\d+)*)-flash$/.exec(id)?.[1] ?? '').split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const d = (b[i] ?? 0) - (a[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const ids = (models ?? []).map((m) => (typeof m === 'string' ? m : m.id)).filter((id) => ver(id).length > 0 && ver(id)[0] > 0);
  return ids.sort((a, b) => cmp(ver(a), ver(b)))[0] ?? '';
}

const geminiPicked = new Map(); // 이 실행 동안만, 키별로 기억(디스크에 쓰지 않는다)

async function geminiModel(key, fetchImpl) {
  if (geminiPicked.has(key)) return geminiPicked.get(key);
  let id = '';
  try {
    const list = await listModels('gemini', key, fetchImpl);
    if (list.ok) id = bestGeminiModel(list.models);
  } catch { /* 아래 기본값 */ }
  id ||= MODELS.gemini;
  geminiPicked.set(key, id);
  return id;
}

function geminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text || '').join('').trim();
}

export function cliPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= 1) return String(list[0]?.content ?? '');
  return list.map((m) => `${m.role === 'assistant' ? '시사' : '사용자'}: ${m.content}`).join('\n');
}

export function completeCli({ system, messages, model }, { exec = execFile, bin = findBin('claude'), cwd = os.tmpdir(), timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) { resolve({ ok: false, error: 'Claude Code 를 찾지 못했습니다.' }); return; }
    const args = [
      '-p',
      '--system-prompt', String(system ?? ''),
      '--tools', '',
      '--setting-sources', '',
      '--no-session-persistence',
      '--disable-slash-commands',
      ...(model && model !== 'default' ? ['--model', model] : []),
      '--', cliPrompt(messages),
    ];
    const child = exec(bin, args, { cwd, timeout, maxBuffer: 256 * 1024 }, (err, stdout) => {
      const text = String(stdout ?? '').trim();
      if (err || !text) resolve({ ok: false, error: 'Claude Code 가 대답하지 못했습니다.' });
      else resolve({ ok: true, text });
    });
    child?.stdin?.end();
  });
}

const CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';

export function codexBin(find = findBin, exists = fs.existsSync) {
  return find('codex') || (exists(CODEX_APP_BIN) ? CODEX_APP_BIN : null);
}

export function completeCodex({ system, messages, model }, { exec = execFile, bin = codexBin(), cwd = os.tmpdir(), timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) { resolve({ ok: false, error: 'Codex 를 찾지 못했습니다.' }); return; }
    const list = Array.isArray(messages) ? messages : [];
    const body = list.map((m) => `${m.role === 'assistant' ? '시사' : '사용자'}: ${m.content}`).join('\n');
    const prompt = `${String(system ?? '')}\n명령이나 도구는 쓰지 않고 말로만 답한다.\n\n${body}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sisa-codex-'));
    const out = path.join(dir, 'last.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '--color', 'never', ...(model && model !== 'default' ? ['-m', model] : []), '-o', out, '--', prompt];
    const child = exec(bin, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err) => {
      let text = '';
      try { text = fs.readFileSync(out, 'utf8').trim(); } catch { /* 답 파일 없음 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무시 */ }
      if (err || !text) resolve({ ok: false, error: 'Codex 가 대답하지 못했습니다.' });
      else resolve({ ok: true, text });
    });
    child?.stdin?.end(); // 입력이 더 없다고 알린다. 안 닫으면 codex 가 입력을 계속 기다린다
  });
}

export async function completeLlm(provider, apiKey, { system, messages, model }, fetchImpl = globalThis.fetch) {
  if (provider === 'claudecode') return completeCli({ system, messages, model });
  if (provider === 'codexcli') return completeCodex({ system, messages, model });
  const key = String(apiKey ?? '').trim();
  if (provider === 'gemini') {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const useModel = model || await geminiModel(key, fetchImpl);
    const res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
        }),
      },
    );
    const body = await readBody(res, key);
    if (!body.ok) return body;
    return { ok: true, text: geminiText(JSON.parse(body.text)) };
  }
  if (provider === 'claude') {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || MODELS.claude,
        max_tokens: 400,
        system,
        messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      }),
    });
    const body = await readBody(res, key);
    if (!body.ok) return body;
    const json = JSON.parse(body.text);
    return { ok: true, text: (json.content || []).map((c) => c.text || '').join('').trim() };
  }
  if (provider === 'openai') {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model || MODELS.openai,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    const body = await readBody(res, key);
    if (!body.ok) return body;
    const json = JSON.parse(body.text);
    return { ok: true, text: json.choices?.[0]?.message?.content?.trim() || '' };
  }
  return { ok: false, error: '알 수 없는 AI입니다.' };
}

export async function revisePersona(provider, apiKey, persona, instruction, fetchImpl = globalThis.fetch, model = '') {
  const system = '너는 비서의 말투 설명만 고친다. 설명문 전체만 출력한다. 따옴표나 머리말은 붙이지 않는다.';
  const messages = [{
    role: 'user',
    content: `지금 설명:\n${persona}\n\n사용자가 바라는 말투:\n${instruction}\n\n할 일 완료를 보고 칭찬하거나 응원하는 역할은 유지한 채, 말투만 고쳐 설명문 전체를 다시 써라.`,
  }];
  const out = await completeLlm(provider, apiKey, { system, messages, model }, fetchImpl);
  if (!out.ok) return out;
  const text = String(out.text || '').trim();
  if (!text) return { ok: false, error: '말투를 고치지 못했습니다.' };
  return { ok: true, persona: text };
}

// 고를 수 있는 모델 목록. 키는 요청에만 쓰고 결과에는 넣지 않는다.
export const CLI_MODELS = {
  claudecode: [
    { id: 'default', label: '기본값 (Claude Code 설정 따름)' },
    { id: 'sonnet', label: 'Sonnet · 균형' },
    { id: 'opus', label: 'Opus · 가장 똑똑함, 느림' },
    { id: 'haiku', label: 'Haiku · 빠르고 가벼움' },
  ],
  codexcli: [{ id: 'default', label: '기본값 (Codex 설정 따름)' }],
};

const NOT_CHAT = /(embedding|audio|image|tts|whisper|realtime|transcribe|moderation|search|instruct|dall|computer-use|codex)/i;

export function pickModels(provider, json) {
  if (provider === 'gemini') {
    return (json?.models ?? [])
      .filter((m) => String(m.name).includes('gemini') && (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || '' }))
      .sort((a, b) => b.id.localeCompare(a.id));
  }
  if (provider === 'claude') {
    return (json?.data ?? []).map((m) => ({ id: String(m.id), label: m.display_name || '' }));
  }
  if (provider === 'openai') {
    return (json?.data ?? [])
      .map((m) => String(m.id))
      .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_CHAT.test(id))
      .sort((a, b) => b.localeCompare(a))
      .map((id) => ({ id, label: '' }));
  }
  return [];
}

export async function listModels(provider, apiKey, fetchImpl = globalThis.fetch) {
  if (CLI_MODELS[provider]) return { ok: true, models: CLI_MODELS[provider] };
  const key = String(apiKey ?? '').trim();
  if (!key) return { ok: false, error: '키가 없습니다.' };
  try {
    let res;
    if (provider === 'gemini') {
      res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
    } else if (provider === 'claude') {
      res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    } else if (provider === 'openai') {
      res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    } else {
      return { ok: false, error: '알 수 없는 AI입니다.' };
    }
    const body = await readBody(res, key);
    if (!body.ok) return { ok: false, error: body.error };
    return { ok: true, models: pickModels(provider, JSON.parse(body.text)).slice(0, 60) };
  } catch (e) {
    return { ok: false, error: clip(e?.message, key) || '목록을 못 가져왔습니다.' };
  }
}
