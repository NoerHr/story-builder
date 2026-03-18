let engineActive = false;
let isStopping = false; 
let monitorInterval = null;

// SISTEM BARU: Menunggu UI ChatGPT benar-benar siap
function initWhenReady(retryCount = 0) {
    const textarea = document.querySelector('div.ProseMirror#prompt-textarea[contenteditable="true"]') || document.querySelector('#prompt-textarea');

    if (textarea && textarea.style.display !== 'none') {
        console.log("[Content Script] Kotak teks ProseMirror ChatGPT ditemukan! Melapor ke Background...");
        try {
            chrome.runtime.sendMessage({ type: "TAB_READY" }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn("[Content Script] Background belum siap. Retry ke-" + (retryCount + 1));
                    if (retryCount < 15) {
                        setTimeout(() => initWhenReady(retryCount + 1), 2000 + (retryCount * 500));
                    } else {
                        console.error("[Content Script] Gagal konek ke Background setelah 15x retry.");
                    }
                    return;
                }

                if (response && response.action === "INJECT") {
                    // Background langsung kirim perintah INJECT via response
                    console.log("[Content Script] Perintah INJECT diterima langsung! Memulai fase:", response.phase);
                    engineActive = true;
                    setTimeout(() => injectTextAndSend(response.text), 1500);
                } else if (response && response.status === "standby") {
                    // Engine belum aktif, retry berkala
                    console.log("[Content Script] Engine belum aktif (standby). Retry dalam 3 detik...");
                    if (retryCount < 30) {
                        setTimeout(() => initWhenReady(retryCount + 1), 3000);
                    }
                } else if (response && response.status === "ok") {
                    // Tab sudah terdaftar tapi bukan fase IDLE (mungkin sudah berjalan)
                    console.log("[Content Script] Tab terdaftar. Menunggu perintah dari Background...");
                }
            });
        } catch (error) {
            console.warn("[Content Script] Koneksi ke background terputus sementara.", error);
            if (retryCount < 15) {
                setTimeout(() => initWhenReady(retryCount + 1), 2000 + (retryCount * 500));
            }
        }
    } else {
        console.log("[Content Script] Menunggu UI ProseMirror loading...");
        setTimeout(() => initWhenReady(retryCount), 1000);
    }
}

// Jangan langsung dieksekusi, tunggu DOM stabil
if (document.readyState === 'complete') {
    setTimeout(initWhenReady, 2000);
} else {
    window.addEventListener('load', () => setTimeout(initWhenReady, 2000));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "STOP_TYPING") {
        engineActive = false;
        isStopping = true;
        clearInterval(monitorInterval);
        console.log("[Content Script] 🛑 Mesin Dihentikan.");
    }
    
    if (message.action === "INJECT" && !isStopping) {
        engineActive = true;
        setTimeout(() => injectTextAndSend(message.text), 2000);
    }
});

// FUNGSI INJEKSI V6.7 (SUPER SPESIFIK KE PROSEMIRROR & ANTI CRASH)
function injectTextAndSend(text, retryCount = 0) {
    if(!engineActive || isStopping) return false; 
    
    let textarea = document.querySelector('div.ProseMirror#prompt-textarea[contenteditable="true"]');
    if (!textarea) textarea = document.querySelector('#prompt-textarea');

    if (!textarea || textarea.style.display === 'none') {
        if (retryCount < 10) {
            console.warn("[Content Script] ProseMirror belum siap, mencoba ulang injeksi...");
            setTimeout(() => injectTextAndSend(text, retryCount + 1), 2000);
        }
        return false;
    }

    console.log("[Content Script] Menyiapkan injeksi teks ProseMirror Native...");
    textarea.focus();
    
    try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(textarea);
        selection.removeAllRanges();
        selection.addRange(range);
    } catch (e) {
        console.warn("[Content Script] Gagal select teks, melanjutkan paste...", e);
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true });
    textarea.dispatchEvent(pasteEvent);
    
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(() => {
        if(!engineActive || isStopping) return; 
        
        const sendButton = document.querySelector('button[data-testid="send-button"]') || 
                           document.querySelector('button[aria-label="Send message"]');
                           
        if (sendButton) {
            sendButton.removeAttribute('disabled');
            sendButton.click();
            mulaiMemonitor(); 
        } else {
            console.warn("[Content Script] Tombol send tidak ada, memaksa Enter...");
            const enterEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 });
            textarea.dispatchEvent(enterEvent);
            mulaiMemonitor();
        }
    }, 1500); 
}

function mulaiMemonitor() {
    if (monitorInterval) clearInterval(monitorInterval);

    let errorStuckCounter = 0;

    monitorInterval = setInterval(() => {
        if (!engineActive || isStopping) {
            clearInterval(monitorInterval);
            return;
        }

        // 1. DETEKSI TOMBOL AJAIB CHATGPT
        const allButtons = Array.from(document.querySelectorAll('button'));
        
        // Cek Tombol "Continue generating"
        const continueBtn = allButtons.find(btn => btn.innerText.toLowerCase().includes('continue generating') || btn.innerText.toLowerCase().includes('lanjutkan'));
        if (continueBtn) {
            console.log("[Content Script] GPT kehabisan nafas. Mengeklik 'Continue generating'...");
            continueBtn.click();
            return; // Jangan lapor selesai dulu!
        }

        // Cek Tombol "Regenerate" karena error
        const regenerateBtn = allButtons.find(btn => btn.innerText.toLowerCase().includes('regenerate') || btn.innerText.toLowerCase().includes('coba lagi'));
        const isErrorVisible = document.querySelector('.text-red-500') || document.querySelector('.bg-red-500'); // Indikasi error GPT
        
        if (regenerateBtn && isErrorVisible) {
            errorStuckCounter++;
            if (errorStuckCounter > 3) {
                console.warn("[Content Script] Terdeteksi Error dari ChatGPT! Mencoba Regenerate otomatis...");
                regenerateBtn.click();
                errorStuckCounter = 0;
            }
            return; // Tunggu GPT memperbaiki dirinya sendiri
        }

        // 2. DETEKSI STATUS NGETIK
        const isTyping = document.querySelector('button[aria-label*="Stop"]') || 
                         document.querySelector('.result-streaming') ||
                         document.querySelector('button[data-testid="stop-button"]');
        const sendButton = document.querySelector('button[data-testid="send-button"]') || 
                           document.querySelector('button[aria-label="Send message"]');

        if (sendButton && !isTyping && !continueBtn) {
            const allMessages = document.querySelectorAll('div[data-message-author-role="assistant"]');
            if (allMessages.length === 0) return;

            const lastMessage = allMessages[allMessages.length - 1];

            if (lastMessage && !lastMessage.getAttribute('data-processed')) {
                lastMessage.setAttribute('data-processed', 'true');
                clearInterval(monitorInterval); 

                const textElement = lastMessage.querySelector('.markdown') || lastMessage;
                const fullText = textElement.innerText;
                const wordCount = fullText.trim().split(/\s+/).length;
                
                let lastParagraph = fullText.substring(fullText.length - 300).trim();
                lastParagraph = lastParagraph.replace(/\n/g, ' '); 

                console.log(`[Content Script] ✅ AI Selesai Ngetik. Mengirim data ke Manajer (Background)...`);

                try {
                    chrome.runtime.sendMessage({ 
                        type: "GPT_DONE", 
                        fullText: fullText,
                        wordCount: wordCount,
                        lastParagraph: lastParagraph
                    });
                } catch (error) {
                    console.error("[Content Script] Gagal mengirim data ke Background (Koneksi Putus).", error);
                }
            }
        }
    }, 3000); 
}