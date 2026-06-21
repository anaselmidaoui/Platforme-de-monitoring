"""
collect_metrics.py — Collecte monitoring pour dataset ML (PFA_final_version)
Sources : Actuator Prometheus (CPU/mémoire), API Prometheus (latence/erreurs/rps),
          Loki (logs), Jaeger (traces)
Stockage : scripts/ml/data/  (append — jamais d'écrasement)
Stdlib Python uniquement.

Usage :
    python collect_metrics.py --label normal
    python collect_metrics.py --label cpu_spike --duration 120 --interval 5
"""

import argparse
import csv
import json
import signal
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ─── Configuration ────────────────────────────────────────────────────────────

SERVICES = [
    {"name": "service-a", "port": 8081},
    {"name": "service-b", "port": 8082},
    {"name": "service-c", "port": 8083},
]

PROMETHEUS_URL = "http://localhost:9090"
LOKI_URL       = "http://localhost:3100"
JAEGER_URL     = "http://localhost:16686"

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "ml" / "data"

METRICS_CSV = DATA_DIR / "metrics.csv"
LOGS_JSON   = DATA_DIR / "logs.json"
TRACES_JSON = DATA_DIR / "traces.json"
DATASET_CSV = DATA_DIR / "dataset.csv"

METRICS_HEADER = [
    "timestamp", "service", "latency_p95", "error_rate",
    "cpu_usage", "memory_mb", "req_per_second", "label",
]
DATASET_HEADER = [
    "timestamp", "service", "latency_p95", "error_rate",
    "cpu_usage", "memory_mb", "req_per_second",
    "has_errors_in_logs", "has_slow_traces", "label",
]

LOGS_INTERVAL         = 10    # secondes entre chaque collecte Loki / Jaeger
LOKI_WINDOW_SECONDS   = 90
JAEGER_WINDOW_SECONDS = 90
BUFFER_WINDOW         = 60    # fenêtre mémoire pour has_errors / has_slow_traces
SLOW_TRACE_MS         = 1000.0

# ─── État global ──────────────────────────────────────────────────────────────

_running = True

_metrics_written = 0
_logs_written    = 0
_traces_written  = 0
_dataset_written = 0

_seen_log_keys  : set = set()
_seen_trace_ids : set = set()

_log_buffer   : dict = {s["name"]: [] for s in SERVICES}
_trace_buffer : dict = {s["name"]: [] for s in SERVICES}

_loki_down_cycles   = 0
_jaeger_down_cycles = 0
_start_time: float  = 0.0

# ─── Signal Ctrl+C ────────────────────────────────────────────────────────────

def _sigint_handler(sig, frame):
    global _running
    _running = False

signal.signal(signal.SIGINT, _sigint_handler)

# ─── Utilitaires temps ────────────────────────────────────────────────────────

def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def _hms_now() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")

