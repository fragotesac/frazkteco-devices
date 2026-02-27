/**
 * slk20r.js
 * Módulo para captura de huellas con ZKTeco SLK20R via ZKFinger SDK (ffi-napi)
 *
 * REQUISITOS:
 *   1. Instalar ZKFinger SDK desde https://www.zkteco.com (drivers + DLL)
 *      El instalador copia libzkfplib.dll en C:\Windows\System32\
 *   2. npm install ffi-napi ref-napi
 *
 * FUNCIONES EXPORTADAS:
 *   inicializar()     → abre el dispositivo, retorna { ok, handle }
 *   capturarHuella(handle, intentos) → captura N lecturas y retorna template fusionado
 *   cerrar(handle)    → cierra el dispositivo
 *   disponible()      → true si el SDK está instalado
 */

let ffi, ref, IntType, UIntType, VoidPtrType, UCharPtrType, UIntPtrType;
let zkfp;
let sdkDisponible = false;

// Intentar cargar ffi-napi y el DLL (puede no estar instalado)
try {
  ffi        = require('ffi-napi');
  ref        = require('ref-napi');
  IntType    = ref.types.int;
  UIntType   = ref.types.uint;
  VoidPtrType  = ref.refType(ref.types.void);
  UCharPtrType = ref.refType(ref.types.uchar);
  UIntPtrType  = ref.refType(UIntType);

  // Nombre del DLL — puede variar según la versión instalada del SDK
  const DLL_NAMES = [
    'libzkfplib',          // ZKFinger SDK v5.x+
    'zkfinger10',          // ZKFinger SDK v4.x
    'libzkfpcsharp',       // wrapper C#
  ];

  for (const dll of DLL_NAMES) {
    try {
      zkfp = ffi.Library(dll, {
        'ZKFPM_Init':                ['int',  []],
        'ZKFPM_Terminate':           ['int',  []],
        'ZKFPM_OpenDevice':          ['pointer', ['int']],
        'ZKFPM_CloseDevice':         ['int',  ['pointer']],
        'ZKFPM_AcquireFingerprint':  ['int',  ['pointer', 'pointer', 'pointer', 'pointer', 'pointer']],
        'ZKFPM_DBMerge':             ['int',  ['pointer', 'pointer', 'uint', 'pointer', 'uint', 'pointer', 'uint', 'pointer', 'pointer']],
        'ZKFPM_GetLastAcquireImage': ['int',  ['pointer', 'pointer', 'pointer']],
      });
      sdkDisponible = true;
      console.log(`[SLK20R] SDK cargado: ${dll}`);
      break;
    } catch {}
  }

  if (!sdkDisponible) {
    console.warn('[SLK20R] DLL no encontrado. Captura de huellas no disponible.');
  }
} catch {
  console.warn('[SLK20R] ffi-napi no instalado. Ejecuta: npm install ffi-napi ref-napi');
}

// ─── Tamaños de buffer según el SDK ──────────────────────────────────────────
const IMG_BUFFER_SIZE  = 500 * 500;   // imagen BMP
const FP_BUFFER_SIZE   = 2048;        // template biométrico

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Inicializa el SDK y abre el primer dispositivo USB disponible.
 * @returns {{ ok: boolean, handle: Buffer|null, error?: string }}
 */
