const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'notas-escuela-mexico-2026-valdivia';
const MATRICULA_DB = process.env.MATRICULA_DB || '/home/ubuntu/matricula/db/matricula.db';
const ANIO = 2026;

// ── Base de datos ─────────────────────────────────────────────────────────────
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
const db = new Database(path.join(dbDir, 'notas.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT,
    email TEXT UNIQUE,
    google_id TEXT,
    role TEXT NOT NULL DEFAULT 'docente',
    active INTEGER DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS asignaturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    nombre_corto TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'numerica',
    niveles TEXT NOT NULL DEFAULT 'todos',
    orden INTEGER DEFAULT 99,
    activa INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS docente_asignaturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asignatura_id INTEGER NOT NULL,
    grado TEXT NOT NULL,
    curso TEXT NOT NULL,
    es_jefe INTEGER DEFAULT 0,
    anio INTEGER NOT NULL DEFAULT 2026,
    UNIQUE(user_id, asignatura_id, grado, curso, anio),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(asignatura_id) REFERENCES asignaturas(id)
  );

  CREATE TABLE IF NOT EXISTS notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    asignatura_id INTEGER NOT NULL,
    semestre INTEGER NOT NULL,
    numero_nota INTEGER NOT NULL,
    valor TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    anio INTEGER NOT NULL DEFAULT 2026,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(student_id, asignatura_id, semestre, numero_nota, anio),
    FOREIGN KEY(asignatura_id) REFERENCES asignaturas(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS asistencia_mensual (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    mes INTEGER NOT NULL,
    anio INTEGER NOT NULL DEFAULT 2026,
    dias_presentes INTEGER DEFAULT 0,
    dias_totales INTEGER DEFAULT 0,
    UNIQUE(student_id, mes, anio)
  );

  CREATE TABLE IF NOT EXISTS observaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    texto TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    anio INTEGER NOT NULL DEFAULT 2026,
    fecha TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Seed asignaturas ──────────────────────────────────────────────────────────
if (!db.prepare('SELECT id FROM asignaturas LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO asignaturas (nombre,nombre_corto,tipo,niveles,orden) VALUES (?,?,?,?,?)');
  [
    ['Lenguaje y Comunicación',       'Lenguaje',    'numerica',   'todos', 1],
    ['Idioma Extranjero Inglés',       'Inglés',      'numerica',   'todos', 2],
    ['Matemática',                     'Matemática',  'numerica',   'todos', 3],
    ['Historia, Geografía y C.S.',     'Historia',    'numerica',   'todos', 4],
    ['Ciencias Naturales',             'Ciencias',    'numerica',   'todos', 5],
    ['Artes Visuales',                 'Artes',       'numerica',   'todos', 6],
    ['Música',                         'Música',      'numerica',   'todos', 7],
    ['Educación Física y Salud',       'Ed. Física',  'numerica',   'todos', 8],
    ['Tecnología',                     'Tecnología',  'numerica',   'todos', 9],
    ['Religión',                       'Religión',    'conceptual', 'todos', 10],
    ['Orientación',                    'Orientación', 'conceptual', 'todos', 11],
  ].forEach(r => ins.run(...r));
}

// ── Seed admin ────────────────────────────────────────────────────────────────
if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
  db.prepare('INSERT INTO users (nombre,username,password,role) VALUES (?,?,?,?)').run(
    'Administrador', 'admin', bcrypt.hashSync('Mexico2026', 10), 'admin'
  );
}

// ── Matrícula DB (solo lectura) ───────────────────────────────────────────────
let matriculaDb;
try {
  matriculaDb = new Database(MATRICULA_DB, { readonly: true });
} catch(e) {
  console.warn('⚠️  No se pudo conectar a matricula.db:', e.message);
  matriculaDb = null;
}

function getAlumnos(grado, curso) {
  if (!matriculaDb) return [];
  return matriculaDb.prepare(`
    SELECT id, nombres, apPaterno, apMaterno, run, dv, descGrado, curso, matricula, nivelMatricula
    FROM students
    WHERE descGrado=? AND curso=?
      AND (fechaRetiro='1900-01-01' OR fechaRetiro IS NULL OR fechaRetiro='')
    ORDER BY apPaterno, apMaterno, nombres
  `).all(grado, curso);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Sin permiso' });
    next();
  };
}

