const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const cors = require("cors");

// 🔐 Configuración de CORS
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://socknorth.net",
      "http://localhost:3001",
      "http://192.168.0.13:3001",
      "https://chocolate-donkey-945086.hostingersite.com",
    ], // ✅ agregá tu dominio de producción
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



// 🔵 Nueva ruta para Registro y Login
app.use("/auth", require("./routes/auth.routes"));

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
