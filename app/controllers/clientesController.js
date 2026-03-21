const db = require("../db").promise();

function normalizarTelefono(telefono = "") {
  return String(telefono).replace(/\D/g, "");
}

function limpiarPayload(body = {}) {
  return {
    nombre: String(body.nombre || "").trim(),
    telefono: String(body.telefono || "").trim(),
    telefono_normalizado: normalizarTelefono(body.telefono || ""),
    sucursal_id: body.sucursal_id ? Number(body.sucursal_id) : null,
    observaciones: body.observaciones
      ? String(body.observaciones).trim()
      : null,
    activo:
      body.activo === true ||
      body.activo === 1 ||
      body.activo === "1" ||
      body.activo === "true",
  };
}

function validarCliente(data) {
  if (!data.nombre) return "El nombre es obligatorio";
  if (!data.telefono) return "El teléfono es obligatorio";
  if (!data.telefono_normalizado) return "El teléfono no es válido";
  return null;
}

function getUsuario(req) {
  return req.usuario || req.user || {};
}

function getRol(req) {
  return getUsuario(req)?.rol || null;
}

function getSucursalUsuario(req) {
  const usuario = getUsuario(req);
  return (
    usuario?.sucursal_id || usuario?.id_sucursal || usuario?.sucursalId || null
  );
}

function esAdmin(req) {
  return getRol(req) === "admin";
}

async function obtenerClientesBase(whereClause = "", params = []) {
  const [rows] = await db.query(
    `
      SELECT
        c.id,
        c.nombre,
        c.telefono,
        c.telefono_normalizado,
        c.nota AS observaciones,
        c.acepta AS activo,
        c.estado,
        c.source,
        c.added_to_group,
        c.created_at AS fecha_creacion,
        c.updated_at AS fecha_actualizacion,
        c.sucursal_id,
        s.nombre AS sucursal_nombre
      FROM clientes c
      LEFT JOIN sucursales s ON s.id = c.sucursal_id
      ${whereClause}
      ORDER BY c.id DESC
    `,
    params,
  );

  return rows;
}

