'use strict';
// Test-only independent QR decoding: locked pngjs reads PNG pixels; native
// ZBar decodes the symbol. No encoder matrix, application input or expected
// text is supplied to the decoder. No npm/Python package or network service.
const { spawnSync } = require('node:child_process');
const { PNG } = require('pngjs');
const PYTHON = String.raw`
import base64,ctypes,ctypes.util,json,sys
value=json.load(sys.stdin)
name=ctypes.util.find_library('zbar')
if not name:
 print(json.dumps({'error':'QrDecoderUnavailable'}));sys.exit(2)
lib=ctypes.CDLL(name);ptr=ctypes.c_void_p
lib.zbar_image_scanner_create.restype=ptr;lib.zbar_image_create.restype=ptr
lib.zbar_image_set_format.argtypes=[ptr,ctypes.c_ulong]
lib.zbar_image_set_size.argtypes=[ptr,ctypes.c_uint,ctypes.c_uint]
lib.zbar_image_set_data.argtypes=[ptr,ptr,ctypes.c_ulong,ptr]
lib.zbar_scan_image.argtypes=[ptr,ptr]
lib.zbar_image_first_symbol.argtypes=[ptr];lib.zbar_image_first_symbol.restype=ptr
lib.zbar_symbol_next.argtypes=[ptr];lib.zbar_symbol_next.restype=ptr
lib.zbar_symbol_get_type.argtypes=[ptr]
lib.zbar_symbol_get_data.argtypes=[ptr];lib.zbar_symbol_get_data.restype=ptr
lib.zbar_symbol_get_data_length.argtypes=[ptr];lib.zbar_symbol_get_data_length.restype=ctypes.c_uint
lib.zbar_image_destroy.argtypes=[ptr];lib.zbar_image_scanner_destroy.argtypes=[ptr]
scanner=lib.zbar_image_scanner_create();image=lib.zbar_image_create()
if not scanner or not image:raise RuntimeError('native allocation failed')
try:
 raw=base64.b64decode(value['gray'],validate=True)
 if len(raw)!=value['width']*value['height']:raise ValueError('invalid image size')
 buffer=ctypes.create_string_buffer(raw)
 lib.zbar_image_set_format(image,int.from_bytes(b'Y800','little'))
 lib.zbar_image_set_size(image,value['width'],value['height'])
 lib.zbar_image_set_data(image,ctypes.cast(buffer,ptr),len(raw),None)
 count=lib.zbar_scan_image(scanner,image);symbol=lib.zbar_image_first_symbol(image);items=[]
 while symbol:
  if len(items)>=4:raise ValueError('too many symbols')
  size=lib.zbar_symbol_get_data_length(symbol)
  if size>8192:raise ValueError('symbol too large')
  data=ctypes.string_at(lib.zbar_symbol_get_data(symbol),size)
  items.append({'type':lib.zbar_symbol_get_type(symbol),'data':base64.b64encode(data).decode('ascii')})
  symbol=lib.zbar_symbol_next(symbol)
 print(json.dumps({'count':count,'symbols':items}))
finally:
 lib.zbar_image_destroy(image);lib.zbar_image_scanner_destroy(scanner)
`;
function failure(name) { return Object.assign(Error(name), { name }); }
function decodeQrPng(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw failure('QrImageError');
    let image;
    try { image = PNG.sync.read(bytes, { checkCRC: true }); } catch { throw failure('QrImageError'); }
    if (image.width < 21 || image.height < 21 || image.width > 1024 || image.height > 1024) throw failure('QrImageError');
    const gray = Buffer.alloc(image.width * image.height);
    for (let i = 0; i < gray.length; i++) {
        const at = i * 4, alpha = image.data[at + 3] / 255;
        gray[i] = Math.round((.299 * image.data[at] + .587 * image.data[at + 1] + .114 * image.data[at + 2]) * alpha + 255 * (1 - alpha));
    }
    const child = spawnSync('python3', ['-c', PYTHON], { input: JSON.stringify({ width: image.width, height: image.height, gray: gray.toString('base64') }),
        encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 });
    let result;
    try { result = JSON.parse(child.stdout); } catch { throw failure('QrDecoderUnavailable'); }
    if (child.status !== 0 || child.error) throw failure(result.error === 'QrDecoderUnavailable' ? 'QrDecoderUnavailable' : 'QrDecodeError');
    if (result.count !== 1 || result.symbols?.length !== 1 || result.symbols[0].type !== 64) throw failure('QrDecodeError');
    const value = Buffer.from(result.symbols[0].data, 'base64');
    if (value.length > 8192) throw failure('QrDecodeError');
    return value;
}
async function selfTest() {
    const assert = require('node:assert/strict'), QR = require('qrcode');
    for (const text of ['  中文 👋\n<em>literal</em>\nhttps://example.test/a?x=1&y=2  ', 'a'.repeat(800)]) {
        const png = await QR.toBuffer([{ data: text, mode: 'byte' }], { width: 512, margin: 4, errorCorrectionLevel: 'M' });
        assert.deepEqual(decodeQrPng(png), Buffer.from(text, 'utf8'));
    }
    const blank = new PNG({ width: 128, height: 128 }); blank.data.fill(255);
    assert.throws(() => decodeQrPng(PNG.sync.write(blank)), { name: 'QrDecodeError' });
    assert.throws(() => decodeQrPng(Buffer.from('not a png')), { name: 'QrImageError' });
    return { decoder: 'native libzbar via standard-library ctypes', utf8AndBoundaryVectors: 2, blankAndInvalidRejected: true };
}
module.exports = { decodeQrPng, selfTest };
if (require.main === module) selfTest().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.name); process.exitCode = 1; });
