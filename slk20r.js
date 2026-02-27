/**
 * slk20r.js - Captura de huellas SLK20R via ZKFinger SDK
 *
 * Usa koffi (binarios precompilados, sin Python ni node-gyp).
 *
 * REQUISITOS:
 *   1. Instalar ZKFinger SDK desde https://www.zkteco.com/support
 *      El instalador copia libzkfplib.dll en C:\Windows\System32\
 *   2. npm install  (koffi ya está en package.json)
 *
 * Si el SDK no está instalado, el módulo queda en modo placeholder
 * y el servidor sigue funcionando con advertencia.
 */

let koffi;
let lib;
let sdkOk = false;

// Nombres posibles del DLL según versión del SDK instalado
const DLL_CANDIDATES = [
  'libzkfplib',    // ZKFinger SDK v5.x (más común)
  'zkfinger10',    // ZKFinger SDK v4.x
];

const IMG_SIZE = 500 * 500;  // buffer imagen BMP
const FP_SIZE  = 2048;       // buffer template biométrico

try {
  koffi = require('koffi');

  for (const dll of DLL_CANDIDATES) {
    try {
      lib = koffi.load(`${dll}.dll`);

      // Declarar las funciones del SDK
      lib.func('ZKFPM_Init',               'int',     []);
      lib.func('ZKFPM_Terminate',          'int',     []);
      lib.func('ZKFPM_OpenDevice',         'void*',   ['int']);
      lib.func('ZKFPM_CloseDevice',        'int',     ['void*']);
      lib.func('ZKFPM_AcquireFingerprint', 'int',     ['void*', 'uint8*', 'uint32*', 'uint8*', 'uint32*']);
      lib.func('ZKFPM_DBMerge',            'int',     ['void*', 'uint8*', 'uint32', 'uint8*', 'uint32', 'uint8*', 'uint32', 'uint8*', 'uint32*']);

      sdkOk = true;
      console.log(`[SLK20R] SDK cargado: ${dll}.dll`);
      break;
    } catch {
      // Probar el siguiente candidato
    }
  }

  if (!sdkOk) {
    console.warn('[SLK20R] DLL no encontrado. Instala ZKFinger SDK desde zkteco.com/support');
  }
} catch {
  console.warn('[SLK20R] koffi no disponible — ejecuta npm install');
}

// ─── API pública ──────────────────────────────────────────────────────────────

function disponible() {
  return sdkOk;
}

/**
 * Inicializa el SDK y abre el primer lector USB.
 * @returns {{ ok: boolean, handle: object|null, error?: string }}
 */
function inicializar() {
  if (!sdkOk) return { ok: false, error: 'SDK no disponible' };

  try {
    const count = lib.ZKFPM_Init();
    if (count <= 0) {
      return { ok: false, error: `No se encontró ningún lector USB (código ${count})` };
    }

    const handle = lib.ZKFPM_OpenDevice(0);
    if (!handle) {
      lib.ZKFPM_Terminate();
      return { ok: false, error: 'No se pudo abrir el SLK20R' };
    }

    return { ok: true, handle };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Captura N lecturas y retorna el template fusionado.
 * Bloqueante: espera a que el usuario coloque el dedo.
 *
 * @param {object} handle
 * @param {number} lecturas  - cuántas capturas hacer (default 3)
 * @param {number} timeoutMs - tiempo máximo por lectura en ms (default 15000)
 * @returns {{ ok: boolean, template: Buffer|null, error?: string }}
 */
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

  // Con 3 templates intentar fusión
  if (templates.length >= 3) {
    const fusion = fusionar(handle, templates[0], templates[1], templates[2]);
    if (fusion.ok) return fusion;
    console.warn(`[SLK20R] DBMerge falló (${fusion.error}), usando primera lectura`);
  }

  return { ok: true, template: templates[0] };
}

/**
 * Espera activamente una lectura exitosa del dedo.
 */
function esperarLectura(handle, timeoutMs) {
  return new Promise((resolve) => {
    const inicio = Date.now();

    const poll = () => {
      try {
        const imgBuf     = Buffer.alloc(IMG_SIZE);
        const imgSizeBuf = [IMG_SIZE];          // koffi pasa uint32* como array de 1 elemento
        const fpBuf      = Buffer.alloc(FP_SIZE);
        const fpSizeBuf  = [FP_SIZE];

        const ret = lib.ZKFPM_AcquireFingerprint(handle, imgBuf, imgSizeBuf, fpBuf, fpSizeBuf);

        if (ret === 0) {
          // Lectura exitosa
          const size = fpSizeBuf[0];
          resolve({ ok: true, template: Buffer.from(fpBuf.slice(0, size)) });
        } else if (Date.now() - inicio >= timeoutMs) {
          resolve({ ok: false, error: `Timeout esperando dedo en SLK20R (${timeoutMs}ms)` });
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

/**
 * Fusiona 3 templates en uno con ZKFPM_DBMerge.
 */
function fusionar(handle, t1, t2, t3) {
  try {
    const regBuf     = Buffer.alloc(FP_SIZE);
    const regSizeBuf = [FP_SIZE];

    const ret = lib.ZKFPM_DBMerge(
      handle,
      t1, t1.length,
      t2, t2.length,
      t3, t3.length,
      regBuf, regSizeBuf
    );

    if (ret === 0) {
      const size = regSizeBuf[0];
      return { ok: true, template: Buffer.from(regBuf.slice(0, size)) };
    }
    return { ok: false, error: `DBMerge retornó ${ret}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Cierra el dispositivo y libera el SDK.
 */
function cerrar(handle) {
  if (!sdkOk || !handle) return;
  try { lib.ZKFPM_CloseDevice(handle); } catch {}
  try { lib.ZKFPM_Terminate(); } catch {}
}

module.exports = { disponible, inicializar, capturarHuella, cerrar };