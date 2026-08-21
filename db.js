'use strict';

// ============================================================
// 双模式数据访问层
//   本地模式（无 DATABASE_URL）：读写 data/*.json 文件
//   云端模式（有 DATABASE_URL）：操作 PostgreSQL（Neon / Render / Supabase 均可）
// ============================================================

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

const isCloud = !!process.env.DATABASE_URL;
let pool = null;

// ---------- JSON 文件读写（本地模式用）----------
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('[db] 读取失败', file, e.message);
    return fallback;
  }
}

const writeQueues = {};
function writeJson(file, data) {
  if (!writeQueues[file]) writeQueues[file] = Promise.resolve();
  const content = JSON.stringify(data, null, 2);
  writeQueues[file] = writeQueues[file].then(() => fsp.writeFile(file, content, 'utf8'));
  return writeQueues[file];
}

// ---------- 初始化（云端模式建表）----------
async function initDb() {
  if (!isCloud) {
    // 本地模式：确保 data 目录和文件存在
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DEVICES_FILE)) await writeJson(DEVICES_FILE, {});
    if (!fs.existsSync(RECORDS_FILE)) await writeJson(RECORDS_FILE, []);
    console.log('[db] 本地模式：数据存储在 data/*.json');
    return;
  }
  // 云端模式：连接 Postgres 并建表
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      line        TEXT NOT NULL DEFAULT '',
      "createdAt" TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS records (
      id           TEXT PRIMARY KEY,
      "deviceId"   TEXT NOT NULL DEFAULT '',
      "deviceName" TEXT NOT NULL DEFAULT '',
      production   INTEGER NOT NULL DEFAULT 0,
      ng           INTEGER NOT NULL DEFAULT 0,
      "ngInner"    INTEGER NOT NULL DEFAULT 0,
      "ngOuter"    INTEGER NOT NULL DEFAULT 0,
      shift        TEXT NOT NULL DEFAULT '',
      operator     TEXT NOT NULL DEFAULT '',
      remark       TEXT NOT NULL DEFAULT '',
      "createdAt"  TEXT NOT NULL DEFAULT '',
      date         TEXT NOT NULL DEFAULT '',
      ts           BIGINT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_records_ts ON records(ts);
    CREATE INDEX IF NOT EXISTS idx_records_device ON records("deviceId");
  `);
  console.log('[db] 云端模式：已连接 PostgreSQL 并确保表存在');
}

// ---------- 设备操作 ----------
async function getDevices() {
  if (isCloud) {
    const r = await pool.query('SELECT id, name, line, "createdAt" FROM devices');
    const obj = {};
    for (const row of r.rows) obj[row.id] = row;
    return obj;
  }
  return readJson(DEVICES_FILE, {});
}

async function saveDevice(device) {
  if (isCloud) {
    await pool.query(
      `INSERT INTO devices (id, name, line, "createdAt")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = $2, line = $3`,
      [device.id, device.name || device.id, device.line || '', device.createdAt || '']
    );
    return;
  }
  const devices = readJson(DEVICES_FILE, {});
  devices[device.id] = device;
  await writeJson(DEVICES_FILE, devices);
}

async function deleteDevice(id) {
  if (isCloud) {
    await pool.query('DELETE FROM devices WHERE id = $1', [id]);
    return;
  }
  const devices = readJson(DEVICES_FILE, {});
  delete devices[id];
  await writeJson(DEVICES_FILE, devices);
}

// ---------- 记录操作 ----------
async function getRecords() {
  if (isCloud) {
    const r = await pool.query('SELECT * FROM records ORDER BY ts DESC');
    return r.rows;
  }
  return readJson(RECORDS_FILE, []);
}

async function addRecord(record) {
  if (isCloud) {
    await pool.query(
      `INSERT INTO records (id, "deviceId", "deviceName", production, ng, "ngInner", "ngOuter", shift, operator, remark, "createdAt", date, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [record.id, record.deviceId, record.deviceName || '', record.production, record.ng,
       record.ngInner, record.ngOuter, record.shift || '', record.operator || '', record.remark || '',
       record.createdAt, record.date, record.ts]
    );
    return;
  }
  const records = readJson(RECORDS_FILE, []);
  records.push(record);
  await writeJson(RECORDS_FILE, records);
}

async function deleteRecord(id) {
  if (isCloud) {
    await pool.query('DELETE FROM records WHERE id = $1', [id]);
    return;
  }
  let records = readJson(RECORDS_FILE, []);
  records = records.filter((r) => r.id !== id);
  await writeJson(RECORDS_FILE, records);
}

module.exports = {
  isCloud,
  initDb,
  getDevices,
  saveDevice,
  deleteDevice,
  getRecords,
  addRecord,
  deleteRecord,
};
