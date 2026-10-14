/* Indonesian money text: "." groups thousands, "," marks decimals. */
"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.Money = api;
    root.parseRp = api.parseRp;
    root.groupRp = api.groupRp;
    root.toMoneyField = api.toMoneyField;
    root.parseDecimal = api.parseDecimal;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // "600.000" / "1.234,5" → number. Numbers pass through unchanged.
  function parseRp(value) {
    if (typeof value === "number") return value;
    const text = String(value == null ? "" : value);
    const negative = /^\s*-/.test(text);
    const body = text.replace(/[^\d,]/g, "").replace(",", ".");
    if (body === "" || body === ".") return NaN;
    const parsed = parseFloat(body);
    return Number.isNaN(parsed) ? NaN : (negative ? -parsed : parsed);
  }

  // Regroup typed text into "1.234.567,89" without changing its value.
  function groupRp(value) {
    const text = String(value == null ? "" : value);
    const negative = /^\s*-/.test(text);
    const body = text.replace(/[^\d,]/g, "");
    const [intPart, decPart] = body.split(",");
    const grouped = (intPart || "").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    let out = (negative ? "-" : "") + grouped;
    if (decPart != null) out += "," + decPart;
    return out;
  }

  // JS number → field text that parseRp reads back as the same number.
  function toMoneyField(value) {
    if (value === "" || value == null) return "";
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    const plain = Math.abs(n).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 6 });
    return groupRp((n < 0 ? "-" : "") + plain.replace(".", ","));
  }

  // Percentages and other small decimals: accept "0,3" and "0.3".
  function parseDecimal(value) {
    const text = String(value == null ? "" : value).trim().replace(",", ".");
    if (text === "") return NaN;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  return { parseRp, groupRp, toMoneyField, parseDecimal };
});
