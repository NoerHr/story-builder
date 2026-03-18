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

// FUNGSI INJEKSI V7.1 (PASTE-FIRST, TANPA innerHTML)
function injectTextAndSend(text, retryCount = 0) {
    if(!engineActive || isStopping) return false;

    let textarea = document.querySelector('div.ProseMirror#prompt-textarea[contenteditable="true"]');
    if (!textarea) textarea = document.querySelector('#prompt-textarea');

    if (!textarea || textarea.style.display === 'none') {
        if (retryCount < 10) {
            console.warn("[Inject] ProseMirror belum siap, retry ke-" + (retryCount + 1));
            setTimeout(() => injectTextAndSend(text, retryCount + 1), 2000);
        }
        return false;
    }

    console.log("[Inject] Mulai injeksi teks ke ProseMirror...");
    textarea.focus();

    // Kosongkan isi lama via execCommand (ProseMirror-safe, JANGAN pakai innerHTML)
    document.execCommand('selectAll');
    document.execCommand('delete');

    // METODE UTAMA: ClipboardEvent paste (terbukti trigger ProseMirror state)
    try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        });
        textarea.dispatchEvent(pasteEvent);
        console.log("[Inject] Paste event dispatched.");
    } catch (e) {
        console.warn("[Inject] Paste gagal:", e.message);
    }

    // Cek apakah paste berhasil, kalau tidak coba execCommand
    setTimeout(() => {
        const content = textarea.textContent.trim();
        if (content.length < 10) {
            console.warn("[Inject] Paste tidak masuk. Fallback ke execCommand...");
            textarea.focus();
            document.execCommand('selectAll');
            document.execCommand('delete');
            document.execCommand('insertText', false, text);
        }

        const finalContent = textarea.textContent.trim();
        console.log("[Inject] Isi textarea:", finalContent.substring(0, 80) + "...", `(${finalContent.length} chars)`);

        if (finalContent.length < 10) {
            console.error("[Inject] Injeksi GAGAL total.");
            if (retryCount < 5) {
                setTimeout(() => injectTextAndSend(text, retryCount + 1), 3000);
            }
            return;
        }

        // Tunggu sebentar agar ProseMirror sync state ke React, lalu kirim
        setTimeout(() => triggerSend(textarea), 1000);
    }, 500);
}

function triggerSend(textarea) {
    if(!engineActive || isStopping) return;

    const sendButton = document.querySelector('button[data-testid="send-button"]') ||
                       document.querySelector('button[aria-label="Send message"]') ||
                       document.querySelector('button[aria-label="Send prompt"]');

    console.log("[Send] Tombol Send ditemukan:", !!sendButton);
    if (sendButton) console.log("[Send] Disabled?", sendButton.disabled, "| aria-disabled:", sendButton.getAttribute('aria-disabled'));

    if (sendButton && !sendButton.disabled) {
        sendButton.click();
        console.log("[Send] Diklik via .click()!");
        mulaiMemonitor();
    } else {
        // Tombol disabled atau tidak ada — coba Enter di form
        console.warn("[Send] Tombol disabled/tidak ada. Coba submit form atau Enter...");

        // Coba submit form langsung
        const form = textarea.closest('form');
        if (form) {
            form.requestSubmit();
            console.log("[Send] form.requestSubmit() dipanggil!");
            mulaiMemonitor();
        } else {
            // Last resort: klik paksa
            if (sendButton) {
                sendButton.removeAttribute('disabled');
                sendButton.click();
                console.log("[Send] Klik paksa (disabled removed)!");
            }
            mulaiMemonitor();
        }
    }

    // Safety check: 3 detik setelah send, cek apakah GPT merespon
    setTimeout(() => {
        const isTyping = document.querySelector('button[data-testid="stop-button"]') ||
                         document.querySelector('button[aria-label*="Stop"]') ||
                         document.querySelector('.result-streaming');
        if (!isTyping && engineActive && !isStopping) {
            console.warn("[Send] GPT tidak merespon setelah 3 detik! Retry send...");
            // Coba klik lagi
            const btn = document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label="Send message"]');
            if (btn) {
                btn.removeAttribute('disabled');
                btn.click();
            }
        }
    }, 3000);
}

