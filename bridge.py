#!/usr/bin/env python3
"""
================================================================
bridge.py — MT5 Local Bridge Server
================================================================
Expone la API de MetaTrader 5 como un servidor HTTP local
para que el bot de Node.js pueda interactuar con MT5 sin
necesidad de MetaApi (sin suscripción mensual).

REQUISITOS:
  pip install MetaTrader5 flask

USO:
  python bridge.py

El servidor escucha en http://localhost:5001
================================================================
"""

import json
import os
import sys
import logging
from datetime import datetime
from flask import Flask, request, jsonify


def check_bridge_token() -> tuple | None:
    """PROMPT 06 §5/§23: candado de escritura del bridge (order/cancel).
    Sin BRIDGE_TOKEN configurado → denegado (fail-closed). Cadena vacía =
    desactivación explícita por el operador. Devuelve (response, code) o None."""
    token = os.environ.get("BRIDGE_TOKEN")
    if token is None:
        return jsonify({"error": "BRIDGE_TOKEN no configurado: operación DENEGADA (fail-closed §5)"}), 403
    if token != "" and request.headers.get("X-AGT-Token") != token:
        return jsonify({"error": "Token de bridge inválido (X-AGT-Token)"}), 401
    return None

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: Instala la librería con: pip install MetaTrader5")
    sys.exit(1)

# ── Configuración ─────────────────────────────────────────────
BRIDGE_PORT = 5001
LOG_LEVEL   = logging.INFO

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [MT5-Bridge] %(levelname)s – %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger("mt5-bridge")

app = Flask(__name__)

# ── Inicializar MT5 ───────────────────────────────────────────
def init_mt5():
    if not mt5.initialize():
        log.error(f"initialize() falló, código de error: {mt5.last_error()}")
        return False
    info = mt5.terminal_info()
    account = mt5.account_info()
    log.info(f"MT5 conectado: {info.name} | Cuenta: {account.login} | Balance: {account.balance}")
    return True

# ── Mapeo de Timeframes ───────────────────────────────────────
TIMEFRAME_MAP = {
    "M1":  mt5.TIMEFRAME_M1,
    "M5":  mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1":  mt5.TIMEFRAME_H1,
    "H4":  mt5.TIMEFRAME_H4,
    "D1":  mt5.TIMEFRAME_D1,
}

# ── Tabla de variantes de símbolos Vantage MT5 ───────────────
# Vantage nombra sus CFDs con variantes específicas.
# El bridge las prueba en orden hasta encontrar la correcta.
VANTAGE_SYMBOL_MAP = {
    "US30":   ["US30", "US30.cash", "DJ30", "US30Cash", "DJIA", "WallStreet30", "USINDEX30", "US30.v"],
    "NAS100": ["NAS100", "NAS100.cash", "USTEC", "NDX", "NAS100Cash", "NAS100.v", "NASDAQ"],
    "BTCUSD": ["BTCUSD", "BITCOIN", "BTC/USD", "BTCUSD.v", "BTC", "BTCUSD.c"],
    "GBPJPY": ["GBPJPY", "GBP/JPY", "GBPJPY.v"],
    "XAUUSD": ["XAUUSD", "GOLD", "XAU/USD", "XAUUSD.v", "GOLD.v"],
    "EURUSD": ["EURUSD", "EUR/USD", "EURUSD.v"],
}

def normalize_symbol(symbol: str) -> str:
    """Busca el símbolo exacto en MT5 usando la tabla Vantage primero."""
    key = symbol.upper()

    # 1. Variantes conocidas de Vantage
    candidates = list(VANTAGE_SYMBOL_MAP.get(key, []))

    # 2. Fallbacks genéricos
    candidates += [key, key + ".v", key + ".c", key + "_", key + ".cash", key + "Cash"]

    for s in candidates:
        info = mt5.symbol_info(s)
        if info is not None:
            mt5.symbol_select(s, True)
            log.info(f"Símbolo resuelto: {key} → {s}")
            return s

    log.warning(f"Símbolo '{key}' no encontrado. Usa GET /symbols?q={key} para ver opciones reales.")
    return key



# ══════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════

@app.route("/health", methods=["GET"])
def health():
    """Verifica que el bridge y MT5 estén activos."""
    if not mt5.terminal_info():
        return jsonify({"status": "error", "message": "MT5 no conectado"}), 503
    account = mt5.account_info()
    return jsonify({
        "status":  "ok",
        "message": "MT5 Bridge activo",
        "account": account.login if account else None,
        "server":  account.server if account else None,
        "balance": account.balance if account else None,
    })


