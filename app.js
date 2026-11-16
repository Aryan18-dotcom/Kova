(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fileInput = $("fileInput"), status = $("scanStatus"), resultCard = $("resultCard");
  const canvas = $("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
  const state = { payload: null, params: null, fixedAmount: false, cameraStream: null, image: null };
  const LEDGER_KEY = "kova-ledger-v1";
  const money = (n) => Number(n).toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2});
  const setStatus = (message, error=false) => { status.textContent = message; status.style.color = error ? "var(--clay)" : "var(--muted)"; };

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("kova-theme", theme);
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#15120f" : "#f6f3ee";
  }
  setTheme(localStorage.getItem("kova-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("themeToggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  function decodeText(text) {
    if (!text) return null;
    let value = String(text).trim().replace(/^[\uFEFF\s]+|[\s]+$/g, "");
    try { value = decodeURIComponent(value); } catch {}
    // UPI deep links can be wrapped in text or a URL parameter.
    const match = value.match(/upi:\/\/pay\?[^\s"'<>]+/i);
    if (match) value = match[0].replace(/[),.;]+$/, "");
    if (/^upi:\/\/pay\?/i.test(value)) return { kind: "upi", raw: value };
    // Some QR payloads are EMVCo TLV strings. Inspect merchant account info templates
    // for a nested UPI URI, but never invent a VPA from arbitrary text.
    const nested = findNestedUpi(value);
    if (nested) return { kind: "upi", raw: nested };
    if (/^https?:\/\//i.test(value)) return { kind: "url", raw: value };
    return { kind: "other", raw: value };
  }

  function findNestedUpi(input) {
    // EMV TLV: two-digit tag + two-digit byte length + value. Search boundedly.
    let i = 0, loops = 0;
    while (i + 4 <= input.length && loops++ < 500) {
      const tag = input.slice(i, i+2), len = Number(input.slice(i+2, i+4));
      if (!/^\d{2}$/.test(tag) || !Number.isFinite(len) || len < 0) break;
      const start = i + 4, end = start + len;
      if (end > input.length) break;
      const chunk = input.slice(start, end);
      const found = chunk.match(/upi:\/\/pay\?[^\s]+/i);
      if (found) return found[0];
      i = end;
    }
    return null;
  }

  function parseUpi(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol.toLowerCase() !== "upi:" || u.hostname.toLowerCase() !== "pay") return null;
      const p = Object.fromEntries(u.searchParams.entries());
      if (!p.pa || !p.pn) return null;
      if (p.cu && p.cu.toUpperCase() !== "INR") return null;
      if (p.am && (!/^\d+(\.\d{1,2})?$/.test(p.am) || Number(p.am) <= 0)) return null;
      return p;
    } catch { return null; }
  }

  function renderResult(raw) {
    const decoded = decodeText(raw);
    if (!decoded || decoded.kind !== "upi") {
      const message = decoded?.kind === "url"
        ? "This QR contains a website link, not a standard UPI payment QR. For safety, Kova won't treat it as a payment."
        : "QR detected, but it isn't a supported UPI payment QR.";
      setStatus(message, true); return;
    }
    const params = parseUpi(decoded.raw);
    if (!params) { setStatus("UPI data is incomplete or malformed. No payment link was created.", true); return; }
    stopCamera();
    state.payload = decoded.raw; state.params = params;
    state.fixedAmount = Boolean(params.am);
    $("payeeName").textContent = params.pn || "Payee name unavailable";
    $("payeeVpa").textContent = params.pa;
    $("payeeAvatar").textContent = (params.pn || "₹").trim().charAt(0).toUpperCase();
    $("qrType").textContent = params.mc ? `Merchant · MCC ${params.mc}` : "UPI payment";
    $("qrAmount").textContent = params.am ? `₹${money(params.am)}` : "Not fixed";
    $("amountInput").value = params.am || "";
    $("amountInput").disabled = state.fixedAmount;
    $("amountHint").textContent = state.fixedAmount ? "Fixed by QR" : "Optional for static QR";
    $("lockedWarning").hidden = !state.fixedAmount;
    resultCard.hidden = false;
    resultCard.scrollIntoView({behavior:"smooth", block:"start"});
    setStatus("UPI QR decoded. Verify the details below.");
  }

  function decodeImage(file) {
    if (!file || !file.type.startsWith("image/")) { setStatus("Please choose an image file.", true); return; }
    if (file.size > 15 * 1024 * 1024) { setStatus("Image is too large. Choose an image under 15 MB.", true); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      if (typeof window.jsQR !== "function") { setStatus("QR engine did not load. Connect to the internet once, then reload Kova.", true); return; }
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts:"attemptBoth" });
      if (!code) { setStatus("No readable QR found. Try a sharper, uncropped image.", true); return; }
      renderResult(code.data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); setStatus("Could not read this image.", true); };
    img.src = url;
    setStatus("Reading QR on this device…");
  }

  fileInput.addEventListener("change", e => decodeImage(e.target.files[0]));
  $("dropzone").addEventListener("dragover", e => { e.preventDefault(); $("dropzone").classList.add("dragging"); });
  $("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
  $("dropzone").addEventListener("drop", e => { e.preventDefault(); $("dropzone").classList.remove("dragging"); decodeImage(e.dataTransfer.files[0]); });
  async function pasteImage() {
    try {
      if (!navigator.clipboard?.read) throw new Error("Clipboard image reading isn't supported here. Use Choose image.");
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t => t.startsWith("image/"));
        if (type) { decodeImage(await item.getType(type)); return; }
      }
      setStatus("No image found in clipboard.", true);
    } catch (e) { setStatus(e.message || "Clipboard access was blocked. Use Choose image.", true); }
  }
  $("pasteBtn").addEventListener("click", pasteImage);
  document.addEventListener("paste", e => {
    const item = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith("image/"));
    if (item) decodeImage(item.getAsFile());
  });

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { setStatus("Camera scanning isn't available in this browser. Upload an image instead.", true); return; }
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
      const video = $("camera"); video.hidden = false; video.srcObject = state.cameraStream; await video.play();
      setStatus("Point your camera at a UPI QR code.");
      const scan = () => {
        if (!state.cameraStream || video.readyState < 2) return;
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        if (window.jsQR) {
          const code = window.jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,{inversionAttempts:"dontInvert"});
          if (code) { renderResult(code.data); return; }
        }
        state.cameraFrame = requestAnimationFrame(scan);
      };
      scan();
    } catch { setStatus("Camera permission denied or unavailable. You can upload a QR image instead.", true); }
  }
  function stopCamera() {
    if (state.cameraFrame) cancelAnimationFrame(state.cameraFrame);
    if (state.cameraStream) state.cameraStream.getTracks().forEach(t=>t.stop());
    state.cameraStream = null; $("camera").hidden = true; $("camera").srcObject = null;
  }
  $("cameraBtn").addEventListener("click", () => state.cameraStream ? stopCamera() : startCamera());

  function readLedger() { try { return JSON.parse(localStorage.getItem(LEDGER_KEY) || "[]"); } catch { return []; } }
  function saveLedger(entry) { const list = [entry, ...readLedger()].slice(0,30); localStorage.setItem(LEDGER_KEY,JSON.stringify(list)); renderLedger(); }
  function renderLedger() {
    const list = readLedger(), el = $("ledgerList");
    if (!list.length) { el.innerHTML = '<p class="empty-ledger">No handoffs recorded yet.</p>'; return; }
    el.replaceChildren(...list.map(item => {
      const row = document.createElement("div"); row.className="ledger-item";
      const left = document.createElement("div"), title = document.createElement("b"), meta = document.createElement("span"), amount = document.createElement("div");
      title.textContent=item.payee; meta.textContent=[item.vpa,item.vehicle,item.note,new Date(item.at).toLocaleString()].filter(Boolean).join(" · ");
      amount.className="ledger-amount"; amount.textContent=item.amount ? `₹${money(item.amount)}` : "Amount not set";
      left.append(title,meta); row.append(left,amount); return row;
    }));
  }
  $("clearLedgerBtn").addEventListener("click", () => { if(confirm("Clear this device's Kova handoff history?")) { localStorage.removeItem(LEDGER_KEY); renderLedger(); } });
  $("resetBtn").addEventListener("click", () => {
    state.payload=null;state.params=null;state.fixedAmount=false;resultCard.hidden=true;fileInput.value="";
    $("vehicleInput").value="";$("noteInput").value="";$("amountInput").value="";setStatus("Ready for another QR.");
  });
  $("copyVpaBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.params.pa); setStatus("UPI ID copied."); }
    catch { setStatus("Clipboard permission unavailable. Select and copy the UPI ID manually.",true); }
  });

  function buildPaymentUri() {
    const p = new URLSearchParams(state.params);
    const entered = $("amountInput").value.trim();
    if (!state.fixedAmount && entered) {
      const n = Number(entered);
      if (!Number.isFinite(n) || n <= 0 || !/^\d+(\.\d{1,2})?$/.test(entered)) throw new Error("Enter a valid amount with up to two decimal places.");
      p.set("am", n.toFixed(2)); p.set("cu", "INR");
    }
    const note = $("noteInput").value.trim();
    if (note && !state.params.tn) p.set("tn", note.slice(0,80));
    return `upi://pay?${p.toString()}`;
  }
  $("continueBtn").addEventListener("click", () => {
    try {
      const uri=buildPaymentUri();
      state.paymentUri=uri;
      saveLedger({payee:state.params.pn,vpa:state.params.pa,amount:state.params.am || $("amountInput").value || "",vehicle:$("vehicleInput").value.trim(),note:$("noteInput").value.trim(),at:Date.now()});
      $("appDialog").showModal();
    } catch(e) { setStatus(e.message,true); }
  });
  $("closeDialog").addEventListener("click", () => $("appDialog").close());
  
