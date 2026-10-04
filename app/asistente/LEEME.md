# El asistente de Telegram

Le escribís al bot como le escribirías a una persona y te contesta con datos de
la base. Solo consulta: no carga ni modifica nada.

## Las piezas

| Archivo | Qué hace |
|---|---|
| `herramientas.js` | Las consultas que el asistente puede hacer. Todas de lectura. |
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

## Por qué solo lee

Una respuesta equivocada se aclara con otra pregunta. Una escritura equivocada
queda en la base. Si alguna vez se agregan acciones, van con confirmación
explícita y nunca para lo irreversible.

## Límites conocidos

- **No entiende audios.** Dictar con el teclado del celular llega como texto y
  funciona igual. Para audios de verdad hace falta un transcriptor.
- **La conversación vive en memoria.** Un deploy la borra.
- **Lee de la base, no del futuro.** Si un dato está mal cargado, lo repite.
