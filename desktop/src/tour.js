// 사용법 둘러보기(설치 마법사가 끝나면 한 번, 메뉴·설정 「사용법 다시 보기」로 언제든) — 순수 로직.
// 캐릭터가 말풍선으로 하나씩 가리킨다. 연결된 것에 맞춰 문구가 바뀌고, 안 된 기능은 "연결하면 이런 것도 돼요"로.
export const TOUR_VERSION = 1;

// view: brain-state.js brainView 결과
export function tourSteps(view = {}) {
  const ready = view.ready !== false;
  const cal = (view.connected ?? []).includes('calendar');
  const slack = (view.connected ?? []).includes('slack');
  const steps = [
    {
      id: 'character',
      text: ready
        ? '안녕하세요, 시사예요! 저를 **한 번** 누르면 패널, **두 번** 누르면 바로 말 걸 수 있어요. 오른쪽 클릭은 메뉴, 끌어서 옮길 수도 있어요.'
        : '안녕하세요, 시사예요! 저를 **한 번** 누르면 패널이 열려요. 뇌(AI)를 연결하면 **두 번** 눌러 바로 말 걸 수 있어요.',
    },
    {
      id: 'todos', section: 'todos',
      text: '패널엔 할 일이 모여요. **▶** 로 「진행 중」 표시, **↻** 로 슬랙·메일 새로 읽기, 지운 건 **휴지통**에 30일 남아요.',
    },
    {
      id: 'chat', section: 'chat',
      text: ready
        ? '채팅에선 길게 이야기하고 파일도 붙일 수 있어요. 대화는 왼쪽 목록에 남아요.'
        : 'AI 없이도 할 일은 정해진 말로 알려 드려요. 뇌(AI)를 연결하면 여기서 자유롭게 대화할 수 있어요.',
    },
    {
      id: 'today', section: 'today',
      text: `**오늘 할 일** 표예요. 아침마다 적어 달라고 물어볼게요.${cal ? ' 회의 10분 전엔 춤추며 알려 드려요.' : ' 캘린더를 연결하면 회의 10분 전에도 알려 드려요.'}`,
    },
    {
      id: 'settings',
      text: `설정(⚙)에서 연결·문구·모델을 바꿀 수 있어요.${slack ? '' : ' 슬랙을 연결하면 DM·멘션도 바로 할 일로 만들어요.'} 이 안내는 메뉴 「사용법 다시 보기」로 다시 볼 수 있어요.`,
    },
  ];
  return steps.map((s, i) => ({ ...s, step: i + 1, total: steps.length }));
}

// 한 장면 → 캐릭터 말풍선
export function tourBubble(s) {
  return { id: 'local-tour', text: `${s.text}`, kind: 'info', ttlMs: 600000, tour: { step: s.step, total: s.total } };
}
