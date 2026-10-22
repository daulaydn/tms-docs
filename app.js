(function () {
"use strict";
const $ = s => document.querySelector(s);
// Chế độ tĩnh: trang được xuất bằng `npm run export` (GitHub Pages…). Không có server, không đăng nhập.
const META = n => { const m = document.querySelector(`meta[name="${n}"]`); return m ? m.content : null; };
const STATIC = META("hd-static") !== null;
const BASE = STATIC ? META("hd-static") : "/";
const PATH = location.pathname.replace(/\/+$/, "") || "/";
const ROUTE = (() => {
  let m;
  if (STATIC) {
    const r = META("hd-route") || "library";
    return r.startsWith("reader:") ? { view: "reader", slug: r.slice(7) } : { view: "library" };
  }
  if (PATH === "/") return { view: "library" };
  if (PATH === "/admin") return { view: "dashboard" };
  if ((m = PATH.match(/^\/admin\/([a-z0-9][a-z0-9-]*)$/))) return { view: "editor", slug: m[1] };
  if ((m = PATH.match(/^\/d\/([a-z0-9][a-z0-9-]*)$/))) return { view: "reader", slug: m[1] };
  return { view: "notfound" };
})();
const IS_ADMIN = ROUTE.view === "editor";
const NEEDS_LOGIN = ROUTE.view === "editor" || ROUTE.view === "dashboard";
const BACKUP_KEY = "huongdan-backup-v2:" + (ROUTE.slug || "");
let SITE = META("hd-site") || "Tài liệu hướng dẫn";
/** Đổi đường dẫn của ứng dụng (/, /d/abc#x, /uploads/…) thành đường dẫn đúng ở chế độ tĩnh. */
function url(p) {
  if (!STATIC || typeof p !== "string" || !p.startsWith("/")) return p;
  if (p === "/") return BASE;
  const m = p.match(/^\/d\/([a-z0-9][a-z0-9-]*)\/?(#.*)?$/);
  if (m) return BASE + "d/" + m[1] + "/" + (m[2] || "");
  return BASE + p.slice(1);
}

/* ---------- Trạng thái ---------- */
let doc = null;          // tài liệu đang hiển thị (bản xuất bản ở trang đọc, bản nháp ở trang soạn)
let active = null;       // mã chương đang mở
let mode = "read";       // "read" | "edit"
let rev = 0;             // số phiên bản nháp trên server
let dirty = false;       // có thay đổi chưa gửi lên server
let conflict = false;    // server có bản mới hơn: ngừng tự lưu
let publishedSame = true;
let savePromise = null, pendingSave = false, publishing = false;
let user = null;
let publishedAt = null;

/* ---------- Tiện ích ---------- */
function toast(msg, ms) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms || 3200);
}
function debounce(fn, ms) { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; }
function slug(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}
function newId(title) {
  const base = slug(title) || "chuong";
  let id = base, i = 2;
  while (doc.sections.some(s => s.id === id)) id = base + "-" + (i++);
  return id;
}
const cur = () => (doc && doc.sections.find(s => s.id === active)) || null;
const idx = () => doc.sections.findIndex(s => s.id === active);
function fmtDate(iso) {
  const d = new Date(iso); if (!iso || isNaN(d)) return "";
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}
async function api(method, url, body, isForm) {
  if (STATIC) return staticApi(method, url);
  const opt = { method, credentials: "same-origin", headers: { "X-Requested-With": "fetch" } };
  if (body !== undefined) {
    if (isForm) opt.body = body;
    else { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  }
  let r;
  try { r = await fetch(url, opt); } catch (_) { const e = new Error("Không kết nối được tới máy chủ."); e.status = 0; throw e; }
  let data = null; try { data = await r.json(); } catch (_) { /* không phải JSON */ }
  if (!r.ok) { const e = new Error((data && data.error) || "Lỗi " + r.status); e.status = r.status; e.data = data; throw e; }
  return data;
}

async function staticApi(method, u) {
  let file = null, m;
  if (method === "GET" && u === "/api/docs") file = "data/docs.json";
  else if (method === "GET" && (m = u.match(/^\/api\/docs\/([a-z0-9-]+)$/))) file = "data/docs/" + m[1] + ".json";
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
  if (!file) fail(u === "/api/me" ? 401 : 404, "Không có ở trang tĩnh.");
  let r;
  try { r = await fetch(BASE + file, { cache: "no-cache" }); } catch (_) { fail(0, "Không kết nối được."); }
  if (!r.ok) fail(r.status, "Không tìm thấy.");
  return r.json();
}

/* ---------- Markdown ---------- */
const LABELS = { note: "Lưu ý", tip: "Mẹo", warning: "Cảnh báo" };
function renderMd(src) {
  const wrap = document.createElement("div");
  if (!window.marked || !window.DOMPurify) {
    const p = document.createElement("p"); p.style.whiteSpace = "pre-wrap"; p.textContent = src || ""; return p.outerHTML;
  }
  wrap.innerHTML = DOMPurify.sanitize(marked.parse(src || "", { mangle: false, headerIds: false, breaks: true, gfm: true }));
  wrap.querySelectorAll("blockquote").forEach(bq => {
    const p = bq.querySelector("p"); if (!p) return;
    const m = p.innerHTML.match(/^\s*\[!(NOTE|TIP|WARNING)\]\s*(<br\s*\/?>)?\s*/i);
    if (!m) return;
    const kind = m[1].toLowerCase();
    p.innerHTML = p.innerHTML.slice(m[0].length);
    if (!p.textContent.trim() && !p.querySelector("img")) p.remove();
    bq.classList.add("callout", "callout-" + kind);
    const lab = document.createElement("div"); lab.className = "callout-label"; lab.textContent = LABELS[kind];
    bq.prepend(lab);
  });
  if (STATIC) {
    wrap.querySelectorAll("img[src^='/']").forEach(i => i.setAttribute("src", url(i.getAttribute("src"))));
    wrap.querySelectorAll("a[href^='/']").forEach(a => a.setAttribute("href", url(a.getAttribute("href"))));
  }
  wrap.querySelectorAll("a[href]").forEach(a => {
    if (/^https?:/i.test(a.getAttribute("href"))) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  });
  wrap.querySelectorAll("table").forEach(tb => { const w = document.createElement("div"); w.className = "table-wrap"; tb.replaceWith(w); w.appendChild(tb); });
  const used = {};
  wrap.querySelectorAll("h2").forEach(h => { let s = slug(h.textContent) || "muc"; used[s] = (used[s] || 0) + 1; if (used[s] > 1) s += "-" + used[s]; h.id = "h-" + s; });
  return wrap.innerHTML;
}
function chapterEl(s, n) {
  const el = document.createElement("div");
  el.innerHTML = `<header class="ch-head"><div class="ch-num">${n}</div><h1 class="ch-title"></h1></header><div class="prose">${renderMd(s.content)}</div>`;
  el.querySelector(".ch-title").textContent = s.title || "Chương chưa đặt tên";
  return el;
}
function highlight(root, q) {
  if (!q) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const hits = []; let node;
  while ((node = walker.nextNode())) if (node.nodeValue.toLowerCase().includes(q)) hits.push(node);
  hits.forEach(n => {
    const text = n.nodeValue, lower = text.toLowerCase(), frag = document.createDocumentFragment();
    let i = 0, j;
    while ((j = lower.indexOf(q, i)) !== -1) {
      frag.append(text.slice(i, j));
      const m = document.createElement("mark"); m.className = "hit"; m.textContent = text.slice(j, j + q.length); frag.append(m);
      i = j + q.length;
    }
    frag.append(text.slice(i)); n.replaceWith(frag);
  });
}

/* ---------- Hiển thị ---------- */
function show(el, on) { el.classList.toggle("hide", !on); }
function renderHeader() {
  const h = $("#hdr-title");
  const listMode = ROUTE.view === "library" || ROUTE.view === "dashboard" || ROUTE.view === "notfound";
  document.body.classList.toggle("list-mode", listMode);
  if (listMode) {
    h.textContent = ROUTE.view === "dashboard" ? "Quản lý tài liệu" : SITE;
    document.title = h.textContent;
  } else {
    h.textContent = (doc && doc.title) || SITE;
    if (doc && doc.version) { const sm = document.createElement("small"); sm.textContent = "Phiên bản " + doc.version; h.append(sm); }
    document.title = (doc && doc.title ? doc.title + " | " : "") + SITE;
  }

  const back = $("#btn-back");
  show(back, ROUTE.view === "reader" || ROUTE.view === "editor");
  back.href = ROUTE.view === "editor" ? "/admin" : url("/");
  $("#btn-back-lbl").textContent = ROUTE.view === "editor" ? "Quản lý" : "Tất cả tài liệu";
  back.title = $("#btn-back-lbl").textContent;

  const toAdmin = $("#btn-to-admin");
  show(toAdmin, !!user && (ROUTE.view === "reader" || ROUTE.view === "library"));
  toAdmin.href = ROUTE.view === "reader" ? "/admin/" + ROUTE.slug : "/admin";
  $("#btn-to-admin-lbl").textContent = ROUTE.view === "reader" ? "Chỉnh sửa" : "Quản lý";

  const pubLink = $("#btn-view-public");
  show(pubLink, !!user && (ROUTE.view === "dashboard" || (IS_ADMIN && !!publishedAt)));
  pubLink.href = IS_ADMIN ? "/d/" + ROUTE.slug + (active ? "#" + active : "") : "/";
  pubLink.textContent = IS_ADMIN ? "Xem bản đã xuất bản" : "Xem thư viện";

  show($("#btn-mode"), IS_ADMIN && !!user);
  show($("#btn-publish"), IS_ADMIN && !!user);
  show($("#btn-logout"), NEEDS_LOGIN && !!user);
  show($("#save-state"), IS_ADMIN && !!user);
  show($("#meta-box"), mode === "edit");
  show($("#btn-add"), mode === "edit");
  $("#btn-mode").textContent = mode === "edit" ? "Xem bản đọc" : "Soạn tiếp";

  if (IS_ADMIN && user) {
    const st = $("#save-state");
    let text, warn = false;
    if (conflict) { text = "Có bản mới hơn trên máy chủ"; warn = true; }
    else if (savePromise) text = "Đang lưu…";
    else if (dirty) { text = "Chưa lưu"; warn = true; }
    else if (!publishedAt) text = "Đã lưu nháp, chưa xuất bản lần nào";
    else if (!publishedSame) text = "Đã lưu nháp, chưa xuất bản";
    else text = "Đã xuất bản";
    st.textContent = text; st.classList.toggle("dirty", warn);
    $("#btn-publish").disabled = publishing || conflict || (!dirty && publishedSame);
  }
}

const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>'
};
function renderToc() {
  const raw = $("#search").value.trim(), q = raw.toLowerCase();
  const ul = $("#toc"); ul.innerHTML = "";
  if (!doc) return;
  let shown = 0;
  doc.sections.forEach((s, i) => {
    if (q && !(s.title + "\n" + s.content).toLowerCase().includes(q)) return;
    shown++;
    const li = document.createElement("li");
    const row = document.createElement("div"); row.className = "toc-row" + (s.id === active ? " active" : "");
    const b = document.createElement("button"); b.className = "toc-item";
    const n = document.createElement("span"); n.className = "n"; n.textContent = i + 1;
    const t = document.createElement("span"); t.className = "t"; t.textContent = s.title || "Chương chưa đặt tên";
    b.append(n, t); b.onclick = () => go(s.id);
    if (s.id === active) b.setAttribute("aria-current", "page");
    row.append(b);
    if (mode === "edit") {
      const mk = (html, label, fn, dis) => {
        const x = document.createElement("button"); x.className = "icon-btn"; x.innerHTML = html; x.title = label;
        x.setAttribute("aria-label", label); x.disabled = !!dis; if (dis) x.style.opacity = .3; x.onclick = fn; return x;
      };
      row.append(
        mk(ICON.up, "Chuyển lên", () => move(i, -1), i === 0),
        mk(ICON.down, "Chuyển xuống", () => move(i, 1), i === doc.sections.length - 1),
        mk(ICON.del, "Xoá chương", e => askDelete(e.currentTarget, s.id))
      );
    }
    li.append(row);
    if (mode === "read" && s.id === active) {
      const hs = document.querySelectorAll("#reader .prose h2");
      if (hs.length) {
        const sub = document.createElement("ul"); sub.className = "toc-sub";
        hs.forEach(h => {
          const l = document.createElement("li"), bb = document.createElement("button");
          bb.textContent = h.textContent;
          bb.onclick = () => { h.scrollIntoView({ behavior: "smooth", block: "start" }); closeDrawer(); };
          l.append(bb); sub.append(l);
        });
        li.append(sub);
      }
    }
    ul.append(li);
  });
  if (!shown) {
    const li = document.createElement("li"); li.className = "toc-empty";
    li.textContent = q ? `Không có chương nào chứa “${raw}”.` : "Chưa có chương nào.";
    ul.append(li);
  }
}

function renderEmpty(el, title, text, link) {
  el.innerHTML = '<div class="empty"><h2></h2><p></p></div>';
  el.querySelector("h2").textContent = title; el.querySelector("p").textContent = text;
  if (link) {
    const a = document.createElement("a"); a.className = "btn primary"; a.href = link[1]; a.textContent = link[0];
    a.style.marginTop = "12px"; el.querySelector(".empty").append(a);
  }
}
function renderReader() {
  const el = $("#reader"); el.innerHTML = "";
  if (!doc) { renderEmpty(el, "Không tìm thấy tài liệu", "Tài liệu này không tồn tại hoặc chưa được xuất bản.", ["Xem tất cả tài liệu", url("/")]); renderToc(); return; }
  const s = cur();
  if (!s) { renderEmpty(el, "Tài liệu chưa có nội dung", IS_ADMIN ? "Bấm “Soạn tiếp” rồi thêm chương đầu tiên." : "Tài liệu này chưa có chương nào."); renderToc(); return; }
  const i = idx();
  el.append(chapterEl(s, i + 1));
  const q = $("#search").value.trim().toLowerCase();
  if (q) highlight(el.querySelector(".prose"), q);
  const prev = doc.sections[i - 1], next = doc.sections[i + 1];
  if (prev || next) {
    const nav = document.createElement("nav"); nav.className = "pager"; nav.setAttribute("aria-label", "Chuyển chương");
    const mk = (sec, cls, dir) => {
      const b = document.createElement("button"); b.className = cls;
      const d = document.createElement("span"); d.className = "dir"; d.textContent = dir;
      const t = document.createElement("span"); t.className = "ttl"; t.textContent = sec.title;
      b.append(d, t); b.onclick = () => go(sec.id); return b;
    };
    if (prev) nav.append(mk(prev, "prev", "Chương trước"));
    if (next) nav.append(mk(next, "next", "Chương sau"));
    el.append(nav);
  }
  $("#main").scrollTop = 0;
  renderToc();
}
function renderPreview() {
  const s = cur(), el = $("#preview"); el.innerHTML = "";
  if (s) el.append(chapterEl(s, idx() + 1));
  else renderEmpty(el, "Chưa có chương nào", "Bấm “Thêm chương” ở cột trái để bắt đầu.");
}
const previewSoon = debounce(renderPreview, 160);
const tocSoon = debounce(renderToc, 200);
function renderEditor() {
  const s = cur();
  $("#ed-pane").style.visibility = s ? "" : "hidden";
  $("#ed-title").value = s ? s.title : "";
  $("#ed-body").value = s ? s.content : "";
  $("#ed-link").textContent = s ? "#" + s.id : "";
  $("#f-title").value = doc.title || ""; $("#f-sub").value = doc.subtitle || ""; $("#f-ver").value = doc.version || "";
  renderPreview();
}
function renderAll() {
  renderHeader();
  if (mode === "edit") { renderEditor(); renderToc(); } else renderReader();
}

/* ---------- Điều hướng ---------- */
function go(id) {
  if (!doc || !doc.sections.some(s => s.id === id)) return;
  active = id;
  try { history.replaceState(null, "", location.pathname + "#" + id); } catch (_) { /* bỏ qua */ }
  closeDrawer();
  renderAll();
}
window.addEventListener("hashchange", () => { const h = decodeURIComponent(location.hash.slice(1)); if (h && h !== active) go(h); });
function closeDrawer() { document.body.classList.remove("toc-open"); }
$("#btn-menu").onclick = () => document.body.classList.toggle("toc-open");
$("#scrim").onclick = closeDrawer;
$("#search").addEventListener("input", debounce(() => { if (mode === "read") renderReader(); else renderToc(); }, 150));

/* ---------- Soạn ---------- */
function setMode(m) {
  mode = m;
  document.body.classList.toggle("editing", m === "edit");
  document.body.classList.remove("show-preview");
  $("#tab-write").setAttribute("aria-pressed", "true"); $("#tab-preview").setAttribute("aria-pressed", "false");
  renderAll();
}
$("#btn-mode").onclick = () => setMode(mode === "edit" ? "read" : "edit");
$("#tab-write").onclick = () => { document.body.classList.remove("show-preview"); $("#tab-write").setAttribute("aria-pressed", "true"); $("#tab-preview").setAttribute("aria-pressed", "false"); };
$("#tab-preview").onclick = () => { renderPreview(); document.body.classList.add("show-preview"); $("#tab-preview").setAttribute("aria-pressed", "true"); $("#tab-write").setAttribute("aria-pressed", "false"); };

function writeBackup() { try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: Date.now(), baseRev: rev, doc })); } catch (_) { /* hết chỗ */ } }
function clearBackup() { try { localStorage.removeItem(BACKUP_KEY); } catch (_) { /* bỏ qua */ } }
const backupSoon = debounce(writeBackup, 500);
const autosave = debounce(() => saveDraft(), 1500);
function markDirty() { dirty = true; backupSoon(); if (!conflict) autosave(); renderHeader(); }

