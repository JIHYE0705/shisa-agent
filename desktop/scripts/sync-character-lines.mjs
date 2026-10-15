// assets/characters/lines.json(캐릭터 대사 — 사람이 고치는 파일) → desktop/src/character-lines.js(렌더러가 import 하는 사본).
// 렌더러는 파일을 못 읽으니 JS 모듈로 옮겨 둔다. lines.json 을 고쳤으면 이걸 돌린다(앱 켜기·dmg 만들기 때도 돈다, 테스트가 어긋나면 잡는다).
// 사용: node scripts/sync-character-lines.mjs [--check]  (--check: 다르면 1로 끝냄)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, '..', 'assets', 'characters', 'lines.json');
export const OUT = path.join(ROOT, 'src', 'character-lines.js');

export function render(json) {
  const data = JSON.parse(json);
  delete data._help;
  return `// 자동으로 만든 파일 — 고치지 마세요. 원본은 assets/characters/lines.json(node scripts/sync-character-lines.mjs)\nexport const CHARACTER_LINES = ${JSON.stringify(data, null, 2)};\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = render(fs.readFileSync(SRC, 'utf8'));
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (want !== have) { console.error('character-lines.js 가 lines.json 과 다릅니다 — node scripts/sync-character-lines.mjs'); process.exit(1); }
  } else if (want !== have) {
    fs.writeFileSync(OUT, want);
    console.log(`→ ${path.relative(process.cwd(), OUT)}`);
  }
}
