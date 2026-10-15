// Personal mascot themes. Assets stay under ~/.cy-agent/assets/themes/<id>/.
export const THEMES = Object.freeze({
  chiikawa: '치이카와',
  hachiware: '가르마 · 하치와레',
  usagi: '우사기',
  kurimanju: '밤만주 · 쿠리만쥬',
});
export const THEME_KEY = 'cy-agent-mascot-theme';
export const themeId = (value) => Object.hasOwn(THEMES, value) ? value : 'chiikawa';
export const themeDir = (value) => `cy-asset://app/themes/${themeId(value)}`;
export const themeImage = (value, file) => `${themeDir(value)}/${file}`;
