const express = require("express");
const app = express();
const cors = require("cors");
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas
app.use("/productos", require("./routes/productos.routes"));
app.use("/ventas", require("./routes/ventas.routes"));
app.use("/stock", require("./routes/stock.routes"));
app.use("/gustos", require("./routes/gustos.routes"));
app.use("/reposiciones", require("./routes/reposiciones.routes"));
app.use("/dashboard", require("./routes/dashboard.routes"));
app.use("/historial", require("./routes/historial.routes"));
app.use("/pagos", require("./routes/pagos.routes"));

// Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
