/**
 * slk20r.js - Captura de huellas SLK20R via ZKFinger SDK (koffi)
 *
 * FIX: koffi.lib.func() RETORNA la funcion, no la adjunta a lib.
 *      Se debe guardar cada referencia: const fn = lib.func(...)
 */

let koffi;
let fn = {};          // aquí guardamos las funciones del SDK
let sdkOk = false;

const IMG_SIZE = 500 * 500;
const FP_SIZE  = 2048;

const DLL_CANDIDATES = [
  'C:\\Windows\\System32\\libzkfp.dll',
  'C:\\Windows\\SysWOW64\\libzkfp.dll',
  'C:\\Windows\\System32\\zkfinger10.dll',
  'C:\\Windows\\SysWOW64\\zkfinger10.dll',
];

try {
  koffi = require('koffi');
  console.log('[SLK20R] Buscando DLL...');

  for (const dll of DLL_CANDIDATES) {
    try {
      const lib = koffi.load(dll);

      // CORRECTO: guardar la función que retorna lib.func()
      const Init               = lib.func('ZKFPM_Init',               'int',    []);
      const Terminate          = lib.func('ZKFPM_Terminate',          'int',    []);
      const OpenDevice         = lib.func('ZKFPM_OpenDevice',         'void*',  ['int']);
      const CloseDevice        = lib.func('ZKFPM_CloseDevice',        'int',    ['void*']);
      const AcquireFingerprint = lib.func('ZKFPM_AcquireFingerprint', 'int',    ['void*', 'uint8 *', 'uint32 *', 'uint8 *', 'uint32 *']);
      const DBMerge            = lib.func('ZKFPM_DBMerge',            'int',    ['void*', 'uint8 *', 'uint32', 'uint8 *', 'uint32', 'uint8 *', 'uint32', 'uint8 *', 'uint32 *']);

      fn = { Init, Terminate, OpenDevice, CloseDevice, AcquireFingerprint, DBMerge };
      sdkOk = true;
      console.log(`[SLK20R] ✓ SDK cargado: ${dll}`);
      break;
    } catch (e) {
      console.log(`[SLK20R]   ${dll.split('\\').pop()} → ${e.message}`);
    }
  }

  if (!sdkOk) console.warn('[SLK20R] ✗ DLL no encontrado');
} catch (e) {
  console.warn('[SLK20R] koffi no disponible:', e.message);
}

// ─── API pública ──────────────────────────────────────────────────────────────

function disponible() { return sdkOk; }

function inicializar() {
  if (!sdkOk) return { ok: false, error: 'SDK no disponible' };
  try {
    const count = fn.Init();
    console.log(`[SLK20R] ZKFPM_Init → ${count} dispositivos`);
    if (count <= 0) return { ok: false, error: `Sin dispositivos USB detectados (código ${count})` };

    const handle = fn.OpenDevice(0);
    if (!handle) {
      fn.Terminate();
      return { ok: false, error: 'No se pudo abrir el SLK20R (handle null)' };
    }
    console.log('[SLK20R] Dispositivo abierto OK');
    return { ok: true, handle };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function capturarHuella(handle, lecturas = 3, timeoutMs = 15000) {
  if (!sdkOk) return { ok: false, error: 'SDK no disponible' };
  const templates = [];

  for (let i = 0; i < lecturas; i++) {
    console.log(`[SLK20R] Esperando lectura ${i + 1}/${lecturas} — coloca el dedo en el lector...`);
    const r = await esperarLectura(handle, timeoutMs);
    if (!r.ok) return r;
    templates.push(r.template);
    console.log(`[SLK20R] Lectura ${i + 1} OK (${r.template.length} bytes)`);
  }

  if (templates.length >= 3) {
    const fusion = fusionar(handle, templates[0], templates[1], templates[2]);
    if (fusion.ok) {
      console.log(`[SLK20R] Template fusionado: ${fusion.template.length} bytes`);
      return fusion;
    }
    console.warn(`[SLK20R] DBMerge falló (${fusion.error}) — usando primera lectura`);
  }

  return { ok: true, template: templates[0] };
}

function esperarLectura(handle, timeoutMs) {
  return new Promise((resolve) => {
    const inicio    = Date.now();
    const imgBuf    = Buffer.alloc(IMG_SIZE);
    const fpBuf     = Buffer.alloc(FP_SIZE);

    const poll = () => {
      try {
        const imgSize = [IMG_SIZE];
        const fpSize  = [FP_SIZE];
        const ret = fn.AcquireFingerprint(handle, imgBuf, imgSize, fpBuf, fpSize);

        if (ret === 0) {
          resolve({ ok: true, template: Buffer.from(fpBuf.slice(0, fpSize[0])) });
        } else if (Date.now() - inicio >= timeoutMs) {
          resolve({ ok: false, error: `Timeout ${timeoutMs / 1000}s esperando dedo (código ${ret})` });
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
    const regBuf  = Buffer.alloc(FP_SIZE);
    const regSize = [FP_SIZE];
    const ret = fn.DBMerge(handle, t1, t1.length, t2, t2.length, t3, t3.length, regBuf, regSize);
    if (ret === 0) return { ok: true, template: Buffer.from(regBuf.slice(0, regSize[0])) };
    return { ok: false, error: `DBMerge código ${ret}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function cerrar(handle) {
  if (!sdkOk || !handle) return;
  try { fn.CloseDevice(handle); } catch {}
  try { fn.Terminate(); } catch {}
}

module.exports = { disponible, inicializar, capturarHuella, cerrar };