function canWriteNotas(user, asignatura_id, grado, curso) {
  if (user.role === 'admin') return true;
  if (user.role === 'directivo') return false;
  const asig = db.prepare(
    'SELECT id FROM docente_asignaturas WHERE user_id=? AND asignatura_id=? AND grado=? AND curso=? AND anio=?'
  ).get(user.id, asignatura_id, grado, curso, ANIO);
  return !!asig;
}

function canReadCurso(user, grado, curso) {
  if (user.role === 'admin' || user.role === 'directivo') return true;
  const asig = db.prepare(
    'SELECT id FROM docente_asignaturas WHERE user_id=? AND grado=? AND curso=? AND anio=?'
  ).get(user.id, grado, curso, ANIO);
  return !!asig;
}

// ── RUTAS AUTH ────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Datos incompletos' });
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = jwt.sign(
    { id: user.id, username: user.username, nombre: user.nombre, role: user.role },
    JWT_SECRET, { expiresIn: '12h' }
  );
  res.json({ token, user: { id: user.id, nombre: user.nombre, username: user.username, role: user.role } });
});

app.get('/api/me', auth, (req, res) => {
  res.json(db.prepare('SELECT id,nombre,username,email,role,active FROM users WHERE id=?').get(req.user.id));
});

// ── RUTAS CURSOS (desde matrícula) ────────────────────────────────────────────
app.get('/api/cursos', auth, (req, res) => {
  if (!matriculaDb) return res.json([]);
  const all = matriculaDb.prepare(`
    SELECT DISTINCT descGrado, curso, nivelMatricula, codGrado
    FROM students
    WHERE fechaRetiro='1900-01-01' OR fechaRetiro IS NULL OR fechaRetiro=''
  `).all();
  // Deduplicar por descGrado+curso
  const seen = new Set();
  const unique = all.filter(c => {
    const key = c.descGrado+'|'+c.curso;
    if(seen.has(key)) return false;
    seen.add(key); return true;
  });
  // Ordenar manualmente con orden correcto
  const orden = [
    '1er nivel de Transición (Pre-kinder)',
    '2° nivel de Transición (Kinder)',
    '1° básico','2° básico','3° básico','4° básico',
    '5° básico','6° básico','7° básico','8° básico'
  ];
  unique.sort((a,b) => {
    const ia = orden.indexOf(a.descGrado);
    const ib = orden.indexOf(b.descGrado);
    const oa = ia===-1 ? 99 : ia;
    const ob = ib===-1 ? 99 : ib;
    if(oa !== ob) return oa - ob;
    return a.curso.localeCompare(b.curso);
  });
  res.json(unique);
});

app.get('/api/alumnos/:grado/:curso', auth, (req, res) => {
  const grado = decodeURIComponent(req.params.grado);
  const { curso } = req.params;
  if (!canReadCurso(req.user, grado, curso))
    return res.status(403).json({ error: 'Sin acceso a este curso' });
  res.json(getAlumnos(grado, curso));
});

// ── RUTAS ASIGNATURAS ─────────────────────────────────────────────────────────
app.get('/api/asignaturas', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM asignaturas WHERE activa=1 ORDER BY orden').all());
});

app.post('/api/asignaturas', auth, requireRole('admin'), (req, res) => {
  const { nombre, nombre_corto, tipo, niveles, orden } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const info = db.prepare(
    'INSERT INTO asignaturas (nombre,nombre_corto,tipo,niveles,orden) VALUES (?,?,?,?,?)'
  ).run(nombre, nombre_corto || nombre, tipo || 'numerica', niveles || 'todos', orden || 99);
  res.json(db.prepare('SELECT * FROM asignaturas WHERE id=?').get(info.lastInsertRowid));
});

