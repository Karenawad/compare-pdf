import * as pdfjsLib from "./lib/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.min.mjs", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const files = { old: null, new: null };

// ---------- اختيار الملفات ----------
for (const k of ["Old", "New"]) {
  $("file" + k).addEventListener("change", (e) => {
    const f = e.target.files[0];
    files[k.toLowerCase()] = f || null;
    $("name" + k).textContent = f ? f.name : "اضغط لاختيار الملف";
    $("lbl" + k).classList.toggle("ok", !!f);
    $("go").disabled = !(files.old && files.new);
  });
}
$("go").addEventListener("click", run);

function setProgress(p, text) {
  $("progress").hidden = false;
  $("bar").style.width = Math.round(p * 100) + "%";
  $("ptext").textContent = text;
}

// ---------- مقارنة النص (كلمة بكلمة) ----------
export function diffWords(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  const out = [];
  for (let i = 0; i < s; i++) out.push(["=", a[i]]);
  const n = A.length, m = B.length;
  if (n === 0 || m === 0 || n * m > 6e6) {
    A.forEach((w) => out.push(["-", w]));
    B.forEach((w) => out.push(["+", w]));
  } else {
    const W = m + 1;
    const t = new Int32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * W + j] = A[i] === B[j] ? t[(i + 1) * W + j + 1] + 1 : Math.max(t[(i + 1) * W + j], t[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push(["=", A[i]]); i++; j++; }
      else if (t[(i + 1) * W + j] >= t[i * W + j + 1]) out.push(["-", A[i++]]);
      else out.push(["+", B[j++]]);
    }
    while (i < n) out.push(["-", A[i++]]);
    while (j < m) out.push(["+", B[j++]]);
  }
  for (let i = ea; i < a.length; i++) out.push(["=", a[i]]);
  return out;
}

// ---------- أدوات الصفحة ----------
async function pageInfo(doc, num) {
  const page = await doc.getPage(num);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  let annots = 0;
  try {
    const an = await page.getAnnotations();
    annots = an.filter((x) => x.subtype !== "Link" && x.subtype !== "Widget").length;
  } catch (e) {}
  return { page, words: text ? text.split(" ") : [], annots };
}

async function render(page, width) {
  const vp0 = page.getViewport({ scale: 1 });
  const scale = Math.min(2, width / vp0.width);
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

const CELL = 12;
function visualDiff(cOld, cNew) {
  const W = Math.max(cOld.width, cNew.width), H = Math.max(cOld.height, cNew.height);
  const mk = (src) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); if (src) x.drawImage(src, 0, 0);
    return { c, x, d: x.getImageData(0, 0, W, H).data };
  };
  const o = mk(cOld), n = mk(cNew);
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
  const grid = new Uint16Array(gw * gh);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const d = Math.max(Math.abs(o.d[p] - n.d[p]), Math.abs(o.d[p + 1] - n.d[p + 1]), Math.abs(o.d[p + 2] - n.d[p + 2]));
      if (d > 60) grid[((y / CELL) | 0) * gw + ((x / CELL) | 0)]++;
    }
  }
  let flagged = 0;
  const out = document.createElement("canvas"); out.width = W; out.height = H;
  const ox = out.getContext("2d");
  ox.drawImage(n.c, 0, 0);
  ox.fillStyle = "rgba(255,255,255,.55)"; ox.fillRect(0, 0, W, H);
  ox.fillStyle = "rgba(230,30,30,.45)";
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++)
      if (grid[gy * gw + gx] >= 8) { flagged++; ox.fillRect(gx * CELL, gy * CELL, CELL, CELL); }
  return { flagged, canvas: out, sizeDiff: cOld.width !== cNew.width || cOld.height !== cNew.height };
}

const toBlob = (c) => new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));

// ---------- التواريخ ----------
const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";
const normDigits = (s) => s.replace(/[٠-٩]/g, (d) => AR.indexOf(d)).replace(/[۰-۹]/g, (d) => FA.indexOf(d));
const MONTHS = "يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|محرم|صفر|ربيع الأول|ربيع الثاني|جمادى الأولى|جمادى الآخرة|رجب|شعبان|رمضان|شوال|ذو القعدة|ذو الحجة|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const DATE_RE = new RegExp(
  "\\d{1,4}\\s*[/\\-.]\\s*\\d{1,2}\\s*[/\\-.]\\s*\\d{1,4}|\\d{1,2}\\s+(?:" + MONTHS + ")\\s+\\d{2,4}|(?:" + MONTHS + ")\\s+\\d{1,2}\\s*,?\\s*\\d{4}", "gi");
function extractDates(words) {
  const t = normDigits(words.join(" ")).replace(/\s*([/\-.])\s*/g, "$1");
  return (t.match(DATE_RE) || []).map((x) => x.replace(/\s+/g, " ").trim()).sort();
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------- نطاق الصفحات ----------
document.querySelectorAll('input[name="rng"]').forEach((r) =>
  r.addEventListener("change", () => { $("rngTxt").disabled = r.value !== "custom" || !r.checked; if (r.checked && r.value === "custom") $("rngTxt").focus(); }));
function parseRange(txt, max) {
  const set = new Set();
  const t = normDigits(txt).replace(/[،؛;\s]+/g, ",");
  for (const part of t.split(",").filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error("صيغة الصفحات غلط: " + part);
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i++) if (i >= 1 && i <= max) set.add(i);
  }
  if (!set.size) throw new Error("مفيش صفحات صح في النطاق ده (عدد الصفحات " + max + ")");
  return [...set].sort((x, y) => x - y);
}

