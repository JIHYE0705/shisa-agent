# 개인용 치이카와 테마 (작업 중)

오버레이의 **캐릭터** 메뉴에서 치이카와, 가르마(하치와레), 우사기, 밤만주(쿠리만쥬)를 고를 수 있습니다. 선택값은 Electron 렌더러의 localStorage에 저장됩니다.

```text
~/.cy-agent/assets/themes/
  chiikawa/eyes_open.png
  hachiware/eyes_open.png
  usagi/eyes_open.png
  kurimanju/eyes_open.png
```

각 테마에 선택적으로 `eyes_closed.png`, `studying.png`, `studying.webm`, `dance.png`, `dance.webm`, `eyes_open@2x.png`, `eyes_closed@2x.png`을 둘 수 있습니다. 없는 테마 그림은 기존 캐릭터로, 없는 테마 비디오는 기존 애니메이션으로 돌아갑니다. `~/.cy-agent/assets`는 기존 `cy-asset://` 프로토콜이 읽는 사용자 전용 폴더입니다.

참고 이미지 소스: https://www.chiikawaofficial.com/characters · https://chiikawamarket.jp/en/collections/chiikawa · https://chiikawamarket.jp/en/collections/hachiware · https://chiikawamarket.jp/en/collections/usagi · https://chiikawamarket.jp/en/collections/kurimanju

**권리 확인:** 위 링크는 이미지의 복제·GitHub 공개 재배포를 허가하는 라이선스가 아닙니다. 현재 커밋은 이미지 바이너리를 포함하지 않습니다. 개인 로컬 에셋 폴더에 사용하는 방식입니다.
