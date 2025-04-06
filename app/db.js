// db.js
const mysql = require("mysql2");

const pool = mysql.createPool({
  host: "auth-db1894.hstgr.io",
  user: "u462364626_nahuelbenjamin",
  password: "45843140Nahuel$",
  database: "u462364626_Control_North",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