@app.route("/symbols", methods=["GET"])
def list_symbols():
    """
    Lista todos los símbolos disponibles en MT5 (filtrado por query ?q=US30).
    Útil para depurar qué nombre exacto usa Vantage.
    """
    q = request.args.get("q", "").upper()
    all_symbols = mt5.symbols_get()
    if all_symbols is None:
        return jsonify({"error": "No se pudieron obtener símbolos"}), 500
    names = [s.name for s in all_symbols if q in s.name.upper()]
    return jsonify({"count": len(names), "symbols": names[:100]})


@app.route("/account", methods=["GET"])
def get_account():
    """Devuelve información de la cuenta: balance, equity, margin."""
    info = mt5.account_info()
    if info is None:
        return jsonify({"error": "No se pudo obtener info de cuenta", "detail": str(mt5.last_error())}), 500
    return jsonify({
        "login":    info.login,
        "balance":  info.balance,
        "equity":   info.equity,
        "margin":   info.margin,
        "freeMargin": info.margin_free,
        "currency": info.currency,
        "leverage": info.leverage,
        "server":   info.server,
    })


@app.route("/price/<symbol>", methods=["GET"])
def get_price(symbol: str):
    """Devuelve el precio actual (bid/ask) del símbolo."""
    resolved = normalize_symbol(symbol.upper())
    tick = mt5.symbol_info_tick(resolved)
    if tick is None:
        return jsonify({"error": f"No se puede obtener precio de {resolved}", "detail": str(mt5.last_error())}), 500
    info = mt5.symbol_info(resolved)
    return jsonify({
        "symbol":    resolved,
        "bid":       tick.bid,
        "ask":       tick.ask,
        "spread":    round(tick.ask - tick.bid, info.digits if info else 5),
        "digits":    info.digits if info else 5,
        "time":      datetime.utcfromtimestamp(tick.time).isoformat() + "Z",
    })


@app.route("/symbol_info/<symbol>", methods=["GET"])
def get_symbol_info(symbol: str):
    """
    Devuelve las propiedades del CONTRATO del símbolo según MT5.
    Base del sizing exacto multi-broker en Node (tick_value/tick_size
    en moneda de la cuenta). 404 honesto si el símbolo no existe:
    nunca se devuelven números inventados.
    """
    resolved = normalize_symbol(symbol.upper())
    info = mt5.symbol_info(resolved)
    if info is None:
        return jsonify({
            "error": f"Símbolo {symbol} no encontrado en MT5 (resuelto como '{resolved}')",
            "detail": str(mt5.last_error()),
        }), 404
    return jsonify({
        "name":             info.name,
        "digits":           info.digits,
        "point":            info.point,
        "trade_tick_value": info.trade_tick_value,
        "trade_tick_size":  info.trade_tick_size,
        "volume_min":       info.volume_min,
        "volume_max":       info.volume_max,
        "volume_step":      info.volume_step,
        "contract_size":    info.trade_contract_size,
        "currency_profit":  info.currency_profit,
        "description":      info.description,
    })


@app.route("/candles/<symbol>/<timeframe>/<int:count>", methods=["GET"])
def get_candles(symbol: str, timeframe: str, count: int):
    """
    Devuelve las últimas N velas del símbolo en el timeframe dado.
    Usado para calcular RVOL (Relative Volume).
    """
    tf = TIMEFRAME_MAP.get(timeframe.upper())
    if tf is None:
        return jsonify({"error": f"Timeframe inválido: {timeframe}. Opciones: {list(TIMEFRAME_MAP.keys())}"}), 400

    resolved = normalize_symbol(symbol.upper())
    rates = mt5.copy_rates_from_pos(resolved, tf, 0, count)
    if rates is None or len(rates) == 0:
        return jsonify({"error": f"No se encontraron velas para {resolved}", "detail": str(mt5.last_error())}), 500

    candles = []
    for r in rates:
        candles.append({
            "time":        datetime.utcfromtimestamp(r["time"]).isoformat() + "Z",
            "open":        float(r["open"]),
            "high":        float(r["high"]),
            "low":         float(r["low"]),
            "close":       float(r["close"]),
            "tickVolume":  int(r["tick_volume"]),
            "realVolume":  int(r["real_volume"]),
            "spread":      int(r["spread"]),
        })
    return jsonify({"symbol": resolved, "timeframe": timeframe, "candles": candles})


