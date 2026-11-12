// STUN discovers candidate addresses; it never relays file contents.
// Only stun: URLs are accepted. TURN and file proxy fallbacks are forbidden.
window.ZEYDROP_CONFIG = {
    enableStun: true,
    iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' }
    ],
    memoryLimit: 64 * 1024 * 1024
};
