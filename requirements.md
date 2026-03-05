# AI Copilot 워크플로우 자동 생성 기능

**프로젝트**: Sim Workflow Builder
**기능**: Local LLM 기반 Copilot 워크플로우 자동 생성
**날짜**: 2026-03-04

---

## 🎯 핵심 목표

`http://localhost:3000/workspace` 페이지의 Copilot UI에서:
1. 사용자가 자연어 프롬프트 입력
2. 로컬 설치된 LLM (Claude Code / Codex / Gemini) 활용
3. Sim의 블록 컴포넌트를 자동으로 조합해 워크플로우 생성
4. 생성된 워크플로우를 Workspace에 즉시 반영

**기본 서버**: sim.ai Copilot 서버 **사용하지 않음** → 로컬 LLM만 사용

---

## 🔧 기술 제약사항

### LLM 제공자 (Local Only)
- ✅ Claude Code (로컬)
- ✅ Codex (로컬)
- ✅ Gemini (로컬)
- ❌ sim.ai Copilot 서버 (비사용)

### 환경
- **설정 위치**: `/apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/copilot`
- **기존 컴포넌트**: `copilot-message`, `thinking-block` 등 활용
- **워크플로우 API**: 기존 `/api/workflows/*` 사용

---

## 📋 필수 요구사항

### 1️⃣ 로컬 LLM 모델 선택 (🔴 필수)
**상태**: 연결 검사 → 모델 목록 필터링

- [ ] 로컬에 설치된 모델만 Dropdown에 표시
- [ ] 미지원 모델: `disabled` 상태로 표시 (선택 불가)
- [ ] 모델 호환성 자동 감지
  - 시작 시 각 LLM 제공자 `/health` 또는 `/models` 엔드포인트 체크
  - 응답 없으면 목록에서 제외
- [ ] 선택된 모델 정보 UI에 표시 (예: "Claude Code v3.1 connected")

**UI 예시**:
```
[Model Selection ▼]
✅ Claude Code (connected)
✅ Codex (connected)
❌ Gemini (disabled - not installed)
⚠️ GPT-4 (disabled - requires API key)
```

---

### 2️⃣ 실시간 연결 상태 & 스트리밍 표시 (🔴 필수)
**상태**: 로딩 → 연결 → 작업 중

#### 연결 중 (Connecting)
- 점(dot) 로딩 애니메이션: `●  ●  ●` (펄싱)
- 텍스트: "Connecting to {ModelName}..."
- 취소 버튼: 연결 중단 가능

#### 연결 완료 & 작업 중 (Processing)
Claude Code / Cursor IDE 스타일로 **단계별 상세 정보 스트리밍**:

```
🔄 Planning (현재 단계)
   - 사용자 요청: "이메일 발송 워크플로우 생성"
   - 분석 중...

💭 Thinking
   - 필요 블록: Email, Trigger, Condition, Logging
   - 데이터 흐름 설계 중...

⚙️ Component Selection
   - Email block 선택
   - HTTP block 선택
   - (진행 중)

🔄 Configuration
   - (대기 중)
```

**구현 세부사항**:
- SSE (Server-Sent Events) 또는 WebSocket으로 스트리밍
- 각 단계: `{icon} {Step Name}` + 상세 내용
- 생각 단계 (thinking): 접힌 상태로 기본 표시, 클릭 시 펼치기
- 스트리밍 텍스트는 하나씩 타이핑 애니메이션 또는 청크 단위로 표시

---

### 3️⃣ 에러 처리 & 사용자 인식 (🔴 필수)
**상태**: LLM 에러 발생 시 원문 노출

- [ ] Rate Limit Error
  ```
  ❌ Error: Rate limit exceeded
  모델이 요청 한도를 초과했습니다.
  대기 시간: 60초 후 재시도 가능
  ```

- [ ] Connection Error
  ```
  ❌ Error: Failed to connect to Claude Code
  포트 3001에서 응답이 없습니다. 로컬 환경을 확인해주세요.
  ```