@app.route("/order", methods=["POST"])
def place_order():
    """
    Coloca una orden en MT5.
    Body JSON:
    {
      "symbol":     "US30",
      "type":       "BUY_LIMIT" | "SELL_LIMIT" | "BUY" | "SELL",
      "volume":     0.01,
      "price":      12345.0,    (para límites)
      "stopLoss":   12300.0,
      "takeProfit": 12500.0,
      "comment":    "Bot SMC",
      "expiration": 1770000000  (opcional, epoch en SEGUNDOS; añade
                    type_time=ORDER_TIME_SPECIFIED — sin él la orden es GTC,
                    compatibilidad hacia atrás con clientes viejos)
    }
    """
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Body JSON requerido"}), 400

    # ── PROMPT 06 §5/§23: el bridge es una frontera de ejecución, no un
    # endpoint abierto (candado compartido con /cancel vía check_bridge_token).
    denied = check_bridge_token()
    if denied:
        return denied
    if not request.is_json:
        return jsonify({"error": "Content-Type debe ser application/json"}), 415

    symbol      = normalize_symbol(body.get("symbol", "").upper())
    order_type  = body.get("type", "BUY_LIMIT").upper()
    volume      = float(body.get("volume", 0.01))
    price       = float(body.get("price", 0))
    stop_loss   = float(body.get("stopLoss", 0))
    take_profit = float(body.get("takeProfit", 0))
    comment     = body.get("comment", "Bot-SMC-Auto")
    expiration  = body.get("expiration")  # epoch en segundos (opcional)

    # PROMPT 06 §5: una pendiente sin SL/TP es una orden sin gestión de
    # riesgo — el bridge la rechaza aunque el cliente Node se equivoque.
    if "LIMIT" in order_type or "STOP" in order_type:
        if stop_loss <= 0 or take_profit <= 0:
            return jsonify({"error": "Órdenes pendientes exigen stopLoss y takeProfit > 0 (fail-closed §5)"}), 400

    # Verificar que el símbolo está disponible
    info = mt5.symbol_info(symbol)
    if info is None:
        return jsonify({"error": f"Símbolo {symbol} no encontrado en MT5"}), 400

    # Mapa de tipos de orden
    type_map = {
        "BUY":        mt5.ORDER_TYPE_BUY,
        "SELL":       mt5.ORDER_TYPE_SELL,
        "BUY_LIMIT":  mt5.ORDER_TYPE_BUY_LIMIT,
        "SELL_LIMIT": mt5.ORDER_TYPE_SELL_LIMIT,
        "BUY_STOP":   mt5.ORDER_TYPE_BUY_STOP,
        "SELL_STOP":  mt5.ORDER_TYPE_SELL_STOP,
    }
    mt5_type = type_map.get(order_type)
    if mt5_type is None:
        return jsonify({"error": f"Tipo de orden inválido: {order_type}"}), 400

    # Para órdenes de mercado, usar precio actual
    if order_type in ("BUY", "SELL"):
        tick = mt5.symbol_info_tick(symbol)
        price = tick.ask if order_type == "BUY" else tick.bid

    # Expiración de pendientes (Task 8-a): las decisiones del pipeline
    # valen 15 minutos; una LIMIT GTC eterna era un riesgo del audit C5.
    # Sin expiration → GTC (comportamiento idéntico al de siempre).
    expiration_epoch = None
    if expiration is not None:
        try:
            expiration_epoch = int(float(expiration))
        except (TypeError, ValueError):
            return jsonify({"error": f"expiration inválido: {expiration!r} (se espera epoch en segundos)"}), 400

    request_data = {
        "action":        mt5.TRADE_ACTION_PENDING if "LIMIT" in order_type or "STOP" in order_type else mt5.TRADE_ACTION_DEAL,
        "symbol":        symbol,
        "volume":        volume,
        "type":          mt5_type,
        "price":         price,
        "sl":            stop_loss,
        "tp":            take_profit,
        "deviation":     20,
        "magic":         234000,
        "comment":       comment,
        "type_time":     mt5.ORDER_TIME_GTC,
        "type_filling":  mt5.ORDER_FILLING_IOC,
    }
    if expiration_epoch is not None:
        request_data["type_time"] = mt5.ORDER_TIME_SPECIFIED
        request_data["expiration"] = expiration_epoch

    log.info(f"Enviando orden: {json.dumps({k: v for k, v in request_data.items() if k != 'action'}, default=str)}")
    result = mt5.order_send(request_data)

    if result is None:
        return jsonify({"error": "order_send devolvió None", "detail": str(mt5.last_error())}), 500

    if result.retcode != mt5.TRADE_RETCODE_DONE and result.retcode != mt5.TRADE_RETCODE_PLACED:
        return jsonify({
            "error":   f"Orden rechazada por MT5 (retcode: {result.retcode})",
            "comment": result.comment,
            "retcode": result.retcode,
        }), 400

    log.info(f"Orden ejecutada: ticket={result.order}, retcode={result.retcode}")
    # PROMPT 06 §13: devolver los valores REALES del fill de MT5 (result.price/
    # result.volume), no los del request — la verificación request-vs-actual
    # vive en el cliente, y necesita datos honestos del broker.
    actual_price = float(getattr(result, "price", 0) or 0)
    actual_volume = float(getattr(result, "volume", 0) or 0)
    return jsonify({
        "success":  True,
        "ticket":   result.order,
        "retcode":  result.retcode,
        "comment":  result.comment,
        "volume":   actual_volume if actual_volume > 0 else volume,
        "price":    actual_price if actual_price > 0 else price,
        "requested_price": price,
        "requested_volume": volume,
        "symbol":   symbol,
        "type":     order_type,
    })