function inicializar() {
  if (!sdkDisponible) return { ok: false, error: 'SDK no disponible' };

  try {
    const count = zkfp.ZKFPM_Init();
    if (count <= 0) {
      return { ok: false, error: `No se encontraron dispositivos (código ${count})` };
    }

    const handle = zkfp.ZKFPM_OpenDevice(0); // índice 0 = primer dispositivo
    if (!handle || handle.isNull()) {
      zkfp.ZKFPM_Terminate();
      return { ok: false, error: 'No se pudo abrir el dispositivo SLK20R' };
    }

    return { ok: true, handle };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Captura N lecturas del dedo y fusiona los templates en uno solo.
 * @param {Buffer} handle - handle del dispositivo
 * @param {number} lecturas - número de capturas (default 3)
 * @param {number} timeoutMs - tiempo máximo de espera por lectura en ms
 * @returns {{ ok: boolean, template: Buffer|null, error?: string }}
 */
async function capturarHuella(handle, lecturas = 3, timeoutMs = 15000) {
  if (!sdkDisponible) return { ok: false, error: 'SDK no disponible' };

  const templates = [];

  for (let i = 0; i < lecturas; i++) {
    const resultado = await esperarLectura(handle, timeoutMs);
    if (!resultado.ok) return resultado;
    templates.push(resultado.template);
    console.log(`[SLK20R] Lectura ${i + 1}/${lecturas} OK (${resultado.template.length} bytes)`);
  }

  // Si solo hay 1 lectura, devolver directamente sin fusionar
  if (templates.length === 1) {
    return { ok: true, template: templates[0] };
  }

  // Fusionar 3 templates en uno (requiere exactamente 3)
  if (templates.length >= 3) {
    const fusionado = fusionarTemplates(handle, templates[0], templates[1], templates[2]);
    if (fusionado.ok) return fusionado;
  }

  // Si la fusión falla, usar el primer template directamente
  return { ok: true, template: templates[0] };
}

/**
 * Espera una lectura de huella con timeout.
 * @returns {{ ok: boolean, template: Buffer|null, error?: string }}
 */
function esperarLectura(handle, timeoutMs) {
  return new Promise((resolve) => {
    const inicio = Date.now();

    const intentar = () => {
      try {
        // Buffers para imagen y template
        const imgBuf      = Buffer.alloc(IMG_BUFFER_SIZE);
        const imgSizeBuf  = ref.alloc(UIntType, IMG_BUFFER_SIZE);
        const fpBuf       = Buffer.alloc(FP_BUFFER_SIZE);
        const fpSizeBuf   = ref.alloc(UIntType, FP_BUFFER_SIZE);

        const ret = zkfp.ZKFPM_AcquireFingerprint(handle, imgBuf, imgSizeBuf, fpBuf, fpSizeBuf);

        if (ret === 0) {
          // Lectura exitosa
          const fpSize = fpSizeBuf.deref();
          const template = Buffer.from(fpBuf.slice(0, fpSize));
          resolve({ ok: true, template });
        } else if (Date.now() - inicio >= timeoutMs) {
          resolve({ ok: false, error: `Timeout esperando huella (código ${ret})` });
        } else {
          // Reintentar en 200ms
          setTimeout(intentar, 200);
        }
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    };

    intentar();
  });
}

/**
 * Fusiona 3 templates en uno usando ZKFPM_DBMerge.
 */
function fusionarTemplates(handle, t1, t2, t3) {
  try {
    const regTemplate = Buffer.alloc(FP_BUFFER_SIZE);
    const regSizeBuf  = ref.alloc(UIntType, FP_BUFFER_SIZE);

    const ret = zkfp.ZKFPM_DBMerge(
      handle,
      t1, t1.length,
      t2, t2.length,
      t3, t3.length,
      regTemplate, regSizeBuf
    );

    if (ret === 0) {
      const size = regSizeBuf.deref();
      return { ok: true, template: Buffer.from(regTemplate.slice(0, size)) };
    }
    return { ok: false, error: `ZKFPM_DBMerge falló con código ${ret}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Cierra el dispositivo y libera el SDK.
 */
function cerrar(handle) {
  if (!sdkDisponible || !handle) return;
  try {
    zkfp.ZKFPM_CloseDevice(handle);
    zkfp.ZKFPM_Terminate();
  } catch {}
}

/**
 * Indica si el SDK está disponible.
 */
function disponible() {
  return sdkDisponible;
}

module.exports = { inicializar, capturarHuella, cerrar, disponible };