def _fmt_duration(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s   = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"

# ─── COLLECTE 1a — Actuator /actuator/prometheus (CPU + heap) ─────────────────

def scrape_actuator(port: int) -> dict:
    """Lit /actuator/prometheus et extrait CPU + mémoire heap."""
    url = f"http://localhost:{port}/actuator/prometheus"
    try:
        text = urllib.request.urlopen(url, timeout=3).read().decode("utf-8")
    except Exception:
        return {}

    cpu      = 0.0
    heap     = 0.0
    metrics  = {}

    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.rsplit(" ", 1)
        if len(parts) != 2:
            continue
        key_part, val_str = parts
        name = key_part.split("{")[0].strip()
        try:
            val = float(val_str)
        except ValueError:
            continue

        if name == "process_cpu_usage":
            cpu = val
        if name == "jvm_memory_used_bytes" and 'area="heap"' in key_part:
            heap += val

    if cpu   > 0: metrics["cpu_usage"]  = cpu
    if heap  > 0: metrics["memory_mb"]  = heap / 1_048_576
    return metrics

# ─── COLLECTE 1b — API Prometheus (latence / erreurs / rps) ──────────────────
# NB : les services exportent un Summary (quantiles pré-calculés), PAS un histogram.
#      → on lit directement {quantile="0.95"} au lieu de histogram_quantile().

def query_prometheus(promql: str) -> float:
    url = PROMETHEUS_URL + "/api/v1/query?query=" + urllib.parse.quote(promql)
    try:
        data   = json.loads(urllib.request.urlopen(url, timeout=5).read().decode("utf-8"))
        result = data.get("data", {}).get("result", [])
        if not result:
            return 0.0
        v = float(result[0]["value"][1])
        return 0.0 if v != v else v   # NaN → 0.0
    except Exception:
        return 0.0


def latency_p95_query(svc: str) -> str:
    # Summary quantile pré-calculé directement disponible
    return (
        f'max(http_request_duration_seconds{{'
        f'application="{svc}",quantile="0.95",uri!~"/actuator/.*"}})'
    )


def error_rate_query(svc: str) -> str:
    base  = f'http_request_duration_seconds_count{{application="{svc}"}}'
    err5  = f'http_request_duration_seconds_count{{application="{svc}",status=~"5.."}}'
    return f'sum(rate({err5}[5m])) / sum(rate({base}[5m]))'


def rps_query(svc: str) -> str:
    return (
        f'sum(rate(http_request_duration_seconds_count{{'
        f'application="{svc}",uri!~"/actuator/.*"}}[1m]))'
    )

# ─── Cycle métriques pour un service ─────────────────────────────────────────

def collect_metrics_for(svc: dict) -> dict:
    name = svc["name"]
    act  = scrape_actuator(svc["port"])
    if not act:
        print(f"  [WARN] {name} non disponible (port {svc['port']})", flush=True)

    return {
        "service":        name,
        "latency_p95":    round(query_prometheus(latency_p95_query(name)), 6),
        "error_rate":     round(query_prometheus(error_rate_query(name)),  6),
        "cpu_usage":      round(act.get("cpu_usage",  0.0), 6),
        "memory_mb":      round(act.get("memory_mb",  0.0), 6),
        "req_per_second": round(query_prometheus(rps_query(name)),         6),
    }

# ─── COLLECTE 2 — Loki → logs.json ──────────────────────────────────────────

def fetch_logs(service_name: str, start_ns: int, end_ns: int):
    query = urllib.parse.quote(f'{{service_name="{service_name}"}}')
    url   = (
        f"{LOKI_URL}/loki/api/v1/query_range"
        f"?query={query}&start={start_ns}&end={end_ns}&limit=200&direction=forward"
    )
    try:
        data = json.loads(urllib.request.urlopen(url, timeout=5).read().decode("utf-8"))
    except Exception:
        return None

    entries = []
    for stream in data.get("data", {}).get("result", []):
        for ts_ns, line in stream.get("values", []):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                parsed = {"msg": line}

            ts_str = (parsed.get("ts") or parsed.get("timestamp") or
                      parsed.get("@timestamp") or "")
            if not ts_str:
                dt     = datetime.fromtimestamp(int(ts_ns) / 1_000_000_000, tz=timezone.utc)
                ts_str = dt.strftime(f"%Y-%m-%dT%H:%M:%S.{dt.microsecond // 1000:03d}Z")

            entries.append({
                "timestamp": ts_str,
                "service":   parsed.get("service",  service_name),
                "level":     parsed.get("level",    ""),
                "msg":       parsed.get("msg",      ""),
                "traceId":   parsed.get("traceId",  ""),
                "spanId":    parsed.get("spanId",   ""),
                "logger":    parsed.get("logger",   ""),
            })
    return entries


def collect_logs():
    global _loki_down_cycles, _logs_written

    end_ns   = time.time_ns()
    start_ns = end_ns - LOKI_WINDOW_SECONDS * 1_000_000_000
    wall_now = time.time()
    new_total = 0
    loki_ok   = False

    for svc in SERVICES:
        name    = svc["name"]
        entries = fetch_logs(name, start_ns, end_ns)
        if entries is None:
            continue
        loki_ok = True
        for e in entries:
            key = (e["timestamp"], e["service"], e["msg"], e.get("traceId", ""))
            if key in _seen_log_keys:
                continue
            _seen_log_keys.add(key)
            with LOGS_JSON.open("a", encoding="utf-8") as f:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
            _logs_written += 1
            new_total     += 1
            _log_buffer[name].append((wall_now, e["level"].upper() in ("ERROR", "WARN")))

    if loki_ok:
        _loki_down_cycles = 0
    else:
        _loki_down_cycles += 1
        print(f"[{_hms_now()}] [WARN] Loki injoignable (cycle #{_loki_down_cycles})", flush=True)

    for name in _log_buffer:
        _log_buffer[name] = [(t, v) for t, v in _log_buffer[name] if wall_now - t <= BUFFER_WINDOW]

    print(f"[{_hms_now()}] logs.json   : +{new_total} nouvelles (total: {_count_jsonl(LOGS_JSON)})", flush=True)

# ─── COLLECTE 3 — Jaeger → traces.json ───────────────────────────────────────

def fetch_traces(service_name: str, start_us: int, end_us: int):
    url = (
        f"{JAEGER_URL}/api/traces"
        f"?service={service_name}&start={start_us}&end={end_us}&limit=50"
    )
    try:
        data = json.loads(urllib.request.urlopen(url, timeout=5).read().decode("utf-8"))
    except Exception:
        return None

    entries = []
    for trace in data.get("data", []):
        trace_id = trace.get("traceID", "")
        spans    = trace.get("spans", [])
        if not spans:
            continue
        span_id_set = {s.get("spanID") for s in spans}
        root = spans[0]
        for span in spans:
            is_child = any(
                r.get("refType") == "CHILD_OF" and r.get("spanID") in span_id_set
                for r in span.get("references", [])
            )
            if not is_child:
                root = span
                break
        dur_ms = round(root.get("duration", 0) / 1000.0, 2)
        tags   = {t.get("key"): t.get("value") for t in root.get("tags", [])}
        entries.append({
            "traceId":     trace_id,
            "service":     service_name,
            "operation":   root.get("operationName", ""),
            "duration_ms": dur_ms,
            "status":      "error" if str(tags.get("error", "false")).lower() in ("true","1") else "ok",
            "spans_count": len(spans),
        })
    return entries


def collect_traces():
    global _jaeger_down_cycles, _traces_written

    now_us   = int(time.time() * 1_000_000)
    start_us = now_us - JAEGER_WINDOW_SECONDS * 1_000_000
    wall_now = time.time()
    new_total = 0
    jaeger_ok = False

    for svc in SERVICES:
        name    = svc["name"]
        entries = fetch_traces(name, start_us, now_us)
        if entries is None:
            continue
        jaeger_ok = True
        for e in entries:
            if e["traceId"] in _seen_trace_ids:
                continue
            _seen_trace_ids.add(e["traceId"])
            with TRACES_JSON.open("a", encoding="utf-8") as f:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
            _traces_written += 1
            new_total       += 1
            _trace_buffer[name].append((wall_now, e["duration_ms"]))

    for name in _trace_buffer:
        _trace_buffer[name] = [(t, d) for t, d in _trace_buffer[name] if wall_now - t <= BUFFER_WINDOW]

    if not jaeger_ok:
        _jaeger_down_cycles += 1
        if _jaeger_down_cycles == 1:
            print(f"[{_hms_now()}] [WARN] Jaeger injoignable", flush=True)
    else:
        _jaeger_down_cycles = 0

    print(f"[{_hms_now()}] traces.json : +{new_total} entrées (total: {_count_jsonl(TRACES_JSON)})", flush=True)

# ─── Colonnes dérivées dataset.csv ────────────────────────────────────────────

def _has_errors_in_logs(service_name: str) -> int:
    t0 = time.time()
    return int(any(v for t, v in _log_buffer[service_name] if t0 - t <= BUFFER_WINDOW))


def _has_slow_traces(service_name: str) -> int:
    t0 = time.time()
    return int(any(d > SLOW_TRACE_MS for t, d in _trace_buffer[service_name] if t0 - t <= BUFFER_WINDOW))

# ─── CSV helpers ──────────────────────────────────────────────────────────────

def _append_csv(path: Path, header: list, row: dict):
    write_header = not path.exists() or path.stat().st_size == 0
    with path.open("a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header)
        if write_header:
            w.writeheader()
        w.writerow({k: row.get(k, 0.0) for k in header})


def _count_csv(path: Path) -> int:
    if not path.exists(): return 0
    try:
        with path.open("r", encoding="utf-8") as f:
            return max(0, sum(1 for _ in f) - 1)
    except Exception:
        return 0


def _count_jsonl(path: Path) -> int:
    if not path.exists(): return 0
    try:
        with path.open("r", encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except Exception:
        return 0

# ─── Cycle principal métriques + dataset ──────────────────────────────────────

def collect_metrics_cycle(label: str):
    global _metrics_written, _dataset_written

    ts    = _iso_now()
    rows  = []

    for svc in SERVICES:
        m = collect_metrics_for(svc)
        m["timestamp"] = ts
        m["label"]     = label
        rows.append(m)
        _append_csv(METRICS_CSV, METRICS_HEADER, m)
        _metrics_written += 1

        dr = dict(m)
        dr["has_errors_in_logs"] = _has_errors_in_logs(svc["name"])
        dr["has_slow_traces"]    = _has_slow_traces(svc["name"])
        _append_csv(DATASET_CSV, DATASET_HEADER, dr)
        _dataset_written += 1

    ts_short = _hms_now()
    for m in rows:
        print(
            f"[{ts_short}] {m['service']:<12}"
            f"  cpu={m['cpu_usage']*100:.1f}%"
            f"  mem={m['memory_mb']:.0f}MB"
            f"  lat={m['latency_p95']*1000:.1f}ms"
            f"  err={m['error_rate']:.3f}"
            f"  rps={m['req_per_second']:.2f}",
            flush=True,
        )

    print(
        f"  -> metrics.csv : +{len(rows)} (total: {_count_csv(METRICS_CSV)})"
        f"  |  dataset.csv : +{len(rows)} (total: {_count_csv(DATASET_CSV)})",
        flush=True,
    )
    print(flush=True)

# ─── Résumé final ─────────────────────────────────────────────────────────────

def _print_summary(label: str):
    elapsed = time.time() - _start_time
    sep = "=" * 52
    print(f"\n{sep}", flush=True)
    print(f"  Collecte terminée  —  label : {label}", flush=True)
    print(sep, flush=True)
    print(f"  Durée       : {_fmt_duration(elapsed)}", flush=True)
    print(f"  Métriques   : {_metrics_written} lignes", flush=True)
    print(f"  Logs        : {_logs_written} entrées", flush=True)
    print(f"  Traces      : {_traces_written} entrées", flush=True)
    print(f"  Dataset     : {_dataset_written} lignes", flush=True)
    print("  Fichiers :", flush=True)
    for p in [METRICS_CSV, LOGS_JSON, TRACES_JSON, DATASET_CSV]:
        size = f"{p.stat().st_size/1024:.1f} KB" if p.exists() else "—"
        print(f"    {p.name:<20} {size}", flush=True)
    print(sep, flush=True)

# ─── Point d'entrée ───────────────────────────────────────────────────────────

VALID_LABELS = ["normal", "cpu_spike", "latency_spike", "error_5xx", "memory_leak"]

def main():
    global _running, _start_time

    parser = argparse.ArgumentParser(description="Collecte monitoring pour dataset ML")
    parser.add_argument("--label",    required=True, choices=VALID_LABELS)
    parser.add_argument("--duration", type=int, default=None,
                        help="Durée en secondes (défaut: infini)")
    parser.add_argument("--interval", type=int, default=5,
                        help="Intervalle métriques en secondes (défaut: 5)")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _start_time = time.time()

    sep = "=" * 52
    print(sep, flush=True)
    print("  collect_metrics.py — PFA_final_version", flush=True)
    print(sep, flush=True)
    print(f"  Label      : {args.label}", flush=True)
    print(f"  Services   : {', '.join(s['name'] for s in SERVICES)}", flush=True)
    print(f"  Intervalle : métriques {args.interval}s / logs+traces {LOGS_INTERVAL}s", flush=True)
    print(f"  Stockage   : {DATA_DIR}", flush=True)
    dur_str = f"{args.duration}s" if args.duration else "infini (Ctrl+C pour arrêter)"
    print(f"  Durée      : {dur_str}", flush=True)
    print(sep, flush=True)
    print(flush=True)

    last_logs_time = 0.0

    try:
        while _running:
            loop_start = time.time()

            if args.duration and (loop_start - _start_time) >= args.duration:
                break

            if loop_start - last_logs_time >= LOGS_INTERVAL:
                collect_logs()
                collect_traces()
                last_logs_time = time.time()

            collect_metrics_cycle(args.label)

            elapsed_cycle = time.time() - loop_start
            sleep_needed  = max(0.0, args.interval - elapsed_cycle)
            deadline      = time.time() + sleep_needed
            while _running and time.time() < deadline:
                if args.duration and (time.time() - _start_time) >= args.duration:
                    _running = False
                    break
                time.sleep(0.2)

    except KeyboardInterrupt:
        pass
    finally:
        collect_logs()
        collect_traces()
        _print_summary(args.label)


if __name__ == "__main__":
    main()
