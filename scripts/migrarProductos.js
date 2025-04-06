const mysql = require("mysql2/promise");

async function migrar() {
  const conn = await mysql.createConnection({
    host: "auth-db1894.hstgr.io",
    user: "u462364626_nahuelbenjamin",
    password: "45843140Nahuel$",
    database: "u462364626_Control_North",
  });

  console.log("✅ Conectado a la base de datos");

  try {
    // Obtener todos los productos viejos
const [productosOld] = await conn.query("SELECT * FROM productos");

    const productosMap = new Map();
    const gustosMap = new Map();
    const sucursalesMap = new Map();

    for (const row of productosOld) {
      const { nombre, gustos, stock, sucursal } = row;

      // 1. Insertar producto si no existe
      if (!productosMap.has(nombre)) {
        const [res] = await conn.query(
          "INSERT INTO productos (nombre) VALUES (?)",
          [nombre]
        );
        productosMap.set(nombre, res.insertId);
      }

      // 2. Insertar sucursal si no existe
      if (!sucursalesMap.has(sucursal)) {
        const [res] = await conn.query(
          "INSERT INTO sucursales (nombre) VALUES (?)",
          [sucursal]
        );
        sucursalesMap.set(sucursal, res.insertId);
      }

      const productoId = productosMap.get(nombre);

      // 3. Insertar gusto si no existe (clave: producto+gusto)
      const gustoKey = `${productoId}-${gustos}`;
      if (!gustosMap.has(gustoKey)) {
        const [res] = await conn.query(
          "INSERT INTO gustos (producto_id, nombre) VALUES (?, ?)",
          [productoId, gustos]
        );
        gustosMap.set(gustoKey, res.insertId);
      }

      const gustoId = gustosMap.get(gustoKey);
      const sucursalId = sucursalesMap.get(sucursal);

      // 4. Insertar stock
      await conn.query(
        "INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
        [gustoId, sucursalId, stock]
      );

      console.log(`📦 Migrado: ${nombre} - ${gustos} (${sucursal}): ${stock}`);
    }

    console.log("✅ Migración completada");
  } catch (error) {
    console.error("❌ Error al migrar:", error);
  } finally {
    conn.end();
  }
}

migrar();
