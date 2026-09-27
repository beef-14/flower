#!/usr/bin/env node
"use strict";
/*
 * _test.js - one regression runner for the flower page (replaces _check.js + _zoom.js + _sizes.js).
 *
 *   node _test.js                          run every suite
 *   node _test.js --suite sizes            run a single suite (state | zoom | sizes)
 *   node _test.js --out shots               write artifacts to ./shots instead of ./_artifacts
 *   node _test.js --chrome "C:/path/chrome.exe"
 *   node _test.js --file other.html --port 8780 --cdp 9350
 *
 * Suites
 *   state  body-class state machine (bud -> bloomed -> done -> bud), petal growth,
 *          message + replay visibility, double-click guard, stem dash coverage,
 *          stem<->head overlap, leaf attachment   -> state-desktop/mobile/bud.png
 *   zoom   18x junction crops (deviceScaleFactor 3 * CDP clip scale 6)
 *                                                  -> zoom-leaf-left/right/head.png
 *   surprise  second stage: "Bloom Again" -> envelope screen -> opening choreography
 *          (seal, flap, sheet) -> letter view, config-driven text, guard checks,
 *          contained scrolling, desktop + phone fit
 *     -> state-envelope[-opening|-out|-mobile].png, state-letter[-end|-mobile].png
 *   voice  the voice message: config-driven labels, button under the envelope, real
 *          tap -> play/pause/resume/end transport, progress + clock, visualizer,
 *          letter-view fit, phone fit, missing-file fallback, no autoplay
 *     -> state-voice[-playing|-letter|-mobile|-small|-missing].png
 *   sizes  8 viewport sweep: no horizontal overflow, stem/head overlap,
 *          leaf-into-stem overlap, no console errors
 *
 * Exit code 0 = every check passed, 1 = at least one FAIL (or a crash).
 */
const http = require("http");
const fss = require("fs");
const cp = require("child_process");
const path = require("path");
const os = require("os");

const HERE = __dirname;
const SUITES = ["state", "zoom", "surprise", "voice", "music", "sizes"];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = n => Math.round(n * 10) / 10;
/* "none" -> 0px, "blur(12px)" -> 12, anything unparseable -> 99 (fails a "< 1" check) */
const blurPx = f => (f === "none" ? 0 : Number((/blur\(([\d.]+)px\)/.exec(f) || [0, 99])[1]));

/* ------------------------------ cli ------------------------------ */
function parseArgs(argv) {
  const a = { file: "index.html", out: "_artifacts", port: 8775, cdp: 9345, suite: "all", chrome: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === "--file") a.file = v();
    else if (k === "--out") a.out = v();
    else if (k === "--chrome") a.chrome = v();
    else if (k === "--port") a.port = Number(v());
    else if (k === "--cdp") a.cdp = Number(v());
    else if (k === "--suite") a.suite = v();
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error("unknown option: " + k);
  }
  return a;
}

function findChrome(explicit) {
  const cands = [
    explicit,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : null,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fss.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  throw new Error("Chrome not found - pass --chrome <path> or set CHROME_PATH. Tried:\n  " + cands.join("\n  "));
}

const USAGE = [
  "usage: node _test.js [--suite state|zoom|surprise|voice|music|sizes] [--file index.html] [--out _artifacts]",
  "                     [--chrome <path>] [--port 8775] [--cdp 9345]"
].join("\n");
/* ---------------------- tiny static file server ---------------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav"
};

function startServer(dir, port) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const file = path.resolve(path.join(root, url === "/" ? "/index.html" : url));
    if (!file.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
    fss.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      const base = {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store, must-revalidate", "accept-ranges": "bytes"
      };
      /* media needs byte ranges: without a 206 Chrome treats the mp3 as an unseekable stream */
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (m) {
        let start = m[1] === "" ? data.length - Number(m[2]) : Number(m[1]);
        let end = (m[1] === "" || m[2] === "") ? data.length - 1 : Number(m[2]);
        if (!isFinite(start) || start < 0) start = 0;
        if (!isFinite(end) || end >= data.length) end = data.length - 1;
        if (start > end) { res.writeHead(416, { "content-range": "bytes */" + data.length }); res.end(); return; }
        res.writeHead(206, Object.assign({}, base, { "content-range": "bytes " + start + "-" + end + "/" + data.length, "content-length": end - start + 1 }));
        res.end(data.slice(start, end + 1));
        return;
      }
      res.writeHead(200, Object.assign({}, base, { "content-length": data.length }));
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/* ------------------------------- chrome ------------------------------- */
function launchChrome(bin, cdpPort, profileDir) {
  fss.rmSync(profileDir, { recursive: true, force: true });
  return cp.spawn(bin, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--force-device-scale-factor=1",
    /* audio: the voice-message suite taps a real button, and nothing may be audible here */
    "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    "--user-data-dir=" + profileDir, "--remote-debugging-port=" + cdpPort, "about:blank"
  ], { stdio: "ignore" });
}

