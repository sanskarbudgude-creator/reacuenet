// ---- node finder: runs ONLY inside the Android app (APK). In the browser served by Flask it does nothing ----
(function () {
    const isApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
        || location.protocol === "file:" || location.protocol === "capacitor:"
        || (location.hostname === "localhost" && !location.port);
    if (!isApp) return;

    const NODE_PORT = 5000;
    // If your server has a fixed address, type it here, e.g. ["192.168.1.23"]. It is tried first.
    const KNOWN_NODES = [];
    // Home/router networks: every address in these ranges is checked during the full scan.
    const COMMON_SUBNETS = ["192.168.0", "192.168.1", "192.168.2", "192.168.10", "192.168.100", "10.0.0", "10.0.1"];
    const PRIORITY = ["192.168.43.1", "192.168.49.1", "192.168.137.1", "172.20.10.1", "10.0.0.1"];
    const _fetch = window.fetch.bind(window);
    let nodeBase = localStorage.getItem("rescue_node") || "";
    let finding = null, lastTry = 0, lastFull = 0;

    // "node" = a RescueNet server answered. "alive" = some device answered fast (even with an error).
    // "dead" = nothing there (request timed out).
    async function probeKind(base) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 1200);
        const t0 = Date.now();
        try {
            const r = await _fetch(base + "/api/ping", { signal: c.signal });
            let d = null;
            try { d = await r.json(); } catch (e) {}
            return d && d.status === "active" ? "node" : "alive";
        } catch (e) {
            return Date.now() - t0 < 600 ? "alive" : "dead";
        } finally { clearTimeout(t); }
    }

    async function probe(base) { return (await probeKind(base)) === "node"; }

    // checks a list of addresses; returns the node found (or "") and which addresses were alive
    async function scanList(ips) {
        const alive = [];
        for (let i = 0; i < ips.length; i += 50) {
            const batch = ips.slice(i, i + 50);
            const res = await Promise.all(batch.map(async ip => [ip, await probeKind("http://" + ip + ":" + NODE_PORT)]));
            for (const [ip, kind] of res) {
                if (kind === "node") return { node: "http://" + ip + ":" + NODE_PORT, alive };
                if (kind === "alive") alive.push(ip);
            }
        }
        return { node: "", alive };
    }

    // the phone's own Wi-Fi network(s), e.g. ["10.164.35"], from the small native plugin in the APK
    async function localSubnets() {
        try {
            const cap = window.Capacitor;
            let res = null;
            if (cap && cap.Plugins && cap.Plugins.NetInfo) res = await cap.Plugins.NetInfo.getAddresses();
            else if (cap && cap.nativePromise) res = await cap.nativePromise("NetInfo", "getAddresses", {});
            const list = (res && res.addresses) || [];
            return [...new Set(list.map(a => a.split("/")[0].split(".").slice(0, 3).join(".")))];
        } catch (e) { return []; }
    }

    async function scanForNode(full) {
        const quick = [...new Set([...KNOWN_NODES, ...PRIORITY])];
        let r = await scanList(quick);
        if (r.node || !full) return r.node;

        // Best case: we know which network we are on, so only that network is checked (fast, light on battery).
        const locals = await localSubnets();
        if (locals.length) {
            const own = [];
            for (const sub of locals) {
                for (let h = 1; h < 255; h++) own.push(sub + "." + h);
            }
            r = await scanList(own);
            return r.node;
        }

        // Find which network this phone is on: gateways of every 192.168.x network answer fast on the right one.
        const gateways = [];
        for (let n = 0; n < 256; n++) {
            const ip = "192.168." + n + ".1";
            if (!quick.includes(ip)) gateways.push(ip);
        }
        r = await scanList(gateways);
        if (r.node) return r.node;

        const subnets = [...new Set(r.alive.concat(quick).map(ip => ip.split(".").slice(0, 3).join(".")))];
        let toScan = subnets.length <= 6 ? subnets : [];     // too many "alive" = no real local network
        if (r.alive.length === 0 || toScan.length === 0) toScan = COMMON_SUBNETS;

        const hosts = [];
        for (const sub of toScan) {
            for (let h = 2; h < 255; h++) hosts.push(sub + "." + h);
        }
        r = await scanList(hosts);
        return r.node;
    }

    // Backup + checkup: tap the status text 5 times quickly. You can type the server address by hand,
    // and the app then shows a short report of what works and what fails.
    let taps = 0, tapTimer = null;

    async function timedTest(label, url, opts) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 3500);
        const t0 = Date.now();
        try {
            const r = await _fetch(url, Object.assign({ signal: c.signal }, opts || {}));
            let body = "";
            if (r.type !== "opaque") { try { body = JSON.stringify(await r.json()); } catch (e) {} }
            return label + ": OK " + (r.type === "opaque" ? "(reply received)" : r.status + " " + body) + " [" + (Date.now() - t0) + " ms]";
        } catch (e) {
            return label + ": FAILED " + (e && e.name) + " - " + (e && e.message) + " [" + (Date.now() - t0) + " ms]";
        } finally { clearTimeout(t); }
    }

    async function runCheckup() {
        const lines = [];
        lines.push("Page address: " + location.href);
        lines.push("Browser says online: " + navigator.onLine);
        const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent || "");
        lines.push("WebView: " + (m ? m[1] : "unknown"));
        try {
            const cap = window.Capacitor;
            let res = null;
            if (cap && cap.Plugins && cap.Plugins.NetInfo) res = await cap.Plugins.NetInfo.getAddresses();
            else if (cap && cap.nativePromise) res = await cap.nativePromise("NetInfo", "getAddresses", {});
            lines.push("Phone Wi-Fi addresses: " + JSON.stringify(res && res.addresses));
        } catch (e) { lines.push("Phone address plugin failed: " + (e && e.message)); }
        lines.push("Server being used: " + (nodeBase || "none found yet"));
        if (nodeBase) {
            lines.push(await timedTest("Test 1 (normal)", nodeBase + "/api/ping"));
            lines.push(await timedTest("Test 2 (no-cors)", nodeBase + "/api/ping", { mode: "no-cors" }));
        }
        window.alert(lines.join("\n"));
    }

    document.addEventListener("click", (e) => {
        if (!e.target || e.target.id !== "statusTitle") return;
        taps++;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { taps = 0; }, 2500);
        if (taps >= 5) {
            taps = 0;
            const v = window.prompt("Server address (example 10.1.2.3). Leave empty to only run the check.", nodeBase.replace("http://", "").replace(":" + NODE_PORT, ""));
            if (v === null) return;
            if (v.trim()) {
                nodeBase = "http://" + v.trim().replace(/^https?:\/\//, "").replace(/:\d+$/, "") + ":" + NODE_PORT;
                localStorage.setItem("rescue_node", nodeBase);
            }
            runCheckup();
        }
    });

    function findNode() {
        if (finding) return finding;
        if (Date.now() - lastTry < 3000) return Promise.resolve("");
        lastTry = Date.now();
        finding = (async () => {
            // first re-check the last server we used: if it was only restarted, we reconnect within seconds
            const remembered = nodeBase || localStorage.getItem("rescue_node") || "";
            if (remembered && await probe(remembered)) { nodeBase = remembered; return nodeBase; }
            const full = Date.now() - lastFull > 30000;   // network scan at most every 30 seconds
            if (full) lastFull = Date.now();
            nodeBase = await scanForNode(full);
            if (nodeBase) localStorage.setItem("rescue_node", nodeBase);
            return nodeBase;
        })().finally(() => { finding = null; });
        return finding;
    }

    window.fetch = async (u, o) => {
        if (typeof u !== "string" || !u.startsWith("/")) return _fetch(u, o);
        let base = nodeBase;
    if (!base) {
        const sig = o && o.signal;
        base = sig
            ? await Promise.race([findNode(), new Promise(r => sig.addEventListener("abort", () => r(""), { once: true }))])
            : await findNode();
    }
        if (!base) throw new TypeError("No volunteer node found");
        try {
            return await _fetch(base + u, o);
        } catch (e) {
            nodeBase = "";   // node changed or left, search again next time
            throw e;
        }
    };
})();

