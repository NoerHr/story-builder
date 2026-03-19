let projectState = {
    isActive: false,
    gptUrl: "https://chatgpt.com/",
    maxDocs: 9,
    maxStoriesPerDoc: 3,
    targetWords: 15000, 
    
    currentDocId: null,
    docsCreated: 0,
    storiesInCurrentDoc: 0,
    totalStoriesGlobal: 0,
    
    isWriting: false, // KUNCI ANTREAN
    tabs: {} 
};

console.log("[Background] Pabrik Cerita Otonom (V9.0 - Window Lock) Berjalan.");

// === FOCUS QUEUE: Antrian tab, tunggu INJECT terkirim baru pindah ===
let focusQueue = [];
let currentFocusTabId = null;
let engineWindowId = null; // Semua tab GPT & Doc dibuka di window ini

const BRAINSTORM_PROMPT = "Berikan 10 ide tema cerita monolog personal (sudut pandang 'Aku') yang sangat liar, emosional, unik, dan tidak klise. Format jawabanmu HANYA berupa teks list biasa, satu baris untuk satu ide. Jangan berikan nomor urut, kalimat pembuka, atau penutup. Berikan idenya saja.";

function addToFocusQueue(tabId) {
    if (!focusQueue.includes(tabId)) {
        focusQueue.push(tabId);
        console.log(`[Queue] Tab ${tabId} masuk antrian. Queue: [${focusQueue}]`);
    }
    // Kalau belum ada tab yang di-focus, langsung focus
    if (!currentFocusTabId) {
        focusNextTab();
    }
}

function focusNextTab() {
    if (focusQueue.length === 0) {
        currentFocusTabId = null;
        return;
    }
    currentFocusTabId = focusQueue.shift();
    console.log(`[Queue] Focus ke Tab ${currentFocusTabId}. Sisa antrian: [${focusQueue}]`);
    // Pastikan window GPT ke depan (penting kalau split window)
    if (engineWindowId) {
        chrome.windows.update(engineWindowId, { focused: true }).catch(() => {});
    }
    chrome.tabs.update(currentFocusTabId, { active: true }).then(() => {
        // Setelah tab aktif, cek apakah perlu kirim BRAINSTORM INJECT
        let tabState = projectState.tabs[currentFocusTabId];
        if (tabState && tabState.phase === "WAIT_FOCUS") {
            tabState.phase = "BRAINSTORM";
            saveStateToDisk();
            // Tunggu 1.5 detik supaya ChatGPT UI render dulu
            setTimeout(() => {
                chrome.tabs.sendMessage(currentFocusTabId, { action: "INJECT", text: BRAINSTORM_PROMPT, phase: "BRAINSTORM" }, (resp) => {
                    if (chrome.runtime.lastError) {
                        console.error(`[Queue] Gagal kirim BRAINSTORM ke tab ${currentFocusTabId}:`, chrome.runtime.lastError.message);
                    } else {
                        console.log(`[Queue] BRAINSTORM INJECT terkirim ke tab ${currentFocusTabId}`);
                    }
                });
            }, 1500);
        }
    }).catch(() => {
        // Tab mungkin sudah ditutup, skip
        currentFocusTabId = null;
        focusNextTab();
    });
}

function onInjectSent(tabId) {
    if (tabId === currentFocusTabId) {
        // INJECT sudah benar-benar dikirim ke GPT → tunggu 1 detik → pindah
        setTimeout(() => {
            console.log(`[Queue] INJECT terkirim di Tab ${tabId}. Pindah ke tab berikutnya...`);
            currentFocusTabId = null;
            focusNextTab();
        }, 1000);
    }
}

// Helper: buat tab di window yang sama dengan tab GPT lainnya
function createTabInEngineWindow(url, active, callback) {
    const opts = { url: url, active: active };
    if (engineWindowId) opts.windowId = engineWindowId;
    chrome.tabs.create(opts, (newTab) => {
        // Simpan windowId dari tab pertama yang dibuat
        if (!engineWindowId && newTab) engineWindowId = newTab.windowId;
        if (callback) callback(newTab);
    });
}