@app.route("/modify_position", methods=["POST"])
def modify_position():
    """
    Modifica el SL/TP de una posición ABIERTA (Task 11-a — "Regla de
    protección" del manual operativo: al tocar TP2/TP1 el gestor de
    posiciones mueve el SL a break-even vía este endpoint).
    Body JSON:
    {
      "ticket": 123456789,   (prioridad sobre symbol; si se envía symbol
      "symbol": "US30",       y hay varias posiciones → se exige ticket)
      "sl": 12300.0,         (nuevo SL; opcional si se envía tp)
      "tp": 12500.0          (nuevo TP; opcional si se envía sl)
    }
    Usa mt5.TRADE_ACTION_SLTP. Validaciones fail-closed:
      - mismo candado X-AGT-Token que /order y /cancel,
      - la posición debe existir (si no → 404 limpio, sin stack traces),
      - el SL NUNCA puede aumentar el riesgo: para un LONG debe quedar
        por debajo del bid actual y NO por debajo del SL actual (alejar
        el stop); para un SHORT por encima del ask y NO por encima del
        SL actual.
    """
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Body JSON requerido"}), 400

    # ── Mismo candado de escritura que el resto de endpoints (§5/§23) ──
    denied = check_bridge_token()
    if denied:
        return denied
    if not request.is_json:
        return jsonify({"error": "Content-Type debe ser application/json"}), 415

    raw_ticket = body.get("ticket")
    symbol     = body.get("symbol", "")
    new_sl     = body.get("sl")
    new_tp     = body.get("tp")

    if new_sl is None and new_tp is None:
        return jsonify({"error": "Debe enviarse al menos 'sl' o 'tp' a modificar"}), 400

    # Parseo defensivo: errores limpios 400, nunca stack traces (estilo /order)
    try:
        new_sl = float(new_sl) if new_sl is not None else None
        new_tp = float(new_tp) if new_tp is not None else None
    except (TypeError, ValueError):
        return jsonify({"error": f"sl/tp deben ser números (sl={new_sl!r}, tp={new_tp!r})"}), 400
    if new_sl is not None and new_sl <= 0:
        return jsonify({"error": f"SL inválido: {new_sl} (un SL de 0 o negativo eliminaría la protección)"}), 400
    if new_tp is not None and new_tp <= 0:
        return jsonify({"error": f"TP inválido: {new_tp} (un TP de 0 o negativo eliminaría la toma de beneficios)"}), 400

    # ── Localizar la posición abierta (rechazo honesto si no existe) ──
    if raw_ticket is not None:
        try:
            ticket = int(raw_ticket)
        except (TypeError, ValueError):
            return jsonify({"error": f"ticket inválido: {raw_ticket!r}"}), 400
        positions = mt5.positions_get(ticket=ticket)
    elif symbol:
        positions = mt5.positions_get(symbol=normalize_symbol(symbol.upper()))
    else:
        return jsonify({"error": "Se requiere 'ticket' o 'symbol' para identificar la posición"}), 400

    if positions is None or len(positions) == 0:
        return jsonify({"error": f"Posición no encontrada en MT5 (ticket={raw_ticket!r}, symbol={symbol!r})"}), 404
    if len(positions) > 1:
        # Fail-closed: modificar N posiciones con una sola llamada es ambiguo
        return jsonify({"error": f"El símbolo {symbol} tiene {len(positions)} posiciones abiertas: envía el 'ticket' concreto"}), 409

    pos = positions[0]
    is_long = pos.type == mt5.POSITION_TYPE_BUY

    # ── Validación de lado del SL (rechazar SL que aumentaría el riesgo) ──
    if new_sl is not None:
        tick = mt5.symbol_info_tick(pos.symbol)
        if tick is None:
            return jsonify({"error": f"No se pudo obtener el precio actual de {pos.symbol}", "detail": str(mt5.last_error())}), 500
        if is_long:
            if new_sl >= tick.bid:
                return jsonify({"error": f"SL inválido para posición LONG {pos.symbol}: {new_sl} debe ser < bid actual ({tick.bid})"}), 400
            if pos.sl > 0 and new_sl < pos.sl:
                return jsonify({"error": f"SL {new_sl} alejaría el stop del LONG (SL actual {pos.sl}): no se acepta un SL que aumente el riesgo"}), 400
        else:
            if new_sl <= tick.ask:
                return jsonify({"error": f"SL inválido para posición SHORT {pos.symbol}: {new_sl} debe ser > ask actual ({tick.ask})"}), 400
            if pos.sl > 0 and new_sl > pos.sl:
                return jsonify({"error": f"SL {new_sl} alejaría el stop del SHORT (SL actual {pos.sl}): no se acepta un SL que aumente el riesgo"}), 400

    request_data = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "position": pos.ticket,
        "symbol":   pos.symbol,
        # Los campos no enviados se mantienen tal cual (no se tocan)
        "sl":       new_sl if new_sl is not None else pos.sl,
        "tp":       new_tp if new_tp is not None else pos.tp,
    }

    log.info(f"Modificando posición {pos.ticket} ({pos.symbol}): sl={request_data['sl']}, tp={request_data['tp']}")
    result = mt5.order_send(request_data)

    if result is None:
        return jsonify({"error": "order_send devolvió None", "detail": str(mt5.last_error())}), 500

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({
            "error":   f"Modificación rechazada por MT5 (retcode: {result.retcode})",
            "comment": result.comment,
            "retcode": result.retcode,
        }), 400

    log.info(f"Posición modificada: ticket={pos.ticket}, retcode={result.retcode}")
    return jsonify({
        "success": True,
        "ticket":  pos.ticket,
        "symbol":  pos.symbol,
        "type":    "BUY" if is_long else "SELL",
        "sl":      request_data["sl"],
        "tp":      request_data["tp"],
    })


