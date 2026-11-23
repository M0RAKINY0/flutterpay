import assert from "node:assert/strict";
import { test } from "node:test";
import { MOCK_NOW, transactions } from "../src/data/mock";
import { filterTransactions, formatNaira } from "../src/lib/format";

test("formats kobo as naira and filters transactions by period, status and search", () => {
  assert.equal(formatNaira(228_900_00), "₦228,900.00");
  assert.equal(formatNaira(5), "₦0.05");

  const refs = (options: Parameters<typeof filterTransactions>[1]) =>
    filterTransactions(transactions, options).map(tx => tx.tx_ref);

  // "Today" keeps only 23 Nov; "pending" also matches awaiting_otp.
  assert.deepEqual(refs({ period: "daily", status: "pending", query: "", now: MOCK_NOW }), [
    "order_10479",
    "order_10475",
  ]);
  // "This month" drops the 30 Oct transaction.
  assert.equal(refs({ period: "monthly", status: "all", query: "", now: MOCK_NOW }).includes("order_10468"), false);
  // Search matches the customer email, case-insensitively.
  assert.deepEqual(refs({ period: "all", status: "all", query: "  ZAINAB ", now: MOCK_NOW }), ["order_10468"]);
});