- [ ] Invalid Request Error
  ```
  ❌ Error: Invalid prompt format
  프롬프트가 너무 길거나 형식이 잘못되었습니다.
  ```

- [ ] 에러 메시지는 Copilot 메시지 영역에 **그대로 노출**
- [ ] 사용자가 원인을 명확히 파악 가능해야 함
- [ ] "재시도" 버튼 제공

---

### 4️⃣ 사용자 승인 요청 흐름 (🟡 선택)
**상태**: 특정 작업에서 승인 필요 시

예시 시나리오:
- 외부 API 호출 (이메일, Slack 등)
- 민감한 정보 처리 (DB 삭제, 결제 처리 등)
- 수정 사항이 큰 경우

**UI**:
```
⚠️ Approval Required
"외부 이메일 서비스를 사용하려면 API Key 인증이 필요합니다."

[Approve] [Cancel]
```

- [ ] 승인 필요 시 다음 단계 진행 일시중지
- [ ] 사용자가 명시적으로 선택할 때까지 대기
- [ ] Cancel 시: 진행 상황 저장, 작업 중단

---

### 5️⃣ 설정값 후처리 (API Key 등) (🟡 선택)
**상태**: 워크플로우 생성 후 사용자 입력

**규칙**:
- [ ] API Key, 토큰, 인증정보는 **워크플로우 생성 이후** 입력 가능
- [ ] 설정값 부족으로 인해 생성 작업을 **중단하지 않음**
- [ ] 생성 완료 후, 설정이 필요한 블록에 경고 표시:
  ```
  ⚠️ Configuration Required
  [Email Block] - API Key not configured
  ```

**예시**:
```
사용자: "이메일 자동 발송 워크플로우"
↓
LLM: Email block 선택, SMTP 설정 자동화
↓
결과: 워크플로우 생성 완료 (Email block은 설정 대기)
↓
사용자: 나중에 Email block의 API Key 입력

❌ 작업 중단 금지 (설정값 때문에)
✅ 워크플로우는 먼저 완성
```

---

### 6️⃣ 요구사항 명확화 (🔵 권장)
**상태**: 모호한 프롬프트 → 사용자 질문

**규칙**:
- [ ] 사용자 입력이 모호한 경우, **작업 시작 전** 질문
- [ ] 명확한 계획 확보 후 워크플로우 생성 시작

**예시**:
```
사용자: "데이터 처리 워크플로우"

LLM: 다음 항목을 확인해주세요:
- 입력 데이터: CSV, JSON, Database?
- 처리 방식: 필터링, 변환, 병합?
- 출력 형식: 파일, DB, API?

👤 사용자 답변 입력...
↓
워크플로우 생성 시작
```

---

## 🔄 처리 흐름 (State Machine)

```
┌─────────────────────────────────────┐
│  1. User Input Prompt               │
│  (프롬프트 입력)                     │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  2. Requirement Clarification?      │
│  (모호함 검사)                       │
└────┬────────────────────────────────┘
     │
     ├─ 모호함 → [질문] → 사용자 입력 ─┐
     │                                  │
     ├─ 명확함 ──────────────────────────┤
     │                                  │
     └──────────────────────────────────┘
                      │
                      ▼
         ┌──────────────────────────┐
         │ 3. Connect to Local LLM  │
         │ (로컬 모델 연결)          │
         │ 점 로딩 표시             │
         └────────┬─────────────────┘
                  │
                  ├─ Success ─┐
                  │            │
                  ├─ Timeout ──┤
                  │            │
                  └─ Error ────┤
                               │
                               ▼
              ┌────────────────────────────┐
              │ 4. Stream Processing Steps │
              │ (단계별 작업 중)            │
              │ • Planning                 │
              │ • Selection                │
              │ • Configuration            │
              │ • Generation               │
              └────────┬───────────────────┘
                       │
         ┌─────────────┴──────────────┐
         │                            │
         ▼                            ▼
  ┌────────────────┐         ┌──────────────┐
  │ Approval Req?  │         │ Configuration│
  │ (승인 필요?)    │         │ Required?    │
  └────┬───────────┘         │ (설정 필요?)  │
       │                     └──────┬───────┘
       ├─ Yes ──────┐              │
       │            │              │
       └─ No ───────┤              │
                    │              │
                    ▼              ▼
         ┌───────────────────┐    ┌──────────────┐
         │ 5. Workflow       │    │ 6. Display   │
         │ Generated         │    │ Config       │
         │ ✅ Complete       │    │ Required     │
         └───────────────────┘    │ Warnings ⚠️  │
                                  └──────────────┘
```

