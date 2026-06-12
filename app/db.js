// db.js
const mysql = require("mysql2");

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || "auth-db1894.hstgr.io",
  user:     process.env.DB_USER     || "u462364626_nahuelbenjamin",
  password: process.env.DB_PASSWORD || "45843140Nahuel$",
  database: process.env.DB_NAME     || "u462364626_Control_North",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
