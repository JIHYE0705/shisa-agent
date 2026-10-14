import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from '../renderer/vendor/marked.js';
import { createMarkdown, escapeHtml } from '../src/markdown.js';

const md = createMarkdown(Marked);

test('기본 마크다운', () => {
  const h = md('# 제목\n\n- **a**\n- b');
  assert.match(h, /<h1>제목<\/h1>/);
  assert.match(h, /<strong>a<\/strong>/);
});

test('링크: http/https/slack 만 a 태그, 나머지는 글자만', () => {
  assert.match(md('[ok](https://example.com)'), /<a href="https:\/\/example.com">ok<\/a>/);
  assert.match(md('[s](slack://channel?id=1)'), /<a href="slack:\/\/channel\?id=1">s<\/a>/);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'relative/path']) {
    const h = md(`[bad](${bad})`);
    assert.doesNotMatch(h, /<a /, bad);
    assert.match(h, /bad/);
  }
});

test('원시 HTML·이미지는 글자로', () => {
  const h = md('<img src=x onerror=alert(1)>\n\n![고양이](https://x/c.png)\n\n텍스트 <b>굵게</b>');
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h, /<b>/);
  assert.match(h, /&lt;img/);
  assert.match(h, /고양이/);
});

test('escapeHtml / 빈 입력', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(md(''), '');
  assert.equal(md(null), '');
});

test('한글 조사 앞 굵게도 렌더', async () => {
  const { Marked } = await import('../renderer/vendor/marked.js');
  const { createMarkdown } = await import('../src/markdown.js');
  const render = createMarkdown(Marked);
  assert.match(render('1등은 **adk-agent(HAO)**야.'), /<strong>adk-agent\(HAO\)<\/strong>야/);
  assert.match(render('**27개**로 제일 많아'), /<strong>27개<\/strong>로/);
  assert.match(render('**굵게 [링크](https://x.com)**다'), /<strong>굵게 <a href="https:\/\/x.com">링크<\/a><\/strong>다/);
  assert.doesNotMatch(render('2 ** 3 = 8'), /<strong>/);
  assert.match(render('| a |\n|---|\n| **b**야 |'), /<td><strong>b<\/strong>야<\/td>/);
});

test('콜아웃·글자색·형광펜', () => {
  const render = createMarkdown(Marked);
  const w = render('> [!WARNING]\n> 마감이 **오늘**이야');
  assert.match(w, /<div class="callout callout-warning"><div class="callout-title">⚠️ 주의<\/div>/);
  assert.match(w, /마감이 <strong>오늘<\/strong>이야/);
  assert.doesNotMatch(w, /\[!WARNING\]/);
  assert.match(render('> [!TIP] 한 줄 팁'), /callout-tip[\s\S]*한 줄 팁/);
  assert.match(render('> 그냥 인용'), /<blockquote>/);
  assert.match(render('상태: :green[완료] / :red[**지연**]'), /<span class="c-green">완료<\/span> \/ <span class="c-red"><strong>지연<\/strong><\/span>/);
  assert.doesNotMatch(render(':pink[x]'), /<span/);
  assert.match(render('이건 ==중요==해'), /<mark>중요<\/mark>해/);
  assert.match(render('| a | b |\n|---|---|\n| :blue[진행] | ==x== |'), /<td><span class="c-blue">진행<\/span><\/td>/);
});
