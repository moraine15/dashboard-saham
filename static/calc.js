/* calc.js - Tab Kalkulator. Average Down (Mode A: beli sekian lot).
   Memakai helper global: $, fmt, fmtRp. 1 lot = 100 lembar (IDX). */
"use strict";
(function () {
  const LOT = 100;
  const num = (id) => { const v = window.parseRp($(id).value); return isNaN(v) ? null : v; };
  const IDS = ["adAvg", "adLot", "adPrice", "adBuy", "adMkt", "adFee"];

  function box(lbl, val, cls) {
    return `<div class="pf-card"><div class="lbl">${lbl}</div><div class="val ${cls || ""}">${val}</div></div>`;
  }

  function calc() {
    const out = $("adOut"), note = $("adNote");
    const avg = num("adAvg"), lot = num("adLot"), price = num("adPrice"), buy = num("adBuy");
    if (avg == null || lot == null || price == null || buy == null || avg <= 0 || lot <= 0 || price <= 0 || buy <= 0) {
      out.innerHTML = "";
      note.innerHTML = "<p class='tiny muted'>Isi <b>harga rata-rata sekarang</b>, <b>lot dimiliki</b>, <b>harga beli baru</b>, dan <b>lot dibeli</b> (semua angka > 0).</p>";
      return;
    }
    const shOld = lot * LOT, shNew = buy * LOT, shTot = shOld + shNew;
    const costOld = avg * shOld, costNew = price * shNew, costTot = costOld + costNew;
    const avgNew = costTot / shTot;
    const totLot = lot + buy;
    const drop = avg - avgNew;                 // > 0 means the average went down (the average-down worked)
    const dropPct = avg ? (drop / avg) * 100 : 0;
    const feePct = window.parseDecimal($("adFee").value), fee = (feePct && feePct > 0) ? feePct / 100 : 0;
    const bep = fee ? avgNew * (1 + fee) : avgNew;   // perkiraan break-even termasuk biaya
    const mkt = num("adMkt");

    let html =
      box("Average baru", fmtRp(avgNew)) +
      box("Average lama", fmtRp(avg)) +
      box(drop >= 0 ? "Average turun" : "Average naik", fmtRp(Math.abs(drop)) + " (" + fmt(Math.abs(dropPct), 2) + "%)", drop >= 0 ? "up" : "down") +
      box("Total lot", fmt(totLot, 0) + " lot") +
      box("Total lembar", fmt(shTot, 0)) +
      box("Total modal", fmtRp(costTot)) +
      box("Break-even" + (fee ? " (incl. biaya)" : ""), fmtRp(bep));
    if (mkt != null && mkt > 0) {
      const val = mkt * shTot, pl = val - costTot, plPct = costTot ? (pl / costTot) * 100 : 0;
      html += box("Nilai sekarang", fmtRp(val)) +
        box("Untung/Rugi", fmtRp(pl) + " (" + fmt(plPct, 2) + "%)", pl >= 0 ? "up" : "down");
    }
    out.innerHTML = html;

    const notes = [];
    if (price >= avg) notes.push("Harga beli baru (" + fmtRp(price) + ") <b>tidak lebih rendah</b> dari average lama: ini <b>average up</b>, rata-rata Anda justru naik.");
    notes.push("Average baru = (modal lama + modal beli baru) ÷ total lembar. <b>Edukasi, bukan rekomendasi.</b> Average down menambah eksposur: pertimbangkan alasan fundamental, jangan rata-rata turun pada saham yang fundamentalnya memburuk.");
    if (!fee) notes.push("Break-even = average baru (belum termasuk biaya broker). Isi <b>biaya beli+jual (%)</b> untuk perkiraan break-even lebih akurat.");
    note.innerHTML = notes.map((n) => "<p class='tiny muted'>" + n + "</p>").join("");
  }

  $("adCalc").onclick = calc;
  $("adReset").onclick = () => { IDS.forEach((id) => $(id).value = ""); $("adOut").innerHTML = ""; $("adNote").innerHTML = ""; };
  IDS.forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") calc(); }));

})();