$("#ed-title").addEventListener("input", e => { const s = cur(); if (!s) return; s.title = e.target.value; markDirty(); previewSoon(); tocSoon(); });
$("#ed-body").addEventListener("input", e => { const s = cur(); if (!s) return; s.content = e.target.value; markDirty(); previewSoon(); });
[["#f-title", "title"], ["#f-sub", "subtitle"], ["#f-ver", "version"]].forEach(([sel, key]) => {
  $(sel).addEventListener("input", e => { doc[key] = e.target.value; markDirty(); });
});

$("#btn-add").onclick = () => {
  const s = { id: newId("chuong-moi"), title: "Chương mới", content: "Viết nội dung chương tại đây.\n\n## Mục đầu tiên\n\n" };
  const at = idx(); doc.sections.splice(at >= 0 ? at + 1 : doc.sections.length, 0, s);
  active = s.id; markDirty(); renderAll();
  setTimeout(() => { const t = $("#ed-title"); t.focus(); t.select(); }, 30);
};
// Đổi tên chương lần đầu thì đặt lại mã chương theo tên (chỉ với chương chưa từng xuất bản)
$("#ed-title").addEventListener("change", () => {
  const s = cur(); if (!s || !/^chuong-moi(-\d+)?$/.test(s.id) || !s.title.trim()) return;
  const old = s.id; s.id = ""; s.id = newId(s.title); active = s.id;
  if (old !== s.id) { $("#ed-link").textContent = "#" + s.id; markDirty(); renderToc(); }
});
function move(i, d) {
  const j = i + d; if (j < 0 || j >= doc.sections.length) return;
  const [s] = doc.sections.splice(i, 1); doc.sections.splice(j, 0, s);
  markDirty(); renderAll();
}
function askDelete(btn, id) {
  if (btn.dataset.armed) {
    const i = doc.sections.findIndex(s => s.id === id); if (i < 0) return;
    const removed = doc.sections.splice(i, 1)[0];
    if (active === id) active = (doc.sections[i] || doc.sections[i - 1] || {}).id || null;
    markDirty(); renderAll();
    toast(`Đã xoá chương “${removed.title}” khỏi bản nháp.`);
    return;
  }
  btn.dataset.armed = "1"; btn.classList.add("confirm"); btn.textContent = "Xoá?";
  btn.setAttribute("aria-label", "Bấm lần nữa để xoá chương");
  setTimeout(() => { if (btn.isConnected) renderToc(); }, 3000);
}

