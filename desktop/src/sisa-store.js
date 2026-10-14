// 시사의 AI 연결 저장 모양(sisa-ai.json). 파일 읽기·쓰기는 main 이 하고, 여기는 값만 다룬다.
// 키는 밖으로 내보내는 값(view)에 절대 넣지 않는다.
import { sanitizeCanned } from './canned.js';
import { PERSONA_MAX, isStockPersona } from './persona.js';

export const KEY_PROVIDERS = ['gemini', 'claude', 'openai'];
export const CLI_PROVIDERS = ['claudecode', 'codexcli'];
export const ALL_PROVIDERS = [...KEY_PROVIDERS, ...CLI_PROVIDERS];

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function isModelId(v) {
  return v === 'default' || (typeof v === 'string' && MODEL_RE.test(v));
}

// 예전 모양(provider + apiKey 하나)도 읽는다
export function normalizeSisa(raw) {
  const d = obj(raw);
  const keys = {};
  for (const [k, v] of Object.entries(obj(d.keys))) {
    if (KEY_PROVIDERS.includes(k) && typeof v === 'string' && v.length > 8) keys[k] = v;
  }
  if (KEY_PROVIDERS.includes(d.provider) && typeof d.apiKey === 'string' && d.apiKey.length > 8 && !keys[d.provider]) {
    keys[d.provider] = d.apiKey;
  }
  const clis = {};
  for (const k of CLI_PROVIDERS) if (obj(d.clis)[k] === true || d.provider === k) clis[k] = true;
  const chatModels = {};
  for (const [k, v] of Object.entries(obj(d.chatModels))) {
    if (ALL_PROVIDERS.includes(k) && isModelId(v)) chatModels[k] = v;
  }
  return {
    keys,
    clis,
    provider: ALL_PROVIDERS.includes(d.provider) || d.provider === 'none' ? d.provider : '',
    chatModels,
    codeModel: isModelId(d.codeModel) ? d.codeModel : 'default',
    persona: typeof d.persona === 'string' && !isStockPersona(d.persona) ? d.persona.slice(0, PERSONA_MAX) : '',
    canned: sanitizeCanned(d.canned),
    done: obj(d.done),
  };
}

export function connectedProviders(data) {
  const d = normalizeSisa(data);
  return ALL_PROVIDERS.filter((p) => (KEY_PROVIDERS.includes(p) ? !!d.keys[p] : !!d.clis[p]));
}

// 지금 채팅에 쓰는 AI. 고른 게 연결돼 있지 않으면 없다(정해진 말만).
export function activeProvider(data) {
  const d = normalizeSisa(data);
  if (d.provider === 'none') return '';
  return connectedProviders(d).includes(d.provider) ? d.provider : '';
}

export function brainOf(data) {
  const d = normalizeSisa(data);
  const provider = activeProvider(d);
  if (!provider) return null;
  const model = d.chatModels[provider];
  return { provider, key: d.keys[provider] ?? '', model: model && model !== 'default' ? model : '' };
}

export function publicView(data, defaultPersona = '') {
  const d = normalizeSisa(data);
  const provider = activeProvider(d);
  return {
    provider: d.provider === 'none' ? 'none' : provider,
    hasKey: !!provider,
    persona: d.persona.trim() ? d.persona : defaultPersona,
    canned: d.canned,
    done: d.done,
    connected: connectedProviders(d),
    chatModels: d.chatModels,
    codeModel: d.codeModel,
  };
}

export function withKey(data, provider, key) {
  const d = normalizeSisa(data);
  if (!KEY_PROVIDERS.includes(provider)) return d;
  return { ...d, keys: { ...d.keys, [provider]: String(key).trim() }, provider };
}

export function withCli(data, provider) {
  const d = normalizeSisa(data);
  if (!CLI_PROVIDERS.includes(provider)) return d;
  return { ...d, clis: { ...d.clis, [provider]: true }, provider };
}