let volunteerSessionPin = "";
let isSyncing = false;
let serverQueueCount = 0;
let seenQueueLength = 0;

// header badge = reports waiting on this device (+ NEW unseen requests when volunteer is logged in)
function updateQueueBadge() {
    const queueCount = document.getElementById("queueCount");
    if (!queueCount) return;
    const local = JSON.parse(localStorage.getItem('rescue_queue') || '[]').length;
    const unseen = volunteerSessionPin ? Math.max(0, serverQueueCount - seenQueueLength) : 0;
    queueCount.innerText = local + unseen;
}

// counts new requests on the server and updates the badge only (list is NOT touched)
async function pollQueueCount() {
    if (!volunteerSessionPin) return;
    try {
        const response = await fetchWithTimeout("/api/volunteer/requests", { headers: { "X-Volunteer-Pin": volunteerSessionPin } });
        if (!response.ok) return;
        const data = await response.json();
        serverQueueCount = (data.queue || []).length;
        if (seenQueueLength > serverQueueCount) seenQueueLength = serverQueueCount;
        updateQueueBadge();
    } catch (e) {}
}

// fetch that gives up quickly, so an unreachable network never freezes the app
async function fetchWithTimeout(url, options = {}, ms = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    checkNetworkStatus();
    
    setInterval(checkNetworkStatus, 2000);

    // keep the badge live: it counts new requests, the list only updates on Refresh
    setInterval(pollQueueCount, 3000);

    window.addEventListener('focus', checkNetworkStatus);
    window.addEventListener('online', checkNetworkStatus);
    window.addEventListener('offline', checkNetworkStatus);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            checkNetworkStatus();
        }
    });

    const sosForm = document.getElementById("sosForm");
    if (sosForm) {
        sosForm.addEventListener("submit", handleCitizenSubmit);
    }
});

