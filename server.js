/**
 * ZKControl - server.js
 *
 * Arquitectura:
 *   SLK20R (USB) ──► captura template ──► BD SQLite ──► MA300 (red) sincroniza usuario
 *   MA300 (red)  ──► descarga marcaciones ──► BD SQLite ──► Dashboard
 */

// ─── Protección global contra crashes de node-zklib ──────────────────────────
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  const esZkError = msg.includes('subarray') || msg.includes('TIMEOUT') ||
                    msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') ||
                    msg.includes('EPIPE');
  if (esZkError) {
    log(`⚠ [zklib interno] ${msg}`);
  } else {
    console.error('✗ Error no manejado:', err);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  const esZkError = msg.includes('subarray') || msg.includes('TIMEOUT') ||
                    msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET');
  if (esZkError) {
    log(`⚠ [zklib rechazo] ${msg}`);
  } else {
    console.error('✗ Promise no manejada:', reason);
  }
});

const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');
const ZKLib    = require('node-zklib');
const slk20r   = require('./slk20r');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT             = 3000;
const MA300_IP         = '192.168.18.201';
const MA300_PORT       = 4370;
const ZK_TIMEOUT       = 10000;
const ZK_RECV_TIMEOUT  = 5000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ─── Base de datos ────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'zkteco.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    uid          INTEGER UNIQUE,          -- ID numérico para el MA300 (1-65535)
    dni          TEXT    UNIQUE NOT NULL,
    nombre       TEXT    NOT NULL,
    apellido     TEXT    DEFAULT '',
    badge_number TEXT,
    creado_en    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS huellas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id    INTEGER NOT NULL,
    dedo          INTEGER DEFAULT 1,
    template      BLOB,                   -- template biométrico del SLK20R
    registrado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  );

  CREATE TABLE IF NOT EXISTS marcaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id  INTEGER,
    dni         TEXT,
    fecha_hora  DATETIME NOT NULL,
    dispositivo TEXT     DEFAULT 'MA300',
    tipo        TEXT,
    creado_en   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dni, fecha_hora)
  );

  -- Secuencia para uid del MA300 (1-65535)
  CREATE TABLE IF NOT EXISTS secuencia_uid (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    valor INTEGER DEFAULT 1
  );
  INSERT OR IGNORE INTO secuencia_uid (id, valor) VALUES (1, 1);
`);

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('es-PE')}] ${msg}`);
}

// ─── Secuencia de UID para MA300 ─────────────────────────────────────────────
function siguienteUID() {
  const row = db.prepare('SELECT valor FROM secuencia_uid WHERE id = 1').get();
  const uid = row.valor;
  db.prepare('UPDATE secuencia_uid SET valor = ? WHERE id = 1').run(uid + 1);
  return uid;
}

// ─── Migraciones: BD existente sin columnas nuevas ────────────────────────────
;(function migrar() {
  const cols = db.prepare('PRAGMA table_info(usuarios)').all().map(c => c.name);
  if (!cols.includes('uid')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN uid INTEGER');
    log('Migracion: columna uid añadida');
  }
  if (!cols.includes('apellido')) {
    db.exec("ALTER TABLE usuarios ADD COLUMN apellido TEXT DEFAULT ''");
    log('Migracion: columna apellido añadida');
  }
  const sinUid = db.prepare('SELECT id FROM usuarios WHERE uid IS NULL').all();
  if (sinUid.length > 0) {
    const setUid = db.prepare('UPDATE usuarios SET uid = ? WHERE id = ?');
    for (const u of sinUid) setUid.run(siguienteUID(), u.id);
    log(`Migracion: uid asignado a ${sinUid.length} usuarios existentes`);
  }
})();

// ─── ZK: una conexión, una operación, cierre seguro ──────────────────────────
async function zkEjecutar(operacion, timeoutMs = 20000) {
  const zk = new ZKLib(MA300_IP, MA300_PORT, ZK_TIMEOUT, ZK_RECV_TIMEOUT);
  let conectado = false;

  const timer = setTimeout(() => {
    // Destruir socket si el timeout externo se activa
    try { zk.zklibtcp?.socket?.destroy(); } catch {}
  }, timeoutMs);

  try {
    await zk.createSocket();
    conectado = true;
    const result = await operacion(zk);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    const msg = err?.err?.message || err?.message || String(err);
    throw new Error(msg);
  } finally {
    if (conectado) {
      try { await zk.disconnect(); } catch {
        try { zk.zklibtcp?.socket?.destroy(); } catch {}
      }
    }
  }
}

// ─── Sincronización automática ────────────────────────────────────────────────
let sincronizando = false;

