# Toonit Manga Lab

DenDenAI의 공개된 NAIManga 작업 흐름을 참고해 만든 AI 만화 제작실 프로토타입입니다.

## 실행

```bash
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 엽니다. API 키 없이도 데모 엔진으로 전체 흐름을 확인할 수 있습니다.

## 구현 기능

- Manga Prompt 입력, 요약, JSON 프로젝트 가져오기/내보내기
- 캐릭터 프로필과 컷별 캐릭터 연결
- Manga/Webtoon, 페이지 수, 페이지당 컷 수, 읽기 방향 설정
- Gemini Lite/Deep 기반 컷별 연출, 페이지 구성, 이미지 프롬프트 생성
- 페이지 레이아웃 Editor/Preview와 패널 상세 편집
- Gemini가 설계하는 가로/세로/강조/비스듬한 컷 혼합 레이아웃과 페이지별 재구성
- 레퍼런스 이미지 연결, 패널별/전체 순차 생성 큐
- 레이아웃 이력 복원과 브라우저 자동 저장

## Gemini 연결

오른쪽 위 설정 버튼에서 Gemini API 키와 모델명을 입력하면 컷별 프롬프트 생성에 Gemini API를 사용합니다. 키는 현재 탭의 `sessionStorage`에만 저장됩니다.

키의 접두사는 제한하지 않으며 `AIza...`, `AQ...` 모두 요청에 전달합니다. 설정 창의 연결 테스트로 해당 키가 Gemini Generative Language API에서 실제로 유효한지 확인할 수 있습니다.

실제 서비스에서는 브라우저에 API 키를 노출하지 말고, 서버 API가 Gemini 호출을 대행하도록 변경해야 합니다. `NAI Generate`는 현재 순차 생성 큐와 결과 상태를 시뮬레이션합니다. NovelAI 또는 다른 이미지 API는 `app.js`의 `queue` 처리 내부에 연결하면 됩니다.
