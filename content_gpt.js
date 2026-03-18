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
                    }
                    return;
                }

                if (response && response.action === "INJECT") {
                    console.log("[Content Script] Perintah INJECT diterima langsung! Memulai fase:", response.phase);
                    engineActive = true;
                    setTimeout(() => injectTextAndSend(response.text), 1500);
                } else if (response && response.status === "standby") {
                    console.log("[Content Script] Engine belum aktif (standby). Retry dalam 3 detik...");
                    if (retryCount < 30) {
                        setTimeout(() => initWhenReady(retryCount + 1), 3000);
                    }
                } else if (response && response.status === "ok") {
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
        console.log("[Content Script] Mesin Dihentikan.");
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

    // Kosongkan isi lama via execCommand (ProseMirror-safe)
    document.execCommand('selectAll');
    document.execCommand('delete');

    // METODE UTAMA: ClipboardEvent paste
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

    // Cek paste berhasil, fallback ke execCommand
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

        setTimeout(() => triggerSend(textarea), 1000);
    }, 500);
}

function triggerSend(textarea) {
    if(!engineActive || isStopping) return;

    const sendButton = document.querySelector('button[data-testid="send-button"]') ||
                       document.querySelector('button[aria-label="Send message"]') ||
                       document.querySelector('button[aria-label="Send prompt"]');

    console.log("[Send] Tombol Send ditemukan:", !!sendButton);

    if (sendButton && !sendButton.disabled) {
        sendButton.click();
        console.log("[Send] Diklik!");
        mulaiMemonitor();
    } else {
        console.warn("[Send] Tombol disabled/tidak ada. Coba form submit...");
        const form = textarea.closest('form');
        if (form) {
            form.requestSubmit();
            console.log("[Send] form.requestSubmit()!");
        } else if (sendButton) {
            sendButton.removeAttribute('disabled');
            sendButton.click();
            console.log("[Send] Klik paksa!");
        }
        mulaiMemonitor();
    }

    // Safety: retry send setelah 3 detik kalau GPT tidak merespon
    setTimeout(() => {
        const isTyping = document.querySelector('button[data-testid="stop-button"]') ||
                         document.querySelector('button[aria-label*="Stop"]') ||
                         document.querySelector('.result-streaming');
        if (!isTyping && engineActive && !isStopping) {
            console.warn("[Send] GPT tidak merespon! Retry send...");
            const btn = document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label="Send message"]');
            if (btn) { btn.removeAttribute('disabled'); btn.click(); }
        }
    }, 3000);
}

