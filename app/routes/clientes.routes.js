const express = require("express");
const router = express.Router();
const controller = require("../controllers/clientesController");
const authenticate = require("../middlewares/authenticate");

router.use(authenticate);

router.post("/", controller.crearCliente);
router.get("/buscar", controller.buscarClientes);
router.get("/", controller.obtenerClientes);
router.get("/:id", controller.obtenerClientePorId);
router.put("/:id", controller.editarCliente);
router.delete("/:id", controller.eliminarCliente);

// Proxy a n8n para evitar CORS desde el frontend
const N8N_WEBHOOK = "https://nahuelminio04.app.n8n.cloud/webhook/f26edb4e-41a0-4252-a06b-b352fd6fb56f";

router.post("/proxy-mensaje", authenticate, async (req, res) => {
  try {
    const response = await fetch(N8N_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      return res.status(502).json({ error: "Error en el workflow de n8n" });
    }

    res.json(data);
  } catch (e) {
    console.error("Error proxy n8n:", e.message);
    res.status(502).json({ error: "No se pudo conectar con el workflow" });
  }
});

module.exports = router;