@app.route("/close_position", methods=["POST"])
def close_position():
    """
    P1 — TP LADDER: cierra TOTAL o PARCIALMENTE una posición abierta.
    Body JSON:
    {
      "ticket":  123456789,   (obligatorio — jamás ambigüedad por símbolo)
      "volume":  0.05,        (opcional; ausente/None = cerrar TODO)
      "comment": "AGT-LADDER-TP1"  (opcional)
    }
    Implementación: TRADE_ACTION_DEAL con la operación CONTRARIA y
    position=ticket (semántica oficial MT5 para cierres parciales; en
    cuentas netting el volumen contrario reduce la posición igual).
    Validaciones fail-closed:
      - mismo candado X-AGT-Token que /order y /modify_position,
      - la posición debe existir (404 limpio, sin stack traces),
      - 0 < volume <= posición.volume (si no → 400; un volumen mayor
        es ambiguo y NO se recorta silenciosamente),
      - precio del tick REAL (bid para cerrar BUY, ask para cerrar
        SELL) con deviation=20 como el resto de la frontera.
    """
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Body JSON requerido"}), 400

    denied = check_bridge_token()
    if denied:
        return denied
    if not request.is_json:
        return jsonify({"error": "Content-Type debe ser application/json"}), 415

    raw_ticket = body.get("ticket")
    raw_volume = body.get("volume")          # None → cerrar TODO
    comment    = body.get("comment", "AGT-LADDER")

    try:
        ticket = int(raw_ticket)
    except (TypeError, ValueError):
        return jsonify({"error": f"ticket inválido: {raw_ticket!r}"}), 400

    positions = mt5.positions_get(ticket=ticket)
    if positions is None or len(positions) == 0:
        # 404 honesto: la posición ya no existe (el broker la cerró por
        # SL/TP/stop-out) — el llamador debe reconciliar, no insistir.
        return jsonify({"error": f"Posición no encontrada en MT5 (ticket={raw_ticket!r})", "code": "POSITION_NOT_FOUND"}), 404

    pos = positions[0]
    close_volume = float(pos.volume) if raw_volume is None else float(raw_volume)
    if close_volume <= 0:
        return jsonify({"error": f"volume inválido: {close_volume} (debe ser > 0)"}), 400
    if close_volume > float(pos.volume) + 1e-8:
        return jsonify({
            "error": f"volume {close_volume} excede el volumen vivo de la posición ({pos.volume}): ambiguo → rechazado (fail-closed)",
        }), 400

    is_long = pos.type == mt5.POSITION_TYPE_BUY
    tick = mt5.symbol_info_tick(pos.symbol)
    if tick is None:
        return jsonify({"error": f"No se pudo obtener el tick de {pos.symbol}", "detail": str(mt5.last_error())}), 500

    request_data = {
        "action":        mt5.TRADE_ACTION_DEAL,
        "symbol":        pos.symbol,
        "volume":        close_volume,
        "type":          mt5.ORDER_TYPE_SELL if is_long else mt5.ORDER_TYPE_BUY,
        "position":      pos.ticket,
        "price":         tick.bid if is_long else tick.ask,
        "deviation":     20,
        "magic":         234000,
        "comment":       str(comment)[:31],
        "type_time":     mt5.ORDER_TIME_GTC,
        "type_filling":  mt5.ORDER_FILLING_IOC,
    }

    log.info(f"Cierre {'parcial' if raw_volume is not None and close_volume < float(pos.volume) else 'total'} de posición: {json.dumps({k: v for k, v in request_data.items() if k != 'action'}, default=str)}")
    result = mt5.order_send(request_data)

    if result is None:
        return jsonify({"error": "order_send devolvió None", "detail": str(mt5.last_error())}), 500

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({
            "error":   f"Cierre rechazado por MT5 (retcode: {result.retcode})",
            "comment": result.comment,
            "retcode": result.retcode,
        }), 400

    # Los valores REALES del deal (nunca los del request — §13).
    actual_volume = float(getattr(result, "volume", 0) or 0)
    actual_price  = float(getattr(result, "price", 0) or 0)
    remaining     = float(pos.volume) - (actual_volume if actual_volume > 0 else close_volume)
    log.info(f"Posición cerrada (parcial={remaining > 1e-8}): ticket={pos.ticket}, deal={result.deal}, retcode={result.retcode}, restante={max(0.0, remaining)}")
    return jsonify({
        "success":        True,
        "ticket":         pos.ticket,
        "deal":           result.deal,
        "retcode":        result.retcode,
        "closed_volume":  actual_volume if actual_volume > 0 else close_volume,
        "remaining_volume": max(0.0, remaining),
        "price":          actual_price if actual_price > 0 else request_data["price"],
        "symbol":         pos.symbol,
        "type":           "BUY" if is_long else "SELL",
        "comment":        result.comment,
    })


