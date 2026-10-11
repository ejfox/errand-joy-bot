import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  approvalUrl,
  buildApprovalRecord,
  hashToken,
  mintToken,
  timingSafeEqualStr,
  verifyApproveToken,
  verifyBinding,
} from "./approval.ts";

const BASE = "https://approve.example.test";

Deno.test("mintToken: 32 bytes base64url, unique", () => {
  const a = mintToken(), b = mintToken();
  assertEquals(a.length, 43);
  assert(/^[A-Za-z0-9_-]{43}$/.test(a));
  assertNotEquals(a, b);
});

Deno.test("hashToken: sha256 hex", async () => {
  assertEquals(await hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("approvalUrl: <base>/a/<token>, https only, malformed token refused", () => {
  const t = mintToken();
  assertEquals(approvalUrl(t, BASE), `${BASE}/a/${t}`);
  assertEquals(approvalUrl(t, BASE + "/"), `${BASE}/a/${t}`);
  assertThrows(() => approvalUrl(t, "http://approve.example.test"));
  assertThrows(() => approvalUrl(t, "https://u:p@approve.example.test"));
  assertThrows(() => approvalUrl("../../x", BASE));
});

Deno.test("buildApprovalRecord: separate approve/deny tokens; record holds hashes, never tokens", async () => {
  const now = new Date("2026-10-12T16:00:00Z");
  const { approveToken, denyToken, record } = await buildApprovalRecord({
    requestId: "r1", vendor: "fakeshop", boundCents: 8000, kind: "approve", summary: "s", now,
  });
  assert(approveToken);
  assertNotEquals(approveToken, denyToken);
  assertEquals(record.approveTokenHash, await hashToken(approveToken));
  assertEquals(record.denyTokenHash, await hashToken(denyToken));
  assert(!JSON.stringify(record).includes(approveToken));
  assert(!JSON.stringify(record).includes(denyToken));
  assertEquals(record.expiresAt, "2026-10-13T16:00:00.000Z");
  assert(await verifyApproveToken(approveToken, record));
  assert(!(await verifyApproveToken(denyToken, record)), "the deny token can never approve");
  assert(!(await verifyApproveToken(mintToken(), record)));
  // retry keeps the approvalId, rotates both hashes
  const again = await buildApprovalRecord({
    requestId: "r1", vendor: "fakeshop", boundCents: 8000, kind: "approve", summary: "s", now, approvalId: record.approvalId,
  });
  assertEquals(again.record.approvalId, record.approvalId);
  assertNotEquals(again.record.denyTokenHash, record.denyTokenHash);
  assertNotEquals(again.record.approveTokenHash, record.approveTokenHash);
});

Deno.test("buildApprovalRecord: veto kind has a deny token only", async () => {
  const { approveToken, denyToken, record } = await buildApprovalRecord({
    requestId: "r1", vendor: "fakeshop", boundCents: 800, kind: "veto", summary: "s", now: new Date(),
  });
  assertEquals(approveToken, undefined);
  assertEquals(record.approveTokenHash, undefined);
  assert(!(await verifyApproveToken(denyToken, record)));
});

Deno.test("verifyBinding: vendor, request and exact cents", async () => {
  const now = new Date("2026-10-12T16:00:00Z");
  const { record } = await buildApprovalRecord({
    requestId: "r1", vendor: "fakeshop", boundCents: 8000, kind: "approve", summary: "s", now,
  });
  assertEquals(verifyBinding(record, { requestId: "r1", vendor: "fakeshop", quoteTotalCents: 8000 }), { ok: true });
  assertEquals(verifyBinding(record, { requestId: "r1", vendor: "fakeshop", quoteTotalCents: 8001 }), {
    ok: false, reason: "quote_changed",
  });
  assertEquals(verifyBinding(record, { requestId: "r1", vendor: "other", quoteTotalCents: 8000 }).ok, false);
  assertEquals(verifyBinding(record, { requestId: "r2", vendor: "fakeshop", quoteTotalCents: 8000 }).ok, false);
  assertEquals(
    verifyBinding(record, { requestId: "r1", vendor: "fakeshop", quoteTotalCents: 8000, now: new Date("2026-10-14T00:00:00Z") }).ok,
    false,
  );
  assertEquals(verifyBinding({ ...record, usedAt: now.toISOString() }, {
    requestId: "r1", vendor: "fakeshop", quoteTotalCents: 8000, requireUnused: true,
  }).ok, false);
});

Deno.test("timingSafeEqualStr", async () => {
  assert(await timingSafeEqualStr("abc", "abc"));
  assert(!(await timingSafeEqualStr("abc", "abd")));
  assert(!(await timingSafeEqualStr("abc", "abcd")));
  assert(!(await timingSafeEqualStr("", "x")));
});