/* ---------- Thanh công cụ ---------- */
const ta = () => $("#ed-body");
function insertText(str, s, e) {
  const t = ta(); t.focus(); t.setSelectionRange(s, e);
  let ok = false; try { ok = document.execCommand("insertText", false, str); } catch (_) { /* không hỗ trợ */ }
  if (!ok) { t.setRangeText(str, s, e, "end"); t.dispatchEvent(new Event("input", { bubbles: true })); }
}
function wrap(a, b, ph) {
  const t = ta(), s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e) || ph;
  insertText(a + sel + b, s, e);
  t.setSelectionRange(s + a.length, s + a.length + sel.length);
}
function linePrefix(p) {
  const t = ta(), s = t.selectionStart, e = t.selectionEnd, v = t.value;
  const ls = v.lastIndexOf("\n", s - 1) + 1;
  let le = v.indexOf("\n", e); if (le < 0) le = v.length;
  const out = v.slice(ls, le).split("\n")
    .map((l, k) => (p === "1. " ? (k + 1) + ". " : p) + l.replace(/^(#{1,6}\s+|[-*]\s+|\d+\.\s+)/, "")).join("\n");
  insertText(out, ls, le);
}
function insertBlock(txt) {
  const t = ta(), s = t.selectionStart, e = t.selectionEnd, before = t.value.slice(0, s);
  const pre = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  insertText(pre + txt + "\n\n", s, e);
}
const TOOLS = {
  h2: () => linePrefix("## "), h3: () => linePrefix("### "),
  bold: () => wrap("**", "**", "chữ đậm"), italic: () => wrap("*", "*", "chữ nghiêng"),
  code: () => wrap("`", "`", "mã"), link: () => wrap("[", "](https://)", "chữ hiển thị"),
  ul: () => linePrefix("- "), ol: () => linePrefix("1. "),
  table: () => insertBlock("| Cột 1 | Cột 2 |\n| --- | --- |\n| Nội dung | Nội dung |"),
  note: () => insertBlock("> [!NOTE]\n> Nội dung lưu ý"),
  tip: () => insertBlock("> [!TIP]\n> Nội dung mẹo"),
  warning: () => insertBlock("> [!WARNING]\n> Nội dung cảnh báo"),
  image: () => $("#file-img").click()
};
document.querySelectorAll(".tool").forEach(b => b.addEventListener("click", () => { if (cur()) TOOLS[b.dataset.t](); }));

$("#file-img").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0]; e.target.value = "";
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast("Chỉ chèn được ảnh PNG, JPG, GIF hoặc WebP."); return; }
  const caret = [ta().selectionStart, ta().selectionEnd];
  const alt = file.name.replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "");
  toast("Đang tải ảnh lên…", 20000);
  try {
    const fd = new FormData(); fd.append("file", file);
    const r = await api("POST", "/api/images", fd, true);
    ta().setSelectionRange(caret[0], caret[1]);
    insertBlock(`![${alt}](${r.url})`);
    toast("Đã chèn ảnh.");
  } catch (err) {
    if (err.status === 401) return sessionExpired();
    toast(err.message || "Không tải được ảnh lên.");
  }
});