// ============================================================
// MONITOR V8: Tangkap teks SELAMA streaming, bukan setelahnya
// ============================================================
function mulaiMemonitor() {
    if (monitorInterval) clearInterval(monitorInterval);

    let monitorTick = 0;
    let typingTicks = 0;
    let lastCapturedText = "";    // Teks yang ditangkap selama GPT ngetik
    let wasTyping = false;        // Apakah sebelumnya GPT sedang ngetik
    let doneWaitTicks = 0;        // Tunggu beberapa tick setelah berhenti ngetik
    const MAX_TYPING_TICKS = 40;  // 2 menit timeout

    // Snapshot teks halaman SEBELUM GPT jawab
    const pageTextBefore = getMainText();
    console.log(`[Monitor] Mulai memantau. Snapshot halaman: ${pageTextBefore.length} chars`);

    monitorInterval = setInterval(() => {
        if (!engineActive || isStopping) {
            clearInterval(monitorInterval);
            return;
        }

        monitorTick++;

        // 1. DETEKSI TOMBOL "Continue generating"
        const allButtons = Array.from(document.querySelectorAll('button'));
        const continueBtn = allButtons.find(btn => {
            const t = (btn.innerText || '').toLowerCase();
            return t.includes('continue generating') || t.includes('lanjutkan');
        });
        if (continueBtn) {
            console.log("[Monitor] Klik 'Continue generating'...");
            continueBtn.click();
            wasTyping = false;
            return;
        }

        // 2. DETEKSI ERROR + auto regenerate
        const regenerateBtn = allButtons.find(btn => {
            const t = (btn.innerText || '').toLowerCase();
            return t.includes('regenerate') || t.includes('coba lagi');
        });
        if (regenerateBtn && (document.querySelector('.text-red-500') || document.querySelector('.bg-red-500'))) {
            if (monitorTick % 3 === 0) {
                regenerateBtn.click();
                console.warn("[Monitor] Error ChatGPT, klik regenerate...");
            }
            return;
        }

        // 3. DETEKSI TYPING
        const stopButton = document.querySelector('button[data-testid="stop-button"]') ||
                           document.querySelector('button[aria-label*="Stop"]');
        const streamingEl = document.querySelector('.result-streaming');
        const isTyping = !!(stopButton || streamingEl);

        if (isTyping) {
            wasTyping = true;
            typingTicks++;
            doneWaitTicks = 0;

            // KUNCI: Tangkap teks SELAMA streaming berlangsung
            captureStreamingText();

            if (monitorTick % 5 === 0) {
                console.log(`[Monitor] GPT mengetik... ${typingTicks * 3}s | Captured: ${lastCapturedText.length} chars`);
            }

            // Timeout 2 menit
            if (typingTicks >= MAX_TYPING_TICKS) {
                console.warn("[Monitor] GPT stuck > 2 menit! Paksa stop...");
                if (stopButton) stopButton.click();
                typingTicks = 0;
                // Jangan return, lanjut proses teks yang ada
            } else {
                return;
            }
        }

        // 4. GPT BERHENTI NGETIK
        if (wasTyping && !isTyping) {
            // Tunggu 2 tick (6 detik) setelah berhenti, pastikan benar-benar selesai
            doneWaitTicks++;
            if (doneWaitTicks < 2) {
                // Tangkap sekali lagi setelah streaming selesai
                captureStreamingText();
                console.log(`[Monitor] GPT berhenti. Tunggu konfirmasi... (${doneWaitTicks}/2)`);
                return;
            }

            // Tangkap teks final
            captureStreamingText();

            // Coba juga ambil dari perbedaan teks halaman
            if (lastCapturedText.length < 20) {
                const pageTextAfter = getMainText();
                if (pageTextAfter.length > pageTextBefore.length) {
                    lastCapturedText = pageTextAfter.substring(pageTextBefore.length).trim();
                    console.log(`[Monitor] Teks dari diff halaman: ${lastCapturedText.length} chars`);
                }
            }

            if (lastCapturedText.length < 20) {
                console.warn("[Monitor] GPT selesai tapi teks masih kosong. Lanjut menunggu...");
                if (monitorTick > 30) {
                    // Sudah terlalu lama, kirim apa adanya
                    console.warn("[Monitor] Force proceed dengan teks seadanya.");
                } else {
                    return;
                }
            }

            // SUKSES — kirim ke background
            clearInterval(monitorInterval);

            const fullText = lastCapturedText;
            const wordCount = fullText.trim().split(/\s+/).filter(w => w.length > 0).length;
            let lastParagraph = fullText.substring(fullText.length - 300).trim().replace(/\n/g, ' ');

            console.log(`[Monitor] AI Selesai! ${wordCount} kata (${fullText.length} chars).`);
            console.log(`[Monitor] Preview: "${fullText.substring(0, 150)}..."`);

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

            wasTyping = false;
            lastCapturedText = "";
            return;
        }

        // 5. Tidak pernah ngetik? Mungkin pesan langsung muncul
        if (!wasTyping && monitorTick % 5 === 0) {
            captureStreamingText();
            console.log(`[Monitor] Tick #${monitorTick} | Belum typing | Captured: ${lastCapturedText.length} chars`);
        }

    }, 3000);

    // === HELPER: Tangkap teks dari berbagai sumber ===
    function captureStreamingText() {
        let text = "";

        // Cara 1: Dari elemen yang sedang streaming (.result-streaming)
        const streaming = document.querySelector('.result-streaming');
        if (streaming) {
            text = streaming.innerText || streaming.textContent || "";
        }

        // Cara 2: Dari <article> conversation turns — ambil yang terakhir
        if (text.trim().length < 20) {
            const turns = document.querySelectorAll('article[data-testid^="conversation-turn"]');
            if (turns.length > 0) {
                text = turns[turns.length - 1].innerText || "";
            }
        }

        // Cara 3: Dari container utama chat — ambil semua teks setelah prompt terakhir
        if (text.trim().length < 20) {
            const mainEl = document.querySelector('main') || document.querySelector('[role="main"]');
            if (mainEl) {
                text = mainEl.innerText || "";
                // Ambil hanya bagian setelah teks sebelumnya (kasar tapi jalan)
                if (text.length > pageTextBefore.length) {
                    text = text.substring(pageTextBefore.length);
                }
            }
        }

        // Cara 4: Cari semua element dengan class mengandung "markdown"
        if (text.trim().length < 20) {
            const allEls = document.querySelectorAll('[class*="markdown"], [class*="prose"]');
            if (allEls.length > 0) {
                text = allEls[allEls.length - 1].innerText || "";
            }
        }

        text = text.trim();
        // Simpan jika lebih panjang dari yang sudah ditangkap
        if (text.length > lastCapturedText.length) {
            lastCapturedText = text;
        }
    }
}

// === HELPER: Ambil semua teks dari area chat utama ===
function getMainText() {
    const mainEl = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    return (mainEl.innerText || "").trim();
}
