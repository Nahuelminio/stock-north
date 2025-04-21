const express = require("express");
const app = express();
const PORT = 3000;
const cors = require("cors");

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Importación de rutas
const productosRoutes = require("./routes/productos.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const ventasRoutes = require("./routes/ventas.routes");
const reposicionesRoutes = require("./routes/reposiciones.routes");
const pagosRoutes = require("./routes/pagos.routes");
const historialRoutes = require("./routes/historial.routes");
const sucursalesRoutes = require("./routes/sucursales.routes");
const importarRoutes = require("./routes/importar.routes");

// Montaje de rutas bajo un mismo prefijo
app.use("/productos", productosRoutes);
app.use("/productos", dashboardRoutes);
app.use("/productos", ventasRoutes);
app.use("/productos", reposicionesRoutes);
app.use("/productos", pagosRoutes);
app.use("/productos", historialRoutes);
app.use("/productos", sucursalesRoutes);
app.use("/productos", importarRoutes);

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
