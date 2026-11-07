// Bundled locally at build time; no runtime CDN or third-party QR service.
import { sha256 } from '@noble/hashes/sha2.js';
import QRCode from 'qrcode';
window.ZeydropHash = sha256;
window.ZeydropQR = QRCode;