/* ---------- Lưu và xuất bản ---------- */
function sessionExpired() {
  writeBackup();
  toast("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại; thay đổi của bạn được giữ trên trình duyệt này.", 6000);
  user = null; showLogin();
}
async function doSave() {
  const snapshot = JSON.stringify(doc);
  try {
    const r = await api("PUT", `/api/admin/docs/${ROUTE.slug}/draft`, { doc: JSON.parse(snapshot), baseRev: rev });
    rev = r.rev; publishedSame = r.publishedSame;
    if (JSON.stringify(doc) === snapshot) { dirty = false; clearBackup(); }
  } catch (err) {
    if (err.status === 409) {
      conflict = true; writeBackup(); autosave.cancel();
      showBanner((err.message || "Bản nháp vừa được người khác sửa.") + " Tải lại trang để xem bản mới; bạn có thể khôi phục thay đổi của mình sau khi tải lại.",
        [["Tải lại trang", () => location.reload(), true]]);
    } else if (err.status === 401) sessionExpired();
    else toast((err.message || "Chưa lưu được.") + " Thay đổi vẫn được giữ trên trình duyệt này.", 5000);
  }
}
function saveDraft() {
  if (conflict) return Promise.resolve();
  if (savePromise) { pendingSave = true; return savePromise; }
  if (!dirty) return Promise.resolve();
  autosave.cancel();
  savePromise = doSave().finally(() => {
    savePromise = null; renderHeader();
    if (pendingSave && dirty && !conflict) { pendingSave = false; saveDraft(); }
  });
  renderHeader();
  return savePromise;
}
async function publish() {
  if (publishing || conflict) return;
  publishing = true; renderHeader();
  try {
    while (savePromise) await savePromise;
    if (dirty) await saveDraft();
    if (dirty || conflict) { toast("Chưa lưu được bản nháp nên chưa xuất bản."); return; }
    const r = await api("POST", `/api/admin/docs/${ROUTE.slug}/publish`, { rev });
    publishedSame = true; publishedAt = r.publishedAt;
    toast("Đã xuất bản. Người dùng sẽ thấy bản mới khi mở hoặc tải lại trang.", 4500);
  } catch (err) {
    if (err.status === 401) sessionExpired();
    else toast(err.message || "Chưa xuất bản được. Thử lại sau ít phút.", 5000);
  } finally { publishing = false; renderHeader(); }
}
$("#btn-publish").onclick = publish;
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && IS_ADMIN && user) {
    e.preventDefault(); saveDraft().then(() => { if (!dirty && !conflict) toast("Đã lưu nháp."); });
  }
});
window.addEventListener("beforeunload", e => {
  if (dirty) { writeBackup(); e.preventDefault(); e.returnValue = ""; }
});

function showBanner(text, actions) {
  const slot = $("#banner-slot"); slot.innerHTML = "";
  const b = document.createElement("div"); b.className = "banner";
  const sp = document.createElement("span"); sp.textContent = text; b.append(sp);
  actions.forEach(([label, fn, primary]) => {
    const x = document.createElement("button"); x.className = "btn" + (primary ? " primary" : ""); x.textContent = label;
    x.onclick = () => { slot.innerHTML = ""; fn(); }; b.append(x);
  });
  slot.append(b);
}
function checkBackup() {
  let bk = null; try { bk = JSON.parse(localStorage.getItem(BACKUP_KEY) || "null"); } catch (_) { /* hỏng */ }
  if (!bk || !bk.doc || !Array.isArray(bk.doc.sections)) return;
  if (JSON.stringify(bk.doc) === JSON.stringify(doc)) { clearBackup(); return; }
  const when = new Date(bk.at).toLocaleString("vi-VN");
  const note = bk.baseRev !== rev ? " Bản nháp trên máy chủ đã thay đổi kể từ đó; khôi phục sẽ ghi đè lên nó." : "";
  showBanner(`Có thay đổi chưa lưu từ ${when} trên trình duyệt này.${note}`, [
    ["Khôi phục", () => {
      doc = bk.doc; if (!cur()) active = (doc.sections[0] || {}).id || null;
      setMode("edit"); markDirty(); toast("Đã khôi phục. Thay đổi sẽ được lưu vào bản nháp.");
    }, true],
    ["Bỏ", clearBackup]
  ]);
}

