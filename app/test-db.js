const mysql = require("mysql2");

const connection = mysql.createConnection({
  host: "auth-db1894.hstgr.io", // tu host de Hostinger
  user: "u462364626_nahuelbenjamin", // tu usuario
  password: "45843140Nahuel$", // tu contraseña
  database: "u462364626_Control_North",
});

connection.connect((err) => {
  if (err) {
    console.error(
      "❌ Error al conectar a la base de datos:",
      err.code || err.message
    );
    process.exit(1);
  } else {
    console.log("✅ Conexión exitosa a la base de datos");
    process.exit(0);
  }
});