exports.crearCliente = async (req, res) => {
  try {
    const data = limpiarPayload(req.body);
    const error = validarCliente(data);

    if (error) {
      return res.status(400).json({ error });
    }

    const rol = getRol(req);
    const sucursalUsuario = getSucursalUsuario(req);

    let sucursalFinal = data.sucursal_id || null;

    if (rol === "sucursal") {
      if (!sucursalUsuario) {
        return res.status(403).json({
          error: "No se pudo determinar la sucursal del usuario",
        });
      }

      sucursalFinal = Number(sucursalUsuario);
    }

    const [result] = await db.query(
      `
        INSERT INTO clientes (
          nombre,
          telefono,
          telefono_normalizado,
          sucursal_id,
          nota,
          acepta,
          estado,
          added_to_group,
          source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        data.nombre,
        data.telefono,
        data.telefono_normalizado,
        sucursalFinal,
        data.observaciones || null,
        data.activo ? 1 : 0,
        "nuevo",
        0,
        "web",
      ],
    );

    const clientes = await obtenerClientesBase("WHERE c.id = ?", [
      result.insertId,
    ]);
    return res.status(201).json(clientes[0]);
  } catch (error) {
    console.error("Error al crear cliente:", error);
    return res.status(500).json({
      error: "Error al crear cliente",
      detalle: error.message,
    });
  }
};

exports.obtenerClientes = async (req, res) => {
  try {
    if (esAdmin(req)) {
      const clientes = await obtenerClientesBase();
      return res.json(clientes);
    }

    const sucursalUsuario = getSucursalUsuario(req);

    if (!sucursalUsuario) {
      return res.status(403).json({
        error: "No se pudo determinar la sucursal del usuario",
      });
    }

    const clientes = await obtenerClientesBase("WHERE c.sucursal_id = ?", [
      Number(sucursalUsuario),
    ]);

    return res.json(clientes);
  } catch (error) {
    console.error("Error al obtener clientes:", error);
    return res.status(500).json({ error: "Error al obtener clientes" });
  }
};

exports.obtenerClientePorId = async (req, res) => {
  try {
    let whereClause = "WHERE c.id = ?";
    const params = [req.params.id];

    if (!esAdmin(req)) {
      const sucursalUsuario = getSucursalUsuario(req);

      if (!sucursalUsuario) {
        return res.status(403).json({
          error: "No se pudo determinar la sucursal del usuario",
        });
      }

      whereClause += " AND c.sucursal_id = ?";
      params.push(Number(sucursalUsuario));
    }

    const clientes = await obtenerClientesBase(whereClause, params);

    if (!clientes.length) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    return res.json(clientes[0]);
  } catch (error) {
    console.error("Error al obtener cliente:", error);
    return res.status(500).json({ error: "Error al obtener cliente" });
  }
};

exports.editarCliente = async (req, res) => {
  try {
    const data = limpiarPayload(req.body);
    const error = validarCliente(data);

    if (error) {
      return res.status(400).json({ error });
    }

    const rol = getRol(req);
    const sucursalUsuario = getSucursalUsuario(req);

    let sucursalFinal = data.sucursal_id || null;
    let whereUpdate = "WHERE id = ?";
    const updateParams = [];

    if (rol === "sucursal") {
      if (!sucursalUsuario) {
        return res.status(403).json({
          error: "No se pudo determinar la sucursal del usuario",
        });
      }

      sucursalFinal = Number(sucursalUsuario);
      whereUpdate += " AND sucursal_id = ?";
    }

    const params = [
      data.nombre,
      data.telefono,
      data.telefono_normalizado,
      sucursalFinal,
      data.observaciones || null,
      data.activo ? 1 : 0,
      req.params.id,
    ];

    if (rol === "sucursal") {
      params.push(Number(sucursalUsuario));
    }

    const [result] = await db.query(
      `
        UPDATE clientes
        SET
          nombre = ?,
          telefono = ?,
          telefono_normalizado = ?,
          sucursal_id = ?,
          nota = ?,
          acepta = ?
        ${whereUpdate}
      `,
      params,
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    let whereClause = "WHERE c.id = ?";
    const selectParams = [req.params.id];

    if (rol === "sucursal") {
      whereClause += " AND c.sucursal_id = ?";
      selectParams.push(Number(sucursalUsuario));
    }

    const clientes = await obtenerClientesBase(whereClause, selectParams);
    return res.json(clientes[0]);
  } catch (error) {
    console.error("Error al editar cliente:", error);
    return res.status(500).json({
      error: "Error al editar cliente",
      detalle: error.message,
    });
  }
};

exports.eliminarCliente = async (req, res) => {
  try {
    let sql = `DELETE FROM clientes WHERE id = ?`;
    const params = [req.params.id];

    if (!esAdmin(req)) {
      const sucursalUsuario = getSucursalUsuario(req);

      if (!sucursalUsuario) {
        return res.status(403).json({
          error: "No se pudo determinar la sucursal del usuario",
        });
      }

      sql += ` AND sucursal_id = ?`;
      params.push(Number(sucursalUsuario));
    }

    const [result] = await db.query(sql, params);

    if (!result.affectedRows) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    return res.json({ message: "Cliente eliminado correctamente" });
  } catch (error) {
    console.error("Error al eliminar cliente:", error);
    return res.status(500).json({ error: "Error al eliminar cliente" });
  }
};

exports.buscarClientes = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const texto = `%${q}%`;

    let whereClause = `
      WHERE (
        c.nombre LIKE ?
        OR c.telefono LIKE ?
        OR c.telefono_normalizado LIKE ?
      )
    `;
    const params = [texto, texto, texto];

    if (!esAdmin(req)) {
      const sucursalUsuario = getSucursalUsuario(req);

      if (!sucursalUsuario) {
        return res.status(403).json({
          error: "No se pudo determinar la sucursal del usuario",
        });
      }

      whereClause += ` AND c.sucursal_id = ?`;
      params.push(Number(sucursalUsuario));
    }

    const clientes = await obtenerClientesBase(whereClause, params);
    return res.json(clientes);
  } catch (error) {
    console.error("Error al buscar clientes:", error);
    return res.status(500).json({ error: "Error al buscar clientes" });
  }
};