async function sincronizarMarcaciones() {
  if (sincronizando) return;
  sincronizando = true;
  log('Sincronizando desde MA300...');

  // PASO 1: usuarios (conexión independiente)
  try {
    const users = await zkEjecutar(async (zk) => {
      const { data } = await zk.getUsers();
      return data || [];
    });

    log(`  Usuarios en dispositivo: ${users.length}`);

    // Importar usuarios del MA300 que no existan en BD
    const insert = db.prepare(`
      INSERT OR IGNORE INTO usuarios (uid, dni, nombre, badge_number)
      VALUES (@uid, @dni, @nombre, @badge_number)
    `);
    for (const u of users) {
      insert.run({
        uid:          u.uid || 0,
        dni:          String(u.userId),
        nombre:       u.name || String(u.userId),
        badge_number: String(u.userId)
      });
    }
  } catch (err) {
    log(`✗ Error obteniendo usuarios: ${err.message}`);
    sincronizando = false;
    return;
  }

  // PASO 2: marcaciones (conexión independiente)
  // El MA300 standalone puede no soportar getAttendances — es opcional
  try {
    const logs = await zkEjecutar(async (zk) => {
      const { data } = await zk.getAttendances();
      return data || [];
    }, 15000);

    const insertM = db.prepare(`
      INSERT OR IGNORE INTO marcaciones (usuario_id, dni, fecha_hora, dispositivo, tipo)
      SELECT u.id, @dni, @fecha_hora, @dispositivo, @tipo
      FROM usuarios u WHERE u.badge_number = @dni
    `);

    let nuevas = 0;
    for (const l of logs) {
      const r = insertM.run({
        dni:         String(l.deviceUserId),
        fecha_hora:  l.recordTime,
        dispositivo: 'MA300',
        tipo:        l.type === 0 ? 'ENTRADA' : 'SALIDA'
      });
      if (r.changes) nuevas++;
    }
    log(`✓ Sincronización completa: ${nuevas} nuevas de ${logs.length} marcaciones`);
  } catch (err) {
    // No crítico — el MA300 standalone a veces no soporta este comando por TCP
    log(`⚠ getAttendances no disponible (normal en MA300 standalone): ${err.message}`);
    log('  → Usa el botón "Descargar eventos" manualmente o exporta por USB');
  } finally {
    sincronizando = false;
  }
}

setTimeout(sincronizarMarcaciones, 2000);
setInterval(sincronizarMarcaciones, SYNC_INTERVAL_MS);

// ─── RUTAS ────────────────────────────────────────────────────────────────────