// ---------- التشغيل ----------
const results = [];
async function run() {
  const wantDate = $("optDate").checked, wantSign = $("optSign").checked;
  if (!wantDate && !wantSign) { alert("اختار حاجة واحدة على الأقل تقارنها"); return; }
  $("go").disabled = true; $("result").hidden = true; results.length = 0;
  try {
    setProgress(0, "تحميل الملفات...");
    const [dOld, dNew] = await Promise.all(
      [files.old, files.new].map(async (f) => pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise)
    );
    const maxPg = Math.max(dOld.numPages, dNew.numPages);
    const custom = document.querySelector('input[name="rng"]:checked').value === "custom";
    const list = custom ? parseRange($("rngTxt").value, maxPg) : Array.from({ length: maxPg }, (_, i) => i + 1);
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      setProgress(k / list.length, `مقارنة الصفحة ${i} (${k + 1} من ${list.length})`);
      const r = { n: i, date: false, sign: false, noText: false, notes: [] };
      const hasO = i <= dOld.numPages, hasN = i <= dNew.numPages;
      if (!hasO || !hasN) {
        r.missing = true; r.date = wantDate; r.sign = wantSign;
        r.notes.push(hasN ? "الصفحة موجودة في الجديدة بس" : "الصفحة موجودة في القديمة بس");
        results.push(r); continue;
      }
      const [pO, pN] = [await pageInfo(dOld, i), await pageInfo(dNew, i)];
      let cO = null, cN = null, vd = null;
      if (wantDate) {
        const dO = extractDates(pO.words), dN = extractDates(pN.words);
        r.datesOld = dO; r.datesNew = dN;
        if (!pO.words.length && !pN.words.length) {
          r.noText = true; r.notes.push("الصفحة صورة (مفيش نص)، التاريخ ما اتقراش — راجعها بنفسك أو اختار «التوقيع / الشكل»");
        } else if (!sameList(dO, dN)) {
          r.date = true; r.notes.push(`التاريخ: ${dO.join("، ") || "—"}  ←  ${dN.join("، ") || "—"}`);
        }
      }
      if (wantSign) {
        cO = await render(pO.page, 900); cN = await render(pN.page, 900);
        vd = visualDiff(cO, cN);
        if (vd.flagged > 0 || vd.sizeDiff) { r.sign = true; r.notes.push(`تغيير في الشكل/التوقيع: ${vd.flagged} منطقة`); }
      }
      if (r.date || r.sign || r.noText) {
        cO = cO || await render(pO.page, 900); cN = cN || await render(pN.page, 900);
        [r.imgOld, r.imgNew] = await Promise.all([toBlob(cO), toBlob(cN)]);
        r.imgDiff = vd && r.sign ? await toBlob(vd.canvas) : r.imgNew;
      }
      results.push(r);
    }
    show(list.length);
  } catch (e) {
    console.error(e);
    alert("حصلت مشكلة: " + (e && e.message ? e.message : e));
  }
  $("progress").hidden = true; $("go").disabled = false;
}

function group(title, rs, cls) {
  const g = document.createElement("div"); g.className = "grp";
  g.innerHTML = `<h3>${title}</h3>`;
  if (!rs.length) { g.insertAdjacentHTML("beforeend", '<div class="none">مفيش ✅</div>'); return g; }
  const w = document.createElement("div"); w.className = "chips";
  rs.forEach((r) => {
    const b = document.createElement("button"); b.className = "chip " + (cls || ""); b.textContent = r.n;
    b.onclick = () => openViewer(r); w.appendChild(b);
  });
  g.appendChild(w); return g;
}

function show(count) {
  const wantDate = $("optDate").checked, wantSign = $("optSign").checked;
  const dates = results.filter((r) => r.date), signs = results.filter((r) => r.sign), nt = results.filter((r) => r.noText);
  const any = dates.length || signs.length;
  const v = $("verdict");
  v.className = any ? "diff" : "same";
  v.innerHTML = any ? `فيه تعديل ⚠️<small>تمت مقارنة ${count} صفحة</small>` : `مفيش تعديل ✅<small>تمت مقارنة ${count} صفحة</small>`;
  const box = $("groups"); box.innerHTML = "";
  if (wantDate) box.appendChild(group("صفحات التاريخ فيها اتغيّر", dates));
  if (wantSign) box.appendChild(group("صفحات التوقيع / الشكل فيها اتغيّر", signs));
  if (nt.length) box.appendChild(group("صفحات صور مش نصية (التاريخ ما اتقراش)", nt, "wn"));
  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: "smooth" });
}

// ---------- عارض الفروق ----------
let cur = null, urls = [];
async function drawBlob(blob) {
  if (!blob) { const c = $("vcanvas"); c.width = 300; c.height = 60; c.getContext("2d").clearRect(0, 0, 300, 60); return; }
  const bmp = await createImageBitmap(blob);
  const c = $("vcanvas"); c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
}
function setMode(m) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
  drawBlob({ diff: cur.imgDiff, old: cur.imgOld, new: cur.imgNew }[m]);
}
function openViewer(r) {
  cur = r;
  $("vtitle").textContent = `صفحة ${r.n}`;
  const t = $("vtext");
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  t.innerHTML = r.notes.map((n) => `<h3>${esc(n)}</h3>`).join("");
  $("viewer").hidden = false;
  document.body.style.overflow = "hidden";
  setMode("diff");
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
$("vclose").onclick = () => { $("viewer").hidden = true; document.body.style.overflow = ""; };

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