---

## 💡 구현 세부사항

### API 엔드포인트 (신규)
```
POST /api/copilot/workflow-generate
- Input: { prompt, modelProvider, modelName }
- Output: SSE Stream (단계별 정보)

GET /api/copilot/models
- Output: [{ provider, name, status: 'connected'|'disabled' }]

POST /api/copilot/approval
- Input: { requestId, approved: boolean }
- Output: { success, nextStep }
```

### 프론트엔드 컴포넌트 (신규/수정)
```
components/copilot/
├── copilot-message/          (기존)
│   ├── thinking-block.tsx    (기존)
│   └── streaming-block.tsx   (신규 - 스트리밍 표시)
├── model-selector.tsx        (신규 - 모델 선택)
├── connection-loader.tsx     (신규 - 점 로딩)
├── approval-dialog.tsx       (신규 - 승인 요청)
└── error-display.tsx         (신규 - 에러 표시)
```

### 상태 관리 (Zustand Store)
```typescript
useCopilotStore({
  selectedModel: 'claude-code',
  availableModels: [],
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'error',
  processingSteps: [],
  currentStep: string,
  error: null | string,
  requiresApproval: boolean,
  approvalMessage: string,
})
```

---

## ✅ 검증 체크리스트

### Phase 1: 기본 기능
- [ ] 로컬 모델 감지 및 목록 표시
- [ ] 모델 선택 가능
- [ ] LLM 연결 상태 표시 (점 로딩)

### Phase 2: 워크플로우 생성
- [ ] SSE 스트리밍으로 단계별 정보 표시
- [ ] 생각 블록 (thinking) 표시
- [ ] 에러 메시지 원문 노출

### Phase 3: 사용자 상호작용
- [ ] 모호한 요청 시 질문 기능
- [ ] 승인 필요 시 dialog 표시
- [ ] 설정값 입력 UI

### Phase 4: 통합 테스트
- [ ] 전체 흐름 end-to-end 테스트
- [ ] 각 모델별 테스트 (Claude Code, Codex, Gemini)
- [ ] 에러 시나리오 테스트 (타임아웃, Rate limit 등)

---

## 📌 우선순위

| 순서 | 항목 | 난이도 | 예상 시간 |
|------|------|--------|---------|
| 1 | 로컬 모델 선택 UI | 중간 | 2-3h |
| 2 | LLM 연결 및 스트리밍 | 높음 | 4-5h |
| 3 | 단계별 정보 표시 | 중간 | 2-3h |
| 4 | 에러 처리 | 낮음 | 1-2h |
| 5 | 요구사항 명확화 | 중간 | 2-3h |
| 6 | 승인 흐름 | 낮음 | 1-2h |
| 7 | 설정값 후처리 | 낮음 | 1-2h |

---

## 🎯 성공 기준

✅ 완료 시:
1. `http://localhost:3000/workspace`에서 Copilot 사용 가능
2. 로컬 LLM만 사용 (sim.ai 서버 불필요)
3. 프롬프트 입력 → 워크플로우 자동 생성 완성
4. 모든 에러 메시지 명확히 표시
5. 실시간 스트리밍으로 진행 상황 확인 가능