@app.route("/positions", methods=["GET"])
def get_positions():
    """Lista las posiciones abiertas actuales."""
    positions = mt5.positions_get()
    if positions is None:
        return jsonify({"positions": []})
    result = []
    for p in positions:
        result.append({
            "ticket":     p.ticket,
            "symbol":     p.symbol,
            "type":       "BUY" if p.type == 0 else "SELL",
            "volume":     p.volume,
            "openPrice":  p.price_open,
            "currentPrice": p.price_current,
            "sl":         p.sl,
            "tp":         p.tp,
            "profit":     p.profit,
            "comment":    p.comment,
            "openTime":   datetime.utcfromtimestamp(p.time).isoformat() + "Z",
        })
    return jsonify({"positions": result, "count": len(result)})


@app.route("/orders", methods=["GET"])
def get_pending_orders():
    """Lista las órdenes pendientes."""
    orders = mt5.orders_get()
    if orders is None:
        return jsonify({"orders": []})
    result = []
    for o in orders:
        type_names = {0:"BUY", 1:"SELL", 2:"BUY_LIMIT", 3:"SELL_LIMIT", 4:"BUY_STOP", 5:"SELL_STOP"}
        result.append({
            "ticket":     o.ticket,
            "symbol":     o.symbol,
            "type":       type_names.get(o.type, str(o.type)),
            "volume":     o.volume_current,
            "price":      o.price_open,
            "sl":         o.sl,
            "tp":         o.tp,
            "comment":    o.comment,
            "time":       datetime.utcfromtimestamp(o.time).isoformat() + "Z",
            "timeEpoch":  int(o.time),
        })
    return jsonify({"orders": result, "count": len(result)})


# ══════════════════════════════════════════════════════════════
# P0 EXECUTION TRUTH — HISTORIAL MT5 (reconstrucción de ejecuciones)
# ══════════════════════════════════════════════════════════════
# La verdad de ejecución vive en la HISTORIA de MT5:
#   ORDER  = intención/orden del broker   (history_orders_get)
#   DEAL   = evidencia central de ejecución (history_deals_get)
#   POSITION = estado agregado (position_id == ticket de posición;
#              NUNCA asumir order_ticket == position_ticket)
# Solo se exponen campos REALES de la API de MetaTrader5 — nada inventado.

ORDER_STATE_NAMES = {
    0: "STARTED", 1: "PLACED", 2: "CANCELED", 3: "PARTIAL",
    4: "FILLED", 5: "REJECTED", 6: "EXPIRED", 7: "CALCULATED", 8: "MODIFY",
}

