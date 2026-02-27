const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');
const ZKLib    = require('node-zklib');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT             = 3000;
const MA300_IP         = '192.168.18.201';
const MA300_PORT       = 4370;
const ZK_TIMEOUT       = 15000; // 15s conexión
const ZK_RECV_TIMEOUT  = 8000;  // 8s por operación
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ─── Base de datos ────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'zkteco.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
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
    template      BLOB,
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
`);

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('es-PE')}] ${msg}`);
}

// ─── ZK Helper: conexión con cierre seguro ────────────────────────────────────
// Resuelve el crash "Cannot read properties of null (reading 'subarray')"
// que ocurre cuando el socket ya está muerto y se intenta disconnectar.
async function zkConectar() {
  const zk = new ZKLib(MA300_IP, MA300_PORT, ZK_TIMEOUT, ZK_RECV_TIMEOUT);
  await zk.createSocket();
  return zk;
}

async function zkDesconectar(zk) {
  if (!zk) return;
  try {
    await zk.disconnect();
  } catch {
    // Si el socket ya está muerto, lo destruimos manualmente
    try {
      if (zk.connectionType === 'tcp' && zk.zklibtcp && zk.zklibtcp.socket) {
        zk.zklibtcp.socket.destroy();
      }
      if (zk.connectionType === 'udp' && zk.zklibutil && zk.zklibutil.socket) {
        zk.zklibutil.socket.close();
      }
    } catch {}
  }
}

// Ejecuta una operación ZK y garantiza el cierre del socket pase lo que pase
async function conZK(operacion) {
  let zk;
  try {
    zk = await zkConectar();
    const resultado = await operacion(zk);
    await zkDesconectar(zk);
    return resultado;
  } catch (err) {
    await zkDesconectar(zk);
    throw err;
  }
}

// ─── Sincronización automática ────────────────────────────────────────────────
let sincronizando = false;

async function sincronizarMarcaciones() {
  if (sincronizando) return; // evitar ejecuciones concurrentes
  sincronizando = true;
  log('Sincronizando marcaciones desde MA300...');

  try {
    await conZK(async (zk) => {

      // 1. Importar usuarios del dispositivo que no existan en BD
      const { data: usersDevice } = await zk.getUsers();
      const insertUsuario = db.prepare(`
        INSERT OR IGNORE INTO usuarios (dni, nombre, badge_number)
        VALUES (@dni, @nombre, @badge_number)
      `);
      for (const u of usersDevice) {
        insertUsuario.run({
          dni:          String(u.userId),
          nombre:       u.name || String(u.userId),
          badge_number: String(u.userId)
        });
      }
      log(`  Usuarios en dispositivo: ${usersDevice.length}`);

      // 2. Importar marcaciones nuevas
      const { data: logs } = await zk.getAttendances();
      const insertMarcacion = db.prepare(`
        INSERT OR IGNORE INTO marcaciones (usuario_id, dni, fecha_hora, dispositivo, tipo)
        SELECT u.id, @dni, @fecha_hora, @dispositivo, @tipo
        FROM usuarios u
        WHERE u.badge_number = @dni
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

      log(`✓ Sincronización completa: ${nuevas} nuevas de ${logs.length} marcaciones`);
    });

  } catch (err) {
    // Mostrar mensaje limpio sin el stack del ZKError
    const msg = err?.err?.message || err?.message || String(err);
    log(`✗ Error sincronizando MA300: ${msg}`);
  } finally {
    sincronizando = false;
  }
}

// Arrancar con delay de 2s para que Express levante primero
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
    const result = db.prepare(`
      INSERT OR REPLACE INTO usuarios (dni, nombre, apellido, badge_number)
      VALUES (@dni, @nombre, @apellido, @badge_number)
    `).run({ dni, nombre, apellido: apellido || '', badge_number: dni });
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

// ── Captura de huella ─────────────────────────────────────────────────────────
app.post('/captura-huella', async (req, res) => {
  const { dni } = req.body;
  if (!dni) return res.status(400).json({ error: 'dni es requerido' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE dni = ?').get(dni);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    // Placeholder — reemplazar con ZKFinger SDK cuando esté disponible
    const template = Buffer.from(`template-${dni}-${Date.now()}`);

    const existe = db.prepare('SELECT id FROM huellas WHERE usuario_id = ?').get(usuario.id);
    if (existe) {
      db.prepare('UPDATE huellas SET template = ?, registrado_en = CURRENT_TIMESTAMP WHERE usuario_id = ?')
        .run(template, usuario.id);
    } else {
      db.prepare('INSERT INTO huellas (usuario_id, dedo, template) VALUES (?, 1, ?)')
        .run(usuario.id, template);
    }

    // Intentar sincronizar al MA300 (no crítico si falla)
    try {
      await conZK(async (zk) => {
        await zk.setUser(parseInt(dni) || 0, dni, usuario.nombre, '', 0, 0);
        log(`✓ Usuario ${usuario.nombre} sincronizado al MA300`);
      });
    } catch (zkErr) {
      const msg = zkErr?.err?.message || zkErr?.message || String(zkErr);
      log(`⚠ No se pudo sincronizar al MA300: ${msg}`);
    }

    res.json({ ok: true, mensaje: `Huella registrada para ${usuario.nombre}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dispositivo ───────────────────────────────────────────────────────────────
app.get('/dispositivo/info', async (req, res) => {
  try {
    const resultado = await conZK(async (zk) => {
      const info               = await zk.getInfo();
      const { data: usuarios } = await zk.getUsers();
      const { data: logs }     = await zk.getAttendances();
      return {
        ip:           MA300_IP,
        puerto:       MA300_PORT,
        firmware:     info.firmwareVersion || 'Ver 6.60',
        usuarios:     usuarios.length,
        huellas:      usuarios.filter(u => u.fingerprintCount > 0).length,
        marcaciones:  logs.length,
        slkConectado: false
      };
    });
    res.json(resultado);
  } catch (err) {
    const msg = err?.err?.message || err?.message || String(err);
    res.status(500).json({ error: `No se pudo conectar al MA300: ${msg}` });
  }
});

app.post('/dispositivo/descargar-eventos', async (req, res) => {
  try {
    const resultado = await conZK(async (zk) => {
      const { data: logs } = await zk.getAttendances();
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
      return { nuevas, total: logs.length };
    });
    res.json({ ok: true, mensaje: `${resultado.nuevas} nuevas marcaciones descargadas (total: ${resultado.total})` });
  } catch (err) {
    const msg = err?.err?.message || err?.message || String(err);
    res.status(500).json({ error: msg });
  }
});

app.post('/dispositivo/sincronizar', async (req, res) => {
  try {
    const usuarios = db.prepare('SELECT * FROM usuarios').all();
    let sincronizados = 0;

    await conZK(async (zk) => {
      for (const u of usuarios) {
        try {
          await zk.setUser(parseInt(u.dni) || 0, u.dni, u.nombre, '', 0, 0);
          sincronizados++;
        } catch (e) {
          const msg = e?.err?.message || e?.message || String(e);
          log(`⚠ No se pudo sincronizar ${u.nombre}: ${msg}`);
        }
      }
    });

    res.json({ ok: true, mensaje: `${sincronizados} de ${usuarios.length} usuarios sincronizados al MA300` });
  } catch (err) {
    const msg = err?.err?.message || err?.message || String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`✓ ZKControl corriendo en http://localhost:${PORT}`);
  log(`  Dashboard → http://localhost:${PORT}`);
  log(`  MA300     → ${MA300_IP}:${MA300_PORT}`);
});