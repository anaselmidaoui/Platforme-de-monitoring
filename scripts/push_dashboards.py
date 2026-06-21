"""
Recrée les 3 dashboards Grafana avec les bonnes requêtes PromQL.
Métriques réelles exportées par les services Spring Boot :
  - http_request_duration_seconds{quantile="0.95"}  (Summary, pas histogram)
  - http_request_duration_seconds_count              (débit / erreurs)
  - process_cpu_usage                                (CPU)
  - jvm_memory_used_bytes{area="heap"}               (mémoire)
"""
import json, base64, urllib.request, sys

GRAFANA = "http://localhost:3001"
AUTH    = base64.b64encode(b"admin:admin").decode()
HEADERS = {"Authorization": f"Basic {AUTH}", "Content-Type": "application/json"}
SERVICES = ["service-a", "service-b", "service-c"]

def api_get(path):
    req = urllib.request.Request(GRAFANA + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def api_post(path, body):
    data = json.dumps(body).encode()
    req  = urllib.request.Request(GRAFANA + path, data=data, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

# ── Récupérer les UIDs des datasources ───────────────────────────────────────
sources  = api_get("/api/datasources")
prom_uid = next((d["uid"] for d in sources if d["type"] == "prometheus"), None)
loki_uid = next((d["uid"] for d in sources if d["type"] == "loki"),       None)
print(f"Prometheus UID : {prom_uid}")
print(f"Loki UID       : {loki_uid}")

if not prom_uid:
    print("[ERREUR] Datasource Prometheus introuvable dans Grafana !")
    sys.exit(1)

# ── Helpers ───────────────────────────────────────────────────────────────────

def prom_ds():
    return {"type": "prometheus", "uid": prom_uid}

def loki_ds():
    return {"type": "loki", "uid": loki_uid}

def timeseries(pid, title, expr, unit, x, y, legend="{{uri}}", color="#6366f1"):
    return {
        "id": pid, "type": "timeseries",
        "title": title,
        "gridPos": {"h": 8, "w": 12, "x": x, "y": y},
        "datasource": prom_ds(),
        "targets": [{
            "refId": "A",
            "datasource": prom_ds(),
            "expr": expr,
            "legendFormat": legend,
            "interval": "",
        }],
        "options": {
            "tooltip": {"mode": "multi", "sort": "none"},
            "legend": {"showLegend": True, "displayMode": "list", "placement": "bottom"},
        },
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "color": {"mode": "fixed", "fixedColor": color},
                "custom": {"lineWidth": 2, "fillOpacity": 12, "gradientMode": "opacity"},
            }
        }
    }

def logs_panel(pid, svc, x, y):
    return {
        "id": pid, "type": "logs",
        "title": f"Logs — {svc}",
        "gridPos": {"h": 8, "w": 12, "x": x, "y": y},
        "datasource": loki_ds(),
        "targets": [{
            "refId": "A",
            "datasource": loki_ds(),
            "expr": f'{{service_name="{svc}"}}',
        }],
        "options": {
            "showTime": True, "showLabels": False,
            "wrapLogMessage": True, "sortOrder": "Descending",
            "enableLogDetails": True,
            "dedupStrategy": "none",
        }
    }

# ── Génération du dashboard par service ──────────────────────────────────────

def make_dashboard(svc):
    s = svc  # alias court
    panels = [
        # Rangée 1
        timeseries(1,
            f"Latence P95 — {s}",
            # Summary pré-calculé : quantile="0.95" directement disponible
            f'max(http_request_duration_seconds{{application="{s}",quantile="0.95",uri!~"/actuator/.*"}}) * 1000',
            "ms", 0, 0, "P95 (ms)", "#6366f1"),

        timeseries(2,
            f"Taux erreur 5xx — {s}",
            f'sum(rate(http_request_duration_seconds_count{{application="{s}",status=~"5.."}}[2m]))',
            "reqps", 12, 0, "5xx/s", "#ef4444"),

        # Rangée 2
        timeseries(3,
            f"Requêtes/sec — {s}",
            f'sum(rate(http_request_duration_seconds_count{{application="{s}",uri!~"/actuator/.*"}}[2m]))',
            "reqps", 0, 8, "req/s", "#10b981"),

        timeseries(4,
            f"CPU — {s}",
            f'process_cpu_usage{{application="{s}"}} * 100',
            "percent", 12, 8, "CPU %", "#f59e0b"),

        # Rangée 3
        timeseries(5,
            f"Mémoire heap — {s}",
            f'sum(jvm_memory_used_bytes{{application="{s}",area="heap"}}) / 1048576',
            "decmbytes", 0, 16, "Heap MB", "#8b5cf6"),
    ]

    if loki_uid:
        panels.append(logs_panel(6, svc, 12, 16))

    return {
        "dashboard": {
            "id":    None,
            "uid":   svc.replace("-", "_"),
            "title": svc,
            "tags":  ["microservices", "chaos", "pfa"],
            "timezone": "browser",
            "refresh":  "10s",
            "time":     {"from": "now-1h", "to": "now"},
            "timepicker": {},
            "panels": panels,
            "schemaVersion": 38,
            "version": 2,
        },
        "overwrite": True,
        "folderId":  0,
        "message":   "Fixed PromQL — Summary quantile instead of histogram_quantile",
    }

# ── Push ─────────────────────────────────────────────────────────────────────

for svc in SERVICES:
    try:
        payload = make_dashboard(svc)
        result  = api_post("/api/dashboards/db", payload)
        status  = result.get("status", "?")
        url     = result.get("url", "")
        print(f"[{svc}] -> {status}  http://localhost:3001{url}")
    except Exception as e:
        print(f"[{svc}] ERREUR : {e}")

print("\nDone. Rafraîchis Grafana (F5).")
