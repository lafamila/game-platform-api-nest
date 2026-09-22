---
status: COMPLETED
completed_at: 2026-09-22
summary: "Auth 웹훅으로 저장된 로그인 세션 권한을 갱신하고 공통 채팅 세션 발급을 연결한다."
---

# Game API Execution

Canonical: root workspace `.idea/AUTH_WEBHOOK_SHARED_CHAT_PLAN.md` (or `.idea/completed/` after integration completion).

- Receive signed `permission.updated` and application rejection events; validate service, timestamp, signature and event identity before processing.
- Persist duplicate-delivery state. Serialize normal and webhook token refresh across processes, reload stored refresh tokens, continue across all account sessions, and return retryable errors when auth is unavailable.
- Notify existing realtime clients after reconciliation. Revocation must invalidate affected sessions, not just change a display label.
- Add opt-in `/api/chat/session` using server-held access tokens and short-lived opaque chat sessions. Preserve legacy social data and behavior.
- Update environment and onboarding docs. Verify build, targeted unit tests and isolated PostgreSQL integration without touching current user data.

## Verification

- Build and TypeScript diagnostics passed; full Node test suite 402 passed.
- Focused webhook/session/chat/realtime tests: 34 passed.
- Isolated PostgreSQL verified inbox dedupe, advisory locks and chat session cleanup.
- Workspace real HTTP smoke proved auth approval renews the JWT under the same opaque game session, duplicate delivery causes no extra rotation, and revocation returns 401.
- Existing npm audit findings: 7 in current dependency tree; no dependencies changed in this feature. Review dependency upgrades separately.
- Chat logout cleanup is best effort during a chat outage, bounded by the short chat-session expiry.
