# Toonit Manga Lab

DenDenAI의 공개된 NAIManga 작업 흐름을 참고해 만든 AI 만화 제작실 프로토타입입니다.

## 실행

```bash
npm start
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
- NovelAI 이미지 생성과 선택한 컷의 직접 재생성
- 레이아웃 이력 복원과 브라우저 자동 저장

## Gemini 연결

오른쪽 위 설정 버튼에서 Gemini API 키와 모델명을 입력하면 컷별 프롬프트 생성에 Gemini API를 사용합니다. 키는 현재 탭의 `sessionStorage`에만 저장됩니다.

키의 접두사는 제한하지 않으며 `AIza...`, `AQ...` 모두 요청에 전달합니다. 설정 창의 연결 테스트로 해당 키가 Gemini Generative Language API에서 실제로 유효한지 확인할 수 있습니다.

실제 서비스에서는 브라우저에 Gemini API 키를 노출하지 말고 서버 API가 Gemini 호출을 대행하도록 변경해야 합니다.

## NovelAI 이미지 생성

앱의 `API & 설정`에서 `NovelAI API Key`에 persistent API token을 입력하면 현재 브라우저 탭의 `sessionStorage`에만 저장되며 이미지 생성 요청에 사용됩니다.

서버 환경 변수로 설정해 공용 기본 키를 사용할 수도 있습니다.

```bash
NAI_API_TOKEN="your-persistent-api-token" npm start
```

앱의 `API & 설정`에서 Image provider를 `NovelAI API`로 선택합니다. 입력한 키가 있으면 환경 변수보다 우선 사용합니다. 기본 모델은 `nai-diffusion-4-5-full`이며 설정에서 변경할 수 있습니다.

정적 호스팅에서 앱을 연 경우 `/api/nai/*` 프록시가 없으므로 별도로 `npm start`를 실행하고 `NovelAI proxy URL`에 해당 서버 주소(예: `http://localhost:8000`)를 입력해야 합니다. 같은 Node 서버에서 앱을 열었다면 proxy URL은 비워둡니다.

- `NAI Generate`: 아직 이미지가 없는 모든 컷을 순차 생성합니다.
- `이 컷 이미지 재생성`: 선택한 만화 컷의 이미지를 즉시 새 결과로 교체합니다.
- 컷 위의 `↻` 버튼: Editor 또는 Preview의 만화 영역에서 해당 컷을 바로 재생성합니다.
- 생성 크기는 컷의 가로세로 비율에 맞춰 자동 선택되고, 결과 이미지는 컷 영역을 왜곡 없이 채우도록 중앙 크롭됩니다.

서버는 공식 NovelAI 이미지 생성 엔드포인트 `https://image.novelai.net/ai/generate-image`를 사용합니다. 토큰을 프로젝트 파일이나 저장소에 커밋하지 마세요.
