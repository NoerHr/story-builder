let projectState = {
    isActive: false,
    gptUrl: "https://chatgpt.com/",
    maxDocs: 3,         
    maxStoriesPerDoc: 9,
    targetWords: 15000, 
    
    currentDocId: null,
    docsCreated: 0,
    storiesInCurrentDoc: 0,
    totalStoriesGlobal: 0,
    
    isWriting: false, // KUNCI ANTREAN
    tabs: {} 
};

console.log("[Background] Pabrik Cerita Otonom (V6.6 - Final Masterpiece) Berjalan.");

async function getAuthToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
            else resolve(token);
        });
    });
}

async function createNewDoc(title) {
    try {
        const token = await getAuthToken();
        const response = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' })
        });
        const data = await response.json();
        if (!response.ok) throw new Error("Gagal API");
        console.log(`[Background] 📄 Doc Baru Berhasil Dibuat: ${title}`);
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
                chrome.tabs.create({ url: newDoc.url, active: true });
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
    
    if (message.type === "UPDATE_SETTINGS") {
        projectState.targetWords = message.wordLimit || 15000;
        projectState.maxStoriesPerDoc = message.tabLimit || 9;
        if (message.gptUrl) projectState.gptUrl = message.gptUrl;
        
        if (message.docId) {
            projectState.currentDocId = message.docId;
        } else if (!projectState.isActive) {
            projectState.currentDocId = null;
        }
        console.log("[Background] Pengaturan Diperbarui:", projectState);
    }

    if (message.type === "START_ENGINE") {
        projectState.isActive = true;
        projectState.docsCreated = 0;
        projectState.storiesInCurrentDoc = 0;
        projectState.totalStoriesGlobal = 0;
        projectState.currentDocId = null;
        projectState.isWriting = false;

        // FITUR BARU: Auto-Cleanup Zombie Tabs
        // Tutup semua tab pekerja dari sesi sebelumnya sebelum mulai yang baru
        Object.keys(projectState.tabs).forEach(id => {
            chrome.tabs.remove(parseInt(id)).catch(() => {});
        });
        projectState.tabs = {}; 
        
        console.log("[Background] ENGINE START! Membuka 3 Tab Fresh...");
        for(let i = 0; i < 3; i++) {
            chrome.tabs.create({ url: projectState.gptUrl || "https://chatgpt.com/", active: false }, (newTab) => {
                projectState.tabs[newTab.id] = { phase: "IDLE", wordCount: 0, storyNumber: 0, currentIdea: "", storyBuffer: "" };
            });
        }
        sendResponse({ status: "started" });
        return true; 
    }

    if (message.type === "STOP_ENGINE") {
        projectState.isActive = false;
        Object.keys(projectState.tabs).forEach(tabIdStr => {
            chrome.tabs.sendMessage(parseInt(tabIdStr), { type: "STOP_TYPING" }).catch(() => {});
        });
        sendResponse({ status: "stopped" });
        return true;
    }

    if (message.type === "TAB_READY") {
        let tabId = sender.tab.id;

        if (!projectState.isActive || !projectState.tabs[tabId]) {
            sendResponse({ status: "standby" });
            return true;
        }

        sendResponse({ status: "ok" });

        if (projectState.tabs[tabId].phase === "IDLE") {
            projectState.tabs[tabId].phase = "BRAINSTORM";
            const promptIde = "Berikan 10 ide tema cerita monolog personal (sudut pandang 'Aku') yang sangat liar, emosional, unik, dan tidak klise. Format jawabanmu HANYA berupa teks list biasa, satu baris untuk satu ide. Jangan berikan nomor urut, kalimat pembuka, atau penutup. Berikan idenya saja.";
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { action: "INJECT", text: promptIde, phase: "BRAINSTORM" });
            }, 500);
        }
        return true;
    }

    if (message.type === "GPT_DONE" && projectState.isActive) {
        let tabId = sender.tab.id;
        let tabState = projectState.tabs[tabId];
        
        if (!tabState) return;

        (async () => {
            
            if (tabState.phase === "BRAINSTORM") {
                const ideArray = message.fullText.split('\n').filter(line => line.trim().length > 15);
                tabState.currentIdea = ideArray.length > 0 ? ideArray[Math.floor(Math.random() * ideArray.length)].trim() : "Sebuah kebohongan masa kecil yang mengubah hidupku.";
                
                tabState.phase = "GENERATING";
                tabState.wordCount = 0;
                tabState.storyBuffer = ""; 

                console.log(`[Background] Tab ${tabId} mulai menulis ide: ${tabState.currentIdea}`);

                const promptMulai = `Bagus. Abaikan ide lainnya. Sekarang bertindaklah sebagai seorang penulis memoar profesional. Ciptakan cerita SANGAT UNIK dari ide ini: "${tabState.currentIdea}". \n\nKembangkan jadi kejadian mengejutkan. Tulis monolog sudut pandang ('Aku'). Mulai langsung dari insiden utama. \nPENTING: Ini monolog batin murni. DILARANG KERAS menggunakan percakapan, dialog, atau tanda kutip sama sekali.`;
                chrome.tabs.sendMessage(tabId, { action: "INJECT", text: promptMulai, phase: "GENERATING" });
                return;
            }

            if (tabState.phase === "GENERATING" || tabState.phase === "FINISHING") {
                
                tabState.storyBuffer += message.fullText + "\n\n";
                tabState.wordCount += message.wordCount;
                
                let nextPrompt = "";
                let nextPhase = "";

                if (tabState.phase === "FINISHING") {
                    console.log(`[Background] Tab ${tabId} Minta Save! Mengantre untuk akses Doc...`);
                    
                    let saveResult = await saveFullStoryToDoc(tabId);
                    
                    if (saveResult === "STOP_ALL") {
                        projectState.isActive = false;
                        Object.keys(projectState.tabs).forEach(id => {
                            chrome.tabs.sendMessage(parseInt(id), { type: "STOP_TYPING" }).catch(() => {});
                        });
                        return; 
                    }
                    
                    if (saveResult === "ERROR") return;

                    // FITUR BARU: Anti-Crash jika tab sudah tertutup duluan
                    console.log(`[Background] Menutup Tab ${tabId} dan membuat Tab Fresh baru...`);
                    chrome.tabs.remove(tabId).catch(() => console.warn(`[Background] Tab ${tabId} sepertinya sudah ditutup manual.`)); 
                    delete projectState.tabs[tabId]; 

                    chrome.tabs.create({ url: projectState.gptUrl || "https://chatgpt.com/", active: false }, (newTab) => {
                        projectState.tabs[newTab.id] = { phase: "IDLE", wordCount: 0, storyNumber: 0, currentIdea: "", storyBuffer: "" };
                    });

                    return; 
                } 
                else {
                    if (tabState.wordCount < (projectState.targetWords - 1000)) {
                        nextPhase = "GENERATING";
                        nextPrompt = `Lanjutkan narasi monolog personal ini berdasarkan bagian akhir cerita sebelumnya:\n\n"...${message.lastParagraph}"\n\nBawa narasi bergerak maju. PENTING: JANGAN memberikan kesimpulan atau penutup. DILARANG KERAS menggunakan percakapan atau dialog.`;
                    } else {
                        nextPhase = "FINISHING";
                        nextPrompt = `Lanjutkan narasi monolog personal ini berdasarkan bagian akhir cerita sebelumnya:\n\n"...${message.lastParagraph}"\n\nArahkan cerita menuju akhir yang memuaskan. Berikan kesimpulan dan penutup cerita yang emosional. DILARANG KERAS menggunakan percakapan atau dialog.`;
                    }
                }

                if (projectState.isActive && nextPrompt) {
                    chrome.tabs.sendMessage(tabId, { action: "INJECT", text: nextPrompt, phase: nextPhase });
                    tabState.phase = nextPhase;
                }
            }
        })();
    }
});