// ── Usuarios ──────────────────────────────────────────────────────────────────
app.get('/usuarios', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM usuarios ORDER BY creado_en DESC').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/usuario', (req, res) => {
  const { dni, nombre, apellido } = req.body;
  if (!dni || !nombre) return res.status(400).json({ error: 'dni y nombre son requeridos' });

  try {
    // Verificar si ya existe para no consumir un uid nuevo
    const existe = db.prepare('SELECT * FROM usuarios WHERE dni = ?').get(dni);
    if (existe) {
      db.prepare('UPDATE usuarios SET nombre=?, apellido=?, badge_number=? WHERE dni=?')
        .run(nombre, apellido || '', dni, dni);
      return res.json({ ok: true, id: existe.id, uid: existe.uid, mensaje: `Usuario ${nombre} actualizado` });
    }

    const uid = siguienteUID();
    const result = db.prepare(`
      INSERT INTO usuarios (uid, dni, nombre, apellido, badge_number)
      VALUES (@uid, @dni, @nombre, @apellido, @badge_number)
    `).run({ uid, dni, nombre, apellido: apellido || '', badge_number: dni });

    log(`Usuario creado: ${nombre} | DNI: ${dni} | UID MA300: ${uid}`);
    res.json({ ok: true, id: result.lastInsertRowid, uid, mensaje: `Usuario ${nombre} registrado (UID: ${uid})` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Marcaciones ───────────────────────────────────────────────────────────────
app.get('/marcaciones', (req, res) => {
  const { desde, hasta, dni } = req.query;
  let query = `
    SELECT m.id, m.fecha_hora, m.tipo, m.dispositivo,
           u.nombre, u.apellido, u.dni,
           CASE WHEN u.id IS NOT NULL THEN 'VALIDADO' ELSE 'NO REGISTRADO' END AS estado
    FROM marcaciones m
    LEFT JOIN usuarios u ON m.dni = u.badge_number
    WHERE 1=1
  `;
  const params = [];
  if (desde) { query += ' AND m.fecha_hora >= ?'; params.push(desde); }
  if (hasta)  { query += ' AND m.fecha_hora <= ?'; params.push(hasta + ' 23:59:59'); }
  if (dni)    { query += ' AND u.dni = ?';          params.push(dni); }
  query += ' ORDER BY m.fecha_hora DESC';
  try {
    res.json(db.prepare(query).all(...params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/marcaciones/sin-validar', (req, res) => {
  try {
    res.json(db.prepare(`
      SELECT m.* FROM marcaciones m
      LEFT JOIN usuarios u ON m.dni = u.badge_number
      WHERE u.id IS NULL
    `).all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Captura de huella con SLK20R ─────────────────────────────────────────────
// Estado del lector (una captura a la vez)
let capturaActiva = false;
let slkHandle     = null;

app.get('/slk20r/estado', (req, res) => {
  res.json({
    sdkDisponible: slk20r.disponible(),
    capturaActiva,
    conectado: slkHandle !== null
  });
});

app.post('/captura-huella', async (req, res) => {
  const { dni, lecturas = 3 } = req.body;
  if (!dni) return res.status(400).json({ error: 'dni es requerido' });
  if (capturaActiva) return res.status(409).json({ error: 'Ya hay una captura en progreso' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE dni = ?').get(dni);
  if (!usuario) return res.status(404).json({ error: `Usuario con DNI ${dni} no encontrado` });

  // ── Sin SDK: modo placeholder ──────────────────────────────────────────────
  if (!slk20r.disponible()) {
    log(`⚠ SLK20R SDK no disponible — usando placeholder para ${usuario.nombre}`);
    const template = Buffer.from(`placeholder-${dni}-${Date.now()}`);
    guardarTemplate(usuario.id, template);
    await sincronizarUsuarioMA300(usuario);
    return res.json({
      ok: true,
      advertencia: 'SDK ZKFinger no instalado — template placeholder guardado',
      mensaje: `Usuario ${usuario.nombre} registrado sin huella real`
    });
  }

  // ── Con SDK: captura real del SLK20R ──────────────────────────────────────
  capturaActiva = true;
  log(`Iniciando captura SLK20R para: ${usuario.nombre} (DNI: ${dni})`);

  try {
    // Abrir dispositivo
    if (!slkHandle) {
      const init = slk20r.inicializar();
      if (!init.ok) {
        capturaActiva = false;
        return res.status(500).json({ error: `SLK20R: ${init.error}` });
      }
      slkHandle = init.handle;
      log('SLK20R abierto');
    }

    // Capturar huellas (bloqueante hasta timeout de 15s por lectura)
    log(`Capturando ${lecturas} lecturas — el usuario debe colocar el dedo en el SLK20R`);
    const resultado = await slk20r.capturarHuella(slkHandle, parseInt(lecturas), 15000);

    if (!resultado.ok) {
      capturaActiva = false;
      return res.status(500).json({ error: `Captura fallida: ${resultado.error}` });
    }

    // Guardar template en BD
    guardarTemplate(usuario.id, resultado.template);
    log(`✓ Template guardado: ${resultado.template.length} bytes`);

    // Sincronizar usuario (solo datos, no huella) al MA300 via TCP
    await sincronizarUsuarioMA300(usuario);

    capturaActiva = false;
    res.json({
      ok: true,
      mensaje: `Huella de ${usuario.nombre} registrada (${resultado.template.length} bytes)`,
      templateSize: resultado.template.length
    });

  } catch (err) {
    capturaActiva = false;
    // Cerrar handle si hubo error
    try { slk20r.cerrar(slkHandle); slkHandle = null; } catch {}
    res.status(500).json({ error: err.message });
  }
});

// Cerrar lector al terminar la captura de la sesión
app.get('/slk20r/diagnostico', (req, res) => {
  const { execSync } = require('child_process');
  let dlls = [];
  try {
    const out = execSync('dir C:\Windows\System32\*zk*.dll /b 2>nul & dir C:\Windows\System32\*fp*.dll /b 2>nul & dir C:\Windows\SysWOW64\*zk*.dll /b 2>nul & dir C:\Windows\SysWOW64\*fp*.dll /b 2>nul', { shell: 'cmd.exe', encoding: 'utf8' });
    dlls = out.trim().split('
').map(s => s.trim()).filter(Boolean);
  } catch {}
  res.json({ sdkDisponible: slk20r.disponible(), dlls, mensaje: dlls.length ? 'DLLs encontrados' : 'Ningún DLL zk/fp encontrado en System32' });
});

app.post('/slk20r/cerrar', (req, res) => {
  if (slkHandle) {
    slk20r.cerrar(slkHandle);
    slkHandle = null;
    log('SLK20R cerrado manualmente');
  }
  res.json({ ok: true });
});

// ── Helpers internos ──────────────────────────────────────────────────────────
function guardarTemplate(usuarioId, template) {
  const existe = db.prepare('SELECT id FROM huellas WHERE usuario_id = ?').get(usuarioId);
  if (existe) {
    db.prepare('UPDATE huellas SET template=?, registrado_en=CURRENT_TIMESTAMP WHERE usuario_id=?')
      .run(template, usuarioId);
  } else {
    db.prepare('INSERT INTO huellas (usuario_id, dedo, template) VALUES (?,1,?)')
      .run(usuarioId, template);
  }
}

async function sincronizarUsuarioMA300(usuario) {
  try {
    // setUser(uid, userId, name, password, role, cardno)
    // uid   → entero pequeño 1-65535 (campo uid de nuestra BD)
    // userId → string que el dispositivo usa como badge number (= DNI)
    await zkEjecutar(async (zk) => {
      await zk.setUser(usuario.uid, usuario.badge_number, usuario.nombre, '', 0, 0);
    }, 10000);
    log(`✓ Usuario sincronizado al MA300: ${usuario.nombre} (uid=${usuario.uid})`);
  } catch (err) {
    log(`⚠ No se pudo sincronizar al MA300: ${err.message}`);
  }
}

// ── Dispositivo MA300 ─────────────────────────────────────────────────────────
app.get('/dispositivo/info', async (req, res) => {
  const info = {
    ip:          MA300_IP,
    puerto:      MA300_PORT,
    firmware:    'Ver 6.60',
    usuarios:    0,
    huellas:     0,
    marcaciones: 0,
    slkConectado: slk20r.disponible() && slkHandle !== null
  };

  try {
    const users = await zkEjecutar(async (zk) => {
      const { data } = await zk.getUsers();
      return data || [];
    });
    info.usuarios = users.length;
    info.huellas  = users.filter(u => u.fingerprintCount > 0).length;
  } catch (err) {
    log(`⚠ /dispositivo/info - getUsers: ${err.message}`);
  }

  // getAttendances es opcional
  try {
    const logs = await zkEjecutar(async (zk) => {
      const { data } = await zk.getAttendances();
      return data || [];
    }, 12000);
    info.marcaciones = logs.length;
  } catch {
    // no crítico
  }

  res.json(info);
});

app.post('/dispositivo/descargar-eventos', async (req, res) => {
  try {
    const logs = await zkEjecutar(async (zk) => {
      const { data } = await zk.getAttendances();
      return data || [];
    }, 20000);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO marcaciones (usuario_id, dni, fecha_hora, dispositivo, tipo)
      SELECT u.id, @dni, @fecha_hora, @dispositivo, @tipo
      FROM usuarios u WHERE u.badge_number = @dni
    `);

    let nuevas = 0;
    for (const l of logs) {
      const r = insert.run({
        dni:         String(l.deviceUserId),
        fecha_hora:  l.recordTime,
        dispositivo: 'MA300',
        tipo:        l.type === 0 ? 'ENTRADA' : 'SALIDA'
      });
      if (r.changes) nuevas++;
    }
    res.json({ ok: true, mensaje: `${nuevas} nuevas marcaciones descargadas (total: ${logs.length})` });
  } catch (err) {
    res.status(500).json({ error: `getAttendances falló: ${err.message}. Prueba exportando por USB (FAT32, max 8GB).` });
  }
});

app.post('/dispositivo/sincronizar', async (req, res) => {
  const usuarios = db.prepare('SELECT * FROM usuarios WHERE uid IS NOT NULL').all();
  let ok = 0, errores = 0;

  for (const u of usuarios) {
    try {
      await zkEjecutar(async (zk) => {
        await zk.setUser(u.uid, u.badge_number, u.nombre, '', 0, 0);
      }, 8000);
      ok++;
    } catch (e) {
      log(`⚠ No se pudo sincronizar ${u.nombre} (uid=${u.uid}): ${e.message}`);
      errores++;
    }
  }

  res.json({ ok: true, mensaje: `${ok} sincronizados, ${errores} errores de ${usuarios.length} usuarios` });
});

// ─── Cerrar SLK20R al salir del proceso ──────────────────────────────────────
process.on('SIGINT', () => {
  if (slkHandle) { slk20r.cerrar(slkHandle); slkHandle = null; }
  process.exit(0);
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`✓ ZKControl corriendo en http://localhost:${PORT}`);
  log(`  MA300  → ${MA300_IP}:${MA300_PORT}`);
  log(`  SLK20R → SDK ${slk20r.disponible() ? 'DISPONIBLE' : 'NO DISPONIBLE (instala ZKFinger SDK + ffi-napi)'}`);
});