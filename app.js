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

// ---------- التشغيل ----------
const results = [];
async function run() {
  $("go").disabled = true; $("result").hidden = true; results.length = 0;
  try {
    setProgress(0, "تحميل الملفات...");
    const [dOld, dNew] = await Promise.all(
      [files.old, files.new].map(async (f) => pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise)
    );
    const total = Math.max(dOld.numPages, dNew.numPages);
    for (let i = 1; i <= total; i++) {
      setProgress((i - 1) / total, `مقارنة الصفحة ${i} من ${total}`);
      const r = { n: i, status: "same", notes: [] };
      const hasO = i <= dOld.numPages, hasN = i <= dNew.numPages;
      if (!hasO || !hasN) {
        r.status = "changed";
        r.notes.push(hasN ? "صفحة جديدة مضافة" : "صفحة محذوفة من النسخة الجديدة");
        r.diff = hasN ? [] : [];
        const info = await pageInfo(hasN ? dNew : dOld, i);
        r.diff = info.words.map((w) => [hasN ? "+" : "-", w]);
        r.imgNew = hasN ? await toBlob(await render(info.page, 900)) : null;
        r.imgOld = hasO ? await toBlob(await render(info.page, 900)) : null;
        r.imgDiff = hasN ? r.imgNew : r.imgOld;
        results.push(r); continue;
      }
      const [pO, pN] = [await pageInfo(dOld, i), await pageInfo(dNew, i)];
      const diff = diffWords(pO.words, pN.words);
      const added = diff.filter((x) => x[0] === "+").length, removed = diff.filter((x) => x[0] === "-").length;
      const cO = await render(pO.page, 900), cN = await render(pN.page, 900);
      const vd = visualDiff(cO, cN);
      r.added = added; r.removed = removed; r.flagged = vd.flagged; r.diff = diff;
      if (added || removed) { r.status = "changed"; r.notes.push(`نص: +${added} كلمة / -${removed} كلمة`); }
      if (vd.flagged > 0) {
        r.status = "changed";
        r.notes.push(added || removed ? `${vd.flagged} منطقة تغيّر شكلها` : "تغيير في الشكل فقط (خط يد، علامة، صورة، تنسيق)");
      }
      if (pO.annots !== pN.annots) {
        r.status = "changed"; r.notes.push(`تعليقات/علامات: ${pO.annots} ← ${pN.annots}`);
      }
      if (vd.sizeDiff) { r.status = "changed"; r.notes.push("مقاس الصفحة اتغيّر"); }
      if (r.status === "changed") {
        [r.imgDiff, r.imgOld, r.imgNew] = await Promise.all([toBlob(vd.canvas), toBlob(cO), toBlob(cN)]);
      }
      results.push(r);
    }
    show(dOld.numPages, dNew.numPages);
  } catch (e) {
    console.error(e);
    alert("حصلت مشكلة في قراءة الملف: " + (e && e.message ? e.message : e));
  }
  $("progress").hidden = true; $("go").disabled = false;
}

function show(nOld, nNew) {
  const changed = results.filter((r) => r.status === "changed");
  const v = $("verdict");
  v.className = changed.length ? "diff" : "same";
  v.innerHTML = changed.length
    ? `فيه تعديل ⚠️<small>${changed.length} صفحة فيها اختلاف من ${results.length}</small>`
    : `مفيش أي تعديل ✅<small>الملفين متطابقين نصًا وشكلًا</small>`;
  $("stats").innerHTML =
    `<div><b>${nOld}</b>صفحات القديمة</div><div><b>${nNew}</b>صفحات الجديدة</div><div><b>${changed.length}</b>صفحات معدّلة</div>`;
  const box = $("pages"); box.innerHTML = "";
  results.forEach((r) => {
    const el = document.createElement("div"); el.className = "pg";
    el.innerHTML = `<span class="n">صفحة ${r.n}</span><span class="d">${r.status === "same" ? "بدون تغيير" : r.notes.join("<br>")}</span>
      <span class="badge ${r.status === "same" ? "ok" : "ch"}">${r.status === "same" ? "متطابقة" : "معدّلة"}</span>`;
    if (r.status === "changed") {
      const b = document.createElement("button"); b.textContent = "عرض"; b.onclick = () => openViewer(r);
      el.appendChild(b);
    }
    box.appendChild(el);
  });
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
  const hasText = r.diff && r.diff.some((x) => x[0] !== "=");
  t.innerHTML = hasText
    ? "<h3>الفروق في النص <ins>مضاف</ins> <del>محذوف</del></h3>" +
      r.diff.map(([k, w]) => (k === "+" ? `<ins>${esc(w)}</ins>` : k === "-" ? `<del>${esc(w)}</del>` : esc(w))).join(" ")
    : "<h3>مفيش فرق في النص — الفرق في الشكل (الأماكن الحمراء في صورة «الفروق»)</h3>";
  $("viewer").hidden = false;
  document.body.style.overflow = "hidden";
  setMode("diff");
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
$("vclose").onclick = () => { $("viewer").hidden = true; document.body.style.overflow = ""; };

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
