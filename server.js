const express = require('express');
const path    = require('path');
const Database = require('better-sqlite3');
const ZKLib   = require('node-zklib');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT     = 3000;
const MA300_IP   = '192.168.18.251';
const MA300_PORT = 4370;
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // sincronizar cada 5 minutos

// ─── Base de datos ────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'zkteco.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dni           TEXT    UNIQUE NOT NULL,
    nombre        TEXT    NOT NULL,
    apellido      TEXT,
    badge_number  TEXT,
    creado_en     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS huellas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id    INTEGER NOT NULL,
    dedo          INTEGER,
    template      BLOB,
    registrado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  );

  CREATE TABLE IF NOT EXISTS marcaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id  INTEGER,
    dni         TEXT,
    fecha_hora  DATETIME NOT NULL,
    dispositivo TEXT DEFAULT 'MA300',
    tipo        TEXT,
    creado_en   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dni, fecha_hora)
  );
`);

// ─── App Express ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // sirve el dashboard

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('es-PE')}] ${msg}`);
}

async function crearConexionMA300() {
  const zk = new ZKLib(MA300_IP, MA300_PORT, 10000, 4000);
  await zk.createSocket();
  return zk;
}

// ─── SINCRONIZACIÓN AUTOMÁTICA MA300 ─────────────────────────────────────────
async function sincronizarMarcaciones() {
  log('Sincronizando marcaciones desde MA300...');
  let zk;
  try {
    zk = await crearConexionMA300();

    // Traer usuarios del dispositivo y guardar si no existen
    const { data: usersDevice } = await zk.getUsers();
    const insertUsuario = db.prepare(`
      INSERT OR IGNORE INTO usuarios (dni, nombre, badge_number)
      VALUES (@dni, @nombre, @badge_number)
    `);
    for (const u of usersDevice) {
      insertUsuario.run({ dni: u.userId, nombre: u.name || u.userId, badge_number: u.userId });
    }

    // Traer marcaciones del dispositivo
    const { data: logs } = await zk.getAttendances();
    const insertMarcacion = db.prepare(`
      INSERT OR IGNORE INTO marcaciones (usuario_id, dni, fecha_hora, dispositivo, tipo)
      SELECT u.id, @dni, @fecha_hora, @dispositivo, @tipo
      FROM usuarios u WHERE u.badge_number = @dni
    `);

    let nuevas = 0;
    for (const l of logs) {
      const result = insertMarcacion.run({
        dni:        String(l.deviceUserId),
        fecha_hora: l.recordTime,
        dispositivo: 'MA300',
        tipo:       l.type === 0 ? 'ENTRADA' : 'SALIDA'
      });
      if (result.changes) nuevas++;
    }

    log(`✓ Sincronización completa: ${nuevas} nuevas marcaciones`);
    await zk.disconnect();
  } catch (err) {
    log(`✗ Error sincronizando MA300: ${err.message}`);
    if (zk) try { await zk.disconnect(); } catch {}
  }
}

// Ejecutar al iniciar y cada SYNC_INTERVAL_MS
sincronizarMarcaciones();
setInterval(sincronizarMarcaciones, SYNC_INTERVAL_MS);

// ─── RUTAS API ────────────────────────────────────────────────────────────────

// GET / → sirve el dashboard (manejado por express.static)

