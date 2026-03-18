// Memantau Jumlah Kata
function checkWordCount() {
    // Mencari bubble jumlah kata di pojok kiri bawah
    const wordCountBubble = document.querySelector('.docs-word-count-bubble');
    if (wordCountBubble) {
        const text = wordCountBubble.innerText;
        const count = parseInt(text.replace(/\D/g, ''));

        if (count >= 15000) {
            chrome.runtime.sendMessage({ type: "DOC_LIMIT_REACHED", count: count });
        }
    }
}

// Jalankan setiap 10 detik
setInterval(checkWordCount, 10000);