/* ---------- PDF ---------- */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
function buildPrint() {
  const host = document.createElement("div"); host.className = "print-host";
  const root = document.createElement("div"); root.className = "print-root"; host.append(root);
  const add = (parent, tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; parent.append(e); return e; };
  const cover = add(root, "section", "pr-cover");
  add(cover, "h1", "", doc.title || "Tài liệu hướng dẫn");
  if (doc.subtitle) add(cover, "p", "sub", doc.subtitle);
  if (doc.version) add(cover, "p", "m", "Phiên bản " + doc.version);
  add(cover, "p", "m", "Ngày " + fmtDate(new Date().toISOString()));
  if (doc.sections.length > 1) {
    const toc = add(root, "section", "pr-toc pdf-break");
    add(toc, "h2", "", "Mục lục");
    const ol = add(toc, "ol");
    doc.sections.forEach(s => add(ol, "li", "", s.title));
  }
  doc.sections.forEach((s, i) => add(root, "section", "pr-ch pdf-break").append(chapterEl(s, i + 1)));
  document.body.append(host);
  return { host, root };
}
function printFallback() {
  const { host } = buildPrint();
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); host.remove(); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  setTimeout(() => window.print(), 150);
}
async function exportPdf() {
  if (!doc || !doc.sections.length) { toast("Tài liệu chưa có chương nào để xuất."); return; }
  const btn = $("#btn-pdf"); btn.disabled = true;
  toast("Đang tạo PDF…", 60000);
  let built = null;
  try {
    if (!window.html2pdf) await loadScript(url("/vendor/html2pdf.bundle.min.js"));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    built = buildPrint();
    await new Promise(r => setTimeout(r, 120));
    const filename = (slug(doc.title) || "tai-lieu") + (doc.version ? "-v" + slug(doc.version) : "") + ".pdf";
    const pdf = await window.html2pdf().set({
      margin: [15, 15, 16, 15], filename,
      image: { type: "jpeg", quality: .94 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff", logging: false },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"], before: ".pdf-break", avoid: ["img", "pre", "blockquote", "tr", ".ch-head"] }
    }).from(built.root).toPdf().get("pdf");
    const total = pdf.internal.getNumberOfPages(), W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
    for (let i = 2; i <= total; i++) { pdf.setPage(i); pdf.setFontSize(9); pdf.setTextColor(120); pdf.text(String(i), W / 2, H - 7, { align: "center" }); }
    const blobUrl = URL.createObjectURL(pdf.output("blob"));
    const a = document.createElement("a"); a.href = blobUrl; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    toast("Đã tạo PDF.");
  } catch (err) {
    console.error(err);
    toast("Không tạo được PDF tự động. Hãy chọn “Lưu dưới dạng PDF” trong hộp thoại in.", 6000);
    printFallback();
  } finally {
    if (built) built.host.remove();
    btn.disabled = false;
  }
}
$("#btn-pdf").onclick = exportPdf;

/* ---------- Thư viện (trang gốc) ---------- */
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function fmtTime(iso) {
  const d = new Date(iso); if (!iso || isNaN(d)) return "";
  return d.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
async function renderLibrary() {
  const box = $("#list"); box.innerHTML = '<div class="lib"><div class="loading">Đang tải…</div></div>';
  let data;
  try { data = await api("GET", "/api/docs"); }
  catch (_) { box.innerHTML = ""; renderEmpty(box, "Không tải được danh sách tài liệu", "Kiểm tra kết nối mạng rồi tải lại trang."); return; }
  SITE = data.site || SITE; renderHeader();
  const wrapEl = el("div", "lib"); box.innerHTML = ""; box.append(wrapEl);
  const head = el("div", "lib-head"); const hl = el("div");
  hl.append(el("h1", "lib-title", SITE), el("p", "lib-sub", data.docs.length ? `${data.docs.length} tài liệu` : ""));
  head.append(hl);
  let search = null;
  if (data.docs.length > 5) { search = el("input", "search lib-search"); search.type = "search"; search.placeholder = "Tìm tài liệu"; search.setAttribute("aria-label", "Tìm tài liệu"); head.append(search); }
  wrapEl.append(head);
  const ul = el("ul", "lib-list"); wrapEl.append(ul);
  const draw = () => {
    const q = search ? search.value.trim().toLowerCase() : "";
    ul.innerHTML = "";
    const items = data.docs.filter(d => !q || ((d.title || "") + " " + (d.subtitle || "")).toLowerCase().includes(q));
    items.forEach(d => {
      const li = el("li"), a = el("a", "lib-item"); a.href = url("/d/" + d.slug);
      a.append(el("span", "lib-name", d.title || d.slug));
      const meta = [d.version ? "Phiên bản " + d.version : "", d.publishedAt ? "Cập nhật " + fmtDate(d.publishedAt) : ""].filter(Boolean).join(", ");
      a.append(el("span", "lib-meta", meta));
      if (d.subtitle) a.append(el("p", "lib-desc", d.subtitle));
      li.append(a); ul.append(li);
    });
    if (!items.length) {
      const li = el("li", "lib-empty");
      li.textContent = q ? `Không có tài liệu nào khớp “${search.value.trim()}”.` : "Chưa có tài liệu nào được xuất bản.";
      if (!q && user) { const b = el("a", "btn primary", "Vào trang quản lý"); b.href = "/admin"; li.append(el("br"), b); }
      ul.append(li);
    }
  };
  if (search) search.addEventListener("input", draw);
  draw();
}

/* ---------- Trang quản lý ---------- */
let dashDocs = [];
async function renderDashboard(focusCreate) {
  const box = $("#list");
  let data;
  try { data = await api("GET", "/api/admin/docs"); }
  catch (err) { if (err.status === 401) return showLogin(); box.innerHTML = ""; renderEmpty(box, "Không tải được danh sách", err.message); return; }
  SITE = data.site || SITE; dashDocs = data.docs; renderHeader();
  box.innerHTML = "";
  const wrapEl = el("div", "lib"); box.append(wrapEl);
  const head = el("div", "lib-head"), hl = el("div");
  hl.append(el("h1", "lib-title", "Tài liệu"), el("p", "lib-sub", `${dashDocs.length} tài liệu, ${dashDocs.filter(d => d.publishedAt).length} đã xuất bản`));
  const newBtn = el("button", "btn primary", "+ Tạo tài liệu mới");
  head.append(hl, newBtn); wrapEl.append(head);
  const pagesSlot = el("div"); wrapEl.append(pagesSlot); renderPagesPanel(pagesSlot);

  const formSlot = el("div"); wrapEl.append(formSlot);
  const openCreate = () => { newBtn.disabled = true; formSlot.innerHTML = ""; formSlot.append(createForm(() => { formSlot.innerHTML = ""; newBtn.disabled = false; })); };
  newBtn.onclick = openCreate;
  if (focusCreate || !dashDocs.length) openCreate();

  const ul = el("ul", "lib-list"); wrapEl.append(ul);
  dashDocs.forEach(d => ul.append(dashRow(d)));
}

async function renderPagesPanel(slot) {
  let st;
  try { st = await api("GET", "/api/admin/pages"); } catch (_) { return; }
  if (!st.enabled) return; // chưa thiết lập GitHub Pages: không hiện gì
  const box = el("div", "pages-panel");
  const info = el("div", "pages-info");
  info.append(el("strong", "", "GitHub Pages"));
  const line = el("span", "");
  if (st.url) { const a = el("a", "", st.url); a.href = st.url; a.target = "_blank"; a.rel = "noopener"; line.append(a); }
  else line.textContent = st.remote;
  info.append(line, el("span", "pages-note", "Chỉ những tài liệu đã xuất bản mới được đưa lên. Trang công khai trên internet."));
  const btn = el("button", "btn primary", "Đưa lên GitHub Pages");
  const result = el("p", "pages-result"); result.setAttribute("role", "status");
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Đang đưa lên…"; result.textContent = ""; result.classList.remove("err");
    try {
      const r = await api("POST", "/api/admin/pages/publish");
      result.textContent = r.changed
        ? `Đã đưa ${r.docs} tài liệu và ${r.images} ảnh lên GitHub. Trang sẽ cập nhật sau khoảng 1 phút.`
        : `Không có gì thay đổi so với lần trước (${r.docs} tài liệu).`;
      if (r.missingImages && r.missingImages.length) result.textContent += ` Thiếu ${r.missingImages.length} ảnh trên server.`;
    } catch (ex) {
      if (ex.status === 401) return showLogin();
      result.textContent = ex.message; result.classList.add("err");
    } finally { btn.disabled = false; btn.textContent = "Đưa lên GitHub Pages"; }
  };
  box.append(info, btn, result); slot.append(box);
}