async function safeSyncWithVolunteer() {
    if (isSyncing) return;
    const queueKey = 'rescue_queue';
    let offlineQueue = JSON.parse(localStorage.getItem(queueKey) || '[]');
    
    if (offlineQueue.length === 0) return;

    isSyncing = true;
    let remainingCount = offlineQueue.length;

    try {
        const response = await fetchWithTimeout("/api/ping");

        if (response.status === 200) {
            const failed = [];
            for (let item of offlineQueue) {
                try {
                    const res = await fetchWithTimeout("/api/submit", {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item)
                    });
                    if (!res.ok) failed.push(item);
                } catch (e) {
                    failed.push(item);
                }
            }

            // keep failed items + anything added while syncing
            const current = JSON.parse(localStorage.getItem(queueKey) || '[]');
            const remaining = failed.concat(current.slice(offlineQueue.length));
            if (remaining.length === 0) {
                localStorage.removeItem(queueKey);
            } else {
                localStorage.setItem(queueKey, JSON.stringify(remaining));
            }
            remainingCount = remaining.length;

            updateQueueBadge();
        }
    } catch (error) {
        console.log("No authorized volunteer node reachable. Keeping local queue safe.");
    } finally {
        isSyncing = false;
    }

    if (remainingCount === 0) {
        checkNetworkStatus();
        if (typeof pollQueueCount === "function") {
            pollQueueCount();
        }
    }
}

function switchTab(tabName) {
    const citizenTab = document.getElementById("tabCitizen");
    const volunteerTab = document.getElementById("tabVolunteer");
    const citizenView = document.getElementById("viewCitizen");
    const volunteerView = document.getElementById("viewVolunteer");

    if (tabName === 'citizen') {
        citizenTab.classList.add("active");
        volunteerTab.classList.remove("active");
        citizenView.classList.remove("hidden");
        volunteerView.classList.add("hidden");
    } else {
        volunteerTab.classList.add("active");
        citizenTab.classList.remove("active");
        volunteerView.classList.remove("hidden");
        citizenView.classList.add("hidden");
        
        pollQueueCount();
        fetchCentralRecords();
    }
}

