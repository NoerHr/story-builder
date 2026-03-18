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

// Track jumlah pesan sebelum kirim, agar tidak proses pesan lama
let messageCountBeforeSend = 0;

function mulaiMemonitor() {
    if (monitorInterval) clearInterval(monitorInterval);

    let errorStuckCounter = 0;
    let monitorTick = 0;
    let typingTicks = 0; // Hitung berapa lama GPT ngetik
    const MAX_TYPING_TICKS = 40; // 40 x 3 detik = 2 menit max ngetik

    // Hitung pesan yang sudah ada SEBELUM GPT mulai jawab
    const existingMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    messageCountBeforeSend = existingMessages.length;
    // Tandai semua pesan lama agar tidak terproses
    existingMessages.forEach(el => el.setAttribute('data-processed', 'true'));

    console.log(`[Monitor] Mulai memantau. Pesan existing: ${messageCountBeforeSend}`);

    monitorInterval = setInterval(() => {
        if (!engineActive || isStopping) {
            clearInterval(monitorInterval);
            return;
        }

        monitorTick++;

        // 1. DETEKSI TOMBOL AJAIB
        const allButtons = Array.from(document.querySelectorAll('button'));
        const continueBtn = allButtons.find(btn => {
            const t = btn.innerText.toLowerCase();
            return t.includes('continue generating') || t.includes('lanjutkan');
        });
        if (continueBtn) {
            console.log("[Monitor] Klik 'Continue generating'...");
            continueBtn.click();
            return;
        }

        const regenerateBtn = allButtons.find(btn => {
            const t = btn.innerText.toLowerCase();
            return t.includes('regenerate') || t.includes('coba lagi');
        });
        if (regenerateBtn && (document.querySelector('.text-red-500') || document.querySelector('.bg-red-500'))) {
            errorStuckCounter++;
            if (errorStuckCounter > 3) {
                regenerateBtn.click();
                errorStuckCounter = 0;
            }
            return;
        }

        // 2. DETEKSI TYPING + TIMEOUT
        const stopButton = document.querySelector('button[data-testid="stop-button"]') ||
                           document.querySelector('button[aria-label*="Stop"]');
        const isStreaming = document.querySelector('.result-streaming');
        const isTyping = stopButton || isStreaming;

        if (isTyping) {
            typingTicks++;
            if (monitorTick % 3 === 0) console.log(`[Monitor] GPT sedang mengetik... (${typingTicks * 3}s / ${MAX_TYPING_TICKS * 3}s)`);

            // TIMEOUT: GPT ngetik > 2 menit → paksa stop & ambil teks yang ada
            if (typingTicks >= MAX_TYPING_TICKS) {
                console.warn("[Monitor] GPT stuck ngetik > 2 menit! Paksa stop...");
                if (stopButton) {
                    stopButton.click();
                    console.log("[Monitor] Tombol Stop diklik. Ambil teks yang sudah ada...");
                }
                // Jangan return, lanjut ke proses ambil teks di bawah
                typingTicks = 0;
            } else {
                return;
            }
        } else {
            typingTicks = 0; // Reset kalau sudah tidak ngetik
        }

        // 3. GPT SELESAI — cari pesan BARU
        if (continueBtn) return;

        // Coba cari pesan lewat berbagai metode
        const allAssistant = document.querySelectorAll('[data-message-author-role="assistant"]');
        const allTurns = document.querySelectorAll('article[data-testid^="conversation-turn"]');

        if (monitorTick % 5 === 0) {
            console.log(`[Monitor] Tick #${monitorTick} | MsgRole: ${allAssistant.length} | Turns: ${allTurns.length}`);
        }

        // Hanya proses kalau ada pesan BARU (lebih banyak dari sebelum send)
        if (allAssistant.length <= messageCountBeforeSend && allTurns.length === 0) {
            return;
        }

        // STRATEGI AMBIL TEKS: coba beberapa cara
        let fullText = "";

        // Cara 1: Dari article conversation turn terakhir
        if (allTurns.length > 0) {
            const lastTurn = allTurns[allTurns.length - 1];
            if (!lastTurn.getAttribute('data-ink-processed')) {
                fullText = lastTurn.innerText.trim();
                if (fullText.length > 20) {
                    lastTurn.setAttribute('data-ink-processed', 'true');
                    console.log("[Monitor] Teks diambil dari article turn.");
                }
            }
        }

        // Cara 2: Dari div[data-message-author-role="assistant"] terakhir yang belum diproses
        if (fullText.length < 20 && allAssistant.length > messageCountBeforeSend) {
            const lastMsg = allAssistant[allAssistant.length - 1];
            if (!lastMsg.getAttribute('data-processed')) {
                lastMsg.setAttribute('data-processed', 'true');

                // Debug: log isi element
                console.log("[Monitor] DEBUG lastMsg tag:", lastMsg.tagName, "class:", lastMsg.className);
                console.log("[Monitor] DEBUG children:", lastMsg.children.length, "innerHTML (200):", lastMsg.innerHTML.substring(0, 200));
                console.log("[Monitor] DEBUG innerText (200):", lastMsg.innerText.substring(0, 200));
                console.log("[Monitor] DEBUG textContent (200):", lastMsg.textContent.substring(0, 200));

                // Coba dari parent/ancestor
                const article = lastMsg.closest('article');
                if (article) {
                    fullText = article.innerText.trim();
                    console.log("[Monitor] Teks dari closest article:", fullText.length, "chars");
                }
                if (fullText.length < 20) {
                    fullText = lastMsg.textContent.trim();
                }
                if (fullText.length < 20) {
                    fullText = lastMsg.innerText.trim();
                }
            }
        }

        // Cara 3: Cari semua .markdown di halaman, ambil yang terakhir belum diproses
        if (fullText.length < 20) {
            const allMarkdown = document.querySelectorAll('.markdown, .prose, [class*="markdown"]');
            for (let i = allMarkdown.length - 1; i >= 0; i--) {
                if (!allMarkdown[i].getAttribute('data-ink-processed')) {
                    const txt = allMarkdown[i].innerText.trim();
                    if (txt.length > 20) {
                        fullText = txt;
                        allMarkdown[i].setAttribute('data-ink-processed', 'true');
                        console.log("[Monitor] Teks dari .markdown global:", fullText.length, "chars");
                        break;
                    }
                }
            }
        }

        // Masih kosong? Skip, jangan kirim GPT_DONE kosong
        if (fullText.length < 20) {
            if (monitorTick % 5 === 0) console.log("[Monitor] Pesan ditemukan tapi teks kosong. Menunggu...");
            return;
        }

        // SUKSES — kirim ke background
        clearInterval(monitorInterval);

        const wordCount = fullText.trim().split(/\s+/).filter(w => w.length > 0).length;
        let lastParagraph = fullText.substring(fullText.length - 300).trim().replace(/\n/g, ' ');

        console.log(`[Monitor] ✅ AI Selesai! ${wordCount} kata (${fullText.length} chars).`);
        console.log(`[Monitor] Preview: "${fullText.substring(0, 120)}..."`);

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
    }, 3000);
}