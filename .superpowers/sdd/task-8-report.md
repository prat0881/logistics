## Task 8 Report — FE Send Follow-up / Acknowledgement + email log

### Implementation

**Files created:**
- `apps/web/src/features/query-wizard/useEmails.ts` — TanStack Query hook with:
  - `list` query keyed `["emails", queryId]` → `GET /api/queries/:id/emails`, `select` reverses for newest-first
  - `sendFollowUp` mutation → `POST /api/queries/:id/emails/follow-up`, invalidates list on success
  - `sendAck` mutation → `POST /api/queries/:id/emails/acknowledgement`, invalidates list on success

**Files modified:**
- `apps/web/src/features/query-wizard/WizardShell.tsx` — imports `useEmails`; adds `handleSendFollowUp`/`handleSendAck` handlers (success/error notices reuse the existing `saveSuccess`/`saveError` state pattern); adds **Send Follow-up** + **Send Acknowledgement** buttons in the final-step action bar, left of **Create Query**
- `apps/web/src/features/query-wizard/steps/Step5Notes.tsx` — imports `useEmails`; mounts `emailList` from the hook; adds a compact **Emails Logged** section below Checklist listing `template · toAddress · time` rows newest-first with "No emails logged yet." empty state
- `apps/web/src/features/query-wizard/steps/Step5Notes.test.tsx` — added 3 new tests

### Placement decision

Send Follow-up and Send Acknowledgement live in **WizardShell's final-step action bar** (right of Save, left of Create Query). The email log lives in **Step5Notes** below the Checklist. This cleanly separates concerns: the action buttons share the same action bar chrome as existing actions; the log is a natural part of the Notes step.

### Send Follow-up disabled gate

```ts
const allChecked =
  (detail?.checklist ?? []).length > 0 &&
  (detail?.checklist ?? []).every((c) => c.checked);
```
Button `disabled` when `allChecked` — which means the button is **enabled** when ≥1 item is unchecked, matching spec §13. Edge case: empty checklist (`length === 0`) → `allChecked` is false → button enabled (allows sending a follow-up before items exist). Matches intent: "every item is checked" is only true once there are items and all are ticked.

### TDD RED → GREEN

RED run (3 failures):
```
pnpm --filter @svyft/web test Step5Notes
Tests  3 failed | 5 passed (8)
```
All 3 new tests failed because `Send Follow-up` / `Send Acknowledgement` buttons didn't exist.

GREEN run (after implementation):
```
pnpm --filter @svyft/web test Step5Notes
Tests  8 passed (8)
```

### Full suite
```
pnpm --filter @svyft/web test   → 219 passed (44 test files)
pnpm --filter @svyft/web typecheck → clean (no output)
pnpm --filter @svyft/web lint   → clean (no output)
```

### Self-review checklist

- [x] Follow-up disabled iff every item checked (+ empty-checklist edge handled)
- [x] Both POST to the right endpoints (`/emails/follow-up`, `/emails/acknowledgement`)
- [x] Log lists logged emails newest-first (via `select: (data) => [...data].reverse()`)
- [x] Empty state "No emails logged yet." rendered
- [x] Buttons only appear on the final step (guarded by `isFinalStep` in WizardShell)
- [x] Tests assert real behavior (disable gate, POST calls, email row in log)
- [x] Full web suite 219/219 + typecheck clean + lint clean

### Concerns

None. The implementation is straightforward; `postJson` is called without a body (the API doesn't require one for these endpoints), which is valid given `postJson(url, body?)` has an optional body parameter.
