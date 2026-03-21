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

module.exports = router;