app.patch('/api/asignaturas/:id', auth, requireRole('admin'), (req, res) => {
  const { nombre, nombre_corto, tipo, niveles, orden, activa } = req.body;
  db.prepare(`UPDATE asignaturas SET
    nombre=COALESCE(?,nombre), nombre_corto=COALESCE(?,nombre_corto),
    tipo=COALESCE(?,tipo), niveles=COALESCE(?,niveles),
    orden=COALESCE(?,orden), activa=COALESCE(?,activa)
    WHERE id=?`).run(nombre, nombre_corto, tipo, niveles, orden, activa, req.params.id);
  res.json(db.prepare('SELECT * FROM asignaturas WHERE id=?').get(req.params.id));
});

// ── RUTAS USUARIOS ────────────────────────────────────────────────────────────
app.get('/api/users', auth, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT id,nombre,username,email,role,active,creado_en FROM users ORDER BY nombre').all());
});

app.post('/api/users', auth, requireRole('admin'), (req, res) => {
  const { nombre, username, password, email, role } = req.body;
  if (!nombre || !username || !password) return res.status(400).json({ error: 'Nombre, usuario y contraseña requeridos' });
  try {
    const info = db.prepare(
      'INSERT INTO users (nombre,username,password,email,role) VALUES (?,?,?,?,?)'
    ).run(nombre, username, bcrypt.hashSync(password, 10), email || null, role || 'docente');
    res.json({ id: info.lastInsertRowid, nombre, username, role: role || 'docente', active: 1 });
  } catch(e) { res.status(400).json({ error: 'Usuario ya existe' }); }
});

app.patch('/api/users/:id', auth, requireRole('admin'), (req, res) => {
  const { nombre, email, role } = req.body;
  db.prepare('UPDATE users SET nombre=COALESCE(?,nombre), email=COALESCE(?,email), role=COALESCE(?,role) WHERE id=?')
    .run(nombre, email, role, req.params.id);
  res.json(db.prepare('SELECT id,nombre,username,email,role,active FROM users WHERE id=?').get(req.params.id));
});

app.patch('/api/users/:id/toggle', auth, requireRole('admin'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });
  db.prepare('UPDATE users SET active=CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);
  res.json(db.prepare('SELECT id,nombre,username,role,active FROM users WHERE id=?').get(req.params.id));
});

