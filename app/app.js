const express = require("express");
const app = express();
const PORT = 3000;
const cors = require("cors");

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas montadas SIN prefijo /productos para evitar romper el frontend
const productosRoutes = require("./routes/productos.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const ventasRoutes = require("./routes/ventas.routes");
const reposicionesRoutes = require("./routes/reposiciones.routes");
const pagosRoutes = require("./routes/pagos.routes");
const historialRoutes = require("./routes/historial.routes");
const sucursalesRoutes = require("./routes/sucursales.routes");
const importarRoutes = require("./routes/importar.routes");

// Montaje directo, sin prefijos
app.use("/", productosRoutes);
app.use("/", dashboardRoutes);
app.use("/", ventasRoutes);
app.use("/", reposicionesRoutes);
app.use("/", pagosRoutes);
app.use("/", historialRoutes);
app.use("/", sucursalesRoutes);
app.use("/", importarRoutes);

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