/* ------------------------------ cdp client ------------------------------ */
async function connectCdp(cdpPort) {
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json(); }
    catch (e) { await sleep(200); }
  }
  if (!version) throw new Error("CDP did not come up on port " + cdpPort);

  const list = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/list")).json();
  const page = list.find(t => t.type === "page") || list[0];
  if (!page) throw new Error("no page target: " + JSON.stringify(list.map(t => t.type)));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const logs = [];
  let id = 0;

  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.consoleAPICalled") {
      logs.push("CONSOLE " + m.params.args.map(a => (a.value !== undefined ? a.value : a.description)).join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push("EXCEPTION " + ((d.exception && d.exception.description) || d.text));
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      logs.push("LOG " + m.params.entry.text);
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(res => ws.addEventListener("open", res));

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, m => (m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");

  const ev = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  return { ws, send, ev, logs, browser: version.Browser };
}
/* ------------------------------- probes ------------------------------- */
/* In-page geometry + style probe, identical math to the old _check.js/_sizes.js harnesses. */
const PROBE_STATE = `JSON.stringify((function(){
  var stem = document.querySelector('.stem');
  var sb = stem.getBoundingClientRect();
  var sep = document.getElementById('sepals').getBoundingClientRect();
  var tip = document.querySelector('.budtip').getBoundingClientRect();
  var headBottom = Math.max(sep.bottom, tip.bottom);
  var petals = document.querySelectorAll('.petal');
  var spread = 0;
  petals.forEach(function (p) {
    var t = getComputedStyle(p).transform;
    var v = t === 'none' ? 1 : Math.abs(parseFloat(t.slice(7)));
    if (v > spread) spread = v;
  });
  var leaves = (function () {
    var svg = stem.ownerSVGElement, ctm = stem.getScreenCTM();
    var pt = svg.createSVGPoint(), L = stem.getTotalLength(), pts = [];
    for (var s = 0; s <= L; s += 3) {
      var p = stem.getPointAtLength(s);
      pt.x = p.x; pt.y = p.y;
      pts.push(pt.matrixTransform(ctm));
    }
    var half = parseFloat(getComputedStyle(stem).strokeWidth) * ctm.a / 2;
    var out = [];
    document.querySelectorAll('.leaf').forEach(function (g, i) {
      var el = g.querySelector('path') || g;   /* the filled blade, not the hairline vein */
      var b = el.getBoundingClientRect();
      var band = pts.filter(function (q) { return q.y > b.top + 3 && q.y < b.bottom - 3; });
      if (!band.length) { out.push({ leaf: i, gap: null, err: 'no-band' }); return; }
      var sx = band.map(function (q) { return q.x; });
      var near = i === 0 ? Math.max.apply(null, sx) : Math.min.apply(null, sx);
      out.push({ leaf: i, gap: Math.round((i === 0 ? near - half - b.right : b.left - (near + half)) * 10) / 10 });
    });
    return out;
  })();
  var msg = getComputedStyle(document.querySelector('.message'));
  return {
    cls: document.body.className || 'bud',
    msgOpacity: parseFloat(msg.opacity),
    msgFilter: msg.filter,
    hintOpacity: parseFloat(getComputedStyle(document.getElementById('hint')).opacity),
    hintText: document.getElementById('hint').textContent.trim(),
    budtip: getComputedStyle(document.querySelector('.budtip')).transform,
    replayHidden: document.getElementById('replay').hidden,
    replayOpacity: parseFloat(getComputedStyle(document.getElementById('replay')).opacity),
    stemLen: Math.round(stem.getTotalLength()),
    dash: parseFloat(getComputedStyle(stem).strokeDasharray),
    stemTop: Math.round(sb.top),
    headBottom: Math.round(headBottom),
    headOverlap: Math.round(headBottom - sb.top),
    petals: petals.length, sepals: document.querySelectorAll('.sepal').length,
    bokeh: document.querySelectorAll('.bokeh').length,
    falling: document.querySelectorAll('.falling').length,
    sparks: document.querySelectorAll('.spark').length,
    ring: document.querySelectorAll('.ring').length,
    spread: Math.round(spread * 1000) / 1000,
    leafAttach: leaves
  };
})())`;

const PROBE_SIZES = `JSON.stringify((function(){
  var stem = document.querySelector('.stem');
  var sb = stem.getBoundingClientRect();
  var sep = document.getElementById('sepals').getBoundingClientRect();
  var tip = document.querySelector('.budtip').getBoundingClientRect();
  var svg = document.getElementById('flower').getBoundingClientRect();
  var out = [];
  document.querySelectorAll('.leaf').forEach(function (g, i) {
    var b = (g.querySelector('path') || g).getBoundingClientRect();   /* leaf blade, not the vein */
    out.push({ leaf: i, intoStem: Math.round(i === 0 ? b.right - sb.left : sb.right - b.left) });
  });
  return {
    flower: Math.round(svg.width) + 'x' + Math.round(svg.height),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    headOverlap: Math.round(Math.max(sep.bottom, tip.bottom) - sb.top),
    leaves: out
  };
})())`;

/* envelope screen: overlay fit, envelope proportions, dimmed flower, floaters */
const PROBE_ENVELOPE = `JSON.stringify((function(){
  var ov = document.getElementById('surprise').getBoundingClientRect();
  var en = document.getElementById('envelope').getBoundingClientRect();
  var fw = getComputedStyle(document.querySelector('.flower-wrap'));
  var msg = getComputedStyle(document.querySelector('.message'));
  return {
    cls: document.body.className,
    overlay: { w: Math.round(ov.width), h: Math.round(ov.height) },
    vw: window.innerWidth, vh: window.innerHeight,
    envelopeW: Math.round(en.width), envelopeH: Math.round(en.height),
    envTop: Math.round(en.top), envBottom: Math.round(en.bottom),
    ratio: Math.round((en.width / en.height) * 100) / 100,
    title: document.getElementById('envTitle').textContent.trim(),
    hint: document.getElementById('envHint').textContent.trim(),
    floaters: document.querySelectorAll('.floater').length,
    flowerBlur: parseFloat((/blur\\(([\\d.]+)px\\)/.exec(fw.filter) || [0, 0])[1]),
    flowerOpacity: parseFloat(fw.opacity),
    msgOpacity: parseFloat(msg.opacity),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    stageHidden: document.querySelector('.stage').hasAttribute('aria-hidden'),
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null
  };
})())`;

/* the opening choreography: seal, flap, sheet */
const PROBE_OPEN = `JSON.stringify((function(){
  return {
    cls: document.body.className,
    seal: parseFloat(getComputedStyle(document.querySelector('.env-heart')).opacity),
    flap: getComputedStyle(document.querySelector('.env-flap')).transform,
    sheet: getComputedStyle(document.querySelector('.env-sheet')).transform,
    envelope: getComputedStyle(document.getElementById('envelope')).transform
  };
})())`;

/* the letter view: size, scrolling, text origin */
const PROBE_LETTER = `JSON.stringify((function(){
  var card = document.getElementById('letterCard').getBoundingClientRect();
  var sc = document.getElementById('letterScroll');
  var body = document.getElementById('letterBody');
  var tail = ':not(.letter-heading):not(.letter-wish):not(.letter-closing):not(.letter-sign):not(.letter-finale)';
  var paras = body.querySelectorAll('p' + tail);
  var closeEl = document.getElementById('letterClose');
  var closeCs = getComputedStyle(closeEl);
  var txt = function (sel) { var el = body.querySelector(sel); return el ? el.textContent.trim() : ''; };
  return {
    cls: document.body.className,
    card: { left: Math.round(card.left), right: Math.round(card.right), top: Math.round(card.top), bottom: Math.round(card.bottom), height: Math.round(card.height), width: Math.round(card.width) },
    vw: window.innerWidth, vh: window.innerHeight,
    paraCount: paras.length,
    firstPara: paras.length ? paras[0].textContent.trim() : '',
    lastPara: paras.length ? paras[paras.length - 1].textContent.trim() : '',
    heading: txt('.letter-heading'),
    wish: txt('.letter-wish'),
    sign: txt('.letter-sign'),
    finale: txt('.letter-finale'),
    lastClass: body.lastElementChild ? body.lastElementChild.className : '',
    overflowY: getComputedStyle(sc).overflowY,
    scrollable: sc.scrollHeight > sc.clientHeight + 2,
    scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight,
    clientWidth: sc.clientWidth, scrollWidth: sc.scrollWidth,
    firstOpacity: parseFloat(getComputedStyle(body.firstElementChild).opacity),
    closeOpacity: parseFloat(closeCs.opacity),
    closeSize: Math.round(closeEl.getBoundingClientRect().width),
    pageOverflowX: document.documentElement.scrollWidth > window.innerWidth
  };
})())`;

/* layout forensics: what the document root + html + body boxes actually are */
const PROBE_DIAG = `JSON.stringify((function(){
  var cs = function (el) { return getComputedStyle(el); };
  var h = document.documentElement, b = document.body, s = document.getElementById('surprise');
  var r = function (el) { var x = el.getBoundingClientRect(); return Math.round(x.left) + ',' + Math.round(x.top) + ' ' + Math.round(x.width) + 'x' + Math.round(x.height); };
  var hcs = cs(h), bcs = cs(b), scs = cs(s);
  return {
    mode: document.compatMode,
    html: { display: hcs.display, width: hcs.width, transform: hcs.transform, filter: hcs.filter, contain: hcs.contain, zoom: hcs.zoom, rect: r(h) },
    body: { display: bcs.display, width: bcs.width, height: bcs.height, transform: bcs.transform, filter: bcs.filter, contain: bcs.contain, zoom: bcs.zoom, overflow: bcs.overflow, position: bcs.position, rect: r(b), kids: b.children.length },
    htmlKids: Array.prototype.map.call(h.children, function (el) { return el.tagName + '.' + el.className; }).join(' | '),
    bodyKids: Array.prototype.map.call(b.children, function (el) { return el.tagName + '#' + el.id + '.' + el.className; }).join(' | '),
    surprise: { position: scs.position, inset: scs.inset, width: scs.width, rect: r(s), parent: s.parentElement.tagName },
    bg: r(document.querySelector('.bg')),
    stage: r(document.querySelector('.stage')),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    scrollingElement: document.scrollingElement ? document.scrollingElement.tagName : null
  };
})())`;

/* voice-message player probe: geometry, config-driven labels, transport state, the real <audio> */
const PROBE_VOICE = `JSON.stringify((function(){
  var p = document.getElementById('voicePlayer');
  var b = document.getElementById('voiceBtn');
  var bar = document.getElementById('voiceBar');
  var barI = document.querySelector('.voice-bars i');
  var a = document.querySelector('.voice-audio');
  var pb = p.getBoundingClientRect(), bb = b.getBoundingClientRect();
  var barBox = bar.getBoundingClientRect();
  var env = document.getElementById('envelope').getBoundingClientRect();
  var card = document.getElementById('letterCard').getBoundingClientRect();
  var cs = getComputedStyle(p);
  var mid = document.elementFromPoint(Math.round(bb.left + bb.width / 2), Math.round(bb.top + bb.height / 2));
  var num = function (v) { return isFinite(v) ? Math.round(v * 100) / 100 : null; };
  return {
    cls: document.body.className,
    player: { left: Math.round(pb.left), top: Math.round(pb.top), right: Math.round(pb.right), bottom: Math.round(pb.bottom), w: Math.round(pb.width), h: Math.round(pb.height) },
    btn: { left: Math.round(bb.left), right: Math.round(bb.right), top: Math.round(bb.top), bottom: Math.round(bb.bottom), w: Math.round(bb.width), h: Math.round(bb.height) },
    envelope: { top: Math.round(env.top), bottom: Math.round(env.bottom) },
    card: { left: Math.round(card.left), right: Math.round(card.right), top: Math.round(card.top), bottom: Math.round(card.bottom), h: Math.round(card.height) },
    label: document.getElementById('voiceLabel').textContent.trim(),
    status: document.getElementById('voiceStatus').textContent.trim(),
    now: document.getElementById('voiceNow').textContent.trim(),
    total: document.getElementById('voiceTotal').textContent.trim(),
    barW: Math.round(barBox.width),
    fillW: Math.round(document.getElementById('voiceFill').getBoundingClientRect().width),
    pct: bar.getAttribute('aria-valuenow'),
    barRole: bar.getAttribute('role'),
    barName: bar.getAttribute('aria-label'),
    statusLive: document.getElementById('voiceStatus').getAttribute('aria-live'),
    pressed: b.getAttribute('aria-pressed'),
    disabled: b.getAttribute('aria-disabled'),
    describedBy: b.getAttribute('aria-describedby'),
    opacity: parseFloat(cs.opacity),
    pointer: cs.pointerEvents,
    shadow: cs.boxShadow.length,
    isPlaying: p.classList.contains('is-playing'),
    isMissing: p.classList.contains('is-missing'),
    barsAnim: barI ? getComputedStyle(barI).animationName : 'none',
    barsHidden: document.getElementById('voiceBars').getAttribute('aria-hidden'),
    hitBtn: !!(mid && (mid === b || b.contains(mid))),
    hitTag: mid ? mid.tagName + (mid.className ? '.' + String(mid.className) : '') : null,
    audioCount: document.querySelectorAll('audio').length,
    voiceCount: document.querySelectorAll('.voice-audio').length,
    musicCount: document.querySelectorAll('.music-audio').length,
    audio: a ? {
      src: a.getAttribute('src') || '', cls: a.className, preload: a.preload, autoplay: a.autoplay, loop: a.loop,
      readyState: a.readyState, paused: a.paused, ended: a.ended, err: a.error ? a.error.code : null,
      t: num(a.currentTime), dur: num(a.duration),
      seekable: (function () { try { return a.seekable.length ? num(a.seekable.end(0)) : 0; } catch (e) { return -1; } })(),
      attached: p.contains(a)
    } : null,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    bodyW: document.body.scrollWidth,
    vw: window.innerWidth, vh: window.innerHeight
  };
})())`;


/* Everything the music suite needs in one shot: both audio elements, the corner note, and the
   boxes the note must never land on. Reads the elements by class, never "the first <audio>". */
const PROBE_MUSIC = `JSON.stringify((function(){
  var m = document.querySelector('.music-audio');
  var v = document.querySelector('.voice-audio');
  var chip = document.getElementById('musicChip');
  var note = chip.querySelector('.music-note');
  var cb = chip.getBoundingClientRect();
  var cs = getComputedStyle(chip);
  var num = function (x) { return isFinite(x) ? Math.round(x * 1000) / 1000 : null; };
  var box = function (el) { var b = el.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
  var read = function (el) {
    if (!el) return null;
    return {
      src: el.getAttribute('src') || '', cls: el.className, preload: el.preload, autoplay: el.autoplay,
      loop: el.loop, muted: el.muted, vol: num(el.volume), readyState: el.readyState,
      paused: el.paused, ended: el.ended, err: el.error ? el.error.code : null,
      t: num(el.currentTime), dur: num(el.duration),
      seekable: (function () { try { return el.seekable.length ? num(el.seekable.end(0)) : 0; } catch (e) { return -1; } })(),
      inBody: el.parentNode === document.body
    };
  };
  var hit = document.elementFromPoint(Math.round(cb.left + cb.width / 2), Math.round(cb.top + cb.height / 2));
  return {
    cls: document.body.className,
    music: read(m), voice: read(v),
    musicCount: document.querySelectorAll('.music-audio').length,
    voiceCount: document.querySelectorAll('.voice-audio').length,
    audioCount: document.querySelectorAll('audio').length,
    bothPlaying: !!(m && v && !m.paused && !v.paused),
    chip: {
      hidden: chip.hidden, display: cs.display, opacity: parseFloat(cs.opacity), pointer: cs.pointerEvents,
      label: document.getElementById('musicLabel').textContent.trim(),
      paused: chip.classList.contains('is-paused'),
      note: note ? getComputedStyle(note).animationName : 'none',
      rect: { left: Math.round(cb.left), top: Math.round(cb.top), right: Math.round(cb.right), bottom: Math.round(cb.bottom), w: Math.round(cb.width), h: Math.round(cb.height) }
    },
    envTitle: box(document.querySelector('.env-title')),
    card: box(document.getElementById('letterCard')),
    player: box(document.getElementById('voicePlayer')),
    chipHit: hit ? (hit.id || hit.tagName) : null,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    vw: window.innerWidth, vh: window.innerHeight
  };
})())`;

function reporter() {
  const rows = [];
  let suite = "-";
  return {
    suite(name) { suite = name; },
    check(name, ok, detail) {
      const row = { suite, name, ok: !!ok, detail: detail === undefined ? "" : String(detail) };
      rows.push(row);
      console.log("  " + (row.ok ? "PASS" : "FAIL") + "  " + name + (row.detail ? "   [" + row.detail + "]" : ""));
      return row.ok;
    },
    rows
  };
}

/* ------------------------------ artifacts ------------------------------ */
function savePng(outDir, name, b64, check) {
  const buf = Buffer.from(b64, "base64");
  const file = path.join(outDir, name);
  fss.writeFileSync(file, buf);
  const valid = buf.length > 5000 && buf.slice(0, 8).equals(PNG_MAGIC);
  check("artifact " + name + " written", valid, Math.round(buf.length / 1024) + " KB -> " + path.relative(HERE, file));
  return file;
}
/* ============================== suite: state ============================== */
async function suiteState(ctx) {
  const { send, ev, check, shot } = ctx;
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(2000);

  const diag = await ev("[location.protocol, document.readyState, document.querySelectorAll('*').length].join(' | ')");
  check("page loads over http", /^http:/.test(diag) && /complete|interactive/.test(diag), diag);

  /* ---- 1. initial bud ---- */
  const bud = JSON.parse(await ev(PROBE_STATE));
  check("initial state is bud", bud.cls === "bud", "body class = " + bud.cls);
  check("flower structure built", bud.petals >= 12 && bud.sepals >= 4, bud.petals + " petals / " + bud.sepals + " sepals");
  check("background particles present", bud.bokeh > 0 && bud.falling > 0, bud.bokeh + " bokeh / " + bud.falling + " falling");
  check("petals start closed", bud.spread < 0.4, "max |scale| = " + bud.spread);
  check("message hidden in bud state", bud.msgOpacity === 0, "opacity = " + bud.msgOpacity);
  check("hint visible in bud state", bud.hintOpacity > 0.4 && bud.hintText.length > 0, "opacity = " + bud.hintOpacity + " (pulses .45-.9) text = " + JSON.stringify(bud.hintText));
  check("replay button hidden", bud.replayHidden === true);
  check("bud tip at unit scale", /matrix\(1, 0, 0, 1/.test(bud.budtip) || bud.budtip === "none", bud.budtip);
  check("stem stroke covers whole path", bud.dash >= bud.stemLen, "dasharray = " + bud.dash + " / pathLength = " + bud.stemLen);
  check("stem top reaches into the flower head", bud.headOverlap > 0 && bud.headOverlap < 40, "overlap = " + bud.headOverlap + "px");
  bud.leafAttach.forEach(l => check("leaf " + l.leaf + " blade attached to stem (bud)", l.gap !== null && l.gap <= 1, "gap = " + l.gap + "px"));

  /* ---- 2. click to bloom (double click must not double-fire) ---- */
  await ev("document.getElementById('bloom').click(); document.getElementById('bloom').click();");
  await sleep(1200);
  const mid = JSON.parse(await ev(PROBE_STATE));
  check("click starts the bloom", /\bbloomed\b/.test(mid.cls), "body class = " + mid.cls);
  check("double click fires one burst", mid.sparks === 26 && mid.ring === 1, mid.sparks + " sparks / " + mid.ring + " ring");
  check("message stays hidden while blooming", mid.msgOpacity === 0, "opacity = " + mid.msgOpacity);
  check("replay stays hidden while blooming", mid.replayHidden === true);
  check("petals are opening", mid.spread > bud.spread * 1.5, bud.spread + " -> " + mid.spread);

  /* ---- 3. settled bloom ---- */
  await sleep(2800);
  const after = JSON.parse(await ev(PROBE_STATE));
  check("bloom completes", /\bbloomed\b/.test(after.cls) && /\bdone\b/.test(after.cls), "body class = " + after.cls);
  check("petals fully open", after.spread > 0.8, "max |scale| = " + after.spread);
  check("message revealed", after.msgOpacity > 0.9, "opacity = " + after.msgOpacity);
  check("message unblurred", blurPx(after.msgFilter) < 1, after.msgFilter + " = " + blurPx(after.msgFilter) + "px blur");
  check("replay revealed", after.replayHidden === false && after.replayOpacity > 0.5, "opacity = " + after.replayOpacity);
  check("hint faded out", after.hintOpacity < 0.1, "opacity = " + after.hintOpacity);
  check("leaf blades attached after bloom", after.leafAttach.every(l => l.gap !== null && l.gap <= 1), JSON.stringify(after.leafAttach));

  /* ---- 4. bloomed screenshots ---- */
  await ev("document.getElementById('bloom').click()");
  await ctx.go(1280, 860, 1, false);
  await sleep(3800);
  await shot("state-desktop.png");
  await ctx.go(390, 844, 2, true);
  await sleep(700);
  await shot("state-mobile.png");
  check("no h-overflow at 390px", (await ev("document.documentElement.scrollWidth <= window.innerWidth")) === true,
    (await ev("document.documentElement.scrollWidth + ' / ' + window.innerWidth")));

  /* ---- 5. "Bloom Again" opens the surprise, Escape closes it ---- */
  await ev("document.getElementById('replay').click()");
  await sleep(500);
  const openedCls = await ev("document.body.className");
  check("'Bloom Again' opens the envelope screen", /\benvelope\b/.test(openedCls), "body class = " + openedCls);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(1600);
  const closedCls = await ev("document.body.className");
  check("Escape closes the surprise", !/\benvelope\b/.test(closedCls), "body class = " + closedCls);
  check("the overlay is hidden again", (await ev("document.getElementById('surprise').hidden")) === true);
  check("the message comes back after closing", blurPx(await ev("getComputedStyle(document.querySelector('.message')).filter")) < 1,
    await ev("getComputedStyle(document.querySelector('.message')).filter"));
  check("'Bloom Again' comes back after closing", (await ev("parseFloat(getComputedStyle(document.getElementById('replay')).opacity)")) > .5,
    "opacity = " + await ev("parseFloat(getComputedStyle(document.getElementById('replay')).opacity)"));
  check("the flower region is focusable again", (await ev("document.querySelector('.stage').hasAttribute('aria-hidden')")) === false);

  /* ---- 6. a fresh load still starts on the closed bud ---- */
  await ctx.navigate(2200);
  const reset = JSON.parse(await ev(PROBE_STATE));
  await shot("state-bud.png");
  check("a fresh load shows the bud again", reset.spread < 0.4 && reset.msgOpacity === 0, "max |scale| = " + reset.spread + ", message opacity = " + reset.msgOpacity);
  check("bud keeps the message blurred", blurPx(reset.msgFilter) >= 8, reset.msgFilter);
  check("bud keeps the hint visible", reset.hintOpacity > 0.4, "opacity = " + reset.hintOpacity + " (pulses .45-.9)");
  check("bud restores the bud tip", /matrix\(1, 0, 0, 1/.test(reset.budtip) || reset.budtip === "none", reset.budtip);
  check("stem/head overlap after reload", reset.headOverlap > 0, "overlap = " + reset.headOverlap + "px");
  check("leaf blades attached after reload", reset.leafAttach.every(l => l.gap !== null && l.gap <= 1), JSON.stringify(reset.leafAttach));
  check("a fresh load matches the first load", reset.spread === bud.spread, "reload " + reset.spread + " vs load " + bud.spread);

  return { bud, mid, after, reset };
}
/* ============================== suite: zoom ============================== */
async function suiteZoom(ctx) {
  const { ev, check } = ctx;
  await ctx.go(1280, 900, 3, false);
  await ctx.navigate(2200);
  // freeze animations so the crops are deterministic
  await ev("document.querySelectorAll('.leaf,.flower-btn,svg#flower').forEach(function(e){e.style.animation='none'})");
  check("animations frozen for crops", (await ev("getComputedStyle(document.querySelector('.leaf')).animationName")) === "none");

  const R = JSON.parse(await ev(`JSON.stringify((function(){
    var r = function(el){ var b = el.getBoundingClientRect(); return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}; };
    var leafG = document.querySelectorAll('.leaf');
    var blade = function (g) { return r(g.querySelector('path') || g); };   /* blade, not the hairline vein */
    return { stem: r(document.querySelector('.stem')), left: blade(leafG[0]), right: blade(leafG[1]) };
  })())`));
  check("left leaf blade crosses into the stem", R.left.r > R.stem.l + 1, "leaf right = " + R.left.r.toFixed(1) + " / stem left = " + R.stem.l.toFixed(1));
  check("right leaf blade crosses into the stem", R.right.l < R.stem.r - 1, "leaf left = " + R.right.l.toFixed(1) + " / stem right = " + R.stem.r.toFixed(1));

  for (const name of ["left", "right"]) {
    const c = name === "left" ? R.left : R.right;
    const clip = { x: Math.round(name === "left" ? c.r - 34 : c.l - 34), y: Math.round(c.t + c.h / 2 - 30), width: 68, height: 60, scale: 6 };
    const inView = clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= 1280 && clip.y + clip.height <= 900;
    check("18x " + name + " leaf/stem crop fits the viewport", inView, JSON.stringify(clip));
    const r = await ctx.send("Page.captureScreenshot", { format: "png", clip });
    savePng(ctx.out, "zoom-leaf-" + name + ".png", r.data, check);
    console.log("       clip[" + name + "] = " + JSON.stringify(clip) + "  -> " + (clip.width * clip.scale * 3) + "px wide png");
  }

  const HC = JSON.parse(await ev(`JSON.stringify((function(){
    var tip = document.querySelector('.budtip').getBoundingClientRect();
    var sb = document.querySelector('.stem').getBoundingClientRect();
    var sepsBottom = 0, sepsTop = 1e9;
    document.querySelectorAll('.sepal').forEach(function(s){
      var b = s.getBoundingClientRect();
      if (b.bottom > sepsBottom) sepsBottom = b.bottom;
      if (b.top < sepsTop) sepsTop = b.top;
    });
    var bottom = Math.max(tip.bottom, sb.top + 4, sepsBottom);
    return {
      x: Math.round(sb.left + sb.width / 2 - 30), y: Math.round(bottom - 42), width: 60, height: 62, scale: 6,
      sepsTop: Math.round(sepsTop), sepsBottom: Math.round(sepsBottom),
      stemTop: Math.round(sb.top), tipBottom: Math.round(tip.bottom)
    };
  })())`));
  check("sepal collar reaches below the stem top", HC.sepsBottom > HC.stemTop, "sepal bottom = " + HC.sepsBottom + " / stem top = " + HC.stemTop);
  check("bud tip sits inside the sepal collar", HC.tipBottom > HC.sepsTop && HC.tipBottom < HC.sepsBottom + 20, "tip bottom = " + HC.tipBottom + " in [" + HC.sepsTop + ", " + HC.sepsBottom + "]");
  check("18x head crop fits the viewport", HC.x >= 0 && HC.y >= 0 && HC.x + HC.width <= 1280 && HC.y + HC.height <= 900, JSON.stringify(HC));
  const hs = await ctx.send("Page.captureScreenshot", { format: "png", clip: { x: HC.x, y: HC.y, width: HC.width, height: HC.height, scale: HC.scale } });
  savePng(ctx.out, "zoom-head.png", hs.data, check);
  return { rects: R, head: HC };
}

/* ============================ suite: surprise ============================ */
async function suiteSurprise(ctx) {
  const { send, ev, check } = ctx;
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(2000);

  const CFG = JSON.parse(await ev("JSON.stringify(window.LETTER)"));
  const keys = ["bloomAgainLabel", "envelopeTitle", "tapHint", "heading", "wish", "closing", "signature", "finale"];
  check("the LETTER config is complete", !!CFG && CFG.paragraphs && CFG.paragraphs.length >= 5 && keys.every(k => typeof CFG[k] === "string" && CFG[k].length > 0),
    (CFG && CFG.paragraphs ? CFG.paragraphs.length : 0) + " paragraphs; keys " + Object.keys(CFG || {}).join(", "));
  check("'Bloom Again' is hidden before the bloom", (await ev("document.getElementById('replay').hidden")) === true);
  check("the surprise overlay starts hidden", (await ev("document.getElementById('surprise').hidden")) === true);

  /* ---- bloom first, then the button ---- */
  await ev("document.getElementById('bloom').click()");
  await sleep(4300);
  const label = await ev("document.getElementById('replay').textContent.trim()");
  const labelOpacity = await ev("parseFloat(getComputedStyle(document.getElementById('replay')).opacity)");
  check("button label comes from the config", label === CFG.bloomAgainLabel, JSON.stringify(label));
  check("button is visible once the bloom is done", labelOpacity > .5, "opacity = " + labelOpacity);

  /* ---- envelope screen ---- */
  await ev("document.getElementById('replay').click()");
  await sleep(1500);
  const env = JSON.parse(await ev(PROBE_ENVELOPE));
  const dom = JSON.parse(await ev(PROBE_DIAG));
  check("the overlay leaves the page layout untouched",
    parseInt(dom.body.width, 10) === dom.innerW && dom.body.position === "static" && dom.body.transform === "none" && dom.body.filter === "none" &&
    dom.html.transform === "none" && dom.html.width === dom.innerW + "px" && dom.bg.indexOf("0,0 ") === 0,
    "body " + dom.body.width + " (" + dom.body.position + ", filter " + dom.body.filter + "), html " + dom.html.width + ", bg box " + dom.bg);
  check("envelope screen opens", /\benvelope\b/.test(env.cls), "body class = " + env.cls);
  check("overlay covers the viewport", env.overlay.w >= env.vw - 2 && env.overlay.h >= env.vh - 2, env.overlay.w + "x" + env.overlay.h);
  check("envelope reads as real paper (3:2)", env.ratio > 1.42 && env.ratio < 1.58, "ratio = " + env.ratio + " (" + env.envelopeW + "x" + env.envelopeH + ")");
  check("envelope is a comfortable touch target", env.envelopeW >= 200 && env.envelopeH >= 130, env.envelopeW + "x" + env.envelopeH + "px");
  check("title + hint come from the config", env.title === CFG.envelopeTitle && env.hint === CFG.tapHint, JSON.stringify(env.title) + " / " + JSON.stringify(env.hint));
  check("the first message is dismissed", env.msgOpacity < .1, "opacity = " + env.msgOpacity);
  check("flower stays visible but softened", env.flowerBlur > 1 && env.flowerOpacity < .7, "blur " + env.flowerBlur + "px, opacity " + env.flowerOpacity);
  check("hearts + petals float around the envelope", env.floaters >= 4, env.floaters + " floaters");
  check("no horizontal overflow with the overlay open", env.overflowX === false, "scrollWidth = " + env.scrollWidth);
  check("envelope takes focus for keyboard users", env.focus === "envelope", "focus = " + env.focus);
  await ctx.shot("state-envelope.png");

  /* ---- guard: only the envelope may open the letter ---- */
  await ev("document.querySelector('.veil').click(); document.getElementById('envTitle').click(); document.getElementById('envHint').click();");
  await sleep(400);
  const guardCls = await ev("document.body.className");
  check("nothing but the envelope opens the letter", !/\bletter\b/.test(guardCls), "body class = " + guardCls);
  /* ---- opening choreography ---- */
  const before = JSON.parse(await ev(PROBE_OPEN));
  await ev("document.getElementById('envelope').click(); document.getElementById('envelope').click();");
  await sleep(800);
  const opening = JSON.parse(await ev(PROBE_OPEN));
  check("a double tap still opens just once", /\bopening\b/.test(opening.cls) && !/\bletter\b/.test(opening.cls), "body class = " + opening.cls);
  check("the heart seal opens first", opening.seal < .25, "seal opacity = " + opening.seal);
  check("the top flap rotates up", opening.flap !== before.flap, before.flap + " -> " + opening.flap);
  check("the envelope leans toward her", opening.envelope !== before.envelope, before.envelope + " -> " + opening.envelope);
  await ctx.shot("state-envelope-opening.png");
  await sleep(900);
  const out = JSON.parse(await ev(PROBE_OPEN));
  check("the letter sheet slides out of the pocket", out.sheet !== opening.sheet, opening.sheet + " -> " + out.sheet);
  await ctx.shot("state-envelope-out.png");
  await sleep(1600);
  const L = JSON.parse(await ev(PROBE_LETTER));
  check("the letter view is reached", /\bletter\b/.test(L.cls), "body class = " + L.cls);
  check("every paragraph is rendered from the config", L.paraCount === CFG.paragraphs.length, L.paraCount + " of " + CFG.paragraphs.length);
  check("heading / wish / signature / finale match the config",
    L.heading === CFG.heading && L.wish === CFG.wish && L.sign === CFG.signature && L.finale === CFG.finale,
    JSON.stringify([L.heading, L.wish, L.sign, L.finale]));
  check("paragraph text matches the config", L.firstPara === CFG.paragraphs[0] && L.lastPara === CFG.paragraphs[CFG.paragraphs.length - 1], JSON.stringify(L.lastPara));
  check("the finale closes the letter", L.lastClass === "letter-finale", L.lastClass);
  check("the letter text has faded in", L.firstOpacity > .9, "first line opacity = " + L.firstOpacity);
  check("the letter fits the viewport", L.card.left >= 0 && L.card.right <= L.vw + 1 && L.card.height <= L.vh, JSON.stringify(L.card) + " inside " + L.vw + "x" + L.vh);
  check("only the letter body scrolls", L.overflowY === "auto" && L.pageOverflowX === false && L.scrollWidth <= L.clientWidth + 1,
    "overflow-y " + L.overflowY + ", scroll " + L.scrollHeight + "/" + L.clientHeight + ", page overflow " + L.pageOverflowX);
  check("the letter scrolls on a desktop screen", L.scrollable === true, L.scrollHeight + " > " + L.clientHeight);
  check("close control is a 44px target", L.closeSize >= 44 && L.closeOpacity > .5, L.closeSize + "px at opacity " + L.closeOpacity);
  await ctx.shot("state-letter.png");
  await ev("document.getElementById('letterScroll').scrollTop = 99999");
  await sleep(500);
  await ctx.shot("state-letter-end.png");

  /* ---- close and open it again ---- */
  await ev("document.getElementById('letterClose').click()");
  await sleep(1000);
  const closed = await ev("document.body.className");
  check("closing returns to the bloomed flower", /\bdone\b/.test(closed) && !/\benvelope\b/.test(closed), "body class = " + closed);
  check("the overlay is hidden after closing", (await ev("document.getElementById('surprise').hidden")) === true);
  await ev("document.getElementById('replay').click()");
  await sleep(800);
  const againCls = await ev("document.body.className");
  check("the surprise can be opened again", /\benvelope\b/.test(againCls), "body class = " + againCls);

  /* ---- phone pass: close, resize, then open again at phone width ---- */
  await ctx.go(390, 844, 2, true);
  await sleep(500);
  await ev("document.getElementById('letterClose').click()");
  await sleep(1100);
  await ev("document.getElementById('replay').click()");
  await sleep(1400);
  const e2 = JSON.parse(await ev(PROBE_ENVELOPE));
  check("the envelope fits a 390px phone", e2.envelopeW <= 320 && e2.envTop >= 0 && e2.envBottom <= e2.vh && e2.overflowX === false,
    e2.envelopeW + "px wide, " + e2.envTop + ".." + e2.envBottom + " of " + e2.vh);
  check("fewer floaters on a phone", e2.floaters <= 7 && e2.floaters >= 3, e2.floaters + " floaters");
  await ctx.shot("state-envelope-mobile.png");
  await ev("document.getElementById('envelope').click()");
  await sleep(3600);
  const L2 = JSON.parse(await ev(PROBE_LETTER));
  check("the letter fits a 390px phone", L2.card.left >= 8 && L2.card.right <= L2.vw - 8 && L2.card.height <= L2.vh - 8,
    JSON.stringify(L2.card) + " inside " + L2.vw + "x" + L2.vh);
  check("the letter scrolls on a phone", L2.scrollable === true && L2.pageOverflowX === false, L2.scrollHeight + " > " + L2.clientHeight);
  await ctx.shot("state-letter-mobile.png");

  /* ---- reduced motion: shorter, but every word must still be readable ---- */
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(1200);
  await ev("document.getElementById('bloom').click()");
  await sleep(4300);
  await ev("document.getElementById('replay').click()");
  await sleep(700);
  const rOpen = JSON.parse(await ev(PROBE_ENVELOPE));
  check("reduced motion still opens the envelope", /\benvelope\b/.test(rOpen.cls) && rOpen.overlay.w >= rOpen.vw - 2 && rOpen.envelopeW >= 200,
    "body class = " + rOpen.cls + ", overlay " + rOpen.overlay.w + "x" + rOpen.overlay.h + ", envelope " + rOpen.envelopeW + "px");
  await ev("document.getElementById('envelope').click()");
  await sleep(1600);
  const rLetter = JSON.parse(await ev(PROBE_LETTER));
  check("reduced motion still reaches the letter", /\bletter\b/.test(rLetter.cls), "body class = " + rLetter.cls);
  check("reduced motion keeps every line visible", rLetter.firstOpacity > .9 && rLetter.closeOpacity > .5 && rLetter.paraCount === CFG.paragraphs.length,
    "first line opacity " + rLetter.firstOpacity + ", close " + rLetter.closeOpacity + ", " + rLetter.paraCount + " paragraphs");
  await send("Emulation.setEmulatedMedia", { features: [] });
  return { env, opening, out, letter: L, mobile: { env: e2, letter: L2 }, reduced: rLetter };
}

/* ============================== suite: voice ============================== */
/* The voice message: config-driven labels, a real trusted tap on the button, play ->
   pause -> resume -> end, progress + clock, visualizer, letter-view fit, phone fit,
   reduced motion, and what happens when the mp3 has not been uploaded yet. */
async function suiteVoice(ctx) {
  const { send, ev, check, tap } = ctx;
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(1600);

  /* ---- the destination + the file itself (checked on disk, not just in the DOM) ---- */
  const CFG = JSON.parse(await ev("JSON.stringify(window.LETTER)"));
  const V = CFG.voice || {};
  const src = await ev("typeof window.VOICE_MESSAGE_AUDIO === 'string' ? window.VOICE_MESSAGE_AUDIO : null");
  check("the voice message has one named destination", typeof src === "string" && /\/[^/]+\.mp3$/i.test(src), JSON.stringify(src));
  const abs = src ? path.resolve(HERE, src) : path.join(HERE, "public/audio/ken-voice-message.mp3");
  const bytes = fss.existsSync(abs) ? fss.statSync(abs).size : 0;
  check("that file exists where the config points", bytes > 4096, bytes + " bytes at " + path.relative(HERE, abs));
  const vkeys = ["label", "playingLabel", "pausedLabel", "statusIdle", "statusPlaying", "caption", "statusPaused", "statusEnded", "statusMissing"];
  check("every voice string comes from the config", vkeys.every(k => typeof V[k] === "string" && V[k].length > 0), Object.keys(V).join(", "));
  check("the button starts on the configured call to action", (await ev("document.getElementById('voiceLabel').textContent.trim()")) === V.label, JSON.stringify(V.label));

  /* ---- with the envelope on screen the button must sit under it ---- */
  await ev("document.getElementById('bloom').click()");
  await sleep(4300);
  await ev("document.getElementById('replay').click()");
  await sleep(1600);
  const v = JSON.parse(await ev(PROBE_VOICE));
  console.log("       player " + v.player.w + "x" + v.player.h + " at y" + v.player.top + "  envelope bottom " + v.envelope.bottom +
    "  audio " + (v.audio ? (v.audio.dur + "s, readyState " + v.audio.readyState + ", seekable " + v.audio.seekable) : "none"));
  check("the voice player appears with the envelope screen", v.opacity > .9 && v.pointer === "auto", "opacity " + v.opacity + ", pointer-events " + v.pointer);
  check("the button sits below the envelope", v.player.top >= v.envelope.bottom + 2, "player top " + v.player.top + " vs envelope bottom " + v.envelope.bottom);
  check("the button is a comfortable touch target", v.btn.h >= 44 && v.btn.w >= 44, v.btn.w + "x" + v.btn.h + "px");
  check("the label is the call to action before any tap", v.label === V.label, JSON.stringify(v.label));
  check("the status line invites her in", v.status === V.statusIdle && v.statusLive === "polite", JSON.stringify(v.status) + " / aria-live " + v.statusLive);
  check("the progress bar is a labelled progressbar", v.barRole === "progressbar" && !!v.barName && v.pct === "0", v.barRole + ", " + JSON.stringify(v.barName) + ", now " + v.pct);
  check("the visualizer is still until she taps", v.barsAnim === "none" && v.isPlaying === false, "animation " + v.barsAnim);
  check("the visualizer is decoration only", v.barsHidden === "true", "aria-hidden = " + v.barsHidden);
  check("one attached voice element plus one separate music element, never autoplaying",
    v.audioCount === 2 && v.voiceCount === 1 && v.musicCount === 1 && !!v.audio && v.audio.attached === true && v.audio.paused === true && v.audio.autoplay === false && v.audio.loop === false,
    v.audioCount + " element(s) = " + v.voiceCount + " voice + " + v.musicCount + " music, " + JSON.stringify(v.audio && [v.audio.paused, v.audio.autoplay, v.audio.loop, v.audio.preload]));
  check("the length of the message is known up front", !!v.audio && v.audio.dur > 1 && v.audio.dur < 3600 && v.audio.seekable > 0,
    "duration " + (v.audio && v.audio.dur) + "s, seekable " + (v.audio && v.audio.seekable));
  check("the total time renders before playing", /^\d+:\d\d$/.test(v.total) && v.now === "0:00", v.now + " / " + v.total);
  check("no horizontal overflow with the player on screen", v.overflowX === false, "scrollWidth " + v.scrollW + " vs " + v.vw);
  await ctx.shot("state-voice.png");

  /* ---- a real tap starts the message ---- */
  await tap("#voiceBtn");
  await sleep(280);
  const p0 = JSON.parse(await ev(PROBE_VOICE));
  check("a real tap starts the audio", !!p0.audio && p0.audio.paused === false && p0.audio.t >= 0, "paused " + (p0.audio && p0.audio.paused) + ", t " + (p0.audio && p0.audio.t));
  check("the button turns into the pause control", p0.label === V.playingLabel && p0.pressed === "true", JSON.stringify(p0.label) + " / aria-pressed " + p0.pressed);
  check("the status says Ken's message is playing", p0.status === V.statusPlaying, JSON.stringify(p0.status));
  check("the visualizer comes alive", p0.barsAnim === "voiceBar" && p0.isPlaying === true, "animation " + p0.barsAnim);
  await ctx.shot("state-voice-playing.png");

  await sleep(2200);
  const p1 = JSON.parse(await ev(PROBE_VOICE));
  check("the clock advances while playing", p1.audio.t > p0.audio.t + .5, p0.audio.t + " -> " + p1.audio.t + "s");
  check("the progress fill grows with it", p1.fillW > p0.fillW && Number(p1.pct) > 0 && Number(p1.pct) <= 100,
    p0.fillW + " -> " + p1.fillW + "px of " + p1.barW + " (" + p1.pct + "%)");
  check("the status settles into the caption", p1.status === V.caption, JSON.stringify(p1.status));
  check("the time reads like a clock", /^\d+:\d\d$/.test(p1.now) && /^\d+:\d\d$/.test(p1.total), p1.now + " / " + p1.total);

  /* ---- pause keeps her place ---- */
  await tap("#voiceBtn");
  await sleep(400);
  const pz = JSON.parse(await ev(PROBE_VOICE));
  const held = pz.audio ? pz.audio.t : 0;
  check("tapping again pauses", pz.audio.paused === true && pz.isPlaying === false, "paused " + pz.audio.paused);
  check("the button offers resume", pz.label === V.pausedLabel && pz.pressed === "false", JSON.stringify(pz.label));
  check("the status owns up to the pause", pz.status === V.statusPaused, JSON.stringify(pz.status));
  check("the visualizer stops with the sound", pz.barsAnim === "none", "animation " + pz.barsAnim);
  check("the position is kept when paused", held > .3, "stopped at " + held + "s");
  await sleep(800);
  const pz2 = JSON.parse(await ev(PROBE_VOICE));
  check("paused really means paused", pz2.audio.t > 0 && Math.abs(pz2.audio.t - held) < .3, held + " -> " + pz2.audio.t + "s");

  /* ---- resume ---- */
  await tap("#voiceBtn");
  await sleep(900);
  const pr = JSON.parse(await ev(PROBE_VOICE));
  check("resuming carries on from where she stopped", pr.audio.paused === false && pr.audio.t > held, held + " -> " + pr.audio.t + "s");
  check("the visualizer is alive again", pr.barsAnim === "voiceBar", "animation " + pr.barsAnim);

  /* ---- the letter view: the message keeps playing, the card must not cover the button ---- */
  await ev("document.getElementById('envelope').click()");
  await sleep(2000);
  const vl = JSON.parse(await ev(PROBE_VOICE));
  check("the message keeps playing while the envelope opens", vl.audio.paused === false && vl.audio.ended === false, "t = " + vl.audio.t + "s of " + vl.audio.dur);
  await sleep(1800);
  const vt = JSON.parse(await ev(PROBE_VOICE));
  check("the letter view is reached", /\bletter\b/.test(vt.cls), "body class = " + vt.cls);
  check("the voice player is still there over the letter", vt.opacity > .9 && vt.pointer === "auto", "opacity " + vt.opacity + ", pointer-events " + vt.pointer);
  check("the letter card never covers the voice button", vt.card.bottom <= vt.player.top, "card bottom " + vt.card.bottom + " vs player top " + vt.player.top);
  check("the voice button is the top element there", vt.hitBtn === true, "elementFromPoint -> " + vt.hitTag);
  check("the letter view has no horizontal overflow", vt.overflowX === false, "scrollWidth " + vt.scrollW + " vs " + vt.vw);
  await ctx.shot("state-voice-letter.png");

  /* ---- the end of the message (seek near the tail, then let the real 'ended' fire) ---- */
  await ev("(function(){var a=document.querySelector('.voice-audio');a.currentTime=Math.max(0,a.duration-0.4);})()");
  await sleep(1600);
  const ve = JSON.parse(await ev(PROBE_VOICE));
  check("the message ends on its own", ve.audio.ended === true && ve.audio.paused === true, "ended " + ve.audio.ended + " at " + ve.audio.t + "s");
  check("the button goes back to the call to action", ve.label === V.label && ve.pressed === "false", JSON.stringify(ve.label));
  check("the status says the message is over", ve.status === V.statusEnded, JSON.stringify(ve.status));
  check("it does not loop", ve.audio.loop === false, "loop " + ve.audio.loop);
  await sleep(900);
  const ve2 = JSON.parse(await ev(PROBE_VOICE));
  check("nothing restarts by itself", ve2.audio.paused === true && ve2.audio.t >= ve.audio.t - .05, ve.audio.t + " -> " + ve2.audio.t + "s");
  await tap("#voiceBtn");
  await sleep(700);
  const vr = JSON.parse(await ev(PROBE_VOICE));
  check("tapping again replays from the top", vr.audio.paused === false && vr.audio.t < ve.audio.t, ve.audio.t + " -> " + vr.audio.t + "s");

  /* ---- closing the surprise silences it, and keeps exactly one player ---- */
  await ev("document.getElementById('letterClose').click()");
  await sleep(1100);
  const vc = JSON.parse(await ev(PROBE_VOICE));
  check("closing the surprise stops the message", vc.audio.paused === true, "paused " + vc.audio.paused + ", t " + vc.audio.t);
  check("closing leaves exactly one voice element and one music element",
    vc.audioCount === 2 && vc.voiceCount === 1 && vc.musicCount === 1 && vc.audio.attached === true,
    vc.audioCount + " element(s) = " + vc.voiceCount + " voice + " + vc.musicCount + " music, attached " + vc.audio.attached);
  await ev("document.getElementById('replay').click()");
  await sleep(1300);
  const vo = JSON.parse(await ev(PROBE_VOICE));
  check("reopening reuses the same player and does not restart it",
    vo.audioCount === 2 && vo.voiceCount === 1 && vo.musicCount === 1 && vo.opacity > .9 && vo.audio.paused === true && vo.label === V.pausedLabel,
    vo.audioCount + " element(s) = " + vo.voiceCount + " voice + " + vo.musicCount + " music, paused " + vo.audio.paused + ", label " + JSON.stringify(vo.label));

  /* ---- phone (390x844) ---- */
  await ctx.go(390, 844, 2, true);
  await sleep(700);
  const vm = JSON.parse(await ev(PROBE_VOICE));
  check("the player fits a 390px phone", vm.player.left >= 0 && vm.player.right <= vm.vw && vm.player.bottom <= vm.vh && vm.overflowX === false,
    JSON.stringify(vm.player) + " inside " + vm.vw + "x" + vm.vh);
  check("the button is still below the envelope on a phone", vm.player.top >= vm.envelope.bottom, "player top " + vm.player.top + " vs envelope bottom " + vm.envelope.bottom);
  check("the button is still a 44px target on a phone", vm.btn.h >= 44 && vm.btn.w >= 44, vm.btn.w + "x" + vm.btn.h + "px");
  await ctx.shot("state-voice-mobile.png");
  await tap("#voiceBtn");
  await sleep(900);
  const vmp = JSON.parse(await ev(PROBE_VOICE));
  check("the message plays on a phone", vmp.audio.paused === false && vmp.overflowX === false, "t = " + vmp.audio.t + "s, overflow " + vmp.overflowX);
  await ev("document.getElementById('envelope').click()");
  await sleep(3600);
  const vml = JSON.parse(await ev(PROBE_VOICE));
  check("the phone letter leaves room for the voice button", vml.card.bottom <= vml.player.top, "card bottom " + vml.card.bottom + " vs player top " + vml.player.top);
  check("the phone letter stays inside the screen", vml.card.left >= 0 && vml.card.right <= vml.vw && vml.card.top >= 0 && vml.overflowX === false,
    JSON.stringify(vml.card) + " inside " + vml.vw + "x" + vml.vh + ", scrollWidth " + vml.scrollW + " / body " + vml.bodyW);
  await ctx.shot("state-voice-letter-mobile.png");

  /* ---- small phone (320x568): the tightest viewport in the sweep ---- */
  await ctx.go(320, 568, 2, true);
  await sleep(700);
  await ev("document.getElementById('letterClose').click()");
  await sleep(1300);
  await ev("document.getElementById('replay').click()");
  await sleep(1600);
  const vs = JSON.parse(await ev(PROBE_VOICE));
  check("the player fits a 320x568 phone", vs.player.left >= 0 && vs.player.right <= vs.vw && vs.player.bottom <= vs.vh && vs.overflowX === false,
    JSON.stringify(vs.player) + " inside " + vs.vw + "x" + vs.vh);
  check("nothing collides on a 320x568 phone", vs.player.top >= vs.envelope.bottom && vs.status.length > 0 && vs.btn.h >= 44,
    "player top " + vs.player.top + " vs envelope bottom " + vs.envelope.bottom + ", " + vs.btn.w + "x" + vs.btn.h);
  await ctx.shot("state-voice-small.png");
  await ev("document.getElementById('envelope').click()");
  await sleep(3600);
  const vsl = JSON.parse(await ev(PROBE_VOICE));
  check("the letter still fits above the player on a small phone", vsl.card.bottom <= vsl.player.top && vsl.card.top >= 0,
    "card " + vsl.card.top + ".." + vsl.card.bottom + " vs player top " + vsl.player.top);

  /* ---- the recording is not uploaded yet: still kind, still tappable, no crash ----
     A real 404 would also drag a network-error line into the console, so the missing file is
     simulated by dispatching the same 'error' event the decoder raises, on a fresh page. */
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(1600);
  await ev("document.getElementById('bloom').click()");
  await sleep(4300);
  await ev("document.getElementById('replay').click()");
  await sleep(1600);
  await ev("document.querySelector('.voice-audio').dispatchEvent(new Event('error'))");
  await sleep(350);
  const vx = JSON.parse(await ev(PROBE_VOICE));
  check("a missing file shows the gentle note", vx.isMissing === true && vx.status === V.statusMissing, JSON.stringify(vx.status));
  check("the button survives a missing file", vx.opacity > .9 && vx.btn.h >= 44 && vx.label === V.label,
    vx.btn.w + "x" + vx.btn.h + ", " + JSON.stringify(vx.label) + ", disabled " + vx.disabled);
  check("the clock shows no invented length", vx.total === "--:--" && vx.pct === "0" && vx.now === "0:00", vx.now + " / " + vx.total + " (" + vx.pct + "%)");
  check("the visualizer goes quiet instead of pretending", vx.barsAnim === "none", "animation " + vx.barsAnim);
  await ctx.shot("state-voice-missing.png");
  await tap("#voiceBtn");
  await sleep(600);
  const vx2 = JSON.parse(await ev(PROBE_VOICE));
  check("tapping a missing message is harmless", vx2.isMissing === true && vx2.audio.paused === true && vx2.label === V.label && vx2.status === V.statusMissing,
    JSON.stringify(vx2.label) + " / " + JSON.stringify(vx2.status));

  /* ---- reduced motion: calmer, but everything still works ---- */
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(1600);
  await ev("document.getElementById('bloom').click()");
  await sleep(4300);
  await ev("document.getElementById('replay').click()");
  await sleep(900);
  const vrm = JSON.parse(await ev(PROBE_VOICE));
  check("reduced motion still shows the voice button", vrm.opacity > .9 && vrm.btn.h >= 44, "opacity " + vrm.opacity + ", " + vrm.btn.w + "x" + vrm.btn.h);
  await tap("#voiceBtn");
  await sleep(1000);
  const vrp = JSON.parse(await ev(PROBE_VOICE));
  check("reduced motion still plays the message", vrp.audio.paused === false && vrp.audio.t > .2, "t = " + vrp.audio.t + "s");
  check("reduced motion calms the visualizer", vrp.barsAnim === "none", "animation " + vrp.barsAnim);
  check("reduced motion keeps the clock and the bar working", /^\d+:\d\d$/.test(vrp.now) && /^\d+:\d\d$/.test(vrp.total) && Number(vrp.pct) >= 0,
    vrp.now + " / " + vrp.total + " at " + vrp.pct + "%");
  await ctx.shot("state-voice-reduced.png");
  await send("Emulation.setEmulatedMedia", { features: [] });
  return { envelope: v, playing: p1, paused: pz, resumed: pr, letter: vt, ended: ve, replay: vr, phone: vm, small: vs, missing: vx, reduced: vrp };
}

/* ============================== suite: music ============================== */
/* The background music: config + file on disk, nothing before the flower tap, the tap starts it,
   it plays over the envelope and the letter, it steps aside at the exact second for Ken's voice
   message, comes back at that same second when the message ends (never from 0), loops instead of
   stopping, survives a second VM run, never plays at the same time as the voice, and stays quiet
   and kind when the mp3 is missing. */
async function suiteMusic(ctx) {
  const { send, ev, check, tap } = ctx;
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(1800);

  /* ---- the destination + the file itself (checked on disk, not just in the DOM) ---- */
  const CFG = JSON.parse(await ev("JSON.stringify(window.LETTER)"));
  const M = CFG.music || {};
  const src = await ev("typeof window.BACKGROUND_MUSIC === 'string' ? window.BACKGROUND_MUSIC : null");
  check("the background music has one named destination", typeof src === "string" && /\/background-music\.mp3$/i.test(src), JSON.stringify(src));
  const abs = src ? path.resolve(HERE, src) : path.join(HERE, "public/audio/background-music.mp3");
  const bytes = fss.existsSync(abs) ? fss.statSync(abs).size : 0;
  check("that file exists where the config points", bytes > 4096, bytes + " bytes at " + path.relative(HERE, abs));
  const vol = await ev("Number(window.BACKGROUND_MUSIC_VOLUME)");
  check("the volume is soft by default", isFinite(vol) && vol >= .2 && vol <= .3, "BACKGROUND_MUSIC_VOLUME = " + vol);
  check("both corner labels come from the config",
    typeof M.playingLabel === "string" && M.playingLabel.length > 0 && typeof M.pausedLabel === "string" && M.pausedLabel.length > 0,
    JSON.stringify(M));

  /* ---- before the tap: two separate elements, both silent, the note hidden ---- */
  const pre = JSON.parse(await ev(PROBE_MUSIC));
  check("two separate audio elements, one per source",
    pre.audioCount === 2 && pre.musicCount === 1 && pre.voiceCount === 1 && !!pre.music && !!pre.voice && pre.music.src !== pre.voice.src,
    pre.audioCount + " element(s): music " + JSON.stringify(pre.music && pre.music.src) + " vs voice " + JSON.stringify(pre.voice && pre.voice.src));
  check("nothing plays before the flower is tapped",
    !!pre.music && pre.music.paused === true && pre.music.autoplay === false && pre.music.t === 0 && pre.voice.paused === true,
    "music paused " + (pre.music && pre.music.paused) + ", autoplay " + (pre.music && pre.music.autoplay) + ", t " + (pre.music && pre.music.t));
  check("the music is built to loop at the soft volume", pre.music.loop === true && pre.music.vol === vol, "loop " + pre.music.loop + ", volume " + pre.music.vol);
  check("the music file really decodes", pre.music.dur > 1 && pre.music.seekable > 0 && pre.music.err === null,
    "duration " + pre.music.dur + "s, seekable " + pre.music.seekable + ", error " + pre.music.err);
  check("the corner note is hidden until she taps the flower", pre.chip.hidden === true && pre.chip.display === "none", "hidden " + pre.chip.hidden);
  await ctx.shot("state-music-idle.png");

  /* ---- the tap that blooms the flower is the tap that starts the song ---- */
  await tap("#bloom");
  await sleep(900);
  const on = JSON.parse(await ev(PROBE_MUSIC));
  check("tapping the flower starts the music", !!on.music && on.music.paused === false && on.music.err === null,
    "paused " + (on.music && on.music.paused) + ", error " + (on.music && on.music.err));
  check("it plays at exactly the soft volume", on.music.vol === vol, "volume " + on.music.vol);
  check("the corner note appears and says Music playing", on.chip.hidden === false && on.chip.label === M.playingLabel && on.chip.paused === false,
    JSON.stringify(on.chip.label) + ", hidden " + on.chip.hidden);
  check("the note never eats a tap", on.chip.pointer === "none" && on.chipHit !== "musicChip", "top element at the note = " + on.chipHit);
  await ctx.shot("state-music-blooming.png");

  await sleep(3300);   /* 900 + 3300 clears the 3.4s bloom before "Bloom Again" is meaningful */
  const grown = JSON.parse(await ev(PROBE_MUSIC));
  check("the song really advances", grown.music.t > on.music.t + 1.5, on.music.t + " -> " + grown.music.t + "s");
  check("the flower finished blooming with the song playing", /\bbloomed\b/.test(grown.cls) && grown.music.paused === false,
    "body class = " + grown.cls + ", music t = " + grown.music.t);

  /* ---- the envelope screen: the song simply carries on ---- */
  await ev("document.getElementById('replay').click()");
  await sleep(1700);
  const env = JSON.parse(await ev(PROBE_MUSIC));
  check("the envelope opens with the music still playing", /\benvelope\b/.test(env.cls) && env.music.paused === false,
    "body class = " + env.cls + ", music paused " + env.music.paused);
  check("the note sits inside the viewport", env.chip.rect.left >= 0 && env.chip.rect.top >= 0 && env.chip.rect.right <= env.vw && env.chip.rect.bottom <= env.vh,
    JSON.stringify(env.chip.rect) + " inside " + env.vw + "x" + env.vh);
  check("the note never lands on the envelope title",
    env.chip.rect.bottom <= env.envTitle.top || env.chip.rect.right <= env.envTitle.left || env.chip.rect.left >= env.envTitle.right,
    "note " + JSON.stringify(env.chip.rect) + " vs title top " + env.envTitle.top);
  await ctx.shot("state-music-envelope.png");

  /* ---- Ken's voice message takes the stage: the song holds its exact second ---- */
  const mark = (JSON.parse(await ev(PROBE_MUSIC))).music.t;
  await tap("#voiceBtn");
  await sleep(700);
  const duck = JSON.parse(await ev(PROBE_MUSIC));
  check("pressing the VM pauses the music", duck.music.paused === true && duck.voice.paused === false,
    "music paused " + duck.music.paused + ", voice playing at " + duck.voice.t + "s");
  check("the song is frozen at the second it had reached", Math.abs(duck.music.t - mark) < .4, mark + " -> " + duck.music.t + "s");
  check("music and voice are never heard together", duck.bothPlaying === false, "bothPlaying " + duck.bothPlaying);
  check("the note owns up to the pause", duck.chip.hidden === false && duck.chip.label === M.pausedLabel && duck.chip.paused === true,
    JSON.stringify(duck.chip.label));
  await ctx.shot("state-music-paused.png");

  await sleep(1400);
  const duck2 = JSON.parse(await ev(PROBE_MUSIC));
  check("the song does not creep forward while Ken talks", duck2.music.paused === true && Math.abs(duck2.music.t - duck.music.t) < .3,
    duck.music.t + " -> " + duck2.music.t + "s");
  check("Ken's message is the only thing playing", duck2.voice.paused === false && duck2.bothPlaying === false, "voice t = " + duck2.voice.t + "s");

  /* ---- pausing the VM by hand must leave the music paused too ---- */
  await tap("#voiceBtn");
  await sleep(500);
  const vp = JSON.parse(await ev(PROBE_MUSIC));
  check("the VM pauses by hand", vp.voice.paused === true && vp.voice.t > .2, "voice paused " + vp.voice.paused + " at " + vp.voice.t + "s");
  check("the music stays paused while the VM is paused", vp.music.paused === true, "music paused " + vp.music.paused);
  await sleep(800);
  const vp2 = JSON.parse(await ev(PROBE_MUSIC));
  check("the song still has not moved", Math.abs(vp2.music.t - vp.music.t) < .3, vp.music.t + " -> " + vp2.music.t + "s");

  /* ---- resume the VM: the music is still waiting ---- */
  await tap("#voiceBtn");
  await sleep(800);
  const vr = JSON.parse(await ev(PROBE_MUSIC));
  check("resuming the VM does not wake the music", vr.voice.paused === false && vr.music.paused === true,
    "voice paused " + vr.voice.paused + ", music paused " + vr.music.paused);
  check("still never together", vr.bothPlaying === false, "bothPlaying " + vr.bothPlaying);

  /* ---- the message ends: the music comes back at that same second, never from 0 ---- */
  await ev("(function(){var a=document.querySelector('.voice-audio');a.currentTime=Math.max(0,a.duration-0.4);})()");
  await sleep(1800);
  const back = JSON.parse(await ev(PROBE_MUSIC));
  check("the message ended", back.voice.ended === true && back.voice.paused === true, "ended " + back.voice.ended + " at " + back.voice.t + "s");
  check("the music resumes when the message ends", back.music.paused === false, "music paused " + back.music.paused);
  check("it resumes from where it stopped, not from the top", back.music.t > 1 && back.music.t >= mark - .6,
    "stopped at " + mark + "s, resumed at " + back.music.t + "s");
  check("the soft volume comes back", back.music.vol === vol, "volume " + back.music.vol);
  check("the note says the music is playing again", back.chip.label === M.playingLabel && back.chip.paused === false, JSON.stringify(back.chip.label));
  check("again: never both playing", back.bothPlaying === false, "bothPlaying " + back.bothPlaying);
  await ctx.shot("state-music-resumed.png");

  /* ---- a second VM run: the message starts over, the song still picks up where it stood ---- */
  await sleep(600);
  const mark2 = (JSON.parse(await ev(PROBE_MUSIC))).music.t;
  await tap("#voiceBtn");
  await sleep(800);
  const second = JSON.parse(await ev(PROBE_MUSIC));
  check("a second VM run replays the message from the top", second.voice.paused === false && second.voice.t < back.voice.t - 1,
    back.voice.t + " -> " + second.voice.t + "s");
  check("and pauses the music again at its own second", second.music.paused === true && Math.abs(second.music.t - mark2) < .5,
    "music at " + second.music.t + "s (was " + mark2 + "s)");
  await ev("(function(){var a=document.querySelector('.voice-audio');a.currentTime=Math.max(0,a.duration-0.4);})()");
  await sleep(1800);
  const third = JSON.parse(await ev(PROBE_MUSIC));
  check("the music comes back a second time, from the newer position", third.music.paused === false && third.music.t >= mark2 - .6,
    "stopped at " + mark2 + "s, resumed at " + third.music.t + "s");
  check("the note is honest after the second run", third.chip.label === M.playingLabel && third.bothPlaying === false, JSON.stringify(third.chip.label));

  /* ---- looping: the song reaches the end and carries on by itself ---- */
  await ev("(function(){var m=document.querySelector('.music-audio');m.currentTime=Math.max(0,m.duration-0.35);})()");
  await sleep(1400);
  const loop = JSON.parse(await ev(PROBE_MUSIC));
  check("the song loops instead of stopping", loop.music.paused === false && loop.music.ended === false && loop.music.loop === true,
    "paused " + loop.music.paused + ", ended " + loop.music.ended + ", loop " + loop.music.loop);
  check("it really came round again", loop.music.t < loop.music.dur - 1, "wrapped to " + loop.music.t + "s of " + loop.music.dur + "s");

  /* ---- the letter screen: the song plays on under the paper ---- */
  await ev("document.getElementById('envelope').click()");
  await sleep(2400);
  const letter = JSON.parse(await ev(PROBE_MUSIC));
  check("the letter view is reached with the music playing", /\bletter\b/.test(letter.cls) && letter.music.paused === false,
    "body class = " + letter.cls + ", music paused " + letter.music.paused);
  check("the note stays clear of the letter card",
    letter.chip.rect.bottom <= letter.card.top || letter.chip.rect.right <= letter.card.left || letter.chip.rect.left >= letter.card.right,
    "note " + JSON.stringify(letter.chip.rect) + " vs card top " + letter.card.top);
  check("the note stays clear of the voice player",
    letter.chip.rect.bottom <= letter.player.top || letter.chip.rect.right <= letter.player.left || letter.chip.rect.left >= letter.player.right,
    "note " + JSON.stringify(letter.chip.rect) + " vs player " + JSON.stringify(letter.player));
  check("no horizontal overflow with the note on screen", letter.overflowX === false, "scrollWidth " + letter.scrollW + " vs " + letter.vw);
  await ctx.shot("state-music-letter.png");

  /* ---- the song survives closing the surprise, and no duplicate element appears ---- */
  await ev("document.getElementById('letterClose').click()");
  await sleep(1200);
  const closed = JSON.parse(await ev(PROBE_MUSIC));
  check("closing the surprise leaves the music playing", closed.music.paused === false && closed.voice.paused === true,
    "music paused " + closed.music.paused + ", voice paused " + closed.voice.paused);
  check("no second music element appeared", closed.musicCount === 1 && closed.voiceCount === 1 && closed.audioCount === 2,
    closed.audioCount + " element(s) = " + closed.voiceCount + " voice + " + closed.musicCount + " music");
  await ev("document.getElementById('bloom').click()");
  await sleep(500);
  const again = JSON.parse(await ev(PROBE_MUSIC));
  check("a second flower tap changes nothing in the audio", again.musicCount === 1 && again.audioCount === 2 && again.music.paused === false,
    again.audioCount + " elements, music paused " + again.music.paused);

  /* ---- phone (390x844): the note fits, stays small, and blocks nothing ---- */
  await ctx.go(390, 844, 2, true);
  await sleep(900);
  const phone = JSON.parse(await ev(PROBE_MUSIC));
  check("the note fits a 390px phone", phone.chip.rect.left >= 0 && phone.chip.rect.right <= phone.vw && phone.chip.rect.bottom <= phone.vh,
    JSON.stringify(phone.chip.rect) + " inside " + phone.vw + "x" + phone.vh);
  check("the note stays small on a phone", phone.chip.rect.w <= Math.round(phone.vw * .5) && phone.chip.rect.h <= 40, phone.chip.rect.w + "x" + phone.chip.rect.h + "px");
  check("no horizontal overflow on a phone", phone.overflowX === false, "scrollWidth " + phone.scrollW + " vs " + phone.vw);
  check("the music still plays on a phone", phone.music.paused === false, "music paused " + phone.music.paused);
  await ctx.shot("state-music-mobile.png");

  /* ---- a missing music file: quiet, kind, and Ken's message still works ---- */
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(1800);
  await ev("document.querySelector('.music-audio').dispatchEvent(new Event('error'))");
  await sleep(350);
  const gone = JSON.parse(await ev(PROBE_MUSIC));
  check("a missing music file hides the note", gone.chip.hidden === true, "hidden " + gone.chip.hidden);
  await tap("#bloom");
  await sleep(900);
  const gone2 = JSON.parse(await ev(PROBE_MUSIC));
  check("the flower still blooms without any music", /\bbloomed\b/.test(gone2.cls) && gone2.chip.hidden === true && gone2.music.paused === true,
    "body class = " + gone2.cls + ", music paused " + gone2.music.paused);
  await sleep(3300);                       /* the bloom takes 3.4s: "Bloom Again" is ignored before that */
  await ev("document.getElementById('replay').click()");
  await sleep(1700);
  const gone2b = JSON.parse(await ev(PROBE_MUSIC));
  check("the envelope is on screen before the VM is tapped", /\benvelope\b/.test(gone2b.cls) && gone2b.player.h > 0,
    "body class = " + gone2b.cls + ", player " + gone2b.player.w + "x" + gone2b.player.h);
  await tap("#voiceBtn");
  await sleep(800);
  const gone3 = JSON.parse(await ev(PROBE_MUSIC));
  check("the voice message still plays on its own", gone3.voice.paused === false && gone3.music.paused === true,
    "voice paused " + gone3.voice.paused + " (t " + gone3.voice.t + "s of " + gone3.voice.dur + "), music paused " + gone3.music.paused);
  check("nothing overlaps even when the music is gone", gone3.bothPlaying === false, "bothPlaying " + gone3.bothPlaying);
  await tap("#voiceBtn");
  await sleep(400);

  /* ---- reduced motion: the note calms down, the sound does not ---- */
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ctx.go(1280, 900, 1, false);
  await ctx.navigate(1800);
  await tap("#bloom");
  await sleep(1200);
  const calm = JSON.parse(await ev(PROBE_MUSIC));
  check("reduced motion still starts the music", calm.music.paused === false && calm.chip.hidden === false, "paused " + calm.music.paused + ", hidden " + calm.chip.hidden);
  check("reduced motion stops the note bouncing", calm.chip.note === "none", "animation " + calm.chip.note);
  await send("Emulation.setEmulatedMedia", { features: [] });

  return { idle: pre, blooming: on, envelope: env, paused: duck, vmPaused: vp, vmResumed: vr, resumed: back, second, third, loop, letter, closed, phone, missing: gone, reduced: calm };
}

/* ============================== suite: sizes ============================== */

const VIEWPORTS = [
  { w: 320, h: 568, name: "iPhoneSE" },
  { w: 360, h: 640, name: "small-android" },
  { w: 390, h: 844, name: "iPhone14" },
  { w: 414, h: 896, name: "iPhonePlus" },
  { w: 768, h: 1024, name: "tablet" },
  { w: 1024, h: 768, name: "small-desktop" },
  { w: 1440, h: 900, name: "desktop" },
  { w: 390, h: 520, name: "short-mobile" }
];

async function suiteSizes(ctx) {
  const { ev, check } = ctx;
  const rows = [];
  for (const v of VIEWPORTS) {
    await ctx.go(v.w, v.h, 1, false);
    await ctx.navigate(1400);
    const p = JSON.parse(await ev(PROBE_SIZES));
    rows.push({ v, p });
    console.log("       " + v.name.padEnd(14) + " [" + v.w + "x" + v.h + "] flower " + p.flower + "  headOverlap " + p.headOverlap + "px  leaves " + JSON.stringify(p.leaves));
    check("no h-overflow @ " + v.name + " (" + v.w + "x" + v.h + ")", p.overflow === false && p.scrollW <= p.innerW + 1, "scrollWidth " + p.scrollW + " vs innerWidth " + p.innerW);
  }
  const minHead = Math.min.apply(null, rows.map(r => r.p.headOverlap));
  check("stem/head overlap at every viewport", rows.every(r => r.p.headOverlap > 0), "smallest overlap = " + minHead + "px");
  const minLeaf = Math.min.apply(null, rows.map(r => Math.min.apply(null, r.p.leaves.map(l => l.intoStem))));
  check("both leaf blades bite into the stem at every viewport", rows.every(r => r.p.leaves.length >= 2 && r.p.leaves.every(l => l.intoStem >= 1)),
    "smallest leaf penetration = " + minLeaf + "px");
  const widths = rows.map(r => parseInt(r.p.flower, 10));
  check("flower scales inside its clamp range", Math.min.apply(null, widths) >= 200 && Math.max.apply(null, widths) <= 420, Math.min.apply(null, widths) + ".." + Math.max.apply(null, widths) + "px");
  return rows;
}
/* ================================ runner ================================ */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }

  const htmlPath = path.resolve(HERE, args.file);
  if (!fss.existsSync(htmlPath)) throw new Error("html file not found: " + htmlPath);
  const outDir = path.resolve(HERE, args.out);
  fss.mkdirSync(outDir, { recursive: true });
  const chromeBin = findChrome(args.chrome);
  const wanted = args.suite === "all" ? SUITES : [args.suite];
  for (const s of wanted) if (!SUITES.includes(s)) throw new Error("unknown suite '" + s + "' - use " + SUITES.join("|") + "|all");

  const rep = reporter();
  const server = await startServer(path.dirname(htmlPath), args.port);
  const profile = path.join(os.tmpdir(), "flower-cdp-test-" + args.cdp);   /* unique per CDP port so runs can overlap */
  const proc = launchChrome(chromeBin, args.cdp, profile);
  let cdp = null;
  const started = Date.now();

  console.log("flower test runner");
  console.log("  file   : " + htmlPath);
  console.log("  chrome : " + chromeBin);
  console.log("  out    : " + outDir);
  console.log("  suites : " + wanted.join(", "));

  try {
    cdp = await connectCdp(args.cdp);
    console.log("  browser: " + cdp.browser + "\n");
    const url = "http://127.0.0.1:" + args.port + "/" + encodeURIComponent(path.basename(htmlPath));
    const ctx = {
      send: cdp.send, ev: cdp.ev, logs: cdp.logs, check: rep.check, out: outDir, url,
      go: (w, h, dsf, mobile) => cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf || 1, mobile: !!mobile }),
      /* a real trusted tap (CDP input = user activation, so autoplay policy behaves like a finger) */
      tap: async sel => {
        const box = JSON.parse(await cdp.ev("JSON.stringify((function(){var el=document.querySelector(" + JSON.stringify(sel) + ");if(!el)return null;var b=el.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2),w:Math.round(b.width),h:Math.round(b.height)};})())"));
        if (!box) throw new Error("tap: nothing matched " + sel);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", buttons: 0 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
        return box;
      },
      navigate: async settle => { await cdp.send("Page.navigate", { url }); await sleep(settle || 1500); },
      shot: async name => {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        return savePng(outDir, name, r.data, rep.check);
      }
    };

    for (const s of wanted) {
      rep.suite(s);
      console.log("== suite: " + s + " ==");
      const t0 = Date.now();
      if (s === "state") await suiteState(ctx);
      else if (s === "zoom") await suiteZoom(ctx);
      else if (s === "surprise") await suiteSurprise(ctx);
      else if (s === "voice") await suiteVoice(ctx);
      else if (s === "music") await suiteMusic(ctx);
      else await suiteSizes(ctx);
      console.log("   (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)\n");
    }

    rep.suite("global");
    console.log("== suite: global ==");
    rep.check("no console errors or exceptions", cdp.logs.length === 0, cdp.logs.length ? JSON.stringify(cdp.logs).slice(0, 400) : "0 messages");
  } catch (e) {
    console.error("\nRUNNER ERROR: " + (e && e.message));
    rep.suite("global");
    rep.check("runner completed without throwing", false, String(e && e.message).slice(0, 300));
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e2) { /* ignore */ }
    try { proc.kill(); } catch (e2) { /* ignore */ }
    try { server.close(); } catch (e2) { /* ignore */ }
    try { fss.rmSync(profile, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
  }

  /* ------------------------------- summary ------------------------------- */
  const failed = rep.rows.filter(r => !r.ok);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log("-".repeat(68));
  console.log((failed.length ? "FAILED" : "ALL PASS") + " - " + (rep.rows.length - failed.length) + "/" + rep.rows.length + " checks in " + secs + "s");
  if (failed.length) {
    console.log("\nfailures:");
    failed.forEach(r => console.log("  [" + r.suite + "] " + r.name + (r.detail ? "  (" + r.detail + ")" : "")));
  }
  const artifacts = fss.readdirSync(outDir).filter(f => f.endsWith(".png")).sort();
  console.log("artifacts: " + (artifacts.length ? artifacts.join(", ") : "(none)"));

  const report = {
    when: new Date().toISOString(), file: htmlPath, chrome: chromeBin, suites: wanted,
    seconds: Number(secs), pass: failed.length === 0, checks: rep.rows, artifacts,
    logs: cdp ? cdp.logs : []
  };
  fss.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fss.writeFileSync(path.join(outDir, "report.txt"),
    rep.rows.map(r => (r.ok ? "PASS" : "FAIL") + " [" + r.suite + "] " + r.name + (r.detail ? " | " + r.detail : "")).join(os.EOL) +
    os.EOL + os.EOL + (failed.length ? "FAILED " + failed.length + "/" + rep.rows.length : "ALL PASS " + rep.rows.length + "/" + rep.rows.length) + " in " + secs + "s" + os.EOL);
  console.log("report  : " + path.relative(HERE, path.join(outDir, "report.txt")) + " + report.json");
  return failed.length ? 1 : 0;
}

main()
  .then(code => { process.exitCode = code; setTimeout(() => process.exit(code), 1500).unref(); })
  .catch(e => { console.error("FATAL: " + ((e && e.stack) || e)); process.exitCode = 1; setTimeout(() => process.exit(1), 1500).unref(); });
