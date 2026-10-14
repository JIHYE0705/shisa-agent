// SSE 파서 — 의존성 없이 text/event-stream 청크를 이벤트로 바꾼다.
// 스펙: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation

export function createSSEParser(onEvent, { onRetry } = {}) {
  let buf = '';
  let eventName = '';
  let data = [];
  let lastId = '';
  let sawData = false;

  function dispatch() {
    if (sawData) {
      onEvent({ event: eventName || 'message', data: data.join('\n'), id: lastId });
    }
    eventName = '';
    data = [];
    sawData = false;
  }

  function line(l) {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return; // 주석(하트비트)
    const i = l.indexOf(':');
    let field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': eventName = value; break;
      case 'data': data.push(value); sawData = true; break;
      case 'id': if (!value.includes('\0')) lastId = value; break;
      case 'retry': if (/^\d+$/.test(value) && onRetry) onRetry(Number(value)); break;
      default: break; // 모르는 필드는 무시
    }
  }

  return {
    push(chunk) {
      buf += chunk;
      // \r\n, \n, \r 모두 줄바꿈. 끝이 \r 이면 다음 청크의 \n 을 기다린다.
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === '\n' || c === '\r') {
          if (c === '\r' && i === buf.length - 1) break;
          line(buf.slice(start, i));
          if (c === '\r' && buf[i + 1] === '\n') i++;
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    },
    // 스트림 종료: 미완성 이벤트는 버린다(스펙대로)
    end() { buf = ''; eventName = ''; data = []; sawData = false; },
    get lastEventId() { return lastId; },
  };
}

// 재연결 백오프 — 1s, 2s, 4s … 최대 30s. jitter 는 테스트에서 끌 수 있게.
export function backoffDelay(attempt, { base = 1000, max = 30000, jitter = Math.random } = {}) {
  const d = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(d * (0.8 + 0.4 * jitter()));
}
