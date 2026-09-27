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
const dir = process.env.TEMP + "/flower-cdp-sizes";
fss.rmSync(dir, { recursive: true, force: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sizes = [
  { w: 320, h: 568, name: "iPhoneSE" },
  { w: 360, h: 640, name: "small-android" },
  { w: 390, h: 844, name: "iPhone14" },
  { w: 414, h: 896, name: "iPhonePlus" },
  { w: 768, h: 1024, name: "tablet" },
  { w: 1024, h: 768, name: "small-desktop" },
  { w: 1440, h: 900, name: "desktop" },
  { w: 390, h: 520, name: "short-landscape-ish" }
];

server.listen(8772, "127.0.0.1", async () => {
  const proc = cp.spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + dir, "--remote-debugging-port=9338", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      try { await (await fetch("http://127.0.0.1:9338/json/version")).json(); break; }
      catch (e) { await sleep(150); }
    }
    const list = await (await fetch("http://127.0.0.1:9338/json/list")).json();
    const page = list.find(t => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const log = [];
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.consoleAPICalled") log.push("CONSOLE " + m.params.args.map(a => a.value ?? a.description).join(" "));
      if (m.method === "Runtime.exceptionThrown") log.push("EXC " + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await new Promise(r => ws.addEventListener("open", r));
    await send("Runtime.enable");
    const ev = async expr => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result.result.value;
    };

    const probe = `JSON.stringify((function(){
      var stem = document.querySelector('.stem');
      var sb = stem.getBoundingClientRect();
      var sep = document.getElementById('sepals').getBoundingClientRect();
      var tip = document.querySelector('.budtip').getBoundingClientRect();
      var headBottom = Math.max(sep.bottom, tip.bottom);
      var svg = document.getElementById('flower').getBoundingClientRect();
      var leaves = [];
      document.querySelectorAll('.leaf').forEach(function(g, i){
        var b = g.getBoundingClientRect();
        leaves.push({ leaf: i, gap: (i === 0 ? (sb.left + sb.width/2) - b.right : b.left - (sb.left + sb.width/2)) });
      });
      return {
        flower: Math.round(svg.width) + 'x' + Math.round(svg.height),
        flowerBottom: Math.round(svg.bottom),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        scrollW: document.documentElement.scrollWidth,
        stageH: document.querySelector('.stage').getBoundingClientRect().height,
        stemHeadOverlap: Math.round(headBottom - sb.top),
        leaves: leaves,
        leafInsideStem: leaves.map(function(l){
          var g = document.querySelectorAll('.leaf')[l.leaf].getBoundingClientRect();
          return Math.round(l.leaf === 0 ? g.right - sb.left : sb.right - g.left);
        })
      };
    })())`;

    for (const s of sizes) {
      await send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: "http://127.0.0.1:8772/index.html" });
      await sleep(1400);
      const r = await ev(probe);
      console.log(s.name + " [" + s.w + "x" + s.h + "] " + r);
    }
    console.log("LOGS " + JSON.stringify(log));
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
