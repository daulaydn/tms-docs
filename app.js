(function () {
"use strict";
const $ = s => document.querySelector(s);
const { I18N, fold, foldWithMap, countMatches } = window.HD_I18N;
// Chế độ tĩnh: trang được xuất bằng `npm run export` (GitHub Pages…). Không có server, không đăng nhập.
const META = n => { const m = document.querySelector(`meta[name="${n}"]`); return m ? m.content : null; };
const STATIC = META("hd-static") !== null;
const BASE = STATIC ? META("hd-static") : "/";
const PATH = location.pathname.replace(/\/+$/, "") || "/";
const QS = new URLSearchParams(location.search);
// Từ khoá đang tìm ở các trang danh sách; cập nhật mỗi lần gõ để đổi ngôn ngữ hay vẽ lại trang không làm mất từ khoá
let currentQ = QS.get("q") || "";
const ROUTE = (() => {
  let m;
  if (STATIC) {
    const r = META("hd-route") || "library";
    if (r.startsWith("reader:")) return { view: "reader", slug: r.slice(7) };
    if (r.startsWith("group:")) return { view: "group", slug: r.slice(6) };
    return { view: "library" };
  }
  if (PATH === "/") return { view: "library" };
  if (PATH === "/admin") return { view: "dashboard" };
  if ((m = PATH.match(/^\/admin\/g\/([a-z0-9][a-z0-9-]*|_)$/))) return { view: "dashgroup", slug: m[1] };
  if ((m = PATH.match(/^\/admin\/([a-z0-9][a-z0-9-]*)$/))) return { view: "editor", slug: m[1] };
  if ((m = PATH.match(/^\/d\/([a-z0-9][a-z0-9-]*)$/))) return { view: "reader", slug: m[1] };
  if ((m = PATH.match(/^\/g\/([a-z0-9][a-z0-9-]*|_)$/))) return { view: "group", slug: m[1] };
  return { view: "notfound" };
})();
const IS_ADMIN = ROUTE.view === "editor";
const NEEDS_LOGIN = ["editor", "dashboard", "dashgroup"].includes(ROUTE.view);
const LIST_VIEWS = ["library", "dashboard", "dashgroup", "notfound"];
// Trang nhóm (/g/...) cũng là trang đọc: cột trái là cây Nhóm > Tài liệu > Chương
const READER = ROUTE.view === "reader" || ROUTE.view === "group";
const BACKUP_KEY = "huongdan-backup-v2:" + (ROUTE.slug || "");
let SITE = META("hd-site") || I18N.vi.appName;
let SITE_EN = META("hd-site-en") || SITE;

/* ---------- Ngôn ngữ giao diện ---------- */
// Ngôn ngữ giao diện (UI) tách rời ngôn ngữ của tài liệu (docLang). Người đọc chọn UI ở thư viện;
// trang đọc dùng ngôn ngữ của tài liệu. Lựa chọn được nhớ trong localStorage.
const LANGS = ["vi", "en"];
const LANG_KEY = "hd-ui-lang";
let UI = (() => {
  const q = QS.get("lang"); if (LANGS.includes(q)) return q;
  try { const s = localStorage.getItem(LANG_KEY); if (LANGS.includes(s)) return s; } catch (_) { /* không có localStorage */ }
  return "vi";
})();
function tl(lang, key, ...args) {
  const table = I18N[lang] || I18N.vi;
  const v = table[key] !== undefined ? table[key] : I18N.vi[key];
  if (v === undefined) return key;
  return typeof v === "function" ? v(...args) : v;
}
const t = (key, ...args) => tl(UI, key, ...args);
const siteName = () => (UI === "en" ? SITE_EN : SITE);
function applyI18n() {
  document.documentElement.lang = UI;
  document.querySelectorAll("[data-i18n]").forEach(e => { e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(e => { e.placeholder = t(e.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-title]").forEach(e => { e.title = t(e.dataset.i18nTitle); });
  document.querySelectorAll("[data-i18n-aria]").forEach(e => { e.setAttribute("aria-label", t(e.dataset.i18nAria)); });
}
function setUi(lang) {
  if (!LANGS.includes(lang)) return;
  UI = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch (_) { /* bỏ qua */ }
  applyI18n();
}
/** Ghi ?lang= (và giữ ?q=) lên thanh địa chỉ để liên kết copy ra mang đúng ngôn ngữ. */
function syncQuery(q) {
  currentQ = q || "";
  const p = new URLSearchParams(location.search);
  p.set("lang", UI);
  if (q) p.set("q", q); else p.delete("q");
  try { history.replaceState(null, "", location.pathname + "?" + p.toString() + location.hash); } catch (_) { /* bỏ qua */ }
}
/** Chuỗi truy vấn ?q=…&lang=… để mang từ khoá và ngôn ngữ sang trang khác. */
function qsFor(q, lang) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (lang) p.set("lang", lang);
  const s = p.toString();
  return s ? "?" + s : "";
}

/** Đổi đường dẫn của ứng dụng (/, /d/abc?q=…#x, /g/abc, /uploads/…) thành đường dẫn đúng ở chế độ tĩnh. */
function url(p) {
  if (!STATIC || typeof p !== "string" || !p.startsWith("/")) return p;
  const parts = p.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const path = parts[1], rest = (parts[2] || "") + (parts[3] || "");
  if (path === "/") return BASE + rest;
  const m = path.match(/^\/(d|g)\/([a-z0-9][a-z0-9-]*|_)\/?$/);
  if (m) return BASE + m[1] + "/" + m[2] + "/" + rest;
  return BASE + path.slice(1) + rest;
}

/* ---------- Trạng thái ---------- */
let doc = null;          // tài liệu đang hiển thị (bản xuất bản ở trang đọc, bản nháp ở trang soạn)
let docLang = "vi";      // ngôn ngữ của tài liệu đang mở
let docGroup = null;     // nhóm của tài liệu đang mở: { slug, name_vi, name_en } hoặc null
let active = null;       // mã chương đang mở
let mode = "read";       // "read" | "edit"
let rev = 0;             // số phiên bản nháp trên server
let dirty = false;       // có thay đổi chưa gửi lên server
let conflict = false;    // server có bản mới hơn: ngừng tự lưu
let publishedSame = true;
let savePromise = null, pendingSave = false, publishing = false;
let user = null;
let publishedAt = null;
let listTitle = "";      // tiêu đề của trang danh sách (thư viện, nhóm, quản lý)
let backTarget = null;   // { href, label } của nút quay lại ở trang danh sách
let curSlug = ROUTE.view === "reader" ? ROUTE.slug : null; // tài liệu đang đọc (đổi được tại chỗ khi đọc theo cây nhóm)
// Cây của nhóm ở trang đọc: { key ("_" là chưa phân nhóm), group, lang, docs: [dòng tài liệu], open: Set, cache: Map(slug -> tài liệu) }
let tree = null;

/* ---------- Tiện ích ---------- */
function toast(msg, ms) {
  const el = $("#toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), ms || 3200);
}
function debounce(fn, ms) { let tm; const d = (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(tm); return d; }
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
function fmtDate(iso, lang) {
  const d = new Date(iso); if (!iso || isNaN(d)) return "";
  return d.toLocaleDateString(tl(lang || UI, "locale"), { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtTime(iso) {
  const d = new Date(iso); if (!iso || isNaN(d)) return "";
  return d.toLocaleString(t("locale"), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const groupName = g => (g ? (UI === "en" ? g.name_en || g.name_vi : g.name_vi || g.name_en) : t("ungrouped"));
const otherName = g => (g ? (UI === "en" ? (g.name_en ? g.name_vi : "") : (g.name_vi ? g.name_en : "")) : "");

async function api(method, u, body, isForm) {
  if (STATIC) return staticApi(method, u);
  const opt = { method, credentials: "same-origin", headers: { "X-Requested-With": "fetch", "X-UI-Lang": UI } };
  if (body !== undefined) {
    if (isForm) opt.body = body;
    else { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  }
  let r;
  try { r = await fetch(u, opt); } catch (_) { const e = new Error(t("noServer")); e.status = 0; throw e; }
  let data = null; try { data = await r.json(); } catch (_) { /* không phải JSON */ }
  if (!r.ok) { const e = new Error((data && data.error) || t("error", r.status)); e.status = r.status; e.data = data; throw e; }
  return data;
}

// Chế độ tĩnh: trả lời các API công khai từ tệp data/*.json đã xuất
let staticDocs = null;
async function staticFile(file) {
  let r;
  try { r = await fetch(BASE + file, { cache: "no-cache" }); } catch (_) { const e = new Error(t("noConnection")); e.status = 0; throw e; }
  if (!r.ok) { const e = new Error(t("notFoundShort")); e.status = r.status; throw e; }
  return r.json();
}
async function staticApi(method, u) {
  const [path, query] = u.split("?");
  const p = new URLSearchParams(query || "");
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
  let m;
  if (method !== "GET") fail(404, t("notOnStatic"));
  if (path === "/api/site") return { name: SITE, nameEn: SITE_EN };
  if ((m = path.match(/^\/api\/docs\/([a-z0-9-]+)$/))) return staticFile("data/docs/" + m[1] + ".json");
  if (path === "/api/search-index") return staticFile("data/search-" + (p.get("lang") === "en" ? "en" : "vi") + ".json");
  if (path === "/api/docs" || path === "/api/groups") {
    if (!staticDocs) staticDocs = await staticFile("data/docs.json");
    const all = staticDocs.docs || [], lang = p.get("lang"), group = p.get("group");
    const base = { site: staticDocs.site, siteEn: staticDocs.siteEn || staticDocs.site };
    if (path === "/api/groups") {
      const L = LANGS.includes(lang) ? lang : "vi";
      const groups = (staticDocs.groups || []).filter(g => g.docs && g.docs[L] > 0)
        .map(g => ({ slug: g.slug, name_vi: g.name_vi, name_en: g.name_en, docs: g.docs[L] }));
      return { ...base, groups, ungrouped: all.filter(d => !d.group && (d.lang || "vi") === L).length };
    }
    let docs = all.filter(d => (!lang || (d.lang || "vi") === lang) && (!group || (group === "_" ? !d.group : d.group === group)));
    if (!group) docs = docs.slice().sort((a, b) => (a.title || "").localeCompare(b.title || "", "vi") || a.slug.localeCompare(b.slug));
    return { ...base, docs };
  }
  return fail(path === "/api/me" ? 401 : 404, t("notOnStatic"));
}

/* ---------- Tìm kiếm ---------- */
// Chỉ mục chữ của mọi tài liệu (một ngôn ngữ với người đọc, mọi ngôn ngữ với người soạn), tải khi cần.
const indexCache = {};
function searchIndex(scope, lang) {
  const key = scope + ":" + (lang || "");
  if (!indexCache[key]) {
    indexCache[key] = (scope === "admin" ? api("GET", "/api/admin/search-index") : api("GET", "/api/search-index?lang=" + lang))
      .then(ix => {
        // Gấp sẵn chữ của từng tài liệu một lần để các lần gõ sau chỉ còn so khớp
        ix.docs.forEach(d => { d._folded = fold([d.title].concat(d.sections.map(s => s.title + "\n" + s.text)).join("\n")); });
        return ix;
      })
      .catch(e => { delete indexCache[key]; throw e; });
  }
  return indexCache[key];
}
/** Số chỗ khớp theo tài liệu và theo nhóm ('_' là chưa phân nhóm). */
function matchCounts(ix, q) {
  const needle = fold(q).trim();
  const byDoc = {}, byGroup = {};
  let total = 0;
  if (needle.length < 2) return { byDoc, byGroup, total, active: false };
  ix.docs.forEach(d => {
    const n = countMatches(d._folded, needle);
    if (!n) return;
    byDoc[d.slug] = n;
    const g = d.group || "_";
    byGroup[g] = (byGroup[g] || 0) + n;
    total += n;
  });
  return { byDoc, byGroup, total, active: true };
}
/** Ô tìm kiếm của trang danh sách: đánh dấu các phần tử có data-key khớp, làm mờ phần còn lại. */
function searchBox(opts) {
  const { container, scope, lang, keyOf, onQuery } = opts;
  const input = el("input", "search lib-search"); input.type = "search";
  input.placeholder = t("searchAll"); input.setAttribute("aria-label", t("searchAll"));
  input.value = opts.initial || "";
  const status = el("p", "search-status"); status.setAttribute("role", "status");
  const run = async () => {
    const q = input.value.trim();
    if (onQuery) onQuery(q);
    const items = container.querySelectorAll("[data-key]");
    const clear = () => items.forEach(it => { it.classList.remove("hit", "dim"); const b = it.querySelector(".hit-badge"); if (b) b.remove(); });
    if (fold(q).trim().length < 2) { clear(); status.textContent = ""; return; }
    status.textContent = t("searching");
    let ix;
    try { ix = await searchIndex(scope, lang); } catch (_) { status.textContent = t("searchFailed"); return; }
    if (input.value.trim() !== q) return; // người dùng đã gõ tiếp
    const res = matchCounts(ix, q);
    clear();
    items.forEach(it => {
      const n = keyOf(res, it.dataset.key);
      if (n) {
        it.classList.add("hit");
        const b = el("span", "hit-badge", t("results", n));
        (it.querySelector(".hit-slot") || it).append(b);
      } else it.classList.add("dim");
    });
    status.textContent = res.total ? "" : t("noMatch", q);
  };
  input.addEventListener("input", debounce(run, 150));
  if (input.value) run();
  return { input, status, run };
}

/* ---------- Markdown ---------- */
function renderMd(src, lang) {
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
    const lab = document.createElement("div"); lab.className = "callout-label"; lab.textContent = tl(lang || docLang, kind + "Label");
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
function chapterEl(s, n, lang) {
  const e = document.createElement("div");
  e.innerHTML = `<header class="ch-head"><div class="ch-num">${n}</div><h1 class="ch-title"></h1></header><div class="prose">${renderMd(s.content, lang)}</div>`;
  e.querySelector(".ch-title").textContent = s.title || tl(lang || docLang, "untitledChapter");
  return e;
}
const sectionMatches = (s, q) => fold(s.title + "\n" + s.content).includes(fold(q));
/** Tô vàng mọi chỗ khớp (không dấu) trong root, đánh dấu đúng vị trí trên chữ gốc. */
function highlight(root, q) {
  const needle = fold(q).trim();
  if (!needle) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const hits = []; let node;
  while ((node = walker.nextNode())) {
    const fm = foldWithMap(node.nodeValue);
    if (fm.text.includes(needle)) hits.push([node, fm]);
  }
  hits.forEach(([n, fm]) => {
    const text = n.nodeValue, frag = document.createDocumentFragment();
    let from = 0, i = 0, j;
    while ((j = fm.text.indexOf(needle, i)) !== -1) {
      const start = fm.map[j];
      let end = fm.map[j + needle.length - 1] + 1;
      while (end < text.length && /[\u0300-\u036f]/.test(text[end])) end++; // giữ dấu tổ hợp theo sau
      frag.append(text.slice(from, start));
      const m = document.createElement("mark"); m.className = "hit"; m.textContent = text.slice(start, end); frag.append(m);
      from = end; i = j + needle.length;
    }
    frag.append(text.slice(from)); n.replaceWith(frag);
  });
}

/* ---------- Hiển thị ---------- */
function show(e, on) { e.classList.toggle("hide", !on); }
function renderLangSwitch() {
  const box = $("#lang-switch");
  const visible = ROUTE.view !== "notfound";
  show(box, visible);
  if (!visible) return;
  box.innerHTML = "";
  box.setAttribute("aria-label", NEEDS_LOGIN ? t("uiLang") : t("langLabel"));
  LANGS.forEach(l => {
    const b = el("button", "lang-btn", l.toUpperCase());
    b.title = tl(l, l === "vi" ? "langVi" : "langEn");
    b.setAttribute("aria-pressed", String(UI === l));
    b.onclick = () => onLangSwitch(l);
    box.append(b);
  });
}
function onLangSwitch(l) {
  if (l === UI) return;
  if (READER) { location.href = url("/" + qsFor("", l)); return; }
  setUi(l);
  if (ROUTE.view === "library") syncQuery(currentQ);
  if (ROUTE.view === "editor") { renderAll(); return; }
  bootView();
}
function renderHeader() {
  const h = $("#hdr-title");
  const listMode = LIST_VIEWS.includes(ROUTE.view);
  document.body.classList.toggle("list-mode", listMode);
  if (listMode) {
    h.textContent = listTitle || (ROUTE.view === "dashboard" || ROUTE.view === "dashgroup" ? t("manageDocs") : siteName());
    document.title = h.textContent + (h.textContent === siteName() ? "" : " | " + siteName());
  } else {
    h.textContent = (doc && doc.title) || siteName();
    if (doc && doc.version) h.append(el("small", "", tl(docLang, "version", doc.version)));
    if (IS_ADMIN && doc) h.append(el("small", "lang-tag", docLang.toUpperCase()));
    document.title = (doc && doc.title ? doc.title + " | " : "") + siteName();
  }

  const back = $("#btn-back");
  let target = null;
  if (READER) {
    target = { href: url("/" + qsFor(QS.get("q"), docLang)), label: t("allDocs") };
  } else if (ROUTE.view === "editor") {
    target = { href: docGroup ? "/admin/g/" + docGroup.slug : "/admin", label: t("manage") };
  } else target = backTarget;
  show(back, !!target);
  if (target) { back.href = target.href; $("#btn-back-lbl").textContent = target.label; back.title = target.label; }

  const toAdmin = $("#btn-to-admin");
  show(toAdmin, !!user && (READER ? !!curSlug : ROUTE.view === "library"));
  toAdmin.href = READER ? "/admin/" + curSlug : "/admin";
  $("#btn-to-admin-lbl").textContent = READER ? t("edit") : t("manage");

  const pubLink = $("#btn-view-public");
  show(pubLink, !!user && (ROUTE.view === "dashboard" || ROUTE.view === "dashgroup" || (IS_ADMIN && !!publishedAt)));
  pubLink.href = IS_ADMIN ? "/d/" + ROUTE.slug + (active ? "#" + active : "") : ROUTE.view === "dashgroup" ? "/g/" + ROUTE.slug : "/";
  pubLink.textContent = IS_ADMIN ? t("viewPublished") : t("viewLibrary");

  show($("#btn-mode"), IS_ADMIN && !!user);
  show($("#btn-publish"), IS_ADMIN && !!user);
  show($("#btn-logout"), NEEDS_LOGIN && !!user);
  show($("#save-state"), IS_ADMIN && !!user);
  show($("#meta-box"), mode === "edit");
  show($("#btn-add"), mode === "edit");
  $("#btn-mode").textContent = mode === "edit" ? t("readView") : t("continueEdit");
  renderLangSwitch();

  if (IS_ADMIN && user) {
    const st = $("#save-state");
    let text, warn = false;
    if (conflict) { text = t("newerOnServer"); warn = true; }
    else if (savePromise) text = t("saving");
    else if (dirty) { text = t("unsaved"); warn = true; }
    else if (!publishedAt) text = t("savedNeverPublished");
    else if (!publishedSame) text = t("savedNotPublished");
    else text = t("published");
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
  const treeMode = !!tree && mode === "read";
  $("#toc-label").textContent = treeMode ? groupName(tree.group) : t("chapters");
  $("#search").placeholder = treeMode ? tl(docLang, "searchInGroup") : t("searchInDoc");
  $("#search").setAttribute("aria-label", $("#search").placeholder);
  if (treeMode) return renderTreeToc();
  const raw = $("#search").value.trim();
  const ul = $("#toc"); ul.innerHTML = "";
  if (!doc) return;
  let shown = 0;
  doc.sections.forEach((s, i) => {
    if (raw && !sectionMatches(s, raw)) return;
    shown++;
    const li = document.createElement("li");
    const row = document.createElement("div"); row.className = "toc-row" + (s.id === active ? " active" : "");
    const b = document.createElement("button"); b.className = "toc-item";
    const n = document.createElement("span"); n.className = "n"; n.textContent = i + 1;
    const tt = document.createElement("span"); tt.className = "t"; tt.textContent = s.title || tl(docLang, "untitledChapter");
    b.append(n, tt); b.onclick = () => go(s.id);
    if (s.id === active) b.setAttribute("aria-current", "page");
    row.append(b);
    if (mode === "edit") {
      const mk = (html, label, fn, dis) => {
        const x = document.createElement("button"); x.className = "icon-btn"; x.innerHTML = html; x.title = label;
        x.setAttribute("aria-label", label); x.disabled = !!dis; if (dis) x.style.opacity = .3; x.onclick = fn; return x;
      };
      row.append(
        mk(ICON.up, t("moveUp"), () => move(i, -1), i === 0),
        mk(ICON.down, t("moveDown"), () => move(i, 1), i === doc.sections.length - 1),
        mk(ICON.del, t("deleteChapter"), e => askDelete(e.currentTarget, s.id))
      );
    }
    li.append(row);
    if (mode === "read" && s.id === active) { const sub = headingList(); if (sub) li.append(sub); }
    ul.append(li);
  });
  if (!shown) {
    const li = document.createElement("li"); li.className = "toc-empty";
    li.textContent = raw ? t("noChapterMatch", raw) : t("noChapters");
    ul.append(li);
  }
}

// Mục lục chương của chương đang đọc: các tiêu đề ## để nhảy nhanh
function headingList() {
  const hs = document.querySelectorAll("#reader .prose h2");
  if (!hs.length) return null;
  const sub = document.createElement("ul"); sub.className = "toc-sub";
  hs.forEach(h => {
    const l = document.createElement("li"), bb = document.createElement("button");
    bb.textContent = h.textContent;
    bb.onclick = () => { h.scrollIntoView({ behavior: "smooth", block: "start" }); closeDrawer(); };
    l.append(bb); sub.append(l);
  });
  return sub;
}
/** Chương của một tài liệu trong cây: tài liệu đang đọc lấy từ doc, tài liệu khác từ bộ nhớ đệm hoặc chỉ mục tìm kiếm. */
function treeChapters(d) {
  if (d.slug === curSlug) return doc.sections.map(s => ({ id: s.id, title: s.title, match: q => sectionMatches(s, q) }));
  const c = tree.cache.get(d.slug);
  if (c) return c.doc.sections.map(s => ({ id: s.id, title: s.title, match: q => sectionMatches(s, q) }));
  const ix = tree.index && tree.index.docs.find(x => x.slug === d.slug);
  if (ix) return ix.sections.map(s => ({ id: s.id, title: s.title, match: q => fold(s.title + "\n" + s.text).includes(fold(q)) }));
  return null;
}
function renderTreeToc() {
  const raw = $("#search").value.trim();
  const ul = $("#toc"); ul.innerHTML = "";
  // Đang tìm: cần chữ của mọi tài liệu trong nhóm, tải chỉ mục một lần rồi vẽ lại
  if (raw && !tree.index) {
    searchIndex("public", tree.lang).then(ix => { tree.index = ix; renderToc(); }).catch(() => {});
  }
  let shown = 0;
  tree.docs.forEach(d => {
    const chapters = treeChapters(d);
    const hits = raw && chapters ? chapters.filter(c => c.match(raw)) : null;
    if (raw && (!hits || !hits.length)) return;
    const isOpen = raw ? true : (tree.open.has(d.slug) || d.slug === curSlug);
    shown++;
    const li = el("li", "tree-doc" + (isOpen ? " open" : "") + (d.slug === curSlug ? " current" : ""));
    const btn = el("button", "tree-doc-btn");
    btn.setAttribute("aria-expanded", String(isOpen));
    btn.append(el("span", "caret"), el("span", "t", d.title || d.slug));
    btn.onclick = () => {
      if (raw) return;
      if (tree.open.has(d.slug) || d.slug === curSlug) { tree.open.delete(d.slug); if (d.slug === curSlug) tree.closedCurrent = !tree.closedCurrent; }
      else tree.open.add(d.slug);
      renderToc();
    };
    li.append(btn);
    // Tài liệu đang đọc có thể được thu gọn bằng tay
    const showChapters = isOpen && !(d.slug === curSlug && tree.closedCurrent && !raw);
    if (!showChapters) { li.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }
    if (showChapters) {
      const sub = el("ul", "tree-ch");
      const list = hits || chapters;
      if (!list) {
        sub.append(el("li", "toc-empty", t("loading")));
        loadTreeDoc(d.slug).then(() => renderToc()).catch(() => {});
      } else {
        const all = chapters;
        list.forEach(c => {
          const ci = el("li");
          const row = el("div", "toc-row" + (d.slug === curSlug && c.id === active ? " active" : ""));
          const b = el("button", "toc-item");
          b.append(el("span", "n", String(all.indexOf(c) + 1)), el("span", "t", c.title || tl(tree.lang, "untitledChapter")));
          if (d.slug === curSlug && c.id === active) b.setAttribute("aria-current", "page");
          b.onclick = () => (d.slug === curSlug ? go(c.id) : openDoc(d.slug, c.id));
          row.append(b); ci.append(row);
          if (d.slug === curSlug && c.id === active) { const h = headingList(); if (h) ci.append(h); }
          sub.append(ci);
        });
      }
      li.append(sub);
    }
    ul.append(li);
  });
  if (!shown) {
    const li = el("li", "toc-empty");
    li.textContent = raw ? (tree.index ? t("noMatch", raw) : t("searching")) : t("noChapters");
    ul.append(li);
  }
}

function renderEmpty(e, title, text, link) {
  e.innerHTML = '<div class="empty"><h2></h2><p></p></div>';
  e.querySelector("h2").textContent = title; e.querySelector("p").textContent = text;
  if (link) {
    const a = document.createElement("a"); a.className = "btn primary"; a.href = link[1]; a.textContent = link[0];
    a.style.marginTop = "12px"; e.querySelector(".empty").append(a);
  }
}
function renderReader() {
  const e = $("#reader"); e.innerHTML = "";
  if (!doc) { renderEmpty(e, t("docNotFound"), t("docNotFoundText"), [t("seeAllDocs"), url("/")]); renderToc(); return; }
  const s = cur();
  if (!s) { renderEmpty(e, t("docEmpty"), IS_ADMIN ? t("docEmptyEditor") : t("docEmptyReader")); renderToc(); return; }
  const i = idx();
  e.append(chapterEl(s, i + 1, docLang));
  const q = $("#search").value.trim();
  if (q) highlight(e.querySelector(".prose"), q);
  const prev = doc.sections[i - 1], next = doc.sections[i + 1];
  // Đọc theo cây nhóm: ở chương đầu/cuối thì chuyển sang tài liệu trước/sau trong nhóm
  const di = tree ? tree.docs.findIndex(d => d.slug === curSlug) : -1;
  const prevDoc = !prev && di > 0 ? tree.docs[di - 1] : null;
  const nextDoc = !next && di >= 0 && di < tree.docs.length - 1 ? tree.docs[di + 1] : null;
  if (prev || next || prevDoc || nextDoc) {
    const nav = document.createElement("nav"); nav.className = "pager"; nav.setAttribute("aria-label", t("switchChapter"));
    const mk = (title, cls, dir, fn) => {
      const b = document.createElement("button"); b.className = cls;
      const d = document.createElement("span"); d.className = "dir"; d.textContent = dir;
      const tt = document.createElement("span"); tt.className = "ttl"; tt.textContent = title;
      b.append(d, tt); b.onclick = fn; return b;
    };
    if (prev) nav.append(mk(prev.title, "prev", t("prevChapter"), () => go(prev.id)));
    else if (prevDoc) nav.append(mk(prevDoc.title, "prev", t("prevDoc"), () => openDoc(prevDoc.slug, "last")));
    if (next) nav.append(mk(next.title, "next", t("nextChapter"), () => go(next.id)));
    else if (nextDoc) nav.append(mk(nextDoc.title, "next", t("nextDoc"), () => openDoc(nextDoc.slug)));
    e.append(nav);
  }
  $("#main").scrollTop = 0;
  renderToc();
}
function renderPreview() {
  const s = cur(), e = $("#preview"); e.innerHTML = "";
  if (s) e.append(chapterEl(s, idx() + 1, docLang));
  else renderEmpty(e, t("noChaptersYet"), t("noChaptersYetText"));
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
  applyI18n();
  renderHeader();
  if (mode === "edit") { renderEditor(); renderToc(); } else renderReader();
}

/* ---------- Điều hướng ---------- */
function go(id) {
  if (!doc || !doc.sections.some(s => s.id === id)) return;
  active = id;
  try { history.replaceState(null, "", location.pathname + location.search + "#" + id); } catch (_) { /* bỏ qua */ }
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
  const s = { id: newId("chuong-moi"), title: tl(docLang, "newChapter"), content: tl(docLang, "newChapterBody") };
  const at = idx(); doc.sections.splice(at >= 0 ? at + 1 : doc.sections.length, 0, s);
  active = s.id; markDirty(); renderAll();
  setTimeout(() => { const ti = $("#ed-title"); ti.focus(); ti.select(); }, 30);
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
    toast(t("chapterDeleted", removed.title));
    return;
  }
  btn.dataset.armed = "1"; btn.classList.add("confirm"); btn.textContent = t("deleteAsk");
  btn.setAttribute("aria-label", t("deleteChapterAgain"));
  setTimeout(() => { if (btn.isConnected) renderToc(); }, 3000);
}

/* ---------- Thanh công cụ ---------- */
const ta = () => $("#ed-body");
function insertText(str, s, e) {
  const tx = ta(); tx.focus(); tx.setSelectionRange(s, e);
  let ok = false; try { ok = document.execCommand("insertText", false, str); } catch (_) { /* không hỗ trợ */ }
  if (!ok) { tx.setRangeText(str, s, e, "end"); tx.dispatchEvent(new Event("input", { bubbles: true })); }
}
function wrap(a, b, ph) {
  const tx = ta(), s = tx.selectionStart, e = tx.selectionEnd, sel = tx.value.slice(s, e) || ph;
  insertText(a + sel + b, s, e);
  tx.setSelectionRange(s + a.length, s + a.length + sel.length);
}
function linePrefix(p) {
  const tx = ta(), s = tx.selectionStart, e = tx.selectionEnd, v = tx.value;
  const ls = v.lastIndexOf("\n", s - 1) + 1;
  let le = v.indexOf("\n", e); if (le < 0) le = v.length;
  const out = v.slice(ls, le).split("\n")
    .map((l, k) => (p === "1. " ? (k + 1) + ". " : p) + l.replace(/^(#{1,6}\s+|[-*]\s+|\d+\.\s+)/, "")).join("\n");
  insertText(out, ls, le);
}
function insertBlock(txt) {
  const tx = ta(), s = tx.selectionStart, e = tx.selectionEnd, before = tx.value.slice(0, s);
  const pre = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  insertText(pre + txt + "\n\n", s, e);
}
// Chữ mẫu chèn vào nội dung theo ngôn ngữ của tài liệu, không theo ngôn ngữ giao diện
const D = key => tl(docLang, key);
const TOOLS = {
  h2: () => linePrefix("## "), h3: () => linePrefix("### "),
  bold: () => wrap("**", "**", D("insBold")), italic: () => wrap("*", "*", D("insItalic")),
  code: () => wrap("`", "`", D("insCode")), link: () => wrap("[", "](https://)", D("insLinkText")),
  ul: () => linePrefix("- "), ol: () => linePrefix("1. "),
  table: () => insertBlock(D("insTable")),
  note: () => insertBlock(D("insNote")),
  tip: () => insertBlock(D("insTip")),
  warning: () => insertBlock(D("insWarning")),
  image: () => $("#file-img").click()
};
document.querySelectorAll(".tool").forEach(b => b.addEventListener("click", () => { if (cur()) TOOLS[b.dataset.t](); }));

$("#file-img").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0]; e.target.value = "";
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast(t("onlyImages")); return; }
  const caret = [ta().selectionStart, ta().selectionEnd];
  const alt = file.name.replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "");
  toast(t("uploading"), 20000);
  try {
    const fd = new FormData(); fd.append("file", file);
    const r = await api("POST", "/api/images", fd, true);
    ta().setSelectionRange(caret[0], caret[1]);
    insertBlock(`![${alt}](${r.url})`);
    toast(t("imageInserted"));
  } catch (err) {
    if (err.status === 401) return sessionExpired();
    toast(err.message || t("uploadFailed"));
  }
});

/* ---------- Lưu và xuất bản ---------- */
function sessionExpired() {
  writeBackup();
  toast(t("sessionExpired"), 6000);
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
      showBanner((err.message || t("draftConflict")) + t("reloadToSee"), [[t("reload"), () => location.reload(), true]]);
    } else if (err.status === 401) sessionExpired();
    else toast((err.message || t("notSaved")) + t("keptLocally"), 5000);
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
    if (dirty || conflict) { toast(t("notSavedNoPublish")); return; }
    const r = await api("POST", `/api/admin/docs/${ROUTE.slug}/publish`, { rev });
    publishedSame = true; publishedAt = r.publishedAt;
    toast(t("publishedToast"), 4500);
  } catch (err) {
    if (err.status === 401) sessionExpired();
    else toast(err.message || t("publishFailed"), 5000);
  } finally { publishing = false; renderHeader(); }
}
$("#btn-publish").onclick = publish;
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && IS_ADMIN && user) {
    e.preventDefault(); saveDraft().then(() => { if (!dirty && !conflict) toast(t("savedDraft")); });
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
  const when = new Date(bk.at).toLocaleString(t("locale"));
  const note = bk.baseRev !== rev ? t("backupOverwrites") : "";
  showBanner(t("backupFound", when, note), [
    [t("restore"), () => {
      doc = bk.doc; if (!cur()) active = (doc.sections[0] || {}).id || null;
      setMode("edit"); markDirty(); toast(t("restored"));
    }, true],
    [t("discard"), clearBackup]
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
  add(cover, "h1", "", doc.title || D("defaultDocTitle"));
  if (doc.subtitle) add(cover, "p", "sub", doc.subtitle);
  if (doc.version) add(cover, "p", "m", tl(docLang, "version", doc.version));
  add(cover, "p", "m", tl(docLang, "dateLabel", fmtDate(new Date().toISOString(), docLang)));
  if (doc.sections.length > 1) {
    const toc = add(root, "section", "pr-toc pdf-break");
    add(toc, "h2", "", D("toc"));
    const ol = add(toc, "ol");
    doc.sections.forEach(s => add(ol, "li", "", s.title));
  }
  doc.sections.forEach((s, i) => add(root, "section", "pr-ch pdf-break").append(chapterEl(s, i + 1, docLang)));
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
  if (!doc || !doc.sections.length) { toast(t("pdfNoChapters")); return; }
  const btn = $("#btn-pdf"); btn.disabled = true;
  toast(t("makingPdf"), 60000);
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
    toast(t("pdfDone"));
  } catch (err) {
    console.error(err);
    toast(t("pdfFailed"), 6000);
    printFallback();
  } finally {
    if (built) built.host.remove();
    btn.disabled = false;
  }
}
$("#btn-pdf").onclick = exportPdf;

/* ---------- Thư viện và trang nhóm (người đọc) ---------- */
function libHead(title, sub) {
  const head = el("div", "lib-head"), hl = el("div");
  hl.append(el("h1", "lib-title", title));
  if (sub) hl.append(el("p", "lib-sub", sub));
  head.append(hl);
  return head;
}
function docItem(d, q) {
  const li = el("li"), a = el("a", "lib-item"); a.href = url("/d/" + d.slug + qsFor(q));
  li.dataset.key = d.slug;
  const name = el("span", "lib-name hit-slot"); name.append(el("span", "", d.title || d.slug));
  a.append(name);
  const meta = [d.version ? t("version", d.version) : "", d.publishedAt ? t("updated", fmtDate(d.publishedAt)) : ""].filter(Boolean).join(", ");
  a.append(el("span", "lib-meta", meta));
  if (d.subtitle) a.append(el("p", "lib-desc", d.subtitle));
  li.append(a);
  // Liên kết luôn mang từ khoá hiện tại để trang đọc lọc sẵn chương
  a.addEventListener("click", () => { const box = document.querySelector(".lib-search"); if (box) a.href = url("/d/" + d.slug + qsFor(box.value.trim())); });
  return li;
}
function groupItem(g, count, q) {
  const key = g ? g.slug : "_";
  const li = el("li"); li.dataset.key = key;
  const a = el("a", "lib-item group-item"); a.href = url("/g/" + key + qsFor(q, UI));
  const name = el("span", "lib-name hit-slot"); name.append(el("span", "", groupName(g)));
  a.append(name, el("span", "lib-meta", t("docsCount", count)));
  li.append(a);
  a.addEventListener("click", () => { const box = document.querySelector(".lib-search"); if (box) a.href = url("/g/" + key + qsFor(box.value.trim(), UI)); });
  return li;
}
async function renderLibrary() {
  backTarget = null; listTitle = siteName();
  const box = $("#list"); box.innerHTML = `<div class="lib"><div class="loading">${t("loading")}</div></div>`;
  let data;
  try { data = await api("GET", "/api/groups?lang=" + UI); }
  catch (_) { box.innerHTML = ""; renderEmpty(box, t("libraryLoadFailed"), t("checkNetwork")); return; }
  SITE = data.site || SITE; SITE_EN = data.siteEn || SITE_EN; listTitle = siteName(); renderHeader();
  const q = currentQ;
  const wrapEl = el("div", "lib"); box.innerHTML = ""; box.append(wrapEl);
  const ul = el("ul", "lib-list");
  let head, sb;
  if (data.groups.length) {
    // Có nhóm: hiện các nhóm, rồi mục "Chưa phân nhóm" nếu có
    head = libHead(siteName(), t("groupsCount", data.groups.length + (data.ungrouped ? 1 : 0)));
    data.groups.forEach(g => ul.append(groupItem(g, g.docs, q)));
    if (data.ungrouped) ul.append(groupItem(null, data.ungrouped, q));
    sb = searchBox({ container: ul, scope: "public", lang: UI, initial: q, keyOf: (r, k) => r.byGroup[k], onQuery: v => syncQuery(v) });
  } else {
    // Chưa có nhóm nào: hiện thẳng danh sách tài liệu như trước
    let docs = [];
    try { docs = (await api("GET", "/api/docs?lang=" + UI)).docs; } catch (_) { /* hiện trống */ }
    head = libHead(siteName(), docs.length ? t("docsCount", docs.length) : "");
    docs.forEach(d => ul.append(docItem(d, q)));
    if (!docs.length) {
      const li = el("li", "lib-empty", t("noDocsPublished"));
      if (user) { const b = el("a", "btn primary", t("goManage")); b.href = "/admin"; li.append(el("br"), b); }
      ul.append(li);
    }
    sb = docs.length ? searchBox({ container: ul, scope: "public", lang: UI, initial: q, keyOf: (r, k) => r.byDoc[k], onQuery: v => syncQuery(v) }) : null;
  }
  if (sb) head.append(sb.input);
  wrapEl.append(head);
  if (sb) wrapEl.append(sb.status);
  wrapEl.append(ul);
}
/* ---------- Đọc theo cây nhóm ---------- */
function makeTree(key, group, lang, docs) {
  return { key, group, lang, docs, open: new Set(), cache: new Map(), loading: new Map(), index: null, closedCurrent: false };
}
/** Nội dung một tài liệu trong cây, tải một lần rồi giữ trong bộ nhớ đệm. */
function loadTreeDoc(slug) {
  if (tree.cache.has(slug)) return Promise.resolve(tree.cache.get(slug));
  if (!tree.loading.has(slug)) {
    tree.loading.set(slug, api("GET", "/api/docs/" + slug)
      .then(r => { tree.cache.set(slug, r); tree.loading.delete(slug); return r; },
            e => { tree.loading.delete(slug); throw e; }));
  }
  return tree.loading.get(slug);
}
/** Mở tài liệu khác trong cây mà không tải lại trang. chapter: mã chương, "last" là chương cuối, bỏ trống là chương đầu (hoặc chương khớp từ khoá). */
async function openDoc(slug, chapter) {
  let r;
  try { r = await loadTreeDoc(slug); } catch (_) { toast(t("docLoadFailed")); return; }
  doc = r.doc; docLang = r.lang || docLang; docGroup = r.group || null; curSlug = slug;
  tree.closedCurrent = false; tree.open.add(slug);
  const q = $("#search").value.trim();
  let s = chapter === "last" ? doc.sections[doc.sections.length - 1] : doc.sections.find(x => x.id === chapter);
  if (!s && q) s = doc.sections.find(x => sectionMatches(x, q));
  active = (s || doc.sections[0] || {}).id || null;
  try { history.pushState(null, "", url("/d/" + slug + (q ? "?q=" + encodeURIComponent(q) : "") + (active ? "#" + active : ""))); } catch (_) { /* bỏ qua */ }
  closeDrawer();
  renderAll();
}
// Lùi/tiến bằng trình duyệt sau khi đã đổi tài liệu tại chỗ: tải lại theo địa chỉ mới
window.addEventListener("popstate", () => { if (tree) location.reload(); });

/** /g/<slug>: mở thẳng trang đọc của nhóm, đọc chương đầu của tài liệu đầu (có từ khoá thì tài liệu khớp đầu tiên). */
async function bootGroup(gslug) {
  const q = currentQ;
  if (q) $("#search").value = q;
  const load = lang => Promise.all([api("GET", `/api/docs?lang=${lang}&group=${gslug}`), api("GET", "/api/groups?lang=" + lang)]);
  let docsRes, groupsRes, lang = UI;
  try {
    [docsRes, groupsRes] = await load(lang);
    // Nhóm không có tài liệu ở ngôn ngữ đang chọn nhưng có ở ngôn ngữ kia: tự chuyển ngôn ngữ
    if (!docsRes.docs.length) {
      const other = lang === "vi" ? "en" : "vi";
      const [d2, g2] = await load(other);
      if (d2.docs.length) {
        lang = other; docsRes = d2; groupsRes = g2; setUi(other); syncQuery(q);
        showBanner(t("switchedLang", other), [[t("close"), () => {}]]);
      }
    }
  } catch (_) { renderHeader(); renderEmpty($("#reader"), t("libraryLoadFailed"), t("checkNetwork")); return; }
  SITE = docsRes.site || SITE; SITE_EN = docsRes.siteEn || SITE_EN;
  const g = gslug === "_" ? null : (groupsRes.groups.find(x => x.slug === gslug) || null);
  if (!docsRes.docs.length || (gslug !== "_" && !g)) {
    doc = null; renderHeader(); renderToc();
    renderEmpty($("#reader"), t("groupNotFound"), t("groupNotFoundText"), [t("seeAllDocs"), url("/" + qsFor("", UI))]);
    return;
  }
  tree = makeTree(gslug, g, lang, docsRes.docs);
  let first = tree.docs[0].slug;
  if (q) {
    try {
      tree.index = await searchIndex("public", lang);
      const needle = fold(q).trim();
      const hit = tree.docs.find(d => { const x = tree.index.docs.find(y => y.slug === d.slug); return x && countMatches(x._folded, needle) > 0; });
      if (hit) first = hit.slug;
    } catch (_) { /* không có chỉ mục thì mở tài liệu đầu */ }
  }
  let r;
  try { r = await loadTreeDoc(first); } catch (_) { renderHeader(); renderEmpty($("#reader"), t("docLoadFailed"), t("checkNetwork")); return; }
  doc = r.doc; docLang = r.lang || lang; docGroup = r.group || null; curSlug = first; tree.open.add(first);
  if (docLang !== UI) setUi(docLang);
  pickActive(); setMode("read");
}
/** Trang đọc /d/<slug>: tài liệu thuộc nhóm (hoặc chưa phân nhóm khi thư viện đã có nhóm) thì hiện cây của nhóm. */
async function attachTree(r) {
  let key = docGroup ? docGroup.slug : null;
  if (!key) {
    try { if ((await api("GET", "/api/groups?lang=" + docLang)).groups.length) key = "_"; } catch (_) { /* không có cây */ }
  }
  if (!key) return;
  try {
    tree = makeTree(key, docGroup, docLang, (await api("GET", `/api/docs?lang=${docLang}&group=${key}`)).docs);
    tree.cache.set(curSlug, r);
  } catch (_) { tree = null; }
}

/* ---------- Trang quản lý ---------- */
let groupsCache = null; // { groups, ungrouped } từ /api/admin/groups
async function loadGroups() { groupsCache = await api("GET", "/api/admin/groups"); return groupsCache; }
function groupSelect(value) {
  const s = el("select");
  s.append(new Option(t("ungrouped"), "_"));
  (groupsCache ? groupsCache.groups : []).forEach(g => s.append(new Option(groupName(g), g.slug)));
  s.value = value || "_";
  return s;
}
function adminFail(ex) { if (ex.status === 401) return showLogin(); toast(ex.message || t("failed")); }

async function renderDashboard(focusCreate) {
  const box = $("#list");
  let gdata;
  try { gdata = await loadGroups(); }
  catch (err) { if (err.status === 401) return showLogin(); box.innerHTML = ""; renderEmpty(box, t("listLoadFailed"), err.message); return; }
  SITE = gdata.site || SITE; SITE_EN = gdata.siteEn || SITE_EN;
  backTarget = null; listTitle = t("manageDocs"); renderHeader();
  const q = currentQ;
  box.innerHTML = "";
  const wrapEl = el("div", "lib"); box.append(wrapEl);
  const hasGroups = gdata.groups.length > 0;
  const total = gdata.groups.reduce((n, g) => n + g.counts.vi + g.counts.en, 0) + gdata.ungrouped.vi + gdata.ungrouped.en;
  const head = libHead(hasGroups ? t("groupsTitle") : t("docsTitle"), hasGroups ? t("groupsCount", gdata.groups.length) : t("docsCount", total));
  const acts = el("div", "head-acts");
  const newGroupBtn = el("button", "btn", t("newGroup"));
  const newDocBtn = el("button", "btn primary", t("newDoc"));
  acts.append(newGroupBtn, newDocBtn); head.append(acts);
  wrapEl.append(head);
  const pagesSlot = el("div"); wrapEl.append(pagesSlot); renderPagesPanel(pagesSlot);
  const formSlot = el("div"); wrapEl.append(formSlot);
  const closeForms = () => { formSlot.innerHTML = ""; newDocBtn.disabled = false; newGroupBtn.disabled = false; };
  newDocBtn.onclick = () => { closeForms(); newDocBtn.disabled = true; formSlot.append(createForm(closeForms, "_")); };
  newGroupBtn.onclick = () => { closeForms(); newGroupBtn.disabled = true; formSlot.append(groupForm(null, closeForms)); };

  const ul = el("ul", "lib-list");
  let sb;
  if (hasGroups) {
    gdata.groups.forEach((g, i) => ul.append(dashGroupRow(g, i, gdata.groups.length)));
    if (gdata.ungrouped.vi + gdata.ungrouped.en > 0) ul.append(dashGroupRow(null));
    sb = searchBox({ container: ul, scope: "admin", initial: q, keyOf: (r, k) => r.byGroup[k], onQuery: v => syncAdminQuery(v) });
  } else {
    let docs = [];
    try { docs = (await api("GET", "/api/admin/docs?group=_")).docs; } catch (err) { return adminFail(err); }
    docs.forEach((d, i) => ul.append(dashRow(d, { index: i, count: docs.length, movable: true })));
    if (!docs.length && !focusCreate) newDocBtn.click();
    sb = searchBox({ container: ul, scope: "admin", initial: q, keyOf: (r, k) => r.byDoc[k], onQuery: v => syncAdminQuery(v) });
  }
  if (focusCreate) newDocBtn.click();
  wrapEl.append(sb.input, sb.status, ul);
  sb.input.classList.add("dash-search");
}
function syncAdminQuery(q) {
  currentQ = q || "";
  const p = new URLSearchParams(location.search);
  if (q) p.set("q", q); else p.delete("q");
  const s = p.toString();
  try { history.replaceState(null, "", location.pathname + (s ? "?" + s : "")); } catch (_) { /* bỏ qua */ }
}
function dashGroupRow(g, i, n) {
  const key = g ? g.slug : "_";
  const counts = g ? g.counts : groupsCache.ungrouped;
  const li = el("li"); li.dataset.key = key;
  const row = el("div", "dash-row"); li.append(row);
  const name = el("div", "lib-name hit-slot");
  const a = el("a", "", groupName(g)); a.href = "/admin/g/" + key;
  a.addEventListener("click", () => { const box = document.querySelector(".dash-search"); if (box && box.value.trim()) a.href = "/admin/g/" + key + "?q=" + encodeURIComponent(box.value.trim()); });
  name.append(a);
  const other = otherName(g); if (other) name.append(el("span", "alt-name", other));
  row.append(name);
  const info = el("div", "dash-info");
  if (g) info.append(el("code", "", "/g/" + g.slug));
  info.append(el("span", "", t("countByLang", counts.vi, counts.en)));
  row.append(info);
  const acts = el("div", "dash-actions");
  const open = el("a", "btn primary", t("openGroup")); open.href = a.href; acts.append(open);
  if (g) {
    const mk = (html, label, dir, dis) => {
      const b = el("button", "btn icon"); b.innerHTML = html; b.title = label; b.setAttribute("aria-label", label); b.disabled = dis;
      b.onclick = async () => { try { await api("POST", `/api/admin/groups/${g.slug}/move`, { dir }); renderDashboard(); } catch (ex) { adminFail(ex); } };
      return b;
    };
    acts.append(mk(ICON.up, t("moveUp"), -1, i === 0), mk(ICON.down, t("moveDown"), 1, i === n - 1));
    const ren = el("button", "btn", t("rename")); acts.append(ren);
    ren.onclick = () => { if (!row.querySelector(".create")) row.append(groupForm(g, () => renderDashboard())); };
    const del = el("button", "btn danger", t("del")); acts.append(del);
    del.onclick = () => confirmAction(del, t("deleteAgain"), async () => {
      await api("DELETE", `/api/admin/groups/${g.slug}`); toast(t("groupDeleted", groupName(g))); renderDashboard();
    });
  }
  row.append(acts);
  return li;
}
function groupForm(g, onClose) {
  const f = el("form", "create"); f.noValidate = true;
  f.append(el("h2", "", g ? t("editGroup") : t("createGroup")));
  const row = el("div", "row");
  const l1 = el("label", "", t("groupNameVi")); const nv = el("input"); nv.value = g ? g.name_vi : ""; l1.append(nv);
  const l2 = el("label", "", t("groupNameEn")); const ne = el("input"); ne.value = g ? g.name_en : ""; l2.append(ne);
  row.append(l1, l2); f.append(row);
  const l3 = el("label", "", t("pathLabel")); const pre = el("div", "prefix"); pre.append(el("span", "", "/g/"));
  const slugIn = el("input"); slugIn.value = g ? g.slug : ""; slugIn.placeholder = t("autoSlug"); slugIn.spellcheck = false; pre.append(slugIn); l3.append(pre);
  f.append(l3, el("p", "form-hint", t("groupNameHint")));
  const err = el("p", "form-err"); err.setAttribute("role", "alert"); f.append(err);
  const acts = el("div", "acts"); const ok = el("button", "btn primary", g ? t("saveGroup") : t("createGroupBtn")); ok.type = "submit";
  const cancel = el("button", "btn", t("cancel")); cancel.type = "button"; cancel.onclick = () => { f.remove(); if (!g) onClose(); };
  acts.append(ok, cancel); f.append(acts);
  let slugTouched = !!g;
  slugIn.addEventListener("input", () => { slugTouched = !!slugIn.value; slugIn.value = slugIn.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); });
  const auto = () => { if (!slugTouched) slugIn.value = slug(nv.value || ne.value); };
  nv.addEventListener("input", auto); ne.addEventListener("input", auto);
  f.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = "";
    if (!nv.value.trim() && !ne.value.trim()) { err.textContent = t("groupNameMissing"); nv.focus(); return; }
    ok.disabled = true;
    const body = { name_vi: nv.value.trim(), name_en: ne.value.trim(), slug: slugIn.value.replace(/^-+|-+$/g, "") || undefined };
    try {
      if (g) { await api("PATCH", `/api/admin/groups/${g.slug}`, body); toast(t("groupSaved")); }
      else { await api("POST", "/api/admin/groups", body); toast(t("groupCreated")); }
      onClose(); renderDashboard();
    } catch (ex) {
      if (ex.status === 401) return showLogin();
      err.textContent = ex.message; ok.disabled = false;
    }
  });
  setTimeout(() => nv.focus(), 30);
  return f;
}

let dashFilter = "all"; // lọc theo ngôn ngữ ở trang nhóm: all | vi | en
async function renderDashGroup(gslug) {
  const box = $("#list");
  let docs;
  try { await loadGroups(); docs = (await api("GET", "/api/admin/docs?group=" + gslug)).docs; }
  catch (err) { if (err.status === 401) return showLogin(); box.innerHTML = ""; renderEmpty(box, t("listLoadFailed"), err.message, [t("backToManage"), "/admin"]); return; }
  SITE = groupsCache.site || SITE; SITE_EN = groupsCache.siteEn || SITE_EN;
  const g = gslug === "_" ? null : groupsCache.groups.find(x => x.slug === gslug) || null;
  const q = currentQ;
  backTarget = { href: "/admin" + (q ? "?q=" + encodeURIComponent(q) : ""), label: t("manage") };
  listTitle = groupName(g); renderHeader();
  box.innerHTML = "";
  const wrapEl = el("div", "lib"); box.append(wrapEl);
  const head = libHead(groupName(g), t("dashSummary", docs.length, docs.filter(d => d.publishedAt).length));
  if (g && otherName(g)) head.firstChild.append(el("p", "alt-name", otherName(g)));
  const newBtn = el("button", "btn primary", t("newDoc")); head.append(newBtn); wrapEl.append(head);
  const formSlot = el("div"); wrapEl.append(formSlot);
  const closeForm = () => { formSlot.innerHTML = ""; newBtn.disabled = false; };
  newBtn.onclick = () => { newBtn.disabled = true; formSlot.innerHTML = ""; formSlot.append(createForm(closeForm, gslug)); };

  const filters = el("div", "seg"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", t("langLabel"));
  [["all", t("filterAll")], ["vi", "VI"], ["en", "EN"]].forEach(([v, label]) => {
    const b = el("button", "seg-btn", label); b.setAttribute("aria-pressed", String(dashFilter === v));
    b.onclick = () => { dashFilter = v; renderDashGroup(gslug); };
    filters.append(b);
  });
  const ul = el("ul", "lib-list");
  const shown = docs.filter(d => dashFilter === "all" || d.lang === dashFilter);
  // Chỉ cho đổi thứ tự khi đang xem tất cả, để vị trí lên/xuống không bị hiểu sai
  shown.forEach((d, i) => ul.append(dashRow(d, { index: i, count: shown.length, movable: dashFilter === "all", group: gslug })));
  if (!shown.length) ul.append(el("li", "lib-empty", t("noDocsInGroup")));
  const sb = searchBox({ container: ul, scope: "admin", initial: q, keyOf: (r, k) => r.byDoc[k], onQuery: v => syncAdminQuery(v) });
  sb.input.classList.add("dash-search");
  const bar = el("div", "dash-bar"); bar.append(filters, sb.input);
  wrapEl.append(bar, sb.status, ul);
  if (!docs.length) newBtn.click();
}

async function renderPagesPanel(slot) {
  let st;
  try { st = await api("GET", "/api/admin/pages"); } catch (_) { return; }
  if (!st.enabled) return; // chưa thiết lập GitHub Pages: không hiện gì
  const box = el("div", "pages-panel");
  const info = el("div", "pages-info");
  info.append(el("strong", "", t("ghPages")));
  const line = el("span", "");
  if (st.url) { const a = el("a", "", st.url); a.href = st.url; a.target = "_blank"; a.rel = "noopener"; line.append(a); }
  else line.textContent = st.remote;
  info.append(line, el("span", "pages-note", t("ghNote")));
  const btn = el("button", "btn primary", t("ghPublish"));
  const result = el("p", "pages-result"); result.setAttribute("role", "status");
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = t("ghPublishing"); result.textContent = ""; result.classList.remove("err");
    try {
      const r = await api("POST", "/api/admin/pages/publish");
      result.textContent = r.changed ? t("ghDone", r.docs, r.images) : t("ghNoChange", r.docs);
      if (r.missingImages && r.missingImages.length) result.textContent += t("ghMissing", r.missingImages.length);
    } catch (ex) {
      if (ex.status === 401) return showLogin();
      result.textContent = ex.message; result.classList.add("err");
    } finally { btn.disabled = false; btn.textContent = t("ghPublish"); }
  };
  box.append(info, btn, result); slot.append(box);
}

function createForm(onClose, defaultGroup) {
  const f = el("form", "create"); f.noValidate = true;
  f.append(el("h2", "", t("createDoc")));
  const row = el("div", "row");
  const l1 = el("label", "", t("docTitle")); const title = el("input"); title.required = true; title.placeholder = t("titlePlaceholder"); l1.append(title);
  const l2 = el("label", "", t("pathLabel")); const pre = el("div", "prefix"); pre.append(el("span", "", "/d/"));
  const slugIn = el("input"); slugIn.placeholder = t("autoSlug"); slugIn.spellcheck = false; pre.append(slugIn); l2.append(pre);
  row.append(l1, l2); f.append(row);
  // Ngôn ngữ của tài liệu: bắt buộc chọn, không chọn sẵn, không lấy theo ngôn ngữ giao diện
  const row2 = el("div", "row");
  const fs = el("fieldset", "lang-pick"); fs.append(el("legend", "", t("docLang")));
  const radios = LANGS.map(l => {
    const lab = el("label", "radio"); const r = el("input"); r.type = "radio"; r.name = "doc-lang"; r.value = l;
    lab.append(r, document.createTextNode(" " + tl(l, l === "vi" ? "langVi" : "langEn"))); fs.append(lab); return r;
  });
  const l4 = el("label", "", t("groupField")); const gsel = groupSelect(defaultGroup); l4.append(gsel);
  row2.append(fs, l4); f.append(row2);
  const l3 = el("label", "", t("initialContent")); const sel = el("select");
  sel.append(new Option(t("blankContent"), ""));
  l3.append(sel); f.append(l3);
  api("GET", "/api/admin/docs").then(r => r.docs.forEach(d => sel.append(new Option(t("copyFrom", (d.title || d.slug) + " (" + d.lang.toUpperCase() + ")"), d.slug)))).catch(() => {});
  const err = el("p", "form-err"); err.setAttribute("role", "alert"); f.append(err);
  const acts = el("div", "acts"); const ok = el("button", "btn primary", t("createAndOpen")); ok.type = "submit";
  const cancel = el("button", "btn", t("cancel")); cancel.type = "button"; cancel.onclick = onClose; acts.append(ok, cancel); f.append(acts);
  let slugTouched = false;
  slugIn.addEventListener("input", () => { slugTouched = !!slugIn.value; slugIn.value = slugIn.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); });
  title.addEventListener("input", () => { if (!slugTouched) slugIn.value = slug(title.value); });
  f.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = "";
    if (!title.value.trim()) { err.textContent = t("needTitle"); title.focus(); return; }
    const lang = (radios.find(r => r.checked) || {}).value;
    if (!lang) { err.textContent = t("chooseLang"); radios[0].focus(); return; }
    ok.disabled = true;
    try {
      const r = await api("POST", "/api/admin/docs", {
        title: title.value.trim(), slug: slugIn.value.replace(/^-+|-+$/g, "") || undefined, copyFrom: sel.value || undefined,
        lang, group: gsel.value === "_" ? undefined : gsel.value
      });
      location.href = "/admin/" + r.slug;
    } catch (ex) {
      if (ex.status === 401) return showLogin();
      err.textContent = ex.message; ok.disabled = false;
    }
  });
  setTimeout(() => title.focus(), 30);
  return f;
}

function rerenderDash() { if (ROUTE.view === "dashgroup") renderDashGroup(ROUTE.slug); else renderDashboard(); }
function dashRow(d, opts) {
  const li = el("li"), row = el("div", "dash-row"); li.append(row);
  li.dataset.key = d.slug;
  const editHref = () => { const box = document.querySelector(".dash-search"); const q = box ? box.value.trim() : ""; return "/admin/" + d.slug + (q ? "?q=" + encodeURIComponent(q) : ""); };
  const name = el("div", "lib-name hit-slot"); const a = el("a", "", d.title || d.slug); a.href = "/admin/" + d.slug;
  a.addEventListener("click", () => { a.href = editHref(); });
  name.append(el("span", "lang-tag", (d.lang || "vi").toUpperCase()), a);
  const pill = !d.publishedAt ? el("span", "pill draft", t("draftPill")) : d.publishedSame ? el("span", "pill live", t("livePill")) : el("span", "pill changed", t("changedPill"));
  name.append(pill); row.append(name);
  const info = el("div", "dash-info");
  info.append(el("code", "", "/d/" + d.slug));
  info.append(el("span", "", t("chaptersCount", d.chapters || 0)));
  info.append(el("span", "", t("lastEdited", fmtTime(d.updatedAt), d.updatedBy)));
  // Đổi nhóm và ngôn ngữ ngay tại dòng
  const gsel = groupSelect(d.group); gsel.setAttribute("aria-label", t("groupField")); gsel.className = "mini";
  gsel.onchange = async () => { try { await api("PATCH", `/api/admin/docs/${d.slug}`, { group: gsel.value === "_" ? null : gsel.value }); toast(t("moved")); rerenderDash(); } catch (ex) { adminFail(ex); } };
  const lsel = el("select", "mini"); lsel.setAttribute("aria-label", t("docLang"));
  LANGS.forEach(l => lsel.append(new Option(l.toUpperCase(), l))); lsel.value = d.lang || "vi";
  lsel.onchange = async () => { try { await api("PATCH", `/api/admin/docs/${d.slug}`, { lang: lsel.value }); toast(t("langChanged")); rerenderDash(); } catch (ex) { adminFail(ex); } };
  if (groupsCache && groupsCache.groups.length) info.append(gsel);
  info.append(lsel);
  row.append(info);

  const acts = el("div", "dash-actions");
  if (opts && opts.movable && opts.count > 1) {
    const mk = (html, label, dir, dis) => {
      const b = el("button", "btn icon"); b.innerHTML = html; b.title = label; b.setAttribute("aria-label", label); b.disabled = dis;
      b.onclick = async () => { try { await api("POST", `/api/admin/docs/${d.slug}/move`, { dir }); rerenderDash(); } catch (ex) { adminFail(ex); } };
      return b;
    };
    acts.append(mk(ICON.up, t("moveUp"), -1, opts.index === 0), mk(ICON.down, t("moveDown"), 1, opts.index === opts.count - 1));
  }
  const edit = el("a", "btn primary", t("write")); edit.href = "/admin/" + d.slug; edit.addEventListener("click", () => { edit.href = editHref(); }); acts.append(edit);
  if (d.publishedAt) { const v = el("a", "btn", t("view")); v.href = "/d/" + d.slug; v.target = "_blank"; v.rel = "noopener"; acts.append(v); }
  const ren = el("button", "btn", t("changePath")); acts.append(ren);
  if (d.publishedAt) {
    const un = el("button", "btn", t("unpublish")); acts.append(un);
    un.onclick = () => confirmAction(un, t("unpublishAgain"), async () => {
      await api("POST", `/api/admin/docs/${d.slug}/unpublish`); toast(t("unpublished", d.title)); rerenderDash();
    });
  }
  const del = el("button", "btn danger", t("del")); acts.append(del);
  del.onclick = () => confirmAction(del, t("deleteAgain"), async () => {
    await api("DELETE", `/api/admin/docs/${d.slug}`); toast(t("deleted", d.title)); rerenderDash();
  });
  row.append(acts);

  ren.onclick = () => {
    if (row.querySelector(".inline-form")) return;
    const f = el("form", "inline-form"); f.noValidate = true;
    f.append(el("span", "", "/d/"));
    const inp = el("input"); inp.value = d.slug; inp.spellcheck = false; inp.setAttribute("aria-label", t("newPath"));
    const sv = el("button", "btn primary", t("savePath")); sv.type = "submit";
    const cc = el("button", "btn", t("cancel")); cc.type = "button"; cc.onclick = () => f.remove();
    const er = el("p", "form-err"); f.append(inp, sv, cc, er);
    if (d.publishedAt) f.append(el("p", "form-err", t("oldLinkWarn", d.slug)));
    f.addEventListener("submit", async e => {
      e.preventDefault(); er.textContent = "";
      try { await api("PATCH", `/api/admin/docs/${d.slug}`, { slug: inp.value.trim() }); toast(t("pathChanged")); rerenderDash(); }
      catch (ex) { if (ex.status === 401) return showLogin(); er.textContent = ex.message; }
    });
    row.append(f); inp.focus(); inp.select();
  };
  return li;
}

function confirmAction(btn, label, fn) {
  if (btn.dataset.armed) {
    btn.disabled = true;
    fn().catch(ex => { if (ex.status === 401) return showLogin(); toast(ex.message || t("failed")); btn.disabled = false; });
    return;
  }
  const old = btn.textContent;
  btn.dataset.armed = "1"; btn.classList.add("armed"); btn.textContent = label;
  setTimeout(() => { if (btn.isConnected && !btn.disabled) { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = old; } }, 4000);
}

/* ---------- Đăng nhập ---------- */
function showLogin() {
  applyI18n();
  document.body.classList.add("show-login");
  setTimeout(() => $("#login-form [name=username]").focus(), 30);
}
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, err = $("#login-err"), btn = $("#login-btn");
  const username = f.username.value.trim(), password = f.password.value;
  if (!username || !password) { err.textContent = t("loginMissing"); return; }
  btn.disabled = true; err.textContent = "";
  try {
    const r = await api("POST", "/api/login", { username, password });
    user = r.user; f.password.value = "";
    document.body.classList.remove("show-login");
    if (IS_ADMIN && doc) { renderHeader(); if (dirty && !conflict) saveDraft(); }
    else await bootView();
  } catch (ex) {
    err.textContent = ex.message || t("loginFailed");
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
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", t("viewImage")); box.dataset.lang = UI;
    box.innerHTML =
      `<div class="lb-bar"><span class="lb-count"></span>
        <button class="lb-btn" data-act="out" title="${t("zoomOutKey")}" aria-label="${t("zoomOut")}">${SVG("M5 12h14")}</button>
        <button class="lb-btn lb-pct" data-act="fit" title="${t("fitKey")}" aria-label="${t("fit")}"></button>
        <button class="lb-btn" data-act="in" title="${t("zoomInKey")}" aria-label="${t("zoomIn")}">${SVG("M12 5v14M5 12h14")}</button>
        <button class="lb-btn" data-act="close" title="${t("closeKey")}" aria-label="${t("close")}">${SVG("M6 6l12 12M18 6L6 18")}</button></div>
      <div class="lb-stage"><img class="lb-img" alt="" draggable="false">
        <button class="lb-btn lb-nav lb-prev" data-act="prev" title="${t("prevImageKey")}" aria-label="${t("prevImage")}">${SVG("M15 6l-6 6 6 6")}</button>
        <button class="lb-btn lb-nav lb-next" data-act="next" title="${t("nextImageKey")}" aria-label="${t("nextImage")}">${SVG("M9 6l6 6-6 6")}</button></div>
      <div class="lb-foot"><div class="lb-cap"></div>
        <div class="lb-hint">${t("zoomHint")}</div></div>`;
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
    if (box && box.dataset.lang !== UI && !box.classList.contains("open")) { box.remove(); box = null; }
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
  const q = $("#search").value.trim();
  let s = doc ? doc.sections.find(x => x.id === h) : null;
  // Đến từ kết quả tìm kiếm mà không chỉ định chương: mở chương khớp đầu tiên
  if (!s && doc && q) s = doc.sections.find(x => sectionMatches(x, q));
  active = doc ? ((s || doc.sections[0] || {}).id || null) : null;
}
async function bootView() {
  applyI18n();
  if (ROUTE.view === "library") return renderLibrary();
  if (ROUTE.view === "group") return bootGroup(ROUTE.slug);
  if (ROUTE.view === "dashboard") return renderDashboard();
  if (ROUTE.view === "dashgroup") return renderDashGroup(ROUTE.slug);
  if (ROUTE.view === "notfound") {
    listTitle = t("pageNotFound"); backTarget = null; renderHeader(); const box = $("#list"); box.innerHTML = "";
    renderEmpty(box, t("pageNotFound"), t("pageNotFoundText"), [t("seeAllDocs"), "/"]); return;
  }
  if (QS.get("q")) $("#search").value = QS.get("q");
  if (ROUTE.view === "editor") {
    try {
      const d = await api("GET", `/api/admin/docs/${ROUTE.slug}/draft`);
      doc = d.doc; rev = d.rev; publishedSame = d.publishedSame; publishedAt = d.publishedAt;
      docLang = d.lang || "vi";
      if (d.group) { if (!groupsCache) await loadGroups().catch(() => {}); docGroup = (groupsCache && groupsCache.groups.find(g => g.slug === d.group)) || { slug: d.group, name_vi: d.group, name_en: d.group }; }
      pickActive(); setMode("edit"); checkBackup();
    } catch (err) {
      if (err.status === 401) return showLogin();
      renderHeader();
      renderEmpty($("#reader"), err.status === 404 ? t("docNotFound") : t("draftLoadFailed"),
        err.status === 404 ? t("draftNotFoundText") : err.message, [t("backToManage"), "/admin"]);
    }
    return;
  }
  // reader: giao diện theo ngôn ngữ của tài liệu
  try {
    const r = await api("GET", `/api/docs/${ROUTE.slug}`);
    doc = r.doc; docLang = r.lang || "vi"; docGroup = r.group || null;
    if (docLang !== UI) setUi(docLang);
    await attachTree(r);
  } catch (err) {
    doc = null;
    if (err.status !== 404) { renderEmpty($("#reader"), t("docLoadFailed"), t("checkNetwork")); renderHeader(); return; }
  }
  pickActive(); setMode("read");
}
async function boot() {
  applyI18n();
  const [me, site] = await Promise.all([
    api("GET", "/api/me").catch(() => null),
    api("GET", "/api/site").catch(() => null)
  ]);
  user = me ? me.user : null;
  if (site) { SITE = site.name || SITE; SITE_EN = site.nameEn || SITE; }
  if (NEEDS_LOGIN && !user) { renderHeader(); showLogin(); return; }
  await bootView();
}
boot();
})();
