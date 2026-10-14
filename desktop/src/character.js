// 캐릭터 상태 — 순수 로직. 렌더러와 테스트가 같이 쓴다.
// 정지 그림: 눈 뜬 그림이 기본, 랜덤 간격으로 잠깐 눈 감은 그림(가끔 두 번 깜빡).
// 활동: 데몬 state { activity, runs, danceId } → 보여줄 것 'idle'(정지 그림) | 'studying'(공부 영상) | 'dancing'(춤 영상).
// 우선순위 dancing > studying > idle. 춤이 끝나면(데몬이 알리거나 로컬 상한) 그 전 상태로 돌아간다.

export const CHAR_DIR = 'cy-asset://app/character';
// 정지 그림 대체 순서: 눈 뜬 그림 → 예전 개인 그림 → 번들 그림 → 번들 svg
export const STILL_SRCS = [`${CHAR_DIR}/eyes_open.png`, 'cy-asset://app/character.png', '../assets/character.png', '../assets/character.svg'];
export const VIDEOS = {
  studying: { src: `${CHAR_DIR}/studying.webm`, poster: `${CHAR_DIR}/studying.png` },
  dancing: { src: `${CHAR_DIR}/dance.webm`, poster: `${CHAR_DIR}/dance.png` },
};

// ---- 깜빡임 ----
export const BLINK = {
  minGap: 2500, maxGap: 7000,           // 다음 깜빡임까지
  reducedMinGap: 9000, reducedMaxGap: 16000, // 동작 줄이기: 드물게
  minClosed: 120, maxClosed: 180,       // 눈 감고 있는 시간
  doubleChance: 0.18, doubleGap: 140,   // 가끔 두 번(동작 줄이기면 안 함)
};

// rand: () => [0,1)
export function nextBlinkDelay(rand = Math.random, reduced = false) {
  const lo = reduced ? BLINK.reducedMinGap : BLINK.minGap;
  const hi = reduced ? BLINK.reducedMaxGap : BLINK.maxGap;
  return Math.round(lo + rand() * (hi - lo));
}

// 한 번의 깜빡임 = 눈 감기·뜨기 단계들. [{ closed: true, ms }, { closed: false, ms }, …] (마지막은 늘 뜬 상태로 끝)
export function blinkPlan(rand = Math.random, reduced = false) {
  const closed = () => Math.round(BLINK.minClosed + rand() * (BLINK.maxClosed - BLINK.minClosed));
  const steps = [{ closed: true, ms: closed() }];
  if (!reduced && rand() < BLINK.doubleChance) steps.push({ closed: false, ms: BLINK.doubleGap }, { closed: true, ms: closed() });
  steps.push({ closed: false, ms: 0 });
  return steps;
}

// ---- 활동 ----
export const ACTIVITIES = ['idle', 'studying', 'dancing'];
export const DANCE_MAX_MS = 15000; // 데몬이 춤 끝을 못 알려도(끊김 등) 이만큼 뒤엔 스스로 멈춘다

export function initialActivity() {
  return { studying: false, dancing: false, danceId: null, endedDance: null, connected: true };
}

// action: { type:'state', activity, runs, danceId } | { type:'danceEnd' } | { type:'connection', connected } | { type:'localDance', on }
export function activityReducer(s, a) {
  switch (a?.type) {
    case 'state': {
      const act = ACTIVITIES.includes(a.activity) ? a.activity : 'idle';
      const runs = Array.isArray(a.runs) ? a.runs.length : 0;
      const studying = act === 'studying' || (act === 'dancing' && runs > 0);
      const danceId = act === 'dancing' ? (typeof a.danceId === 'string' && a.danceId ? a.danceId : 'dance') : null;
      // 로컬에서 이미 끝낸 춤은 같은 id 로 다시 와도(재연결 등) 다시 추지 않는다
      const dancing = !!danceId && danceId !== s.endedDance;
      return { ...s, studying, dancing, danceId, connected: true };
    }
    case 'danceEnd': {
      let n = s;
      if (s.localDance) n = { ...n, localDance: false };
      if (s.dancing) n = { ...n, dancing: false, endedDance: s.danceId };
      return n;
    }
    // 앱이 스스로 추는 짧은 춤(뇌 연결 전 더블클릭 등) — 데몬과 끊겨 있어도 춘다
    case 'localDance':
      return { ...s, localDance: !!a.on };
    case 'connection':
      return a.connected ? { ...s, connected: true } : { ...initialActivity(), connected: false, endedDance: s.endedDance };
    default:
      return s;
  }
}

export function viewOf(s) {
  if (s.localDance) return 'dancing';
  if (!s.connected) return 'idle';
  return s.dancing ? 'dancing' : s.studying ? 'studying' : 'idle';
}
