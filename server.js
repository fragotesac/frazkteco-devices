const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');
const ZKLib    = require('node-zklib');

// ─── CRÍTICO: capturar errores internos de node-zklib que matan el proceso ────
// node-zklib tiene un bug donde reply=null explota en zklibtcp.js:234
// Este handler previene que el proceso muera
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  // Solo ignorar errores conocidos de zklib, relanzar el resto
  if (msg.includes('subarray') || msg.includes('TIMEOUT') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
    log(`⚠ [zklib] Error interno capturado (proceso protegido): ${msg}`);
  } else {
    log(`✗ Error no manejado: ${msg}`);
    console.error(err);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('subarray') || msg.includes('TIMEOUT') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
    log(`⚠ [zklib] Promise rechazada capturada: ${msg}`);
  } else {
    log(`✗ Promise no manejada: ${msg}`);
  }
});

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT            = 3000;
const MA300_IP        = '192.168.18.201';
const MA300_PORT      = 4370;
const ZK_TIMEOUT      = 10000;
const ZK_RECV_TIMEOUT = 5000;
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

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('es-PE')}] ${msg}`);
}

// ─── ZK: ejecutar UNA sola operación por conexión ────────────────────────────
// La causa raíz del crash es que node-zklib no soporta bien múltiples
// operaciones secuenciales en la misma sesión TCP con el MA300.
// Solución: cada operación abre y cierra su propia conexión.
async function zkEjecutar(operacion) {
  const zk = new ZKLib(MA300_IP, MA300_PORT, ZK_TIMEOUT, ZK_RECV_TIMEOUT);
  let conectado = false;

  try {
    await zk.createSocket();
    conectado = true;
    const resultado = await operacion(zk);
    return resultado;
  } catch (err) {
    const msg = err?.err?.message || err?.message || String(err);
    throw new Error(msg);
  } finally {
    // Cierre defensivo: nunca dejar el socket abierto
    if (conectado) {
      try {
        await zk.disconnect();
      } catch {
        // Si disconnect falla, destruir el socket manualmente
        try {
          const tcp = zk.zklibtcp;
          if (tcp && tcp.socket) {
            tcp.socket.destroy();
            tcp.socket = null;
          }
        } catch {}
      }
    }
  }
}

// Helper: ejecutar zkEjecutar con timeout de seguridad
function zkConTimeout(operacion, ms = 20000) {
  return Promise.race([
    zkEjecutar(operacion),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout de ${ms}ms superado`)), ms)
    )
  ]);
}

// ─── Sincronización automática (dos conexiones separadas) ─────────────────────
let sincronizando = false;

async function sincronizarMarcaciones() {
  if (sincronizando) return;
  sincronizando = true;
  log('Sincronizando desde MA300...');

  // PASO 1: obtener usuarios (conexión propia)
  let usersDevice = [];
  try {
    usersDevice = await zkConTimeout(async (zk) => {
      const { data } = await zk.getUsers();
      return data || [];
    });
    log(`  Usuarios en dispositivo: ${usersDevice.length}`);

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
  } catch (err) {
    log(`✗ Error obteniendo usuarios: ${err.message}`);
    sincronizando = false;
    return;
  }

  // PASO 2: obtener marcaciones (conexión propia, separada)
  try {
    const logs = await zkConTimeout(async (zk) => {
      const { data } = await zk.getAttendances();
      return data || [];
    });

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

    log(`✓ Sincronización completa: ${nuevas} nuevas de ${logs.length} marcaciones`);
  } catch (err) {
    log(`✗ Error obteniendo marcaciones: ${err.message}`);
  } finally {
    sincronizando = false;
  }
}

setTimeout(sincronizarMarcaciones, 2000);
setInterval(sincronizarMarcaciones, SYNC_INTERVAL_MS);

// ─── RUTAS API ────────────────────────────────────────────────────────────────

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

// ── Captura de huella ─────────────────────────────────────────────────────────
app.post('/captura-huella', async (req, res) => {
  const { dni } = req.body;
  if (!dni) return res.status(400).json({ error: 'dni es requerido' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE dni = ?').get(dni);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    // Placeholder — reemplazar con ZKFinger SDK
    const template = Buffer.from(`template-${dni}-${Date.now()}`);

    const existe = db.prepare('SELECT id FROM huellas WHERE usuario_id = ?').get(usuario.id);
    if (existe) {
      db.prepare('UPDATE huellas SET template = ?, registrado_en = CURRENT_TIMESTAMP WHERE usuario_id = ?')
        .run(template, usuario.id);
    } else {
      db.prepare('INSERT INTO huellas (usuario_id, dedo, template) VALUES (?, 1, ?)')
        .run(usuario.id, template);
    }

    // Sincronizar usuario al MA300 (conexión propia)
    try {
      await zkConTimeout(async (zk) => {
        await zk.setUser(parseInt(dni) || 0, dni, usuario.nombre, '', 0, 0);
      });
      log(`✓ Usuario ${usuario.nombre} sincronizado al MA300`);
    } catch (zkErr) {
      log(`⚠ No se pudo sincronizar al MA300: ${zkErr.message}`);
    }

    res.json({ ok: true, mensaje: `Huella registrada para ${usuario.nombre}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dispositivo ───────────────────────────────────────────────────────────────
app.get('/dispositivo/info', async (req, res) => {
  try {
    // Tres conexiones separadas para evitar el crash de múltiples ops
    const [usuarios, logs] = await Promise.all([
      zkConTimeout(async (zk) => {
        const { data } = await zk.getUsers();
        return data || [];
      }),
      zkConTimeout(async (zk) => {
        const { data } = await zk.getAttendances();
        return data || [];
      })
    ]);

    res.json({
      ip:          MA300_IP,
      puerto:      MA300_PORT,
      firmware:    'Ver 6.60',
      usuarios:    usuarios.length,
      huellas:     usuarios.filter(u => u.fingerprintCount > 0).length,
      marcaciones: logs.length,
      slkConectado: false
    });
  } catch (err) {
    res.status(500).json({ error: `No se pudo conectar al MA300: ${err.message}` });
  }
});

app.post('/dispositivo/descargar-eventos', async (req, res) => {
  try {
    const logs = await zkConTimeout(async (zk) => {
      const { data } = await zk.getAttendances();
      return data || [];
    });

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
    res.status(500).json({ error: err.message });
  }
});

app.post('/dispositivo/sincronizar', async (req, res) => {
  const usuarios = db.prepare('SELECT * FROM usuarios').all();
  let sincronizados = 0;

  // Sincronizar de a uno con conexión propia por usuario para no saturar el MA300
  for (const u of usuarios) {
    try {
      await zkConTimeout(async (zk) => {
        await zk.setUser(parseInt(u.dni) || 0, u.dni, u.nombre, '', 0, 0);
      }, 8000);
      sincronizados++;
    } catch (e) {
      log(`⚠ No se pudo sincronizar ${u.nombre}: ${e.message}`);
    }
  }

  res.json({ ok: true, mensaje: `${sincronizados} de ${usuarios.length} usuarios sincronizados al MA300` });
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`✓ ZKControl corriendo en http://localhost:${PORT}`);
  log(`  Dashboard → http://localhost:${PORT}`);
  log(`  MA300     → ${MA300_IP}:${MA300_PORT}`);
});