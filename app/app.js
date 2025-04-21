const express = require("express");
const app = express();
const PORT = 3000;
const cors = require("cors");

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Montaje directo sin prefijo para que coincidan las rutas esperadas por el frontend
app.use("/", require("./routes/productos.routes"));
app.use("/", require("./routes/dashboard.routes"));
app.use("/", require("./routes/stock.routes"));

app.use("/", require("./routes/ventas.routes"));
app.use("/", require("./routes/reposiciones.routes"));
app.use("/", require("./routes/pagos.routes"));
app.use("/", require("./routes/historial.routes"));
app.use("/sucursales", require("./routes/sucursales.routes"));
app.use("/", require("./routes/importar.routes"));

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
