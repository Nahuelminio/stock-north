const express = require("express");
const router = express.Router();
const pool = require("../db");
const { listaDeStock } = require("../asistente/listaStock");
const controller = require("../controllers/clientesController");
const authenticate = require("../middlewares/authenticate");

router.use(authenticate);

router.post("/", controller.crearCliente);
router.get("/buscar", controller.buscarClientes);
router.get("/", controller.obtenerClientes);
router.get("/:id", controller.obtenerClientePorId);
router.put("/:id", controller.editarCliente);
router.delete("/:id", controller.eliminarCliente);

/**
 * POST /clientes/proxy-mensaje
 * Arma el mensaje de stock para mandarle a un cliente por WhatsApp.
 *
 * Body: { modo: "cliente" | "difusion", sucursal_id, sucursal_nombre, nombre? }
 * Devuelve: { mensaje }
 *
 * Antes esto era un proxy a un workflow de n8n, que se dio de baja. Ahora el
 * mensaje se arma acá con la misma lista que manda el bot por Telegram, así
 * los dos canales dicen lo mismo. El nombre del endpoint queda como estaba
 * para no tocar el frontend.
 */
router.post("/proxy-mensaje", authenticate, async (req, res) => {
  const { modo = "difusion", sucursal_id, sucursal_nombre, nombre } = req.body || {};

  const cual = sucursal_id || sucursal_nombre;
  if (!cual) return res.status(400).json({ error: "Falta la sucursal" });

  try {
    // El id viene como número; listaDeStock resuelve por nombre, así que si
    // tenemos el id lo traducimos primero.
    let destino = sucursal_nombre;
    if (sucursal_id) {
      const [[s]] = await pool
        .promise()
        .query("SELECT nombre FROM sucursales WHERE id = ?", [Number(sucursal_id)]);
      if (s) destino = s.nombre;
    }

    const r = await listaDeStock(destino);
    if (!r.ok) return res.status(404).json({ error: r.error });
    if (r.vacio) {
      return res.status(409).json({
        error: `${r.sucursal} no tiene stock cargado, no hay nada que mandar.`,
      });
    }

    // Para un cliente puntual, el saludo adelante. En difusión no, porque el
    // mismo texto se le manda a muchos.
    const saludo =
      modo === "cliente" && nombre
        ? `Hola ${String(nombre).trim().split(" ")[0]}! Te paso lo que tenemos:\n\n`
        : "";

    res.json({ mensaje: saludo + r.partes.join("\n\n") });
  } catch (e) {
    console.error("❌ POST /clientes/proxy-mensaje:", e);
    res.status(500).json({ error: "No se pudo armar el mensaje" });
  }
});

module.exports = router;
