const express = require("express");
const app = express();
const PORT = 3000;
const cors = require("cors");



app.use(cors());

// ✅ Middleware para leer JSON enviado desde React
app.use(express.json());

// ✅ Middleware para leer datos de formularios HTML
app.use(express.urlencoded({ extended: true }));

// Rutas de productos
const productosRoutes = require("./routes/productos");
app.use("/productos", productosRoutes);

// Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