app.patch('/api/users/:id/password', auth, requireRole('admin'), (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Mínimo 4 caracteres' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

// ── RUTAS ASIGNACIONES ────────────────────────────────────────────────────────
app.get('/api/asignaciones', auth, requireRole('admin'), (req, res) => {
  res.json(db.prepare(`
    SELECT da.*, u.nombre as docente_nombre, a.nombre as asignatura_nombre, a.nombre_corto
    FROM docente_asignaturas da
    JOIN users u ON u.id=da.user_id
    JOIN asignaturas a ON a.id=da.asignatura_id
    WHERE da.anio=? ORDER BY da.grado, da.curso, a.orden
  `).all(ANIO));
});

app.post('/api/asignaciones', auth, requireRole('admin'), (req, res) => {
  const { user_id, asignatura_id, grado, curso, es_jefe } = req.body;
  if (!user_id || !asignatura_id || !grado || !curso) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const info = db.prepare(
      'INSERT OR REPLACE INTO docente_asignaturas (user_id,asignatura_id,grado,curso,es_jefe,anio) VALUES (?,?,?,?,?,?)'
    ).run(user_id, asignatura_id, grado, curso, es_jefe ? 1 : 0, ANIO);
    res.json({ id: info.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/asignaciones/:id', auth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM docente_asignaturas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/mis-asignaciones', auth, (req, res) => {
  if (req.user.role === 'admin' || req.user.role === 'directivo') {
    const cursos = matriculaDb ? matriculaDb.prepare(`
      SELECT DISTINCT descGrado as grado, curso FROM students
      WHERE fechaRetiro='1900-01-01' OR fechaRetiro IS NULL OR fechaRetiro=''
      ORDER BY nivelMatricula DESC, CAST(codGrado AS INTEGER), curso
    `).all() : [];
    return res.json(cursos.map(c => ({ ...c, es_jefe: 0, asignatura_id: null, asignatura_nombre: null })));
  }
  const asig = db.prepare(`
    SELECT da.*, a.nombre as asignatura_nombre, a.nombre_corto, a.tipo
    FROM docente_asignaturas da
    JOIN asignaturas a ON a.id=da.asignatura_id
    WHERE da.user_id=? AND da.anio=?
    ORDER BY da.grado, da.curso, a.orden
  `).all(req.user.id, ANIO);
  res.json(asig);
});

// ── RUTAS NOTAS ───────────────────────────────────────────────────────────────
app.get('/api/notas/:asignatura_id/:grado/:curso/:semestre', auth, (req, res) => {
  const asignatura_id = parseInt(req.params.asignatura_id);
  const grado = decodeURIComponent(req.params.grado);
  const { curso, semestre } = req.params;

  if (!canReadCurso(req.user, grado, curso))
    return res.status(403).json({ error: 'Sin acceso a este curso' });

  const alumnos = getAlumnos(grado, curso);
  const notasRaw = db.prepare(
    'SELECT * FROM notas WHERE asignatura_id=? AND semestre=? AND anio=?'
  ).all(asignatura_id, parseInt(semestre), ANIO);

  const notasMap = {};
  for (const n of notasRaw) {
    if (!notasMap[n.student_id]) notasMap[n.student_id] = {};
    notasMap[n.student_id][n.numero_nota] = n.valor;
  }

  res.json(alumnos.map(a => ({ ...a, notas: notasMap[a.id] || {} })));
});

app.post('/api/notas', auth, (req, res) => {
  const { student_id, asignatura_id, semestre, numero_nota, valor, grado, curso } = req.body;
  if (!canWriteNotas(req.user, asignatura_id, grado, curso))
    return res.status(403).json({ error: 'No tienes esta asignatura asignada en este curso' });
  db.prepare(`
    INSERT INTO notas (student_id,asignatura_id,semestre,numero_nota,valor,user_id,anio)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(student_id,asignatura_id,semestre,numero_nota,anio)
    DO UPDATE SET valor=excluded.valor, user_id=excluded.user_id, fecha=datetime('now','localtime')
  `).run(student_id, asignatura_id, semestre, numero_nota, valor, req.user.id, ANIO);
  res.json({ ok: true });
});

app.delete('/api/notas', auth, (req, res) => {
  const { student_id, asignatura_id, semestre, numero_nota, grado, curso } = req.body;
  if (!canWriteNotas(req.user, asignatura_id, grado, curso))
    return res.status(403).json({ error: 'Sin permiso' });
  db.prepare('DELETE FROM notas WHERE student_id=? AND asignatura_id=? AND semestre=? AND numero_nota=? AND anio=?')
    .run(student_id, asignatura_id, semestre, numero_nota, ANIO);
  res.json({ ok: true });
});

// Notas completas de un alumno (para informe)
app.get('/api/notas/alumno/:student_id', auth, (req, res) => {
  const notas = db.prepare('SELECT * FROM notas WHERE student_id=? AND anio=?').all(req.params.student_id, ANIO);
  res.json(notas);
});

// ── RUTAS ASISTENCIA ──────────────────────────────────────────────────────────
app.get('/api/asistencia/:grado/:curso', auth, (req, res) => {
  const grado = decodeURIComponent(req.params.grado);
  const { curso } = req.params;
  if (!canReadCurso(req.user, grado, curso)) return res.status(403).json({ error: 'Sin acceso' });
  const alumnos = getAlumnos(grado, curso).map(a => a.id);
  if (!alumnos.length) return res.json([]);
  res.json(db.prepare(
    `SELECT * FROM asistencia_mensual WHERE student_id IN (${alumnos.map(()=>'?').join(',')}) AND anio=?`
  ).all(...alumnos, ANIO));
});

// Guardar asistencia individual
app.post('/api/asistencia', auth, (req, res) => {
  const { student_id, mes, dias_presentes, dias_totales } = req.body;
  if (req.user.role === 'directivo') return res.status(403).json({ error: 'Sin permiso' });
  db.prepare(`INSERT INTO asistencia_mensual (student_id,mes,anio,dias_presentes,dias_totales) VALUES (?,?,?,?,?) ON CONFLICT(student_id,mes,anio) DO UPDATE SET dias_presentes=excluded.dias_presentes, dias_totales=excluded.dias_totales`).run(student_id, mes, ANIO, dias_presentes, dias_totales);
  res.json({ ok: true });
});

// Guardar asistencia curso completo (bulk)
app.post('/api/asistencia/bulk', auth, (req, res) => {
  if (req.user.role === 'directivo') return res.status(403).json({ error: 'Sin permiso' });
  const { mes, dias_trabajados, registros } = req.body;
  const stmt = db.prepare(`INSERT INTO asistencia_mensual (student_id,mes,anio,dias_presentes,dias_totales) VALUES (?,?,?,?,?) ON CONFLICT(student_id,mes,anio) DO UPDATE SET dias_presentes=excluded.dias_presentes, dias_totales=excluded.dias_totales`);
  const run = db.transaction((rows) => { for (const r of rows) stmt.run(r.student_id, mes, ANIO, r.dias_presentes, dias_trabajados); });
  run(registros);
  res.json({ ok: true, guardados: registros.length });
});

// Resumen asistencia por curso
app.get('/api/asistencia/resumen/:grado/:curso', auth, (req, res) => {
  const grado = decodeURIComponent(req.params.grado);
  const { curso } = req.params;
  if (!canReadCurso(req.user, grado, curso)) return res.status(403).json({ error: 'Sin acceso' });
  const alumnos = getAlumnos(grado, curso);
  if (!alumnos.length) return res.json([]);
  const ids = alumnos.map(a => a.id);
  const asistencia = db.prepare(`SELECT * FROM asistencia_mensual WHERE student_id IN (${ids.map(()=>'?').join(',')}) AND anio=? ORDER BY mes`).all(...ids, ANIO);
  const result = alumnos.map(a => {
    const meses = asistencia.filter(x => x.student_id === a.id);
    const totalP = meses.reduce((s,x)=>s+x.dias_presentes,0);
    const totalD = meses.reduce((s,x)=>s+x.dias_totales,0);
    return { ...a, meses, totalPresentes:totalP, totalDias:totalD, pctAnual: totalD>0 ? Math.round(totalP/totalD*100) : null };
  });
  res.json(result);
});

// Métricas asistencia todos los cursos
app.get('/api/asistencia/metricas', auth, requireRole('admin','directivo'), (req, res) => {
  if (!matriculaDb) return res.json([]);
  const cursos = matriculaDb.prepare(`SELECT DISTINCT descGrado, curso, nivelMatricula, codGrado FROM students WHERE fechaRetiro='1900-01-01' OR fechaRetiro IS NULL OR fechaRetiro='' ORDER BY nivelMatricula DESC, CAST(codGrado AS INTEGER), curso`).all();
  const result = cursos.map(c => {
    const alumnos = getAlumnos(c.descGrado, c.curso);
    const ids = alumnos.map(a=>a.id);
    if (!ids.length) return { grado:c.descGrado, curso:c.curso, total:0, pctPromedio:null, bajoMinimo:0, conDatos:0 };
    const asist = db.prepare(`SELECT student_id, SUM(dias_presentes) as tp, SUM(dias_totales) as td FROM asistencia_mensual WHERE student_id IN (${ids.map(()=>'?').join(',')}) AND anio=? GROUP BY student_id`).all(...ids, ANIO);
    const pcts = asist.filter(x=>x.td>0).map(x=>Math.round(x.tp/x.td*100));
    return { grado:c.descGrado, curso:c.curso, total:alumnos.length, pctPromedio: pcts.length?Math.round(pcts.reduce((s,v)=>s+v,0)/pcts.length):null, bajoMinimo:pcts.filter(p=>p<85).length, conDatos:pcts.length };
  });
  res.json(result);
});

// ── RUTAS OBSERVACIONES ───────────────────────────────────────────────────────
app.get('/api/observaciones/:student_id', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT o.*, u.nombre as autor FROM observaciones o
    JOIN users u ON u.id=o.user_id
    WHERE o.student_id=? AND o.anio=? ORDER BY o.fecha DESC
  `).all(req.params.student_id, ANIO));
});

app.post('/api/observaciones', auth, (req, res) => {
  const { student_id, texto, grado, curso } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'Texto requerido' });
  if (req.user.role === 'directivo') return res.status(403).json({ error: 'Sin permiso' });
  const info = db.prepare(
    'INSERT INTO observaciones (student_id,texto,user_id,anio) VALUES (?,?,?,?)'
  ).run(student_id, texto.trim(), req.user.id, ANIO);
  res.json({ id: info.lastInsertRowid, ok: true });
});

// ── RESUMEN CURSO ─────────────────────────────────────────────────────────────
app.get('/api/resumen/:grado/:curso/:semestre', auth, (req, res) => {
  const grado = decodeURIComponent(req.params.grado);
  const { curso, semestre } = req.params;
  if (!canReadCurso(req.user, grado, curso)) return res.status(403).json({ error: 'Sin acceso' });

  const alumnos = getAlumnos(grado, curso);
  const asignaturas = db.prepare('SELECT * FROM asignaturas WHERE activa=1 ORDER BY orden').all();

  const resultado = asignaturas.map(a => {
    const filas = alumnos.map(al => {
      const notas = db.prepare(
        'SELECT numero_nota, valor FROM notas WHERE student_id=? AND asignatura_id=? AND semestre=? AND anio=? ORDER BY numero_nota'
      ).all(al.id, a.id, parseInt(semestre), ANIO);
      let promedio = null;
      if (a.tipo === 'numerica') {
        const nums = notas.map(n => parseFloat(n.valor)).filter(n => !isNaN(n));
        if (nums.length) promedio = parseFloat((nums.reduce((s,v)=>s+v,0)/nums.length).toFixed(1));
      } else {
        if (notas.length) promedio = notas[notas.length-1].valor;
      }
      return { alumno_id: al.id, nombre: `${al.apPaterno} ${al.nombres}`, notas, promedio };
    });
    return { asignatura: a, filas };
  });

  res.json(resultado);
});

// ── INFORME INDIVIDUAL ────────────────────────────────────────────────────────
app.get('/api/informe/:student_id', auth, (req, res) => {
  if (!matriculaDb) return res.status(503).json({ error: 'Base matrícula no disponible' });
  const alumno = matriculaDb.prepare('SELECT * FROM students WHERE id=?').get(req.params.student_id);
  if (!alumno) return res.status(404).json({ error: 'Alumna no encontrada' });

  const asignaturas = db.prepare('SELECT * FROM asignaturas WHERE activa=1 ORDER BY orden').all();
  const informe = asignaturas.map(a => {
    const n1 = db.prepare('SELECT numero_nota,valor FROM notas WHERE student_id=? AND asignatura_id=? AND semestre=1 AND anio=? ORDER BY numero_nota').all(alumno.id, a.id, ANIO);
    const n2 = db.prepare('SELECT numero_nota,valor FROM notas WHERE student_id=? AND asignatura_id=? AND semestre=2 AND anio=? ORDER BY numero_nota').all(alumno.id, a.id, ANIO);
    let prom1=null, prom2=null, promFinal=null;
    if (a.tipo === 'numerica') {
      const v1 = n1.map(n=>parseFloat(n.valor)).filter(n=>!isNaN(n));
      const v2 = n2.map(n=>parseFloat(n.valor)).filter(n=>!isNaN(n));
      if (v1.length) prom1 = parseFloat((v1.reduce((s,v)=>s+v,0)/v1.length).toFixed(1));
      if (v2.length) prom2 = parseFloat((v2.reduce((s,v)=>s+v,0)/v2.length).toFixed(1));
      if (prom1!==null && prom2!==null) promFinal = parseFloat(((prom1+prom2)/2).toFixed(1));
      else promFinal = prom1 ?? prom2;
    } else {
      prom1 = n1.length ? n1[n1.length-1].valor : null;
      prom2 = n2.length ? n2[n2.length-1].valor : null;
      promFinal = prom2 ?? prom1;
    }
    return { asignatura: a, notas1: n1, notas2: n2, prom1, prom2, promFinal };
  });

  const asistencia = db.prepare('SELECT * FROM asistencia_mensual WHERE student_id=? AND anio=? ORDER BY mes').all(alumno.id, ANIO);
  const totalP = asistencia.reduce((s,a)=>s+a.dias_presentes,0);
  const totalD = asistencia.reduce((s,a)=>s+a.dias_totales,0);
  const pctAsistencia = totalD > 0 ? Math.round(totalP/totalD*100) : null;
  const observaciones = db.prepare('SELECT o.*, u.nombre as autor FROM observaciones o JOIN users u ON u.id=o.user_id WHERE o.student_id=? AND o.anio=? ORDER BY o.fecha DESC').all(alumno.id, ANIO);

  res.json({ alumno, informe, asistencia, pctAsistencia, observaciones });
});

// ── MÉTRICAS DIRECTIVO ────────────────────────────────────────────────────────
app.get('/api/metricas', auth, requireRole('admin','directivo'), (req, res) => {
  if (!matriculaDb) return res.json([]);
  const cursos = matriculaDb.prepare(`
    SELECT DISTINCT descGrado, curso, nivelMatricula, codGrado FROM students
    WHERE fechaRetiro='1900-01-01' OR fechaRetiro IS NULL OR fechaRetiro=''
    ORDER BY nivelMatricula DESC, CAST(codGrado AS INTEGER), curso
  `).all();

  const metricas = cursos.map(c => {
    const alumnos = getAlumnos(c.descGrado, c.curso);
    const promedios = alumnos.map(al => {
      const notas = db.prepare('SELECT valor FROM notas WHERE student_id=? AND anio=?').all(al.id, ANIO);
      const nums = notas.map(n=>parseFloat(n.valor)).filter(n=>!isNaN(n));
      return nums.length ? nums.reduce((s,v)=>s+v,0)/nums.length : null;
    }).filter(p=>p!==null);

    return {
      grado: c.descGrado,
      curso: c.curso,
      total: alumnos.length,
      promedio: promedios.length ? parseFloat((promedios.reduce((s,v)=>s+v,0)/promedios.length).toFixed(2)) : null,
      enRiesgo: promedios.filter(p=>p<4).length,
      sinNotas: alumnos.length - promedios.length,
    };
  });
  res.json(metricas);
});

// ── ESTADÍSTICAS NOTAS PARA DASHBOARD ────────────────────────────────────────
app.get('/api/stats', auth, (req, res) => {
  const totalNotas = db.prepare('SELECT COUNT(*) as n FROM notas WHERE anio=?').get(ANIO).n;
  const totalAlumnos = matriculaDb ? matriculaDb.prepare(
    "SELECT COUNT(*) as n FROM students WHERE fechaRetiro='1900-01-01' OR fechaRetiro IS NULL OR fechaRetiro=''"
  ).get().n : 0;
  const asignaturasActivas = db.prepare('SELECT COUNT(*) as n FROM asignaturas WHERE activa=1').get().n;
  const docentesActivos = db.prepare("SELECT COUNT(*) as n FROM users WHERE active=1 AND role IN ('docente','jefe')").get().n;
  res.json({ totalNotas, totalAlumnos, asignaturasActivas, docentesActivos });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`✅ Sistema de Notas Escuela México en http://localhost:${PORT}`));