function mulaiMemonitor() {
    if (monitorInterval) clearInterval(monitorInterval);

    let errorStuckCounter = 0;
    let monitorTick = 0;

    console.log("[Monitor] Mulai memantau respon ChatGPT...");

    monitorInterval = setInterval(() => {
        if (!engineActive || isStopping) {
            clearInterval(monitorInterval);
            console.log("[Monitor] Dihentikan (engine off).");
            return;
        }

        monitorTick++;

        // 1. DETEKSI TOMBOL AJAIB CHATGPT
        const allButtons = Array.from(document.querySelectorAll('button'));

        const continueBtn = allButtons.find(btn => btn.innerText.toLowerCase().includes('continue generating') || btn.innerText.toLowerCase().includes('lanjutkan'));
        if (continueBtn) {
            console.log("[Monitor] GPT kehabisan nafas. Mengeklik 'Continue generating'...");
            continueBtn.click();
            return;
        }

        const regenerateBtn = allButtons.find(btn => btn.innerText.toLowerCase().includes('regenerate') || btn.innerText.toLowerCase().includes('coba lagi'));
        const isErrorVisible = document.querySelector('.text-red-500') || document.querySelector('.bg-red-500');

        if (regenerateBtn && isErrorVisible) {
            errorStuckCounter++;
            if (errorStuckCounter > 3) {
                console.warn("[Monitor] Error ChatGPT terdeteksi! Regenerate...");
                regenerateBtn.click();
                errorStuckCounter = 0;
            }
            return;
        }

        // 2. DETEKSI STATUS NGETIK
        const isTyping = document.querySelector('button[data-testid="stop-button"]') ||
                         document.querySelector('button[aria-label*="Stop"]') ||
                         document.querySelector('.result-streaming');
        const sendButton = document.querySelector('button[data-testid="send-button"]') ||
                           document.querySelector('button[aria-label="Send message"]') ||
                           document.querySelector('button[aria-label="Send prompt"]');
        const allMessages = document.querySelectorAll('div[data-message-author-role="assistant"]');

        // Debug log setiap 5 tick (15 detik)
        if (monitorTick % 5 === 0) {
            console.log(`[Monitor] Tick #${monitorTick} | Typing: ${!!isTyping} | SendBtn: ${!!sendButton} | Messages: ${allMessages.length}`);
        }

        if (isTyping) {
            if (monitorTick % 3 === 0) console.log("[Monitor] GPT sedang mengetik...");
            return; // Tunggu selesai
        }

        // GPT tidak sedang mengetik — cek apakah ada pesan baru
        if (!continueBtn) {
            if (allMessages.length === 0) {
                if (monitorTick % 5 === 0) console.log("[Monitor] Belum ada pesan assistant.");
                return;
            }

            const lastMessage = allMessages[allMessages.length - 1];

            if (lastMessage && !lastMessage.getAttribute('data-processed')) {
                lastMessage.setAttribute('data-processed', 'true');
                clearInterval(monitorInterval);

                const textElement = lastMessage.querySelector('.markdown') || lastMessage;
                const fullText = textElement.innerText;
                const wordCount = fullText.trim().split(/\s+/).length;

                let lastParagraph = fullText.substring(fullText.length - 300).trim();
                lastParagraph = lastParagraph.replace(/\n/g, ' ');

                console.log(`[Monitor] ✅ AI Selesai! ${wordCount} kata. Mengirim GPT_DONE...`);

                try {
                    chrome.runtime.sendMessage({
                        type: "GPT_DONE",
                        fullText: fullText,
                        wordCount: wordCount,
                        lastParagraph: lastParagraph
                    });
                } catch (error) {
                    console.error("[Monitor] Gagal kirim GPT_DONE:", error);
                }
            }
        }
    }, 3000);
}