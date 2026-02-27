/**
 * slk20r.js - Captura de huellas SLK20R via ZKFinger SDK (koffi)
 *
 * REQUISITOS:
 *   - ZKFinger SDK instalado (copia DLL a Windows\System32)
 *   - npm install  (koffi está en package.json)
 */

let koffi;
let lib;
let sdkOk = false;

const IMG_SIZE = 500 * 500;
const FP_SIZE  = 2048;

// Todos los nombres conocidos del DLL según versión del SDK
// Probamos nombre solo Y con ruta absoluta a System32
const SYS32 = 'C:\\Windows\\System32\\';
const SYS32_86 = 'C:\\Windows\\SysWOW64\\';

const DLL_CANDIDATES = [
  // Con ruta completa (más confiable)
  SYS32    + 'libzkfplib.dll',
  SYS32    + 'zkfinger10.dll',
  SYS32    + 'libzkfp.dll',
  SYS32    + 'ZKFPLib.dll',
  SYS32    + 'zkfplib.dll',
  SYS32    + 'libzkfpcsharp.dll',
  SYS32_86 + 'libzkfplib.dll',
  SYS32_86 + 'zkfinger10.dll',
  SYS32_86 + 'libzkfp.dll',
  SYS32_86 + 'ZKFPLib.dll',
  SYS32_86 + 'zkfplib.dll',
  // Sin ruta (busca en PATH)
  'libzkfplib',
  'zkfinger10',
  'libzkfp',
  'ZKFPLib',
  'zkfplib',
];

try {
  koffi = require('koffi');

  console.log('[SLK20R] Buscando DLL del ZKFinger SDK...');

  for (const dll of DLL_CANDIDATES) {
    try {
      const candidate = koffi.load(dll);

      // Verificar que tenga las funciones esperadas
      candidate.func('ZKFPM_Init',               'int',    []);
      candidate.func('ZKFPM_Terminate',          'int',    []);
      candidate.func('ZKFPM_OpenDevice',         'void*',  ['int']);
      candidate.func('ZKFPM_CloseDevice',        'int',    ['void*']);
      candidate.func('ZKFPM_AcquireFingerprint', 'int',    ['void*', 'uint8*', 'uint32*', 'uint8*', 'uint32*']);
      candidate.func('ZKFPM_DBMerge',            'int',    ['void*', 'uint8*', 'uint32', 'uint8*', 'uint32', 'uint8*', 'uint32', 'uint8*', 'uint32*']);

      lib   = candidate;
      sdkOk = true;
      console.log(`[SLK20R] ✓ SDK cargado: ${dll}`);
      break;
    } catch (e) {
      // Mostrar solo errores que no sean "archivo no encontrado" para no saturar el log
      const msg = e.message || '';
      if (!msg.includes('find') && !msg.includes('open') && !msg.includes('No such') && !msg.includes('cannot') && !msg.includes('The specified module')) {
        console.log(`[SLK20R]   ${dll.split('\\').pop()} → ${msg}`);
      }
    }
  }

  if (!sdkOk) {
    console.warn('[SLK20R] ✗ DLL no encontrado en ninguna ubicación conocida.');
    console.warn('[SLK20R]   Verifica cuál DLL instaló el SDK ejecutando en CMD:');
    console.warn('[SLK20R]   dir C:\\Windows\\System32\\*zk*.dll');
    console.warn('[SLK20R]   dir C:\\Windows\\System32\\*fp*.dll');
  }
} catch (e) {
  console.warn('[SLK20R] koffi no disponible:', e.message);
}

// ─── API pública ──────────────────────────────────────────────────────────────

function disponible() { return sdkOk; }

function inicializar() {
  if (!sdkOk) return { ok: false, error: 'SDK no disponible' };
  try {
    const count = lib.ZKFPM_Init();
    if (count <= 0) return { ok: false, error: `Sin dispositivos USB (código ${count})` };
    const handle = lib.ZKFPM_OpenDevice(0);
    if (!handle) { lib.ZKFPM_Terminate(); return { ok: false, error: 'No se pudo abrir el SLK20R' }; }
    return { ok: true, handle };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function capturarHuella(handle, lecturas = 3, timeoutMs = 15000) {
  if (!sdkOk) return { ok: false, error: 'SDK no disponible' };
  const templates = [];
  for (let i = 0; i < lecturas; i++) {
    console.log(`[SLK20R] Esperando lectura ${i + 1}/${lecturas}...`);
    const r = await esperarLectura(handle, timeoutMs);
    if (!r.ok) return r;
    templates.push(r.template);
    console.log(`[SLK20R] Lectura ${i + 1} OK (${r.template.length} bytes)`);
  }
  if (templates.length >= 3) {
    const fusion = fusionar(handle, templates[0], templates[1], templates[2]);
    if (fusion.ok) return fusion;
    console.warn(`[SLK20R] DBMerge falló: ${fusion.error} — usando primera lectura`);
  }
  return { ok: true, template: templates[0] };
}

function esperarLectura(handle, timeoutMs) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const poll = () => {
      try {
        const imgBuf     = Buffer.alloc(IMG_SIZE);
        const imgSizeBuf = [IMG_SIZE];
        const fpBuf      = Buffer.alloc(FP_SIZE);
        const fpSizeBuf  = [FP_SIZE];
        const ret = lib.ZKFPM_AcquireFingerprint(handle, imgBuf, imgSizeBuf, fpBuf, fpSizeBuf);
        if (ret === 0) {
          resolve({ ok: true, template: Buffer.from(fpBuf.slice(0, fpSizeBuf[0])) });
        } else if (Date.now() - inicio >= timeoutMs) {
          resolve({ ok: false, error: `Timeout ${timeoutMs}ms esperando dedo` });
        } else {
          setTimeout(poll, 200);
        }
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    };
    poll();
  });
}

function fusionar(handle, t1, t2, t3) {
  try {
    const regBuf     = Buffer.alloc(FP_SIZE);
    const regSizeBuf = [FP_SIZE];
    const ret = lib.ZKFPM_DBMerge(handle, t1, t1.length, t2, t2.length, t3, t3.length, regBuf, regSizeBuf);
    if (ret === 0) return { ok: true, template: Buffer.from(regBuf.slice(0, regSizeBuf[0])) };
    return { ok: false, error: `DBMerge código ${ret}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function cerrar(handle) {
  if (!sdkOk || !handle) return;
  try { lib.ZKFPM_CloseDevice(handle); } catch {}
  try { lib.ZKFPM_Terminate(); } catch {}
}

module.exports = { disponible, inicializar, capturarHuella, cerrar };