export function withSkip(data) {
  return { ...normalizeSisa(data), provider: 'none' };
}

// { chat: { provider, model }, code: model } → 새 데이터. 값이 잘못되면 null.
export function withModels(data, { chat, code } = {}) {
  const d = normalizeSisa(data);
  let next = d;
  if (chat !== undefined) {
    if (chat === 'none') {
      next = { ...next, provider: 'none' };
    } else {
      const p = chat?.provider;
      const m = chat?.model;
      if (!connectedProviders(d).includes(p) || !isModelId(m)) return null;
      next = { ...next, provider: p, chatModels: { ...next.chatModels, [p]: m } };
    }
  }
  if (code !== undefined) {
    if (!isModelId(code)) return null;
    next = { ...next, codeModel: code };
  }
  return next;
}

// { persona, canned } 중 온 것만 바꾼다. 잘못된 칸은 무시.
export function withVoice(data, { persona, canned } = {}) {
  const d = normalizeSisa(data);
  let next = d;
  if (persona !== undefined) {
    const p = typeof persona === 'string' ? persona.replace(/\r\n/g, '\n').trim().slice(0, PERSONA_MAX) : '';
    next = { ...next, persona: isStockPersona(p) ? '' : p };
  }
  if (canned !== undefined) next = { ...next, canned: sanitizeCanned(canned) };
  return next;
}

// 고른 AI → 시사 데몬 설정(~/.cy-agent/config.json)의 brain·models.general 로 옮길 값.
// 패널 채팅·캐릭터 대화·브리핑은 전부 데몬이 답한다(Claude API 키도 데몬의 anthropic 뇌로) — 'none' 은 로컬 뇌(정해진 말·간단한 답)
export const DAEMON_BRAIN = { claudecode: 'claude-code', codexcli: 'codex', gemini: 'gemini', openai: 'openai', claude: 'anthropic', none: 'local' };
const KEY_FIELD = { gemini: 'geminiApiKey', openai: 'openaiApiKey', claude: 'anthropicApiKey' };
export function daemonBrainPatch(data) {
  const d = normalizeSisa(data);
  const chosen = d.provider === 'none' ? 'none' : activeProvider(d);
  const provider = DAEMON_BRAIN[chosen];
  if (!provider) return null;
  const brain = { provider };
  if (KEY_FIELD[chosen]) brain[KEY_FIELD[chosen]] = d.keys[chosen];
  const m = d.chatModels[chosen];
  // models.general: 고른 모델(기본값이면 비운다). codex·local 은 데몬 쪽 기본을 그대로
  const general = chosen === 'codexcli' || chosen === 'none' ? undefined : m && m !== 'default' ? m : null;
  return { brain, general };
}

// daemonBrainPatch → PUT /settings 본문 { brain: { provider, keys?, model? } } — 데몬이 재시작 없이 바로 쓴다
export function settingsBrainBody(patch) {
  if (!patch?.brain?.provider) return null;
  const b = { provider: patch.brain.provider };
  const keys = {};
  if (patch.brain.geminiApiKey) keys.gemini = patch.brain.geminiApiKey;
  if (patch.brain.openaiApiKey) keys.openai = patch.brain.openaiApiKey;
  if (patch.brain.anthropicApiKey) keys.anthropic = patch.brain.anthropicApiKey;
  if (Object.keys(keys).length) b.keys = keys;
  if (patch.general !== undefined) b.model = patch.general || null;
  return { brain: b };
}

// 데몬 설정 객체에 patch 를 얹은 새 객체(다른 칸·다른 키는 그대로)
export function withDaemonBrain(cfg, patch) {
  const c = obj(cfg);
  const next = { ...c, brain: { ...obj(c.brain), ...patch.brain } };
  if (patch.general !== undefined) {
    const models = { ...obj(c.models) };
    if (patch.general) models.general = patch.general;
    else delete models.general;
    if (Object.keys(models).length) next.models = models;
    else delete next.models;
  }
  return next;
}