function appUri(app) {
  const generic = state.paymentUri;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  const query = generic.includes("?")
    ? generic.substring(generic.indexOf("?") + 1)
    : "";

  if (!query) return generic;

  if (app === "gpay") {
    if (isIOS) {
      // Google Pay deep link for iPhone
      return `gpay://upi/pay?${query}`;
    }

    // Android Chrome: explicitly target Google Pay
    return `intent://pay?${query}#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end`;
  }

  if (app === "phonepe") {
    return generic.replace(/^upi:/, "phonepe:");
  }

  if (app === "paytm") {
    return generic.replace(/^upi:/, "paytmmp:");
  }

  return generic;
}


  async function processShared() {
    const params = new URLSearchParams(location.search);
    const upi = params.get("upi");
    if (upi) { history.replaceState({}, "", location.pathname); renderResult(upi); return; }
    if (params.get("shared")==="1" && "caches" in window) {
      try {
        const cache=await caches.open("kova-shared-v1"), response=await cache.match("/__kova_shared_image__");
        if (response) { const blob=await response.blob(); await cache.delete("/__kova_shared_image__"); decodeImage(blob); }
        history.replaceState({}, "", location.pathname);
      } catch { setStatus("Couldn't open the shared image. Please upload it again.",true); }
    }
  }
  renderLedger();
  processShared();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/sw.js").catch(()=>setStatus("Offline support could not be enabled in this browser.",true));
  }
})();
