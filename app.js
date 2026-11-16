
(() => {
  "use strict";

  // ============================================================
  // KOVA — QR TO UPI
  // Vanilla JavaScript | No backend | Local-first
  // ============================================================

  const $ = (id) => document.getElementById(id);

  const fileInput = $("fileInput");
  const status = $("scanStatus");
  const resultCard = $("resultCard");
  const canvas = $("canvas");
  const ctx = canvas?.getContext("2d", {
    willReadFrequently: true
  });

  const LEDGER_KEY = "kova-ledger-v1";

  const state = {
    payload: null,
    params: null,
    fixedAmount: false,
    cameraStream: null,
    cameraFrame: null,
    paymentUri: null
  };

  // ============================================================
  // HELPERS
  // ============================================================

  function setStatus(message, error = false) {
    if (!status) return;

    status.textContent = message;
    status.style.color = error
      ? "var(--clay)"
      : "var(--muted)";
  }

  function money(value) {
    return Number(value).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function isIOS() {
    return (
      /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (
        navigator.platform === "MacIntel" &&
        navigator.maxTouchPoints > 1
      )
    );
  }

  // ============================================================
  // THEME
  // ============================================================

  function setTheme(theme) {
    const selected = theme === "dark" ? "dark" : "light";

    document.documentElement.dataset.theme = selected;

    try {
      localStorage.setItem("kova-theme", selected);
    } catch (error) {
      console.warn("Theme storage unavailable.", error);
    }

    const themeMeta = document.querySelector(
      'meta[name="theme-color"]'
    );

    if (themeMeta) {
      themeMeta.content = selected === "dark"
        ? "#15120f"
        : "#f6f3ee";
    }
  }

  let savedTheme = null;

  try {
    savedTheme = localStorage.getItem("kova-theme");
  } catch (error) {
    console.warn("Could not read saved theme.", error);
  }

  const preferredTheme = window.matchMedia?.(
    "(prefers-color-scheme: dark)"
  ).matches
    ? "dark"
    : "light";

  setTheme(savedTheme || preferredTheme);

  $("themeToggle")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;

    setTheme(current === "dark" ? "light" : "dark");
  });

  // ============================================================
  // UPI QR DECODING
  // ============================================================

  function decodeText(input) {
    if (!input) return null;

    let value = String(input).trim();

    value = value.replace(/^[\uFEFF\s]+|[\s]+$/g, "");

    // Decode only if the complete input is URL-encoded.
    // Never unnecessarily decode an existing UPI URI.
    if (!/^upi:\/\/pay\?/i.test(value)) {
      try {
        const decoded = decodeURIComponent(value);

        if (/upi:\/\/pay\?/i.test(decoded)) {
          value = decoded;
        }
      } catch (error) {
        // Keep original payload.
      }
    }

    // Extract UPI URI from wrapped text.
    const match = value.match(
      /upi:\/\/pay\?[^\s"'<>]+/i
    );

    if (match) {
      value = match[0].replace(/[),.;]+$/, "");
    }

    if (/^upi:\/\/pay\?/i.test(value)) {
      return {
        kind: "upi",
        raw: value
      };
    }

    const nested = findNestedUpi(value);

    if (nested) {
      return {
        kind: "upi",
        raw: nested
      };
    }

    if (/^https?:\/\//i.test(value)) {
      return {
        kind: "url",
        raw: value
      };
    }

    return {
      kind: "other",
      raw: value
    };
  }

  function findNestedUpi(input) {
    // Search for UPI URI in an EMV-style payload.
    const match = input.match(
      /upi:\/\/pay\?[^\s"'<>]+/i
    );

    if (match) {
      return match[0].replace(/[),.;]+$/, "");
    }

    return null;
  }

  function parseUpi(raw) {
    try {
      const url = new URL(raw);

      if (
        url.protocol.toLowerCase() !== "upi:" ||
        url.hostname.toLowerCase() !== "pay"
      ) {
        return null;
      }

      const params = Object.fromEntries(
        url.searchParams.entries()
      );

      if (!params.pa || !params.pn) {
        return null;
      }

      if (
        params.cu &&
        params.cu.toUpperCase() !== "INR"
      ) {
        return null;
      }

      if (
        params.am &&
        (
          !/^\d+(\.\d{1,2})?$/.test(params.am) ||
          Number(params.am) <= 0
        )
      ) {
        return null;
      }

      return params;

    } catch (error) {
      return null;
    }
  }

  // ============================================================
  // DISPLAY PAYMENT DETAILS
  // ============================================================

  function renderResult(raw) {
    const decoded = decodeText(raw);

    if (!decoded || decoded.kind !== "upi") {
      const message = decoded?.kind === "url"
        ? "This QR contains a website link, not a standard UPI payment QR."
        : "QR detected, but it isn't a supported UPI payment QR.";

      setStatus(message, true);
      return;
    }

    const params = parseUpi(decoded.raw);

    if (!params) {
      setStatus(
        "UPI data is incomplete or malformed. No payment link was created.",
        true
      );
      return;
    }

    stopCamera();

    state.payload = decoded.raw;
    state.params = params;
    state.paymentUri = null;
    state.fixedAmount = Boolean(params.am);

    $("payeeName").textContent =
      params.pn || "Payee name unavailable";

    $("payeeVpa").textContent = params.pa;

    $("payeeAvatar").textContent =
      (params.pn || "₹").trim().charAt(0).toUpperCase();

    $("qrType").textContent = params.mc
      ? `Merchant · MCC ${params.mc}`
      : "UPI payment";

    $("qrAmount").textContent = params.am
      ? `₹${money(params.am)}`
      : "Not fixed";

    $("amountInput").value = params.am || "";

    $("amountInput").disabled = state.fixedAmount;

    $("amountHint").textContent = state.fixedAmount
      ? "Fixed by QR"
      : "Optional for static QR";

    $("lockedWarning").hidden = !state.fixedAmount;

    resultCard.hidden = false;

    resultCard.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });

    setStatus(
      "UPI QR decoded. Verify the details below."
    );
  }

  // ============================================================
  // IMAGE QR SCANNER
  // ============================================================

  function decodeImage(file) {
    if (!file || !file.type?.startsWith("image/")) {
      setStatus("Please choose an image file.", true);
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      setStatus(
        "Image is too large. Choose an image under 15 MB.",
        true
      );
      return;
    }

    if (!ctx) {
      setStatus(
        "Image scanning is unavailable in this browser.",
        true
      );
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const scale = Math.min(
        1,
        1800 / Math.max(image.width, image.height)
      );

      canvas.width = Math.max(
        1,
        Math.round(image.width * scale)
      );

      canvas.height = Math.max(
        1,
        Math.round(image.height * scale)
      );

      ctx.drawImage(
        image,
        0,
        0,
        canvas.width,
        canvas.height
      );

      URL.revokeObjectURL(objectUrl);

      if (typeof window.jsQR !== "function") {
        setStatus(
          "QR engine did not load. Connect to the internet once and reload Kova.",
          true
        );
        return;
      }

      try {
        const imageData = ctx.getImageData(
          0,
          0,
          canvas.width,
          canvas.height
        );

        const code = window.jsQR(
          imageData.data,
          imageData.width,
          imageData.height,
          {
            inversionAttempts: "attemptBoth"
          }
        );

        if (!code) {
          setStatus(
            "No readable QR found. Try a sharper, uncropped image.",
            true
          );
          return;
        }

        renderResult(code.data);

      } catch (error) {
        console.error(error);

        setStatus(
          "Could not process this image. Try another QR image.",
          true
        );
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setStatus("Could not read this image.", true);
    };

    image.src = objectUrl;

    setStatus("Reading QR on this device…");
  }

  fileInput?.addEventListener("change", (event) => {
    decodeImage(event.target.files?.[0]);
  });

  // ============================================================
  // DRAG AND DROP
  // ============================================================

  $("dropzone")?.addEventListener("dragover", (event) => {
    event.preventDefault();

    $("dropzone").classList.add("dragging");
  });

  $("dropzone")?.addEventListener("dragleave", () => {
    $("dropzone").classList.remove("dragging");
  });

  $("dropzone")?.addEventListener("drop", (event) => {
    event.preventDefault();

    $("dropzone").classList.remove("dragging");

    decodeImage(event.dataTransfer?.files?.[0]);
  });

  // ============================================================
  // CLIPBOARD IMAGE
  // ============================================================

  async function pasteImage() {
    try {
      if (!navigator.clipboard?.read) {
        throw new Error(
          "Clipboard image reading isn't supported here. Use Choose image."
        );
      }

      const items = await navigator.clipboard.read();

      for (const item of items) {
        const imageType = item.types.find((type) =>
          type.startsWith("image/")
        );

        if (imageType) {
          const blob = await item.getType(imageType);

          decodeImage(blob);
          return;
        }
      }

      setStatus("No image found in clipboard.", true);

    } catch (error) {
      setStatus(
        error.message ||
        "Clipboard access was blocked. Use Choose image.",
        true
      );
    }
  }

  $("pasteBtn")?.addEventListener("click", pasteImage);

  document.addEventListener("paste", (event) => {
    const item = [
      ...(event.clipboardData?.items || [])
    ].find((entry) =>
      entry.type.startsWith("image/")
    );

    if (item) {
      const file = item.getAsFile();

      if (file) {
        decodeImage(file);
      }
    }
  });

  // ============================================================
  // LIVE CAMERA SCANNER
  // ============================================================

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus(
        "Camera scanning isn't available in this browser. Upload an image instead.",
        true
      );
      return;
    }

    if (typeof window.jsQR !== "function") {
      setStatus(
        "QR engine is still loading. Please try again.",
        true
      );
      return;
    }

    try {
      state.cameraStream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: {
              ideal: "environment"
            }
          },
          audio: false
        });

      const video = $("camera");

      video.hidden = false;
      video.srcObject = state.cameraStream;

      await video.play();

      setStatus("Point your camera at a UPI QR code.");

      const scan = () => {
        if (!state.cameraStream) return;

        if (video.readyState < 2) {
          state.cameraFrame =
            requestAnimationFrame(scan);
          return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        if (canvas.width && canvas.height) {
          try {
            ctx.drawImage(
              video,
              0,
              0,
              canvas.width,
              canvas.height
            );

            const imageData = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height
            );

            const code = window.jsQR(
              imageData.data,
              imageData.width,
              imageData.height,
              {
                inversionAttempts: "attemptBoth"
              }
            );

            if (code) {
              renderResult(code.data);
              return;
            }

          } catch (error) {
            // Continue scanning.
          }
        }

        state.cameraFrame =
          requestAnimationFrame(scan);
      };

      scan();

    } catch (error) {
      console.error(error);

      stopCamera();

      setStatus(
        "Camera permission denied or unavailable. You can upload a QR image instead.",
        true
      );
    }
  }

  function stopCamera() {
    if (state.cameraFrame) {
      cancelAnimationFrame(state.cameraFrame);
      state.cameraFrame = null;
    }

    if (state.cameraStream) {
      state.cameraStream
        .getTracks()
        .forEach((track) => track.stop());

      state.cameraStream = null;
    }

    const video = $("camera");

    if (video) {
      video.pause();
      video.srcObject = null;
      video.hidden = true;
    }
  }

  $("cameraBtn")?.addEventListener("click", () => {
    if (state.cameraStream) {
      stopCamera();
      setStatus("Camera stopped.");
    } else {
      startCamera();
    }
  });

  // ============================================================
  // LOCAL LEDGER
  // ============================================================

  function readLedger() {
    try {
      const data = JSON.parse(
        localStorage.getItem(LEDGER_KEY) || "[]"
      );

      return Array.isArray(data) ? data : [];

    } catch (error) {
      return [];
    }
  }

  function saveLedger(entry) {
    try {
      const list = [
        entry,
        ...readLedger()
      ].slice(0, 30);

      localStorage.setItem(
        LEDGER_KEY,
        JSON.stringify(list)
      );

      renderLedger();

    } catch (error) {
      console.warn("Could not save ledger.", error);
    }
  }

  function renderLedger() {
    const list = readLedger();
    const element = $("ledgerList");

    if (!element) return;

    if (!list.length) {
      element.innerHTML =
        '<p class="empty-ledger">No handoffs recorded yet.</p>';

      return;
    }

    element.replaceChildren(
      ...list.map((item) => {
        const row = document.createElement("div");
        row.className = "ledger-item";

        const left = document.createElement("div");
        const title = document.createElement("b");
        const meta = document.createElement("span");
        const amount = document.createElement("div");

        title.textContent =
          item.payee || "Unknown payee";

        meta.textContent = [
          item.vpa,
          item.vehicle,
          item.note,
          item.at
            ? new Date(item.at).toLocaleString()
            : ""
        ]
          .filter(Boolean)
          .join(" · ");

        amount.className = "ledger-amount";

        amount.textContent = item.amount
          ? `₹${money(item.amount)}`
          : "Amount not set";

        left.append(title, meta);
        row.append(left, amount);

        return row;
      })
    );
  }

  $("clearLedgerBtn")?.addEventListener("click", () => {
    if (
      confirm(
        "Clear this device's Kova handoff history?"
      )
    ) {
      try {
        localStorage.removeItem(LEDGER_KEY);
      } catch (error) {
        console.warn(error);
      }

      renderLedger();
    }
  });

  // ============================================================
  // RESET SCANNER
  // ============================================================

  $("resetBtn")?.addEventListener("click", () => {
    stopCamera();

    state.payload = null;
    state.params = null;
    state.fixedAmount = false;
    state.paymentUri = null;

    resultCard.hidden = true;

    fileInput.value = "";

    $("vehicleInput").value = "";
    $("noteInput").value = "";
    $("amountInput").value = "";
    $("amountInput").disabled = false;

    setStatus("Ready for another QR.");
  });

  // ============================================================
  // COPY UPI ID
  // ============================================================

  $("copyVpaBtn")?.addEventListener("click", async () => {
    if (!state.params?.pa) {
      setStatus("No UPI ID available to copy.", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(
        state.params.pa
      );

      setStatus("UPI ID copied.");

    } catch (error) {
      setStatus(
        "Clipboard permission unavailable. Select and copy the UPI ID manually.",
        true
      );
    }
  });

  // ============================================================
  // BUILD PAYMENT URI
  // ============================================================

  function buildPaymentUri() {
    if (!state.params?.pa || !state.params?.pn) {
      throw new Error(
        "Scan a valid UPI QR before continuing."
      );
    }

    // Preserve the original UPI parameters.
    const params = new URLSearchParams(state.params);

    const enteredAmount =
      $("amountInput").value.trim();

    // Do not overwrite QR-locked amounts.
    if (!state.fixedAmount && enteredAmount) {
      const amount = Number(enteredAmount);

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !/^\d+(\.\d{1,2})?$/.test(enteredAmount)
      ) {
        throw new Error(
          "Enter a valid amount with up to two decimal places."
        );
      }

      params.set("am", amount.toFixed(2));
      params.set("cu", "INR");
    }

    const note = $("noteInput").value.trim();

    if (note && !state.params.tn) {
      params.set("tn", note.slice(0, 80));
    }

    return `upi://pay?${params.toString()}`;
  }

  // ============================================================
  // CONTINUE TO PAYMENT
  // ============================================================

  $("continueBtn")?.addEventListener("click", () => {
    try {
      const uri = buildPaymentUri();

      state.paymentUri = uri;

      // This is a handoff record, NOT payment confirmation.
      saveLedger({
        payee: state.params.pn,
        vpa: state.params.pa,

        amount:
          state.params.am ||
          $("amountInput").value.trim() ||
          "",

        vehicle: $("vehicleInput").value.trim(),
        note: $("noteInput").value.trim(),

        at: Date.now()
      });

      $("appDialog").showModal();

    } catch (error) {
      setStatus(
        error.message || "Could not prepare payment details.",
        true
      );
    }
  });

  $("closeDialog")?.addEventListener("click", () => {
    $("appDialog").close();
  });

  // ============================================================
  // PAYMENT APP URL GENERATOR
  // ============================================================

  function appUri(app) {
    const generic = state.paymentUri;

    if (
      !generic ||
      !/^upi:\/\/pay\?/i.test(generic)
    ) {
      return null;
    }

    // GOOGLE PAY
    if (app === "gpay") {
      if (isIOS()) {
        // Google Pay iOS deep link.
        return generic.replace(
          /^upi:\/\/pay\?/i,
          "gpay://upi/pay?"
        );
      }

      // Google Pay Android deep link.
      return generic.replace(
        /^upi:\/\/pay\?/i,
        "tez://upi/pay?"
      );
    }

    // PHONEPE
    if (app === "phonepe") {
      return generic.replace(
        /^upi:/i,
        "phonepe:"
      );
    }

    // PAYTM
    if (app === "paytm") {
      return generic.replace(
        /^upi:/i,
        "paytmmp:"
      );
    }

    // GENERIC UPI CHOOSER
    if (app === "generic") {
      return generic;
    }

    return null;
  }

  // ============================================================
  // APP BUTTON CLICK HANDLERS
  // ============================================================

  document.querySelectorAll("[data-app]").forEach((button) => {
    button.addEventListener("click", () => {
      const app = button.dataset.app;
      const uri = appUri(app);

      if (!uri) {
        setStatus(
          "Unable to create the payment link. Please scan the QR again.",
          true
        );

        return;
      }

      // Close dialog first.
      $("appDialog").close();

      // Launch directly from the user's click.
      // This preserves the browser's user-initiated navigation context.
      window.location.href = uri;
    });
  });

  // ============================================================
  // IOS SHORTCUT / ANDROID SHARE TARGET
  // ============================================================

  async function processShared() {
    const params = new URLSearchParams(
      location.search
    );

    // iOS Shortcut: ?upi=upi%3A%2F%2Fpay...
    const upi = params.get("upi");

    if (upi) {
      history.replaceState(
        {},
        "",
        location.pathname
      );

      renderResult(upi);
      return;
    }

    // Android shared image.
    if (
      params.get("shared") === "1" &&
      "caches" in window
    ) {
      try {
        const cache = await caches.open(
          "kova-shared-v1"
        );

        const response = await cache.match(
          "/__kova_shared_image__"
        );

        if (response) {
          const blob = await response.blob();

          await cache.delete(
            "/__kova_shared_image__"
          );

          decodeImage(blob);
        }

        history.replaceState(
          {},
          "",
          location.pathname
        );

      } catch (error) {
        setStatus(
          "Couldn't open the shared image. Please upload it again.",
          true
        );
      }
    }
  }

  // ============================================================
  // INITIALIZE APP
  // ============================================================

  renderLedger();

  processShared();

  // Register service worker only on HTTPS.
  if (
    "serviceWorker" in navigator &&
    location.protocol === "https:"
  ) {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((error) => {
        console.warn(
          "Service worker registration failed.",
          error
        );

        setStatus(
          "Offline support could not be enabled in this browser.",
          true
        );
      });
  }

  // Stop camera when leaving the page.
  window.addEventListener("pagehide", stopCamera);

})();
