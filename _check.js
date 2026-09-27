2const http = require("http");
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
const dir = process.env.TEMP + "/flower-cdp4";
fss.rmSync(dir, { recursive: true, force: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

server.listen(8770, "127.0.0.1", async () => {
  const proc = cp.spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + dir, "--remote-debugging-port=9336", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      try { await (await fetch("http://127.0.0.1:9336/json/version")).json(); break; }
      catch (e) { await sleep(150); }
    }
    const list = await (await fetch("http://127.0.0.1:9336/json/list")).json();
    const page = list.find(t => t.type === "page");
    console.log("targets", list.map(t => t.type + ":" + t.url).join(" , "));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const log = [];
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.consoleAPICalled") log.push(m.params.args.map(a => a.value ?? a.description).join(" "));
      if (m.method === "Runtime.exceptionThrown") log.push("EXC " + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
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
    await send("Page.navigate", { url: "http://127.0.0.1:8770/index.html" });
    await sleep(2000);
    const diag = await ev("[location.href, document.readyState, document.documentElement.outerHTML.length, document.querySelectorAll('*').length].join(' | ')");
    console.log("DIAG " + diag);
    const before = await ev("JSON.stringify({petals:document.querySelectorAll('.petal').length,sepals:document.querySelectorAll('.sepal').length,bokeh:document.querySelectorAll('.bokeh').length,falling:document.querySelectorAll('.falling').length,msgOpacity:getComputedStyle(document.querySelector('.message')).opacity,closed:getComputedStyle(document.querySelector('.petal')).transform,hint:document.getElementById('hint').textContent.trim()})");
    await ev("document.getElementById('bloom').click(); document.getElementById('bloom').click();");
    await sleep(1200);
    const mid = await ev("JSON.stringify({cls:document.body.className,transform:getComputedStyle(document.querySelector('.petal')).transform,delay:getComputedStyle(document.querySelector('.petal')).transitionDelay,msgOpacity:getComputedStyle(document.querySelector('.message')).opacity,sparks:document.querySelectorAll('.spark').length,ring:document.querySelectorAll('.ring').length,replayHidden:document.getElementById('replay').hidden})");
    await sleep(2800);
    const after = await ev("JSON.stringify({cls:document.body.className,msgOpacity:getComputedStyle(document.querySelector('.message')).opacity,blur:getComputedStyle(document.querySelector('.message')).filter,replayHidden:document.getElementById('replay').hidden,center:getComputedStyle(document.querySelector('.center')).transform,sepal:getComputedStyle(document.querySelector('.sepal')).transform})");
    await ev("document.getElementById('replay').click()");
    await sleep(400);
    const reset = await ev("document.body.className || 'bud'");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    const mobile = await ev("JSON.stringify({innerW:window.innerWidth,scrollW:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>window.innerWidth+1,flowerW:Math.round(document.getElementById('flower').getBoundingClientRect().width),msgW:Math.round(document.getElementById('message').getBoundingClientRect().width)})");
    console.log("BEFORE " + before);
    console.log("MID " + mid);
    console.log("AFTER " + after);
    console.log("RESET " + reset);
    console.log("MOBILE " + mobile);
    console.log("LOGS " + JSON.stringify(log));
    await ev("document.getElementById('bloom').click()");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await sleep(3800);
    const shot1 = await send("Page.captureScreenshot", { format: "png" });
    fss.writeFileSync("C:/Users/PC/flower/_shot_desktop.png", Buffer.from(shot1.result.data, "base64"));
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    const shot2 = await send("Page.captureScreenshot", { format: "png" });
    fss.writeFileSync("C:/Users/PC/flower/_shot_mobile.png", Buffer.from(shot2.result.data, "base64"));
    await ev("document.getElementById('replay').click()");
    await sleep(5400);
    const buds = await ev("JSON.stringify({cls:document.body.className||'bud',msgOpacity:getComputedStyle(document.querySelector('.message')).opacity,msgFilter:getComputedStyle(document.querySelector('.message')).filter,hintOpacity:getComputedStyle(document.getElementById('hint')).opacity,budtip:getComputedStyle(document.querySelector('.budtip')).transform,replayHidden:document.getElementById('replay').hidden})");
    console.log("BUD " + buds);
    const shot3 = await send("Page.captureScreenshot", { format: "png" });
    fss.writeFileSync("C:/Users/PC/flower/_shot_bud.png", Buffer.from(shot3.result.data, "base64"));
    console.log("shots saved");
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