DEAL_ENTRY_NAMES = {0: "IN", 1: "OUT", 2: "INOUT", 3: "OUT_BY"}

DEAL_REASON_NAMES = {
    0: "CLIENT", 1: "MOBILE", 2: "WEB", 3: "EXPERT", 4: "SL", 5: "TP",
    6: "SO", 7: "ROLLOVER", 8: "VMARGIN", 9: "SPLIT",
}

DEAL_TYPE_NAMES = {0: "BUY", 1: "SELL"}


def _iso_epoch(ts: float) -> str:
    return datetime.utcfromtimestamp(ts).isoformat() + "Z"


def _serialize_history_order(o) -> dict:
    return {
        "ticket":        o.ticket,
        "time":          _iso_epoch(o.time),
        "timeEpoch":     int(o.time),
        "timeMsc":       int(getattr(o, "time_msc", 0) or 0),
        "type":          DEAL_TYPE_NAMES.get(o.type, str(o.type)),
        "volumeInitial": float(o.volume_initial),
        "volumeCurrent": float(o.volume_current),
        "priceOpen":     float(o.price_open),
        "priceCurrent":  float(o.price_current),
        "sl":            float(o.sl),
        "tp":            float(o.tp),
        "state":         int(o.state),
        "stateName":     ORDER_STATE_NAMES.get(o.state, str(o.state)),
        "comment":       o.comment,
        "positionId":    int(getattr(o, "position_id", 0) or 0),
        "magic":         int(getattr(o, "magic", 0) or 0),
        "retcode":       int(getattr(o, "retcode", 0) or 0),
        "symbol":        o.symbol,
    }


def _serialize_history_deal(d) -> dict:
    return {
        "ticket":        d.ticket,
        "order":         int(getattr(d, "order", 0) or 0),
        "time":          _iso_epoch(d.time),
        "timeEpoch":     int(d.time),
        "timeMsc":       int(getattr(d, "time_msc", 0) or 0),
        "type":          DEAL_TYPE_NAMES.get(d.type, str(d.type)),
        "entry":         int(d.entry),
        "entryName":     DEAL_ENTRY_NAMES.get(d.entry, str(d.entry)),
        "volume":        float(d.volume),
        "price":         float(d.price),
        "profit":        float(d.profit),
        "commission":    float(getattr(d, "commission", 0.0) or 0.0),
        "swap":          float(getattr(d, "swap", 0.0) or 0.0),
        "fee":           float(getattr(d, "fee", 0.0) or 0.0),
        "symbol":        d.symbol,
        "comment":       d.comment,
        "positionId":    int(getattr(d, "position_id", 0) or 0),
        "magic":         int(getattr(d, "magic", 0) or 0),
        "reason":        int(getattr(d, "reason", 0) or 0),
        "reasonName":    DEAL_REASON_NAMES.get(getattr(d, "reason", 0), str(getattr(d, "reason", 0))),
    }


def _parse_epoch_arg(name: str, default):
    """Parsea un epoch en SEGUNDOS desde querystring. Devuelve (valor, error_json|None)."""
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default, None
    try:
        value = int(float(raw))
        if value < 0:
            raise ValueError
        return datetime.utcfromtimestamp(value), None
    except (TypeError, ValueError):
        return None, (jsonify({"error": f"Parámetro '{name}' inválido: {raw!r} (se espera epoch en segundos)"}), 400)


def _history_window(default_days: float = 7.0):
    """Ventana temporal por defecto: últimos N días (UTC, como espera la API)."""
    import time as _time
    now = _time.time()
    frm, err = _parse_epoch_arg("from", now - default_days * 86400)
    if err:
        return None, None, err
    to, err = _parse_epoch_arg("to", now + 60)
    if err:
        return None, None, err
    return frm, to, None


@app.route("/history/orders", methods=["GET"])
def get_history_orders():
    """
    Historia de ÓRDENES (intención del broker). APIs reales:
      mt5.history_orders_get(date_from, date_to) — ventana temporal
      mt5.history_orders_get(ticket=X)           — orden concreta
      mt5.history_orders_get(position=X)         — órdenes de una posición
    Query: ?from=<epoch s>&to=<epoch s>&ticket=<int>&position=<int>
    """
    denied = check_bridge_token()
    if denied:
        return denied

    ticket = request.args.get("ticket", type=int)
    position = request.args.get("position", type=int)

    try:
        if ticket is not None:
            orders = mt5.history_orders_get(ticket=ticket)
        elif position is not None:
            orders = mt5.history_orders_get(position=position)
        else:
            date_from, date_to, err = _history_window()
            if err:
                return err
            orders = mt5.history_orders_get(date_from, date_to)
    except Exception as exc:  # noqa: BLE001 — el bridge nunca tumba al cliente
        return jsonify({"error": "history_orders_get falló", "detail": str(exc)}), 500

    if orders is None:
        # None = sin datos / rango sin órdenes: respuesta honesta vacía
        return jsonify({"orders": [], "count": 0, "detail": str(mt5.last_error())})

    return jsonify({"orders": [_serialize_history_order(o) for o in orders], "count": len(orders)})


