document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const btnText = document.getElementById('btn-text');
    const btnIcon = document.getElementById('btn-icon');
    const statusText = document.getElementById('status-text');
    const statusIndicator = document.getElementById('status-indicator');
    const msgBox = document.getElementById('msg-box');
    
    const inputWordLimit = document.getElementById('input-word-limit');
    const inputTabLimit = document.getElementById('input-tab-limit');
    const inputDocLimit = document.getElementById('input-doc-limit');
    const inputGptUrl = document.getElementById('input-gpt-url');
    const inputDocId = document.getElementById('input-doc-id');
    const saveSettingsBtn = document.getElementById('save-settings-btn');

    const statWordLimit = document.getElementById('stat-word-limit');
    const statTabLimit = document.getElementById('stat-tab-limit');
    const statDocLimit = document.getElementById('stat-doc-limit');

    let isEngineRunning = false; // State ON/OFF

    const updateFooterUI = (wordLimit, tabLimit, docLimit) => {
        let formattedWords = wordLimit >= 1000 ? (wordLimit / 1000) + 'K' : wordLimit;
        statWordLimit.innerText = `${formattedWords} Kata`;
        statTabLimit.innerText = `${tabLimit}/Doc`;
        statDocLimit.innerText = docLimit;
    };

    const loadSettings = () => {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['wordLimit', 'tabLimit', 'docLimit', 'gptUrl', 'docId', 'isEngineRunning'], (result) => {
                if (result.wordLimit) inputWordLimit.value = result.wordLimit;
                if (result.tabLimit) inputTabLimit.value = result.tabLimit;
                if (result.docLimit) inputDocLimit.value = result.docLimit;
                if (result.gptUrl) inputGptUrl.value = result.gptUrl;
                if (result.docId) inputDocId.value = result.docId;

                // Kembalikan state tombol jika sebelumnya sedang jalan
                if (result.isEngineRunning) {
                    setEngineState(true, false);
                }
                updateFooterUI(inputWordLimit.value, inputTabLimit.value, inputDocLimit.value);
            });
        }
    };

    saveSettingsBtn.onclick = () => {
        const wl = parseInt(inputWordLimit.value, 10) || 15000;
        const tl = parseInt(inputTabLimit.value, 10) || 3;
        const dl = parseInt(inputDocLimit.value, 10) || 9;
        const url = inputGptUrl.value.trim() || "https://chatgpt.com/";
        const docId = inputDocId.value.trim();

        saveSettingsBtn.innerText = 'TERSIMPAN ✓';
        saveSettingsBtn.classList.add('success');
        setTimeout(() => {
            saveSettingsBtn.innerText = 'SIMPAN PENGATURAN';
            saveSettingsBtn.classList.remove('success');
        }, 2000);

        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ wordLimit: wl, tabLimit: tl, docLimit: dl, gptUrl: url, docId: docId }, () => {
                updateFooterUI(wl, tl, dl);
                chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", wordLimit: wl, tabLimit: tl, docLimit: dl, gptUrl: url, docId: docId });
            });
        }
    };

    // FUNGSI UNTUK MENGUBAH TAMPILAN ON/OFF
    function setEngineState(active, sendMessage = true) {
        isEngineRunning = active;
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ isEngineRunning: active });
        }

        if (active) {
            // MODE ON (Berjalan)
            startBtn.classList.add('stop-btn');
            btnText.innerText = 'MATIKAN ENGINE (STOP)';
            btnIcon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>'; // Ikon kotak (Stop)
            
            statusText.innerText = 'ENGINE ACTIVE';
            statusText.style.color = '#10b981';
            statusIndicator.classList.add('is-active');
            msgBox.style.display = 'block';

            if (sendMessage && typeof chrome !== 'undefined' && chrome.runtime) {
                chrome.runtime.sendMessage({ type: "START_ENGINE" }, (response) => {
                    if (response && response.status === "auth_failed") {
                        // Login gagal — kembalikan ke standby
                        statusText.innerText = 'LOGIN GAGAL!';
                        statusText.style.color = '#ef4444';
                        setTimeout(() => setEngineState(false, false), 2000);
                    }
                });
            }
        } else {
            // MODE OFF (Berhenti)
            startBtn.classList.remove('stop-btn');
            btnText.innerText = 'AKTIFKAN ENGINE';
            btnIcon.innerHTML = '<path d="M13 10V3L4 14h7v7l9-11h-7z"></path>'; // Ikon petir (Start)
            
            statusText.innerText = 'Standby Mode';
            statusText.style.color = '#9ca3af';
            statusIndicator.classList.remove('is-active');
            msgBox.style.display = 'none';

            if (sendMessage && typeof chrome !== 'undefined' && chrome.runtime) {
                chrome.runtime.sendMessage({ type: "STOP_ENGINE" });
            }
        }
    }

    startBtn.onclick = () => {
        // Toggle (Balikkan state)
        setEngineState(!isEngineRunning, true);
    };

    loadSettings();
});