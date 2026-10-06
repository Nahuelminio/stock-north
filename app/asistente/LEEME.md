# El asistente de Telegram

Le escribís al bot como le escribirías a una persona y te contesta con datos de
la base. Solo consulta: no carga ni modifica nada.

## Las piezas

| Archivo | Qué hace |
|---|---|
| `herramientas.js` | Las consultas que el asistente puede hacer, más registrar ventas. |
| `transcribir.js` | Audio a texto, con Whisper de OpenAI. |
| `cerebro.js` | Claude con esas herramientas: decide qué consultar y redacta. |
| `../routes/telegram.routes.js` | La puerta por donde entran los mensajes de Telegram. |
| `../../conectar_bot.js` | Da de alta el webhook y averigua tu chat_id. |
| `../../probar_asistente.js` | Hablarle desde la terminal, sin Telegram. |

## Variables de entorno

| Variable | Para qué | ¿Obligatoria? |
|---|---|---|
| `ANTHROPIC_API_KEY` | La misma del lector de comprobantes | sí |
| `TELEGRAM_BOT_TOKEN` | El bot, ya estaba | sí |
| `TELEGRAM_WEBHOOK_SECRET` | Secreto de la URL y del header | sí |
| `TELEGRAM_CHATS_ASISTENTE` | Chats autorizados, separados por coma | si falta usa `TELEGRAM_CHAT_ID` |
| `ASISTENTE_MODELO` | Para cambiar de modelo | no (`claude-sonnet-5-5`) |
| `OPENAI_API_KEY` | Transcribir audios (Claude no hace audio) | solo para audio |
| `DISPOSITIVO_TOKEN` | La placa del mostrador | solo para la placa |

## Ponerlo a andar

```
node conectar_bot.js secreto                                  # genera el secreto
node conectar_bot.js conectar https://TU-BACKEND.onrender.com  # avisa a Telegram
node conectar_bot.js estado                                   # verifica
```

Para saber tu chat_id: desconectá el webhook, escribile al bot y corré
`node conectar_bot.js chat`. El webhook y `getUpdates` no pueden leer a la vez.

## Agregar una consulta

En `herramientas.js`, sumá la función y su entrada en `HERRAMIENTAS`. La
descripción es lo que el modelo lee para decidir cuándo usarla, así que conviene
que diga cuándo sirve y no solo qué devuelve.

Probala suelta antes de pasar por el modelo: están todas exportadas al final.

## Registrar ventas

Es lo único que el asistente escribe, y va en dos pasos: `preparar_venta`
resuelve el sabor y el precio sin tocar nada, y `confirmar_venta` escribe.

El freno no es que el prompt pida confirmación —eso un modelo lo puede saltear—
sino que `confirmar_venta` rechaza un pendiente creado en el mismo turno. El
turno avanza solo cuando mandás un mensaje, así que entre preparar y confirmar
tenés que haber escrito vos. El pendiente dura diez minutos y se usa una vez.

La venta la hace `services/registrarVenta.js`, el mismo que usa la pantalla:
una sola implementación para los dos, como con los costos.

Todo lo demás sigue siendo de lectura.

## Audios

Un audio por Telegram se baja, se transcribe y sigue el mismo camino que un
mensaje escrito. Antes de contestar, el bot te dice qué entendió: si transcribió
mal, lo ves vos y no después en la respuesta.

Sin `OPENAI_API_KEY` no rompe: avisa que falta y te pide que escribas.

## El aparato del mostrador

`GET /dispositivo/panel?token=...` devuelve, en 89 bytes, el dólar de hoy, lo
vendido en el día y la hora. Es lo que muestra la pantalla del ESP32.

`POST /dispositivo/preguntar` recibe el audio crudo en el cuerpo: la placa graba
mientras apretás el botón y lo manda tal cual. Transcribe, se lo pasa al mismo
asistente, manda la respuesta completa a Telegram y le devuelve a la placa un
renglón corto para la pantalla.

Ese cuerpo esquiva los parsers globales (ver `app.js`): si `express.json` lo toca
primero, el audio llega como objeto en vez de bytes.

Va con un token fijo (`DISPOSITIVO_TOKEN`) porque un microcontrolador no puede
manejar un JWT que vence. Por eso devuelve solo lo que no molesta que se lea en
una pantalla apoyada en el mostrador: nada de costos, deudas ni márgenes.

## Límites conocidos

- **La conversación vive en memoria.** Un deploy la borra.
- **Lee de la base, no del futuro.** Si un dato está mal cargado, lo repite.