function createForm(onClose) {
  const f = el("form", "create"); f.noValidate = true;
  f.append(el("h2", "", "Tạo tài liệu mới"));
  const row = el("div", "row");
  const l1 = el("label", "", "Tên tài liệu"); const title = el("input"); title.required = true; title.placeholder = "Ví dụ: Hướng dẫn sử dụng phần mềm bán hàng"; l1.append(title);
  const l2 = el("label", "", "Đường dẫn"); const pre = el("div", "prefix"); pre.append(el("span", "", "/d/"));
  const slugIn = el("input"); slugIn.placeholder = "tu-dong-theo-ten"; slugIn.spellcheck = false; pre.append(slugIn); l2.append(pre);
  row.append(l1, l2); f.append(row);
  const l3 = el("label", "", "Nội dung ban đầu"); const sel = el("select");
  sel.append(new Option("Trống (một chương mẫu)", ""));
  dashDocs.forEach(d => sel.append(new Option("Sao chép từ: " + (d.title || d.slug), d.slug)));
  l3.append(sel); f.append(l3);
  const err = el("p", "form-err"); err.setAttribute("role", "alert"); f.append(err);
  const acts = el("div", "acts"); const ok = el("button", "btn primary", "Tạo và mở trình soạn"); ok.type = "submit";
  const cancel = el("button", "btn", "Huỷ"); cancel.type = "button"; cancel.onclick = onClose; acts.append(ok, cancel); f.append(acts);
  let slugTouched = false;
  slugIn.addEventListener("input", () => { slugTouched = !!slugIn.value; slugIn.value = slugIn.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); });
  title.addEventListener("input", () => { if (!slugTouched) slugIn.value = slug(title.value); });
  f.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = "";
    if (!title.value.trim()) { err.textContent = "Hãy đặt tên cho tài liệu."; title.focus(); return; }
    ok.disabled = true;
    try {
      const r = await api("POST", "/api/admin/docs", { title: title.value.trim(), slug: slugIn.value.replace(/^-+|-+$/g, "") || undefined, copyFrom: sel.value || undefined });
      location.href = "/admin/" + r.slug;
    } catch (ex) {
      if (ex.status === 401) return showLogin();
      err.textContent = ex.message; ok.disabled = false;
    }
  });
  setTimeout(() => title.focus(), 30);
  return f;
}

function dashRow(d) {
  const li = el("li"), row = el("div", "dash-row"); li.append(row);
  const name = el("div", "lib-name"); const a = el("a", "", d.title || d.slug); a.href = "/admin/" + d.slug; name.append(a);
  const pill = !d.publishedAt ? el("span", "pill draft", "Chưa xuất bản") : d.publishedSame ? el("span", "pill live", "Đã xuất bản") : el("span", "pill changed", "Có thay đổi chưa xuất bản");
  name.append(pill); row.append(name);
  const info = el("div", "dash-info");
  const code = el("code", "", "/d/" + d.slug); info.append(code);
  info.append(el("span", "", `${d.chapters || 0} chương`));
  info.append(el("span", "", "Sửa lần cuối " + fmtTime(d.updatedAt) + (d.updatedBy ? " bởi " + d.updatedBy : "")));
  row.append(info);

  const acts = el("div", "dash-actions");
  const edit = el("a", "btn primary", "Soạn"); edit.href = "/admin/" + d.slug; acts.append(edit);
  if (d.publishedAt) { const v = el("a", "btn", "Xem"); v.href = "/d/" + d.slug; v.target = "_blank"; v.rel = "noopener"; acts.append(v); }
  const ren = el("button", "btn", "Đổi đường dẫn"); acts.append(ren);
  if (d.publishedAt) { const un = el("button", "btn", "Ngừng xuất bản"); acts.append(un); un.onclick = () => confirmAction(un, "Bấm lần nữa để ẩn khỏi người đọc", async () => {
    await api("POST", `/api/admin/docs/${d.slug}/unpublish`); toast(`Đã ngừng xuất bản “${d.title}”. Bản nháp vẫn còn.`); renderDashboard();
  }); }
  const del = el("button", "btn danger", "Xoá"); acts.append(del);
  del.onclick = () => confirmAction(del, "Bấm lần nữa để xoá vĩnh viễn", async () => {
    await api("DELETE", `/api/admin/docs/${d.slug}`); toast(`Đã xoá “${d.title}”.`); renderDashboard();
  });
  row.append(acts);

  ren.onclick = () => {
    if (row.querySelector(".inline-form")) return;
    const f = el("form", "inline-form"); f.noValidate = true;
    f.append(el("span", "", "/d/"));
    const inp = el("input"); inp.value = d.slug; inp.spellcheck = false; inp.setAttribute("aria-label", "Đường dẫn mới");
    const sv = el("button", "btn primary", "Lưu đường dẫn"); sv.type = "submit";
    const cc = el("button", "btn", "Huỷ"); cc.type = "button"; cc.onclick = () => f.remove();
    const er = el("p", "form-err"); f.append(inp, sv, cc, er);
    if (d.publishedAt) f.append(el("p", "form-err", "Lưu ý: liên kết cũ /d/" + d.slug + " sẽ không còn hoạt động."));
    f.addEventListener("submit", async e => {
      e.preventDefault(); er.textContent = "";
      try { await api("PATCH", `/api/admin/docs/${d.slug}`, { slug: inp.value.trim() }); toast("Đã đổi đường dẫn."); renderDashboard(); }
      catch (ex) { if (ex.status === 401) return showLogin(); er.textContent = ex.message; }
    });
    row.append(f); inp.focus(); inp.select();
  };
  return li;
}