@app.route("/history/deals", methods=["GET"])
def get_history_deals():
    """
    Historia de DEALS (evidencia central de ejecución). APIs reales:
      mt5.history_deals_get(date_from, date_to) — ventana temporal
      mt5.history_deals_get(position=X)         — deals de una posición
      mt5.history_deals_get(ticket=X)           — deal concreto
    Query: ?from=<epoch s>&to=<epoch s>&position=<int>&ticket=<int>
    """
    denied = check_bridge_token()
    if denied:
        return denied

    ticket = request.args.get("ticket", type=int)
    position = request.args.get("position", type=int)

    try:
        if ticket is not None:
            deals = mt5.history_deals_get(ticket=ticket)
        elif position is not None:
            deals = mt5.history_deals_get(position=position)
        else:
            date_from, date_to, err = _history_window()
            if err:
                return err
            deals = mt5.history_deals_get(date_from, date_to)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "history_deals_get falló", "detail": str(exc)}), 500

    if deals is None:
        return jsonify({"deals": [], "count": 0, "detail": str(mt5.last_error())})

    return jsonify({"deals": [_serialize_history_deal(d) for d in deals], "count": len(deals)})


@app.route("/history/position/<int:ticket>", methods=["GET"])
def get_history_position(ticket: int):
    """
    Reconstruye UNA posición cerrada desde evidencia:
      deals = history_deals_get(position=ticket)  (entry + exit deals, con
              profit/commission/swap/fee y reason de cierre)
      orders = history_orders_get(position=ticket)
    El ticket aquí es el POSITION TICKET (position_id), que NO es el order
    ticket ni un deal ticket (ver docs/EXECUTION_TRUTH.md).
    """
    denied = check_bridge_token()
    if denied:
        return denied

    try:
        deals = mt5.history_deals_get(position=ticket)
        orders = mt5.history_orders_get(position=ticket)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "history de posición falló", "detail": str(exc)}), 500

    if (deals is None or len(deals) == 0) and (orders is None or len(orders) == 0):
        return jsonify({"error": f"Posición {ticket} sin evidencia en la historia de MT5"}), 404

    return jsonify({
        "position_ticket": ticket,
        "deals":  [_serialize_history_deal(d) for d in (deals or [])],
        "orders": [_serialize_history_order(o) for o in (orders or [])],
    })


@app.route("/cancel/<int:ticket>", methods=["DELETE"])
def cancel_order(ticket: int):
    """Cancela una orden pendiente por ticket."""
    denied = check_bridge_token()
    if denied:
        return denied
    request_data = {
        "action": mt5.TRADE_ACTION_REMOVE,
        "order":  ticket,
    }
    result = mt5.order_send(request_data)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({"error": f"No se pudo cancelar la orden {ticket}", "detail": str(mt5.last_error())}), 500
    return jsonify({"success": True, "ticket": ticket})


# ── Entry Point ───────────────────────────────────────────────
if __name__ == "__main__":
    log.info("Iniciando MT5 Bridge...")

    if not init_mt5():
        log.error("No se pudo conectar a MetaTrader 5. Asegúrate de que MT5 esté abierto.")
        sys.exit(1)

    log.info(f"MT5 Bridge activo en http://localhost:{BRIDGE_PORT}")
    log.info("Endpoints disponibles:")
    log.info("  GET  /health")
    log.info("  GET  /account")
    log.info("  GET  /price/<symbol>")
    log.info("  GET  /symbol_info/<symbol>")
    log.info("  GET  /candles/<symbol>/<timeframe>/<count>")
    log.info("  GET  /positions")
    log.info("  GET  /orders")
    log.info("  GET  /history/orders?from=&to=&ticket=&position=")
    log.info("  GET  /history/deals?from=&to=&position=&ticket=")
    log.info("  GET  /history/position/<ticket>")
    log.info("  POST /order")
    log.info("  POST /modify_position")
    log.info("  DELETE /cancel/<ticket>")

    try:
        app.run(host="127.0.0.1", port=BRIDGE_PORT, debug=False)
    finally:
        mt5.shutdown()
        log.info("MT5 desconectado. Bridge cerrado.")
