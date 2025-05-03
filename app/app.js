const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const cors = require("cors");

// 🔐 Configuración de CORS
app.use(
  cors({
    origin: ["http://localhost:5173", "https://socknorth.net"], // ✅ agregá tu dominio de producción
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

// 🔵 Nueva ruta para Registro y Login
app.use("/auth", require("./routes/auth.routes"));

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