async function checkNetworkStatus() {
    const statusDot = document.getElementById("statusDot");
    const statusTitle = document.getElementById("statusTitle");
    const queueCount = document.getElementById("queueCount");

    const offlineQueue = JSON.parse(localStorage.getItem('rescue_queue') || '[]');
    const targetCount = offlineQueue.length + (volunteerSessionPin ? Math.max(0, serverQueueCount - seenQueueLength) : 0);

    if (queueCount && parseInt(queueCount.innerText || "-1") !== targetCount) {
        queueCount.innerText = targetCount;
    }

    const showUnreachable = () => {
        if (!navigator.onLine) {
            if (statusDot) statusDot.className = "status-dot dot-yellow";
            if (statusTitle) statusTitle.innerText = "Offline / No Connection";
        } else {
            if (statusDot) statusDot.className = "status-dot dot-red";
            if (statusTitle) statusTitle.innerText = "Connected / Unauthorized Network";
        }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    try {
        const response = await fetch("/api/ping", { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.status === 200 || response.status === 401) {
            if (statusDot) statusDot.className = "status-dot dot-green";
            if (statusTitle) statusTitle.innerText = "Online / Authorized Node";

            if (offlineQueue.length > 0) {
                await safeSyncWithVolunteer();
            }
        } else {
            showUnreachable();
        }
    } catch (e) {
        clearTimeout(timeoutId);
        showUnreachable();
    }
}

async function handleCitizenSubmit(e) {
    e.preventDefault();
    const alertBox = document.getElementById("citizenAlert");

    const payload = {
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        name: document.getElementById("citizenName")?.value.trim() || "Anonymous",
        location: document.getElementById("citizenLocation")?.value.trim() || "Unknown Location",
        people_count: parseInt(document.getElementById("peopleCount")?.value || document.getElementById("citizenPeopleCount")?.value) || 1,
        needs: document.getElementById("neededAid")?.value.trim() || document.getElementById("citizenDetails")?.value.trim() || "Emergency Aid",
        urgency: document.getElementById("urgency")?.value || "Medium"
    };

    const queueCount = document.getElementById("queueCount");

    // Send directly to server backend queue so volunteer list increases immediately
    let sentToServer = false;
    try {
        const response = await fetchWithTimeout("/api/submit", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            sentToServer = true;
        } else {
            throw new Error("Server submission failed");
        }
    } catch (err) {
        // Fallback: store in local storage if offline
        const queueKey = 'rescue_queue';
        let offlineQueue = JSON.parse(localStorage.getItem(queueKey) || '[]');
        offlineQueue.push(payload);
        localStorage.setItem(queueKey, JSON.stringify(offlineQueue));
    }

    updateQueueBadge();

    if (sentToServer) {
        showAlert(alertBox, "success", "SOS Broadcasted Successfully!");
    } else {
        showAlert(alertBox, "success", "No volunteer node in range. Saved on this device and will sync automatically.");
    }
    document.getElementById("sosForm").reset();
    
    checkNetworkStatus();
    if (typeof pollQueueCount === "function") {
        pollQueueCount();
    }
}

async function authenticateVolunteer() {
    const pin = document.getElementById("volunteerPin").value.trim();
    const authAlert = document.getElementById("authAlert");

    if (!pin) {
        showAlert(authAlert, "error", "Please enter a PIN.");
        return;
    }

    try {
        const response = await fetch("/api/verify-pin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: pin })
        });

        if (response.ok) {
            volunteerSessionPin = pin;
            document.getElementById("volunteerAuthBlock").classList.add("hidden");
            document.getElementById("volunteerDashboardBlock").classList.remove("hidden");
            fetchVolunteerRequests();
            fetchCentralRecords();
        } else {
            showAlert(authAlert, "error", "Invalid PIN code.");
        }
    } catch (err) {
        showAlert(authAlert, "error", "Server connection failed.");
    }
}

async function updateVolunteerPin() {
    const currentPin = document.getElementById("currentPin").value.trim();
    const newPin = document.getElementById("newPin").value.trim();
    const alertBox = document.getElementById("changePinAlert");

    if (!currentPin || !newPin) {
        showAlert(alertBox, "error", "Please complete both PIN fields.");
        return;
    }

    try {
        const response = await fetch("/api/change-pin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current_pin: currentPin, new_pin: newPin })
        });

        const data = await response.json();

        if (response.ok) {
            showAlert(alertBox, "success", data.message);
            document.getElementById("currentPin").value = "";
            document.getElementById("newPin").value = "";
            document.getElementById("volunteerPin").value = newPin; 
            volunteerSessionPin = newPin;
        } else {
            showAlert(alertBox, "error", data.message);
        }
    } catch (err) {
        showAlert(alertBox, "error", "Server error. Could not change PIN.");
    }
}