function confirmAction(btn, label, fn) {
  if (btn.dataset.armed) {
    btn.disabled = true;
    fn().catch(ex => { if (ex.status === 401) return showLogin(); toast(ex.message || "Không thực hiện được."); btn.disabled = false; });
    return;
  }
  const old = btn.textContent;
  btn.dataset.armed = "1"; btn.classList.add("armed"); btn.textContent = label;
  setTimeout(() => { if (btn.isConnected && !btn.disabled) { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = old; } }, 4000);
}

/* ---------- Đăng nhập ---------- */
function showLogin() {
  document.body.classList.add("show-login");
  setTimeout(() => $("#login-form [name=username]").focus(), 30);
}
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, err = $("#login-err"), btn = $("#login-btn");
  const username = f.username.value.trim(), password = f.password.value;
  if (!username || !password) { err.textContent = "Nhập tên đăng nhập và mật khẩu."; return; }
  btn.disabled = true; err.textContent = "";
  try {
    const r = await api("POST", "/api/login", { username, password });
    user = r.user; f.password.value = "";
    document.body.classList.remove("show-login");
    if (IS_ADMIN && doc) { renderHeader(); if (dirty && !conflict) saveDraft(); }
    else await bootView();
  } catch (ex) {
    err.textContent = ex.message || "Không đăng nhập được.";
  } finally { btn.disabled = false; }
});
$("#btn-logout").onclick = async () => {
  if (dirty) await saveDraft();
  try { await api("POST", "/api/logout"); } catch (_) { /* vẫn chuyển trang */ }
  location.href = "/";
};

/* ---------- Xem ảnh phóng to ---------- */
// Bấm ảnh trong nội dung để mở. Cuộn chuột, chụm hai ngón hoặc nhấn đúp vào ảnh để phóng to; kéo để di chuyển;
// ←/→ hoặc vuốt ngang để chuyển ảnh; Esc để đóng. Tỉ lệ s = 1 nghĩa là ảnh vừa khung.
const lightbox = (() => {
  const SVG = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  let box = null, stage, pic, cap, count, pct, btnPrev, btnNext, btnOut, btnIn;
  let list = [], at = 0, back = null;
  let nw = 0, nh = 0, fit = 1, s = 1, tx = 0, ty = 0;
  const ptrs = new Map();
  let gesture = null, lastTap = null;

  function build() {
    box = el("div", "lightbox");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "Xem ảnh");
    box.innerHTML =
      `<div class="lb-bar"><span class="lb-count"></span>
        <button class="lb-btn" data-act="out" title="Thu nhỏ (−)" aria-label="Thu nhỏ">${SVG("M5 12h14")}</button>
        <button class="lb-btn lb-pct" data-act="fit" title="Vừa khung (0)" aria-label="Vừa khung"></button>
        <button class="lb-btn" data-act="in" title="Phóng to (+)" aria-label="Phóng to">${SVG("M12 5v14M5 12h14")}</button>
        <button class="lb-btn" data-act="close" title="Đóng (Esc)" aria-label="Đóng">${SVG("M6 6l12 12M18 6L6 18")}</button></div>
      <div class="lb-stage"><img class="lb-img" alt="" draggable="false">
        <button class="lb-btn lb-nav lb-prev" data-act="prev" title="Ảnh trước (←)" aria-label="Ảnh trước">${SVG("M15 6l-6 6 6 6")}</button>
        <button class="lb-btn lb-nav lb-next" data-act="next" title="Ảnh sau (→)" aria-label="Ảnh sau">${SVG("M9 6l6 6-6 6")}</button></div>
      <div class="lb-foot"><div class="lb-cap"></div>
        <div class="lb-hint">Cuộn chuột hoặc chụm hai ngón để phóng to, kéo để di chuyển, nhấn đúp để phóng nhanh</div></div>`;
    stage = box.querySelector(".lb-stage"); pic = box.querySelector(".lb-img");
    cap = box.querySelector(".lb-cap"); count = box.querySelector(".lb-count"); pct = box.querySelector(".lb-pct");
    btnPrev = box.querySelector(".lb-prev"); btnNext = box.querySelector(".lb-next");
    btnOut = box.querySelector('[data-act="out"]'); btnIn = box.querySelector('[data-act="in"]');
    document.body.append(box);

    box.addEventListener("click", e => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.dataset.act;
      if (act === "close") close();
      else if (act === "prev") show(at - 1);
      else if (act === "next") show(at + 1);
      else if (act === "fit") reset(true);
      else zoomTo(s * (act === "in" ? 1.5 : 1 / 1.5), null, true);
    });
    document.addEventListener("keydown", e => { if (box.classList.contains("open")) onKey(e); });
    pic.addEventListener("load", () => { nw = pic.naturalWidth; nh = pic.naturalHeight; reset(false); pic.style.visibility = ""; });
    stage.addEventListener("wheel", e => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoomTo(s * Math.exp(-dy * 0.002), { x: e.clientX, y: e.clientY }, false);
    }, { passive: false });
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", () => { if (box.classList.contains("open")) { layout(); clamp(); apply(false); } });
  }

  const maxS = () => Math.max(4, 3 / fit);
  function center() { const r = stage.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function layout() {
    if (!nw || !nh) return;
    fit = Math.min(1, (stage.clientWidth - 32) / nw, (stage.clientHeight - 32) / nh);
    const w = nw * fit, h = nh * fit;
    pic.style.width = w + "px"; pic.style.height = h + "px";
    pic.style.marginLeft = -w / 2 + "px"; pic.style.marginTop = -h / 2 + "px";
  }
  function clamp() {
    const lx = Math.max(0, (nw * fit * s - stage.clientWidth) / 2), ly = Math.max(0, (nh * fit * s - stage.clientHeight) / 2);
    tx = Math.min(lx, Math.max(-lx, tx)); ty = Math.min(ly, Math.max(-ly, ty));
  }
  function apply(animate) {
    pic.classList.toggle("animate", !!animate);
    pic.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    box.classList.toggle("zoomed", s > 1.01);
    pct.textContent = Math.round(fit * s * 100) + "%";
    btnOut.disabled = s <= 1.001; btnIn.disabled = s >= maxS() - 0.001;
  }
  function reset(animate) { layout(); s = 1; tx = 0; ty = 0; apply(animate); }
  // Phóng tới tỉ lệ ns, giữ nguyên điểm ảnh nằm dưới toạ độ màn hình p (mặc định là giữa khung)
  function zoomTo(ns, p, animate) {
    ns = Math.min(maxS(), Math.max(1, ns));
    const c = center(), qx = p ? p.x - c.x : 0, qy = p ? p.y - c.y : 0;
    tx = qx - (qx - tx) * ns / s; ty = qy - (qy - ty) * ns / s; s = ns;
    clamp(); apply(animate);
  }

  function onDown(e) {
    if (e.target.closest(".lb-nav")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...ptrs.values()];
    if (pts.length === 1) gesture = { kind: "pan", x0: e.clientX, y0: e.clientY, tx0: tx, ty0: ty, moved: false, onImg: e.target === pic };
    else if (pts.length === 2) {
      const [a, b] = pts;
      gesture = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s, tx0: tx, ty0: ty, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, moved: true };
    }
    box.classList.add("dragging");
  }
  function onMove(e) {
    if (!ptrs.has(e.pointerId) || !gesture) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.kind === "pan") {
      const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
      if (Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
      if (s > 1.01) { tx = gesture.tx0 + dx; ty = gesture.ty0 + dy; clamp(); apply(false); }
    } else if (ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const ns = Math.min(maxS(), Math.max(1, gesture.s0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0));
      const c = center(), m = { x: (a.x + b.x) / 2 - c.x, y: (a.y + b.y) / 2 - c.y }, m0 = { x: gesture.m0.x - c.x, y: gesture.m0.y - c.y };
      tx = m.x - (m0.x - gesture.tx0) * ns / gesture.s0; ty = m.y - (m0.y - gesture.ty0) * ns / gesture.s0; s = ns;
      clamp(); apply(false);
    }
  }
  function onUp(e) {
    if (!ptrs.delete(e.pointerId)) return;
    const g = gesture;
    if (ptrs.size > 0) {
      // Còn một ngón sau khi chụm: tiếp tục kéo từ vị trí hiện tại
      const p = [...ptrs.values()][0];
      gesture = { kind: "pan", x0: p.x, y0: p.y, tx0: tx, ty0: ty, moved: true };
      return;
    }
    gesture = null; box.classList.remove("dragging");
    if (!g || g.kind !== "pan") return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (s <= 1.01 && e.pointerType !== "mouse" && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) show(at + (dx < 0 ? 1 : -1));
    else if (g.moved || e.type !== "pointerup") return;
    else if (!g.onImg) close();
    else if (lastTap && e.timeStamp - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      // Nhấn đúp: đang phóng thì về vừa khung, chưa phóng thì phóng tới cỡ thật (ít nhất gấp đôi) quanh điểm nhấn
      lastTap = null;
      if (s > 1.01) reset(true);
      else zoomTo(Math.max(2, 1 / fit), { x: e.clientX, y: e.clientY }, true);
    } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  }

  function onKey(e) {
    const k = e.key;
    if (k === "Escape") close();
    else if (k === "ArrowLeft") show(at - 1);
    else if (k === "ArrowRight") show(at + 1);
    else if (k === "+" || k === "=") zoomTo(s * 1.5, null, true);
    else if (k === "-" || k === "_") zoomTo(s / 1.5, null, true);
    else if (k === "0") reset(true);
    else if (k === "Tab") {
      // Giữ focus trong khung xem ảnh
      const f = [...box.querySelectorAll("button:not([disabled])")].filter(b => b.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      return;
    } else return;
    e.preventDefault();
  }

  function show(i) {
    if (i < 0 || i >= list.length) return;
    at = i;
    const src = list[i];
    nw = nh = 0; s = 1; tx = ty = 0; lastTap = null;
    pic.style.visibility = "hidden";
    pic.alt = src.alt || "";
    pic.src = src.currentSrc || src.src;
    if (pic.complete && pic.naturalWidth) { nw = pic.naturalWidth; nh = pic.naturalHeight; reset(false); pic.style.visibility = ""; }
    cap.textContent = src.alt || "";
    count.textContent = list.length > 1 ? `${i + 1} / ${list.length}` : "";
    btnPrev.classList.toggle("hide", list.length < 2); btnNext.classList.toggle("hide", list.length < 2);
    btnPrev.disabled = i === 0; btnNext.disabled = i === list.length - 1;
  }
  function open(imgs, i) {
    if (!box) build();
    list = imgs; back = document.activeElement;
    box.classList.add("open"); document.body.classList.add("lb-open");
    show(Math.max(0, i));
    box.querySelector('[data-act="close"]').focus();
  }
  function close() {
    if (!box || !box.classList.contains("open")) return;
    box.classList.remove("open", "zoomed", "dragging"); document.body.classList.remove("lb-open");
    ptrs.clear(); gesture = null;
    if (back && back.focus) back.focus();
  }
  return { open };
})();
// Biểu tượng nhỏ chèn giữa dòng và ảnh nằm trong liên kết không mở khung xem
const zoomable = im => !im.closest("a") && im.getBoundingClientRect().width >= 48;
document.addEventListener("click", e => {
  const im = e.target.closest(".reader .prose img");
  if (!im || !zoomable(im)) return;
  e.preventDefault();
  const imgs = [...im.closest(".prose").querySelectorAll("img")].filter(zoomable);
  lightbox.open(imgs, imgs.indexOf(im));
});