// ── Usuarios ──────────────────────────────────────────────────────────────────
app.get('/usuarios', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM usuarios ORDER BY creado_en DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/usuario', (req, res) => {
  const { dni, nombre, apellido } = req.body;
  if (!dni || !nombre) return res.status(400).json({ error: 'dni y nombre son requeridos' });

  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO usuarios (dni, nombre, apellido, badge_number)
      VALUES (@dni, @nombre, @apellido, @badge_number)
    `);
    const result = stmt.run({ dni, nombre, apellido: apellido || '', badge_number: dni });
    res.json({ ok: true, id: result.lastInsertRowid, mensaje: `Usuario ${nombre} registrado` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Marcaciones ───────────────────────────────────────────────────────────────
app.get('/marcaciones', (req, res) => {
  const { desde, hasta, dni } = req.query;

  let query = `
    SELECT
      m.id, m.fecha_hora, m.tipo, m.dispositivo,
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
    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/marcaciones/sin-validar', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT m.* FROM marcaciones m
      LEFT JOIN usuarios u ON m.dni = u.badge_number
      WHERE u.id IS NULL
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Captura de huella SLK20R ──────────────────────────────────────────────────
// Este endpoint espera que el ZKFinger SDK esté disponible en el servidor.
// Si usas el SDK nativo de ZKTeco (ZKFinger10.dll en Windows), debes llamarlo
// desde aquí usando edge-js o un proceso hijo.
app.post('/captura-huella', async (req, res) => {
  const { dni, intentos = 3 } = req.body;
  if (!dni) return res.status(400).json({ error: 'dni es requerido' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE dni = ?').get(dni);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    // ── Opción A: ZKFinger SDK via edge-js (Windows) ──
    // const edge = require('edge-js');
    // const capture = edge.func({ assemblyFile: 'ZKFingerWrapper.dll', ... });
    // const template = await new Promise((res, rej) => capture({ intentos }, (e,t) => e ? rej(e) : res(t)));

    // ── Opción B: proceso hijo que llama al SDK ──
    // const { execFile } = require('child_process');
    // const template = await new Promise((res, rej) => {
    //   execFile('zkfinger-capture.exe', [dni, intentos], (err, stdout) => {
    //     if (err) rej(err); else res(Buffer.from(stdout, 'base64'));
    //   });
    // });

    // ── Placeholder hasta que integres el SDK ──
    // Cuando tengas el template real, reemplaza esto:
    const template = Buffer.from(`template-placeholder-${dni}-${Date.now()}`);

    // Guardar template en BD
    const existeHuella = db.prepare('SELECT id FROM huellas WHERE usuario_id = ?').get(usuario.id);
    if (existeHuella) {
      db.prepare('UPDATE huellas SET template = ?, registrado_en = CURRENT_TIMESTAMP WHERE usuario_id = ?')
        .run(template, usuario.id);
    } else {
      db.prepare('INSERT INTO huellas (usuario_id, dedo, template) VALUES (?, ?, ?)')
        .run(usuario.id, 1, template);
    }

    // Sincronizar usuario al MA300
    let zk;
    try {
      zk = await crearConexionMA300();
      await zk.setUser(parseInt(dni) || 0, dni, usuario.nombre, '', 0, 0);
      log(`✓ Usuario ${usuario.nombre} sincronizado al MA300`);
      await zk.disconnect();
    } catch (zkErr) {
      log(`⚠ No se pudo sincronizar al MA300: ${zkErr.message}`);
    }

    res.json({ ok: true, mensaje: `Huella registrada para ${usuario.nombre}` });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dispositivo MA300 ─────────────────────────────────────────────────────────
app.get('/dispositivo/info', async (req, res) => {
  let zk;
  try {
    zk = await crearConexionMA300();
    const info       = await zk.getInfo();
    const { data: usuarios } = await zk.getUsers();
    const { data: logs }     = await zk.getAttendances();
    await zk.disconnect();

    res.json({
      ip:           MA300_IP,
      puerto:       MA300_PORT,
      firmware:     info.firmwareVersion || 'Ver 6.60',
      usuarios:     usuarios.length,
      huellas:      usuarios.filter(u => u.fingerprintCount > 0).length,
      marcaciones:  logs.length,
      slkConectado: false // actualizar si detectas el SLK20R via USB
    });
  } catch (err) {
    if (zk) try { await zk.disconnect(); } catch {}
    res.status(500).json({ error: `No se pudo conectar al MA300: ${err.message}` });
  }
});

app.post('/dispositivo/descargar-eventos', async (req, res) => {
  let zk;
  try {
    zk = await crearConexionMA300();
    const { data: logs } = await zk.getAttendances();

    const insertMarcacion = db.prepare(`
      INSERT OR IGNORE INTO marcaciones (usuario_id, dni, fecha_hora, dispositivo, tipo)
      SELECT u.id, @dni, @fecha_hora, @dispositivo, @tipo
      FROM usuarios u WHERE u.badge_number = @dni
    `);

    let nuevas = 0;
    for (const l of logs) {
      const r = insertMarcacion.run({
        dni:         String(l.deviceUserId),
        fecha_hora:  l.recordTime,
        dispositivo: 'MA300',
        tipo:        l.type === 0 ? 'ENTRADA' : 'SALIDA'
      });
      if (r.changes) nuevas++;
    }

    await zk.disconnect();
    res.json({ ok: true, mensaje: `${nuevas} nuevas marcaciones descargadas (total: ${logs.length})` });
  } catch (err) {
    if (zk) try { await zk.disconnect(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.post('/dispositivo/sincronizar', async (req, res) => {
  let zk;
  try {
    zk = await crearConexionMA300();

    const usuarios = db.prepare('SELECT * FROM usuarios').all();
    let sincronizados = 0;

    for (const u of usuarios) {
      try {
        await zk.setUser(parseInt(u.dni) || 0, u.dni, u.nombre, '', 0, 0);
        sincronizados++;
      } catch (e) {
        log(`⚠ No se pudo sincronizar ${u.nombre}: ${e.message}`);
      }
    }

    await zk.disconnect();
    res.json({ ok: true, mensaje: `${sincronizados} usuarios sincronizados al MA300` });
  } catch (err) {
    if (zk) try { await zk.disconnect(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// ─── Inicio del servidor ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`✓ ZKControl corriendo en http://localhost:${PORT}`);
  log(`  Dashboard → http://localhost:${PORT}`);
  log(`  API       → http://localhost:${PORT}/usuarios`);
  log(`  MA300     → ${MA300_IP}:${MA300_PORT}`);
});
