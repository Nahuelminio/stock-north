-- ============================================================
-- Migración: Sistema de ventas mayoristas
-- Ejecutar una sola vez en la base de datos de producción
-- ============================================================

-- 1. Agregar columna es_mayorista a clientes
-- (si ya existe, este comando falla con un error inofensivo — podés ignorarlo)
ALTER TABLE clientes
  ADD COLUMN es_mayorista TINYINT(1) NOT NULL DEFAULT 0;

-- 2. Tabla principal de pedidos mayoristas
CREATE TABLE IF NOT EXISTS pedidos_mayoristas (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id          INT NOT NULL,
  sucursal_id         INT NOT NULL,
  estado              ENUM('pendiente','confirmado','cancelado') NOT NULL DEFAULT 'pendiente',
  tipo_cambio         DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_usd           DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_ars           DECIMAL(10,2) NOT NULL DEFAULT 0,
  notas               TEXT,
  creado_por          INT,
  fecha_creacion      DATETIME NOT NULL DEFAULT NOW(),
  fecha_confirmacion  DATETIME,
  FOREIGN KEY (cliente_id)  REFERENCES clientes(id),
  FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)
);

-- 3. Tabla de ítems del pedido
CREATE TABLE IF NOT EXISTS pedido_mayorista_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  pedido_id   INT NOT NULL,
  gusto_id    INT NOT NULL,
  cantidad    INT NOT NULL,
  precio_usd  DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (pedido_id) REFERENCES pedidos_mayoristas(id) ON DELETE CASCADE,
  FOREIGN KEY (gusto_id)  REFERENCES gustos(id)
);
