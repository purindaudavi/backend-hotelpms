# Withdrawal recipients and approval

Implemented 2026-11-04 (Asia/Colombo). No Manager role was added: the user confirmed that they meant Administrator and Owner.

## Behavior

- New withdrawal records require an explicitly selected account belonging to this property's Owner or Administrators. The selector shows `Name · Owner` or `Name · Administrator`. It does not list Finance, Front Desk, Housekeeping, unrelated accounts or administrators who have lost property membership.
- Finance sees **Requested recipient**. Submitting creates a **Pending** request, with verified requester and time, no Money Out posting and no completed-withdrawal amount.
- Owner/Admin sees the request in Withdrawals and in the existing property notification bell. Finance retains visibility of the status. These are in-app records/notifications, not a bank transfer, personal email or a message directed using the recipient's name.
- Owner/Admin reviews, confirms the actual money-received date/time and approval note, then chooses **Approve and Record**. Completion posts one Money Out transaction and records the approver/time separately from requester and recipient.
- Owner/Admin can also directly record a completed withdrawal after the recipient received the money. It uses the same recipient selector and saves recorder/approval identity.
- The table shows the recipient and role. Details show requester/time, recipient/role and approver/time where available. Finance and other read-only viewers cannot approve or reject; Owner/Admin controls are explicit.
- The endpoint accepts only `recipient_user_id`, resolves the actual account name and role server-side, and ignores browser-supplied names, roles, status and approval identity. This replaces the fixed ASIRI PERERA value for new records.
- Creation, completion and rejection/void recheck current actor access inside the existing per-property transaction guard. Approval also revalidates the recipient's current eligibility. Stale concurrent approvals continue to produce one completed record and one transaction.

## History

Recipient name, account ID and role are snapshots when the record is created. Existing records are not renamed or relinked. Changing an account name later does not rewrite completed withdrawal history; new requests use the new name.

Older completed withdrawals keep their saved recipient text. Older pending requests with no linked recipient cannot safely be approved using a guessed account. Their details instruct Owner/Admin to reject and recreate them with a selected recipient. The same reject/recreate path applies if a requested recipient loses the required property role before approval.

## Manual walkthrough

1. Register the required employee accounts and grant Finance/Administrator access from **Users & access**. Owner and Administrator accounts must exist on the selected property.
2. Sign in as Finance and open **Financials → Withdrawals → Request Withdrawal**.
3. Verify **Requested recipient** lists only this property's actual Owner/Administrators, with their names and roles. No account is preselected. Choose a person, enter amount/currency, request date, source, method and reason.
4. Submit. Verify Pending, no completed-total increase and no withdrawal Money Out entry yet. View the request and check the recipient and requester are distinct fields.
5. As Owner/Admin, refresh the notification bell or Withdrawals. Open the pending request, verify the recipient, and approve only after the actual cash/bank handover. Fill **Actual money received** and **Approval note**, then choose **Approve and Record**.
6. Verify Completed, correct recipient, Finance requester and Owner/Admin approver, and one Money Out entry in **Financials → Transactions**.
7. As Owner/Admin, test **Record Withdrawal** with another eligible recipient after a real/test handover. It directly creates a completed record; do not duplicate an already-approved request.
8. Test a second property: its recipient list must not include the first hotel's unrelated members.
9. For a disposable pending request, remove its selected Administrator's access before approving. Approval must stop with instructions to reject/recreate. Do not alter historical records to test this on real withdrawals.
10. Older completed withdrawals should retain their saved payee; older unlinked pending requests should show the reject/recreate guidance.

## Verification

- Backend full suite: 257 tests passed, including minimal recipient output, owner/admin membership checks, no default payee and request notification wording.
- `node scripts/live-withdrawal-recipients-smoke.js`: 42 authenticated MongoDB/API checks passed. Covers role options, cross-property access, forged names/roles, pending status, notifications, duplicate approval protection, snapshots after name changes, revoked recipients, direct Owner recording and legacy records.
- `node scripts/live-finance-role-smoke.js`: existing 40-check Finance regression passed with an explicit recipient.
- Frontend TypeScript and isolated browser checks passed for Owner/Admin role labels, required selection, Finance request/approval separation, direct recording, list failure/empty/retry, legacy guidance and mobile overflow.
- Browser fixture helper: ignored `tmp/withdrawal-recipient-preview.cjs`. Database scripts use disposable users and properties, remove them afterward and verify cleanup.

Backend and frontend changes should be used together: new POST `/api/withdrawals` calls must provide `recipient_user_id`. GET `/api/withdrawals/recipients` returns only `{user_id,name,role}` options. Refresh the frontend and restart the backend if it is not watching files.
