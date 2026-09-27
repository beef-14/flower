const http = require("http");
const fss = require("fs");
const cp = require("child_process");
const path = require("path");

const root = "C:/Users/PC/flower";
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  fss.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(data);
  });
});

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const dir = process.env.TEMP + "/flower-cdp-zoom";
fss.rmSync(dir, { recursive: true, force: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

server.listen(8771, "127.0.0.1", async () => {
  const proc = cp.spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + dir, "--remote-debugging-port=9337", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      try { await (await fetch("http://127.0.0.1:9337/json/version")).json(); break; }
      catch (e) { await sleep(150); }
    }
    const list = await (await fetch("http://127.0.0.1:9337/json/list")).json();
    const page = list.find(t => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await new Promise(r => ws.addEventListener("open", r));
    await send("Runtime.enable");
    const ev = async expr => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result.value;
    };
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 3, mobile: false });
    await send("Page.navigate", { url: "http://127.0.0.1:8771/index.html" });
    await sleep(2200);

    // Freeze animations so crops are deterministic
    await ev("document.querySelectorAll('.leaf,.flower-btn,svg#flower').forEach(function(e){e.style.animation='none'})");

    const rects = await ev(`JSON.stringify((function(){
      var r = function(el){ var b = el.getBoundingClientRect(); return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}; };
      var stem = document.querySelector('.stem');
      var leafG = document.querySelectorAll('.leaf');
      return { stem: r(stem), left: r(leafG[0]), right: r(leafG[1]) };
    })())`);
    const R = JSON.parse(rects);
    console.log("RECTS " + rects);

    const clipFor = (name) => {
      if (name === "left") {
        const c = R.left, halfPad = 30;
        return { x: Math.round(c.r - 34), y: Math.round(c.t + c.h / 2 - halfPad), width: 68, height: halfPad * 2, scale: 6 };
      }
      if (name === "right") {
        const c = R.right, halfPad = 30;
        return { x: Math.round(c.l - 34), y: Math.round(c.t + c.h / 2 - halfPad), width: 68, height: halfPad * 2, scale: 6 };
      }
      return null;
    };

    for (const name of ["left", "right"]) {
      const clip = clipFor(name);
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale } });
      fss.writeFileSync("C:/Users/PC/flower/_zoom_leaf_" + name + ".png", Buffer.from(shot.result.data, "base64"));
      console.log("saved leaf " + name + " clip " + JSON.stringify(clip));
    }

    // Bud-state head/stem junction (page is in bud state on load)
    const headClip = await ev(`JSON.stringify((function(){
      var seps = document.querySelectorAll('.sepal');
      var tip = document.querySelector('.budtip').getBoundingClientRect();
      var sb = document.querySelector('.stem').getBoundingClientRect();
      var bottom = Math.max(tip.bottom, sb.top + 4) ;
      var sepsBottom = 0;
      seps.forEach(function(s){ sepsBottom = Math.max(sepsBottom, s.getBoundingClientRect().bottom); });
      bottom = Math.max(bottom, sepsBottom);
      var cx = sb.left + sb.width / 2;
      return { x: Math.round(cx - 30), y: Math.round(bottom - 42), width: 60, height: 62, scale: 6, sepsBottom: Math.round(sepsBottom), stemTop: Math.round(sb.top) };
    })())`);
    const HC = JSON.parse(headClip);
    console.log("HEADCLIP " + headClip);
    const shot3 = await send("Page.captureScreenshot", { format: "png", clip: { x: HC.x, y: HC.y, width: HC.width, height: HC.height, scale: HC.scale } });
    fss.writeFileSync("C:/Users/PC/flower/_zoom_head.png", Buffer.from(shot3.result.data, "base64"));
    console.log("saved head crop");
    console.log("done");
    ws.close();
    proc.kill();
  } catch (e) {
    console.error("ERR", e);
    proc.kill();
    process.exitCode = 1;
  } finally {
    server.close();
    setTimeout(() => process.exit(), 300);
  }
});
