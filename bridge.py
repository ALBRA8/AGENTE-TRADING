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
    log.info("  POST /order")
    log.info("  DELETE /cancel/<ticket>")

    try:
        app.run(host="127.0.0.1", port=BRIDGE_PORT, debug=False)
    finally:
        mt5.shutdown()
        log.info("MT5 desconectado. Bridge cerrado.")
