import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  approvalUrl,
  buildApprovalRecord,
  hashToken,
  mintLookupId,
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

Deno.test("approvalUrl: <base>/a/<lookupId>#<token>, https only, malformed parts refused", () => {
  const t = mintToken();
  const id = mintLookupId();
  assertEquals(id.length, 22);
  assertEquals(approvalUrl(id, t, BASE), `${BASE}/a/${id}#${t}`);
  assertEquals(approvalUrl(id, t, BASE + "/"), `${BASE}/a/${id}#${t}`);
  // the token is only in the fragment: the part a browser sends never contains it
  const u = new URL(approvalUrl(id, t, BASE));
  assertEquals(u.pathname, `/a/${id}`);
  assertEquals(u.hash, `#${t}`);
  assertThrows(() => approvalUrl(id, t, "http://approve.example.test"));
  assertThrows(() => approvalUrl(id, t, "https://u:p@approve.example.test"));
  assertThrows(() => approvalUrl(id, t, BASE + "#x"));
  assertThrows(() => approvalUrl(id, "../../x", BASE));
  assertThrows(() => approvalUrl("../../x", t, BASE));
  assertThrows(() => approvalUrl(t, t, BASE), "a token is not a lookupId");
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
  // two public lookupIds, distinct, fresh on every mint, unrelated to the tokens
  assert(/^[A-Za-z0-9_-]{22}$/.test(record.denyLookupId) && /^[A-Za-z0-9_-]{22}$/.test(record.approveLookupId!));
  assertNotEquals(record.denyLookupId, record.approveLookupId);
  assertNotEquals(again.record.denyLookupId, record.denyLookupId);
  assertNotEquals(again.record.approveLookupId, record.approveLookupId);
  for (const id of [record.denyLookupId, record.approveLookupId!]) {
    assert(!approveToken.includes(id) && !denyToken.includes(id));
  }
});

Deno.test("buildApprovalRecord: veto kind has a deny token only", async () => {
  const { approveToken, denyToken, record } = await buildApprovalRecord({
    requestId: "r1", vendor: "fakeshop", boundCents: 800, kind: "veto", summary: "s", now: new Date(),
  });
  assertEquals(approveToken, undefined);
  assertEquals(record.approveTokenHash, undefined);
  assertEquals(record.approveLookupId, undefined);
  assert(/^[A-Za-z0-9_-]{22}$/.test(record.denyLookupId));
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
