require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const cors = require("cors");

// 🔐 Configuración de CORS
const ALLOWED_ORIGINS = [
  "https://socknorth.net",
  "https://chocolate-donkey-945086.hostingersite.com",
  process.env.CATALOG_NORTH_URL, // dominio producción del catálogo North
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Sin origin (curl, Postman, apps móviles) → permitir
      if (!origin) return callback(null, true);
      // Cualquier localhost en cualquier puerto → permitir en desarrollo
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
      // Red local 192.168.x.x
      if (/^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin)) return callback(null, true);
      // Dominios de producción autorizados
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origen no permitido: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Montaje de rutas
app.use("/", require("./routes/productos.routes"));
app.use("/", require("./routes/dashboard.routes"));
app.use("/", require("./routes/stock.routes"));
app.use("/", require("./routes/ventas.routes"));
app.use("/", require("./routes/reposiciones.routes"));
app.use("/", require("./routes/pagos.routes"));
app.use("/", require("./routes/historial.routes"));
app.use("/sucursales", require("./routes/sucursales.routes"));
app.use("/", require("./routes/importar.routes"));
app.use("/admin/stock", require("./routes/adminStock.routes"));
app.use("/", require("./routes/public.routes"));
app.use("/clientes", require("./routes/clientes.routes"));
app.use("/", require("./routes/cuentas.routes"));
app.use("/mayorista", require("./routes/mayorista.routes"));
app.use("/transferencias", require("./routes/transferencias.routes"));
app.use("/ordenes-reposicion", require("./routes/ordenesReposicion.routes"));
app.use("/vendedores", require("./routes/vendedores.routes"));
app.use("/", require("./routes/pedidosCentral.routes"));
app.use("/", require("./routes/shisha.routes"));



// 🔵 Nueva ruta para Registro y Login
app.use("/auth", require("./routes/auth.routes"));

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