function showInlinePurgeConfirm() {
    document.getElementById("purgeInitialBlock").classList.add("hidden");
    document.getElementById("purgeConfirmBlock").classList.remove("hidden");
}

function hideInlinePurgeConfirm() {
    document.getElementById("purgeConfirmBlock").classList.add("hidden");
    document.getElementById("purgeInitialBlock").classList.remove("hidden");
}

async function executeDatabasePurge() {
    const activePin = volunteerSessionPin || document.getElementById("volunteerPin").value.trim();
    const alertBox = document.getElementById("purgeAlert");

    try {
        const response = await fetch("/api/clear-database", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: activePin })
        });

        const data = await response.json();

        if (response.ok) {
            showAlert(alertBox, "success", data.message);
            fetchVolunteerRequests();
            fetchCentralRecords();
            checkNetworkStatus();
        } else {
            showAlert(alertBox, "error", data.message);
        }
    } catch (err) {
        showAlert(alertBox, "error", "Server communication error.");
    } finally {
        hideInlinePurgeConfirm();
    }
}

async function fetchVolunteerRequests() {
    try {
        const response = await fetch("/api/volunteer/requests", { headers: { "X-Volunteer-Pin": volunteerSessionPin } });
        if (!response.ok) return;
        const data = await response.json();
        serverQueueCount = (data.queue || []).length;
        seenQueueLength = serverQueueCount;
        updateQueueBadge();
        
        const container = document.getElementById("requestContainer");
        if (!container) return;
        container.innerHTML = "";

        if (!data.queue || data.queue.length === 0) {
            container.innerHTML = "<p style='color:#64748b; font-size:12px;'>Queue empty.</p>";
        } else {
            data.queue.forEach((item, index) => {
                const card = document.createElement("div");
                card.className = "item-card";
                card.innerHTML = `
                    <h4>#${index + 1} ${escapeHtml(item.name)} (${item.people_count} trapped)</h4>
                    <p>📍 ${escapeHtml(item.location)}</p>
                    <p>⚠️ ${escapeHtml(item.needs)} [${escapeHtml(item.urgency || '')}]</p>
                `;
                container.appendChild(card);
            });
        }
    } catch (e) {}
}

async function fetchCentralRecords() {
    try {
        const response = await fetch("/api/central/dashboard", { headers: { "X-Volunteer-Pin": volunteerSessionPin } });
        if (!response.ok) return;
        const data = await response.json();

        const container = document.getElementById("centralContainer");
        if (!container) return;
        container.innerHTML = "";

        if (!data.central_records || data.central_records.length === 0) {
            container.innerHTML = "<p style='color:#64748b; font-size:12px;'>Central Base log empty.</p>";
        } else {
            data.central_records.forEach((item, index) => {
                const card = document.createElement("div");
                card.className = "item-card central-card";
                card.innerHTML = `
                    <h4>Record #${index + 1} - ${escapeHtml(item.name)}</h4>
                    <p>📍 ${escapeHtml(item.location)} | 👥 ${item.people_count} People</p>
                    <p>⚠️ ${escapeHtml(item.needs)}</p>
                `;
                container.appendChild(card);
            });
        }
    } catch (e) {}
}

async function offloadToCentral() {
    const response = await fetch("/api/central/offload", { method: "POST", headers: { "X-Volunteer-Pin": volunteerSessionPin } });
    if (response.ok) {
        fetchVolunteerRequests();
        fetchCentralRecords();
    }
}

function showAlert(elem, type, message) {
    if (!elem) return;
    elem.className = `alert-msg ${type}`;
    elem.innerText = message;
    elem.style.display = "block";
    setTimeout(() => { elem.style.display = "none"; }, 3000);
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}