// === PERSISTENT STATE: Simpan & pulihkan dari chrome.storage.local ===
function saveStateToDisk() {
    const saveData = {
        isActive: projectState.isActive,
        gptUrl: projectState.gptUrl,
        maxDocs: projectState.maxDocs,
        maxStoriesPerDoc: projectState.maxStoriesPerDoc,
        targetWords: projectState.targetWords,
        currentDocId: projectState.currentDocId,
        docsCreated: projectState.docsCreated,
        storiesInCurrentDoc: projectState.storiesInCurrentDoc,
        totalStoriesGlobal: projectState.totalStoriesGlobal,
        tabs: projectState.tabs
    };
    chrome.storage.local.set({ _engineState: saveData });
}

// Pulihkan state saat service worker restart
chrome.storage.local.get(['_engineState'], (result) => {
    if (result._engineState) {
        const s = result._engineState;
        projectState.isActive = s.isActive || false;
        projectState.gptUrl = s.gptUrl || "https://chatgpt.com/";
        projectState.maxDocs = s.maxDocs || 3;
        projectState.maxStoriesPerDoc = s.maxStoriesPerDoc || 9;
        projectState.targetWords = s.targetWords || 15000;
        projectState.currentDocId = s.currentDocId || null;
        projectState.docsCreated = s.docsCreated || 0;
        projectState.storiesInCurrentDoc = s.storiesInCurrentDoc || 0;
        projectState.totalStoriesGlobal = s.totalStoriesGlobal || 0;
        projectState.tabs = s.tabs || {};
        if (projectState.isActive) {
            console.log("[Background] State dipulihkan dari storage! Engine masih aktif.", projectState);
        }
    }
});

async function getAuthToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
            else resolve(token);
        });
    });
}

const FOLDER_NAME = "InkFlow AI";
let cachedFolderId = null;

async function getOrCreateFolder() {
    if (cachedFolderId) return cachedFolderId;

    try {
        const token = await getAuthToken();

        // Cari folder yang sudah ada
        const query = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const searchData = await searchRes.json();

        if (searchData.files && searchData.files.length > 0) {
            cachedFolderId = searchData.files[0].id;
            console.log(`[Background] Folder "${FOLDER_NAME}" ditemukan: ${cachedFolderId}`);
            return cachedFolderId;
        }

        // Belum ada → buat baru
        const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
        });
        const createData = await createRes.json();
        if (!createRes.ok) throw new Error("Gagal buat folder");

        cachedFolderId = createData.id;
        console.log(`[Background] Folder "${FOLDER_NAME}" dibuat baru: ${cachedFolderId}`);
        return cachedFolderId;
    } catch (error) {
        console.error("[Background] Gagal get/create folder:", error);
        return null;
    }
}

async function getUniqueDocTitle(baseTitle, folderId) {
    try {
        const token = await getAuthToken();
        // Cari semua doc di folder yang namanya mirip baseTitle
        let query = `name contains '${baseTitle}' and mimeType='application/vnd.google-apps.document' and trashed=false`;
        if (folderId) query += ` and '${folderId}' in parents`;

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(name)`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const existingNames = (data.files || []).map(f => f.name);

        // Kalau baseTitle belum ada, pakai langsung
        if (!existingNames.includes(baseTitle)) return baseTitle;

        // Cari nomor tertinggi lalu +1
        let maxNum = 1;
        for (const name of existingNames) {
            const match = name.match(/\((\d+)\)$/);
            if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
        }
        return `${baseTitle} (${maxNum + 1})`;
    } catch (error) {
        // Fallback: tambah timestamp
        return `${baseTitle} (${Date.now()})`;
    }
}

async function createNewDoc(title) {
    try {
        const token = await getAuthToken();
        const folderId = await getOrCreateFolder();
        const uniqueTitle = await getUniqueDocTitle(title, folderId);

        const body = { name: uniqueTitle, mimeType: 'application/vnd.google-apps.document' };
        if (folderId) body.parents = [folderId];

        const response = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error("Gagal API");
        console.log(`[Background] Doc Baru Berhasil Dibuat: ${uniqueTitle} (folder: ${folderId || 'root'})`);
        return { id: data.id, url: `https://docs.google.com/document/d/${data.id}/edit` };
    } catch (error) {
        console.error("[Background] Gagal buat Doc:", error);
        return null;
    }
}