/* ---------- Khởi động ---------- */
function pickActive() {
  const h = decodeURIComponent(location.hash.slice(1));
  active = doc ? ((doc.sections.find(s => s.id === h) || doc.sections[0] || {}).id || null) : null;
}
async function bootView() {
  if (ROUTE.view === "library") return renderLibrary();
  if (ROUTE.view === "dashboard") return renderDashboard();
  if (ROUTE.view === "notfound") {
    renderHeader(); const box = $("#list"); box.innerHTML = "";
    renderEmpty(box, "Không tìm thấy trang", "Địa chỉ này không tồn tại.", ["Xem tất cả tài liệu", "/"]); return;
  }
  if (ROUTE.view === "editor") {
    try {
      const d = await api("GET", `/api/admin/docs/${ROUTE.slug}/draft`);
      doc = d.doc; rev = d.rev; publishedSame = d.publishedSame; publishedAt = d.publishedAt;
      pickActive(); setMode("edit"); checkBackup();
    } catch (err) {
      if (err.status === 401) return showLogin();
      renderHeader();
      renderEmpty($("#reader"), err.status === 404 ? "Không tìm thấy tài liệu" : "Không tải được bản nháp",
        err.status === 404 ? "Tài liệu này không tồn tại hoặc đã bị đổi đường dẫn." : err.message, ["Về trang quản lý", "/admin"]);
    }
    return;
  }
  // reader
  try { const r = await api("GET", `/api/docs/${ROUTE.slug}`); doc = r.doc; }
  catch (err) {
    doc = null;
    if (err.status !== 404) { renderEmpty($("#reader"), "Không tải được tài liệu", "Kiểm tra kết nối mạng rồi tải lại trang."); renderHeader(); return; }
  }
  pickActive(); setMode("read");
}
async function boot() {
  const [me, site] = await Promise.all([
    api("GET", "/api/me").catch(() => null),
    (ROUTE.view === "reader" || ROUTE.view === "editor") ? api("GET", "/api/site").catch(() => null) : null
  ]);
  user = me ? me.user : null;
  if (site && site.name) SITE = site.name;
  if (NEEDS_LOGIN && !user) { renderHeader(); showLogin(); return; }
  await bootView();
}
boot();
})();