async function writeToDoc(fileId, text) {
    try {
        const token = await getAuthToken();
        const url = `https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`;
        const requests = [{ insertText: { endOfSegmentLocation: { segmentId: "" }, text: text + "\n\n" } }];
        const response = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ requests }) });
        
        if (!response.ok) throw new Error("Penolakan dari Google API");
        
        console.log("[Background] 💾 1 Cerita FULL berhasil di-dump ke Google Doc.");
        return true; 
    } catch (error) {
        console.error("[Background] Gagal nulis ke Doc (Cek Internet/Auth):", error);
        return false; 
    }
}

// SISTEM ANTREAN V6.6: Aman dari semua kemungkinan Crash
async function saveFullStoryToDoc(tabId) {
    while(projectState.isWriting) {
        await new Promise(r => setTimeout(r, 1000));
    }
    projectState.isWriting = true; 

    try {
        if (!projectState.isActive) return "STOP_ALL";

        let tabState = projectState.tabs[tabId];
        
        // Buat Doc baru JIKA ID Doc masih kosong
        if (!projectState.currentDocId) {
            console.log(`[Background] Menyiapkan Dokumen Ke-${projectState.docsCreated + 1}...`);
            const newDoc = await createNewDoc(`InkFlow AI - Dokumen ${projectState.docsCreated + 1}`);
            if (newDoc) {
                projectState.currentDocId = newDoc.id;
                createTabInEngineWindow(newDoc.url, true, null);
            } else {
                return "ERROR"; 
            }
        }

        let currentStoryNum = projectState.totalStoriesGlobal + 1;
        let finalStoryText = `\n\n=========================================\nCERITA KE-${currentStoryNum} (Tab Asal: ${tabId})\n=========================================\nIde: ${tabState.currentIdea}\n\n` + tabState.storyBuffer;

        // Tembak ke Google Doc DULUAN
        let isSuccess = await writeToDoc(projectState.currentDocId, finalStoryText);

        if (!isSuccess) {
            console.warn("[Background] Teks gagal disave ke Doc! Menahan buffer agar tidak hilang.");
            return "ERROR"; 
        }

        // UPDATE ANGKA JIKA SUKSES
        tabState.storyBuffer = "";
        projectState.totalStoriesGlobal++;
        projectState.storiesInCurrentDoc++;
        saveStateToDisk(); // Persist setelah save ke Doc berhasil

        // 1. Cek target keseluruhan
        if (projectState.totalStoriesGlobal >= (projectState.maxDocs * projectState.maxStoriesPerDoc)) {
            console.log(`[Background] 🎉 TARGET TOTAL TERCAPAI (${projectState.totalStoriesGlobal} CERITA). MESIN BERHENTI OTOMATIS.`);
            return "STOP_ALL";
        }

        // 2. Cek kapasitas Doc
        if (projectState.storiesInCurrentDoc >= projectState.maxStoriesPerDoc) {
            projectState.docsCreated++;
            projectState.storiesInCurrentDoc = 0; 
            projectState.currentDocId = null; 
            console.log(`[Background] Dokumen Ke-${projectState.docsCreated} Penuh. Dokumen baru akan disiapkan pada cerita berikutnya.`);
        }

        return "CONTINUE";

    } finally {
        projectState.isWriting = false; 
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // Content script lapor: prompt sudah diketik & Send diklik
    if (message.type === "INJECT_SENT" && sender.tab) {
        onInjectSent(sender.tab.id);
    }

    if (message.type === "UPDATE_SETTINGS") {
        projectState.targetWords = message.wordLimit || 15000;
        projectState.maxStoriesPerDoc = message.tabLimit || 3;
        projectState.maxDocs = message.docLimit || 9;
        if (message.gptUrl) projectState.gptUrl = message.gptUrl;
        
        if (message.docId) {
            projectState.currentDocId = message.docId;
        } else if (!projectState.isActive) {
            projectState.currentDocId = null;
        }
        console.log("[Background] Pengaturan Diperbarui:", projectState);
    }

    if (message.type === "START_ENGINE") {
        // Login Google DULU sebelum mulai engine
        console.log("[Background] Mengecek login Google...");
        getAuthToken().then((token) => {
            console.log("[Background] Login Google OK! Token diterima.");

            projectState.isActive = true;
            projectState.docsCreated = 0;
            projectState.storiesInCurrentDoc = 0;
            projectState.totalStoriesGlobal = 0;
            projectState.currentDocId = null;
            projectState.isWriting = false;
            focusQueue = [];
            currentFocusTabId = null;
            engineWindowId = null;

            // Auto-Cleanup Zombie Tabs
            Object.keys(projectState.tabs).forEach(id => {
                chrome.tabs.remove(parseInt(id)).catch(() => {});
            });
            projectState.tabs = {};

            console.log("[Background] ENGINE START! Membuka 3 Tab Fresh...");
            for(let i = 0; i < 3; i++) {
                createTabInEngineWindow(projectState.gptUrl || "https://chatgpt.com/", false, (newTab) => {
                    projectState.tabs[newTab.id] = { phase: "IDLE", wordCount: 0, storyNumber: 0, currentIdea: "", storyBuffer: "" };
                    saveStateToDisk();
                });
            }
            saveStateToDisk();
            sendResponse({ status: "started" });
        }).catch((err) => {
            console.error("[Background] Login Google GAGAL:", err);
            sendResponse({ status: "auth_failed", error: String(err) });
        });
        return true; // Async sendResponse
    }

    if (message.type === "STOP_ENGINE") {
        projectState.isActive = false;
        focusQueue = [];
        currentFocusTabId = null;
        Object.keys(projectState.tabs).forEach(tabIdStr => {
            chrome.tabs.sendMessage(parseInt(tabIdStr), { type: "STOP_TYPING" }).catch(() => {});
        });
        saveStateToDisk();
        sendResponse({ status: "stopped" });
        return true;
    }

    if (message.type === "TAB_READY") {
        let tabId = sender.tab.id;

        if (!projectState.isActive || !projectState.tabs[tabId]) {
            sendResponse({ status: "standby" });
            return true;
        }

        if (projectState.tabs[tabId].phase === "IDLE") {
            // Tandai tab siap, tapi JANGAN kirim INJECT dulu
            // INJECT dikirim oleh focusNextTab() setelah tab benar-benar di-focus
            projectState.tabs[tabId].phase = "WAIT_FOCUS";
            addToFocusQueue(tabId);
            sendResponse({ status: "queued" });
        } else {
            sendResponse({ status: "ok" });
        }
        return true;
    }

    if (message.type === "GPT_DONE" && projectState.isActive) {
        let tabId = sender.tab.id;
        let tabState = projectState.tabs[tabId];

        if (!tabState) {
            console.warn(`[Background] GPT_DONE dari tab ${tabId} tapi tab tidak terdaftar.`);
            return;
        }

        console.log(`[Background] GPT_DONE diterima dari tab ${tabId} | Phase: ${tabState.phase} | Words: ${message.wordCount}`);
        sendResponse({ status: "received" }); // Tutup channel langsung, async lanjut sendiri

        // Masukkan ke antrian focus
        addToFocusQueue(tabId);

        (async () => {
            try {
                if (tabState.phase === "BRAINSTORM") {
                    const ideArray = message.fullText.split('\n').filter(line => line.trim().length > 15);
                    tabState.currentIdea = ideArray.length > 0 ? ideArray[Math.floor(Math.random() * ideArray.length)].trim() : "Sebuah kebohongan masa kecil yang mengubah hidupku.";

                    tabState.phase = "GENERATING";
                    tabState.wordCount = 0;
                    tabState.storyBuffer = "";
                    saveStateToDisk();

                    console.log(`[Background] Tab ${tabId} mulai menulis ide: ${tabState.currentIdea}`);

                    const promptMulai = `Bagus. Abaikan ide lainnya. Sekarang bertindaklah sebagai seorang penulis memoar profesional. Ciptakan cerita SANGAT UNIK dari ide ini: "${tabState.currentIdea}". \n\nKembangkan jadi kejadian mengejutkan. Tulis monolog sudut pandang ('Aku'). Mulai langsung dari insiden utama. \nPENTING: Ini monolog batin murni. DILARANG KERAS menggunakan percakapan, dialog, atau tanda kutip sama sekali.`;
                    chrome.tabs.sendMessage(tabId, { action: "INJECT", text: promptMulai, phase: "GENERATING" }, (resp) => {
                        if (chrome.runtime.lastError) {
                            console.error(`[Background] Gagal kirim INJECT ke tab ${tabId}:`, chrome.runtime.lastError.message);
                        } else {
                            console.log(`[Background] INJECT GENERATING terkirim ke tab ${tabId}`);
                        }
                    });
                    return;
                }

                if (tabState.phase === "GENERATING" || tabState.phase === "FINISHING") {
                    tabState.storyBuffer += message.fullText + "\n\n";
                    tabState.wordCount += message.wordCount;
                    console.log(`[Background] Tab ${tabId} buffer: ${tabState.wordCount} / ${projectState.targetWords} kata`);
                    saveStateToDisk();

                    // Bersihkan lastParagraph dari UI text ChatGPT
                    let cleanParagraph = (message.lastParagraph || "").replace(/Gen Story bilang:/g, '').replace(/Gen Story said:/g, '').replace(/ChatGPT said:/g, '').replace(/ChatGPT bilang:/g, '').replace(/\.\s*\./g, '.').trim();
                    // Potong di batas kata utuh (buang kata terpotong di awal)
                    cleanParagraph = cleanParagraph.replace(/^\S*\s+/, '');

                    if (tabState.phase === "FINISHING") {
                        console.log(`[Background] Tab ${tabId} FINISHING! Menyimpan ke Doc...`);

                        let saveResult = await saveFullStoryToDoc(tabId);

                        if (saveResult === "STOP_ALL") {
                            projectState.isActive = false;
                            saveStateToDisk();
                            Object.keys(projectState.tabs).forEach(id => {
                                chrome.tabs.sendMessage(parseInt(id), { type: "STOP_TYPING" }).catch(() => {});
                            });
                            return;
                        }

                        if (saveResult === "ERROR") {
                            console.error(`[Background] Save gagal! Buffer tetap disimpan.`);
                            return;
                        }

                        console.log(`[Background] Menutup Tab ${tabId}, buat Tab Fresh...`);
                        chrome.tabs.remove(tabId).catch(() => {});
                        delete projectState.tabs[tabId];
                        saveStateToDisk();

                        createTabInEngineWindow(projectState.gptUrl || "https://chatgpt.com/", false, (newTab) => {
                            projectState.tabs[newTab.id] = { phase: "IDLE", wordCount: 0, storyNumber: 0, currentIdea: "", storyBuffer: "" };
                            saveStateToDisk();
                        });
                        return;
                    }

                    // GENERATING → tentukan prompt berikutnya
                    let nextPhase = "";
                    let nextPrompt = "";

                    if (tabState.wordCount < (projectState.targetWords - 1000)) {
                        nextPhase = "GENERATING";
                        nextPrompt = `Lanjutkan narasi monolog personal ini berdasarkan bagian akhir cerita sebelumnya:\n\n"...${cleanParagraph}"\n\nBawa narasi bergerak maju. PENTING: JANGAN memberikan kesimpulan atau penutup. DILARANG KERAS menggunakan percakapan atau dialog.`;
                    } else {
                        nextPhase = "FINISHING";
                        nextPrompt = `Lanjutkan narasi monolog personal ini berdasarkan bagian akhir cerita sebelumnya:\n\n"...${cleanParagraph}"\n\nArahkan cerita menuju akhir yang memuaskan. Berikan kesimpulan dan penutup cerita yang emosional. DILARANG KERAS menggunakan percakapan atau dialog.`;
                    }

                    console.log(`[Background] Tab ${tabId} → ${nextPhase} (${tabState.wordCount}/${projectState.targetWords} kata)`);

                    if (projectState.isActive && nextPrompt) {
                        tabState.phase = nextPhase;
                        saveStateToDisk();
                        chrome.tabs.sendMessage(tabId, { action: "INJECT", text: nextPrompt, phase: nextPhase }, (resp) => {
                            if (chrome.runtime.lastError) {
                                console.error(`[Background] Gagal kirim INJECT ${nextPhase} ke tab ${tabId}:`, chrome.runtime.lastError.message);
                            } else {
                                console.log(`[Background] INJECT ${nextPhase} terkirim ke tab ${tabId}`);
                            }
                        });
                    }
                }
            } catch (err) {
                console.error(`[Background] Error di GPT_DONE handler:`, err);
            }
        })();

        return true;
    }
});