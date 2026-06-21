"""
Monitoring Platform Backend — FastAPI
REST API + SSE streaming pour le frontend React de supervision.
"""
import csv
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import AsyncGenerator, List, Optional

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Query
try:
    from groq import Groq as GroqClient
    _GROQ_AVAILABLE = True
except ImportError:
    _GROQ_AVAILABLE = False
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="Monitoring Platform API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PROMETHEUS_URL = os.getenv("PROMETHEUS_URL", "http://localhost:9090")
GROQ_API_KEY   = os.getenv("GROQ_API_KEY",   "")
LOKI_URL       = os.getenv("LOKI_URL",       "http://localhost:3100")
GRAFANA_URL    = os.getenv("GRAFANA_URL",    "http://localhost:3001")
SCRIPTS_DIR    = Path(__file__).parent.parent.parent / "scripts"


# ─── Pydantic models ──────────────────────────────────────────────────────────

class ScanRequest(BaseModel):
    project_path: str

class InstrumentRequest(BaseModel):
    project_path: str

class ScaleRequest(BaseModel):
    compose_path: str
    service: str
    replicas: int


# ─── Project scanning ─────────────────────────────────────────────────────────

_NS = {"m": "http://maven.apache.org/POM/4.0.0"}


def _parse_pom(pom_path: Path) -> dict:
    try:
        root = ET.parse(pom_path).getroot()
        deps = [d.findtext("m:artifactId", "", _NS)
                for d in root.findall(".//m:dependency", _NS)]
        return {
            "artifact_id": root.findtext("m:artifactId", pom_path.parent.name, _NS),
            "group_id":    root.findtext("m:groupId",    "", _NS),
            "has_actuator":  "spring-boot-starter-actuator"   in deps,
            "has_prometheus":"micrometer-registry-prometheus"  in deps,
        }
    except Exception:
        return {"artifact_id": pom_path.parent.name, "group_id": "",
                "has_actuator": False, "has_prometheus": False}


def _main_class(svc_dir: Path) -> str:
    java_root = svc_dir / "src" / "main" / "java"
    if java_root.exists():
        for f in java_root.rglob("*Application.java"):
            pkg = ".".join(f.relative_to(java_root).parts[:-1])
            return f"{pkg}.{f.stem}" if pkg else f.stem
    return ""


def _container_port(svc_dir: Path) -> int:
    props = svc_dir / "src" / "main" / "resources" / "application.properties"
    if props.exists():
        for line in props.read_text(errors="ignore").splitlines():
            m = re.match(r"server\.port\s*=\s*(\d+)", line.strip())
            if m:
                return int(m.group(1))
    return 8080


def _external_port(service_name: str, compose: Optional[Path]) -> Optional[int]:
    if not compose or not compose.exists():
        return None
    try:
        data = yaml.safe_load(compose.read_text(encoding="utf-8"))
        svc  = data.get("services", {}).get(service_name, {})
        for p in svc.get("ports", []):
            m = re.match(r"(\d+):(\d+)", str(p))
            if m:
                return int(m.group(1))
    except Exception:
        pass
    return None


def scan_project(project_path: str) -> List[dict]:
    root = Path(project_path)
    if not root.exists():
        raise ValueError(f"Chemin introuvable : {project_path}")

    compose = next(
        (root / n for n in ("docker-compose.yml", "docker-compose.yaml")
         if (root / n).exists()),
        None,
    )

    services = []
    for pom_path in sorted(root.rglob("pom.xml")):
        rel = pom_path.relative_to(root)
        if len(rel.parts) > 2:
            continue
        svc_dir = pom_path.parent
        if not (svc_dir / "src" / "main" / "java").exists():
            continue

        pom  = _parse_pom(pom_path)
        main = _main_class(svc_dir)
        pkg  = ".".join(main.split(".")[:-1]) if "." in main else main
        cp   = _container_port(svc_dir)
        ep   = _external_port(svc_dir.name, compose)

        services.append({
            "name":          svc_dir.name,
            "artifact_id":   pom["artifact_id"],
            "group_id":      pom["group_id"],
            "main_package":  pkg,
            "main_class":    main,
            "container_port": cp,
            "external_port":  ep or cp,
            "has_actuator":   pom["has_actuator"],
            "has_prometheus": pom["has_prometheus"],
            "path":           str(svc_dir),
        })
    return services


# ─── SSE instrumentation ──────────────────────────────────────────────────────

def _sse(type_: str, message: str) -> str:
    return f"data: {json.dumps({'type': type_, 'message': message})}\n\n"


async def _stream_instrument(project_path: str) -> AsyncGenerator[str, None]:
    import asyncio

    script = SCRIPTS_DIR / "setup_monitoring.py"
    if not script.exists():
        yield _sse("error", f"Script introuvable : {script}")
        yield _sse("done", "")
        return

    yield _sse("info", f"Racine du projet : {project_path}")
    yield _sse("info", "Lancement de l'instrumentation…")

    q: queue.Queue = queue.Queue()

    def _worker():
        try:
            proc = subprocess.Popen(
                [sys.executable, "-X", "utf8", str(script)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=project_path,
                encoding="utf-8",
                errors="replace",
            )
            proc.stdin.write("O\n")
            proc.stdin.flush()
            proc.stdin.close()
            for line in proc.stdout:
                q.put(("log", line.rstrip()))
            proc.wait()
            q.put(("done", proc.returncode))
        except Exception as exc:
            q.put(("error", str(exc)))

    threading.Thread(target=_worker, daemon=True).start()

    loop = asyncio.get_event_loop()
    while True:
        try:
            kind, data = await loop.run_in_executor(
                None, lambda: q.get(timeout=180)
            )
        except queue.Empty:
            yield _sse("ping", "")
            continue

        if kind == "log":
            if data:
                yield _sse("log", data)
        elif kind == "done":
            if data == 0:
                yield _sse("success", "Instrumentation et démarrage du monitoring terminés !")
            else:
                yield _sse("error", f"Script terminé avec le code {data}")
            break
        else:
            yield _sse("error", str(data))
            break

    yield _sse("done", "")


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "prometheus": PROMETHEUS_URL,
            "loki": LOKI_URL, "grafana": GRAFANA_URL}


@app.post("/api/scan")
async def scan(req: ScanRequest):
    try:
        services = scan_project(req.project_path)
        return {"services": services, "count": len(services)}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/instrument")
async def instrument(req: InstrumentRequest):
    if not Path(req.project_path).exists():
        raise HTTPException(400, f"Chemin introuvable : {req.project_path}")
    return StreamingResponse(
        _stream_instrument(req.project_path),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/docker/scale")
async def scale(req: ScaleRequest):
    if not (1 <= req.replicas <= 10):
        raise HTTPException(400, "replicas doit être entre 1 et 10")
    path = Path(req.compose_path)
    if not path.exists():
        raise HTTPException(400, f"Chemin introuvable : {req.compose_path}")
    try:
        r = subprocess.run(
            ["docker", "compose", "up", "-d",
             "--scale", f"{req.service}={req.replicas}", "--no-recreate"],
            cwd=str(path), capture_output=True, text=True, timeout=120,
        )
        return {"success": r.returncode == 0, "stdout": r.stdout, "stderr": r.stderr}
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Timeout Docker")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/docker/containers")
async def containers():
    try:
        r = subprocess.run(
            ["docker", "ps", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=10,
        )
        items = []
        for line in r.stdout.strip().splitlines():
            if line.strip():
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return {"containers": items}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/metrics/range")
async def metrics_range(
    query:         str = Query(...),
    range_minutes: int = Query(60),
    step:          str = Query("30s"),
):
    now = time.time()
    params = {"query": query, "start": now - range_minutes * 60, "end": now, "step": step}
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(f"{PROMETHEUS_URL}/api/v1/query_range",
                                    params=params, timeout=10)
            return resp.json()
        except httpx.ConnectError:
            raise HTTPException(503, "Prometheus inaccessible (vérifiez que la stack monitoring est démarrée)")


# ─── Collect process state ────────────────────────────────────────────────────

_collect_proc:   Optional[subprocess.Popen] = None
_collect_output: queue.Queue                = queue.Queue()
_collect_lock    = threading.Lock()

COLLECT_SCRIPT = SCRIPTS_DIR / "collect_metrics.py"
DATA_DIR       = SCRIPTS_DIR / "ml" / "data"
VALID_LABELS   = ["normal", "cpu_spike", "latency_spike", "error_5xx", "memory_leak"]


class CollectRequest(BaseModel):
    label:    str
    duration: Optional[int] = None
    interval: int           = 5


def _reader_thread(proc: subprocess.Popen):
    """Lit stdout du subprocess et met les lignes dans la queue globale."""
    try:
        for line in proc.stdout:
            _collect_output.put(("log", line.rstrip()))
        proc.wait()
        _collect_output.put(("done", proc.returncode))
    except Exception as e:
        _collect_output.put(("error", str(e)))


def _file_stat(path: Path) -> dict:
    if not path.exists():
        return {"rows": 0, "size_kb": 0}
    size_kb = round(path.stat().st_size / 1024, 1)
    try:
        with path.open("r", encoding="utf-8") as f:
            lines = sum(1 for l in f if l.strip())
        # CSV : soustraire l'en-tête
        rows = max(0, lines - 1) if path.suffix == ".csv" else lines
    except Exception:
        rows = 0
    return {"rows": rows, "size_kb": size_kb}


@app.post("/api/collect/start")
async def collect_start(req: CollectRequest):
    global _collect_proc

    if req.label not in VALID_LABELS:
        raise HTTPException(400, f"Label invalide. Valeurs : {VALID_LABELS}")

    with _collect_lock:
        if _collect_proc and _collect_proc.poll() is None:
            raise HTTPException(409, "Une collecte est déjà en cours.")

        if not COLLECT_SCRIPT.exists():
            raise HTTPException(404, f"Script introuvable : {COLLECT_SCRIPT}")

        # Vider la queue avant de démarrer
        while not _collect_output.empty():
            try:
                _collect_output.get_nowait()
            except queue.Empty:
                break

        DATA_DIR.mkdir(parents=True, exist_ok=True)

        cmd = [sys.executable, "-X", "utf8", str(COLLECT_SCRIPT),
               "--label", req.label, "--interval", str(req.interval)]
        if req.duration:
            cmd += ["--duration", str(req.duration)]

        _collect_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
        )
        threading.Thread(target=_reader_thread, args=(_collect_proc,), daemon=True).start()

    return {"status": "started", "pid": _collect_proc.pid, "label": req.label}


@app.post("/api/collect/stop")
async def collect_stop():
    global _collect_proc
    with _collect_lock:
        if not _collect_proc or _collect_proc.poll() is not None:
            return {"status": "not_running"}
        try:
            _collect_proc.terminate()
            _collect_proc.wait(timeout=5)
        except Exception:
            _collect_proc.kill()
    return {"status": "stopped"}


@app.delete("/api/collect/data")
async def collect_delete_data():
    """Supprime tous les fichiers de données ML."""
    deleted, errors = [], []
    for fname in ["metrics.csv", "dataset.csv", "logs.json", "traces.json"]:
        p = DATA_DIR / fname
        try:
            if p.exists():
                p.unlink()
                deleted.append(fname)
        except Exception as e:
            errors.append(f"{fname}: {e}")
    return {"deleted": deleted, "errors": errors}


@app.get("/api/collect/status")
async def collect_status():
    global _collect_proc
    running = bool(_collect_proc and _collect_proc.poll() is None)
    files   = {
        "metrics_csv": _file_stat(DATA_DIR / "metrics.csv"),
        "dataset_csv": _file_stat(DATA_DIR / "dataset.csv"),
        "logs_json":   _file_stat(DATA_DIR / "logs.json"),
        "traces_json": _file_stat(DATA_DIR / "traces.json"),
    }
    return {"running": running, "files": files}


async def _stream_collect() -> AsyncGenerator[str, None]:
    loop = __import__("asyncio").get_event_loop()
    while True:
        try:
            kind, data = await loop.run_in_executor(
                None, lambda: _collect_output.get(timeout=30)
            )
        except queue.Empty:
            yield f"data: {json.dumps({'type': 'ping', 'message': ''})}\n\n"
            continue

        if kind in ("log", "error"):
            if data:
                yield f"data: {json.dumps({'type': kind, 'message': data})}\n\n"
        elif kind == "done":
            yield f"data: {json.dumps({'type': 'done', 'message': f'Terminé (code {data})'})}\n\n"
            break


@app.get("/api/collect/stream")
async def collect_stream():
    return StreamingResponse(
        _stream_collect(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/metrics/loki")
async def metrics_loki(
    query:         str = Query(...),
    range_minutes: int = Query(15),
    limit:         int = Query(100),
):
    now_ns = int(time.time() * 1_000_000_000)
    params = {
        "query":     query,
        "start":     now_ns - range_minutes * 60 * 1_000_000_000,
        "end":       now_ns,
        "limit":     limit,
        "direction": "backward",
    }
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(f"{LOKI_URL}/loki/api/v1/query_range",
                                    params=params, timeout=10)
            return resp.json()
        except httpx.ConnectError:
            raise HTTPException(503, "Loki inaccessible")


# ─── ML / Random Forest ───────────────────────────────────────────────────────

try:
    import pickle
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import accuracy_score, classification_report
    from sklearn.preprocessing import StandardScaler
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False

MODEL_FILE   = SCRIPTS_DIR / "ml" / "rf_model.pkl"
FEATURE_COLS = [
    "latency_p95", "error_rate", "cpu_usage",
    "memory_mb", "req_per_second",
    "has_errors_in_logs", "has_slow_traces",
]
LABEL_COL     = "label"
SERVICES_LIST = ["service-a", "service-b", "service-c"]

_rf: dict = {
    "model": None, "scaler": None,
    "trained_at": None, "accuracy": 0.0,
    "n_samples": 0, "labels": [],
    "feature_importance": {}, "report": {},
}
_pred_history: list = []


def _rf_load() -> bool:
    global _rf
    if MODEL_FILE.exists():
        try:
            with open(MODEL_FILE, "rb") as f:
                _rf = pickle.load(f)
            return True
        except Exception:
            pass
    return False


def _rf_save():
    MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(MODEL_FILE, "wb") as f:
        pickle.dump(_rf, f)


@app.get("/api/model/status")
async def model_status():
    if not ML_AVAILABLE:
        return {"available": False,
                "message": "pip install scikit-learn pandas numpy"}
    if _rf["model"] is None:
        _rf_load()
    return {
        "available": True,
        "trained":   _rf["model"] is not None,
        "trained_at":         _rf.get("trained_at"),
        "accuracy":           _rf.get("accuracy", 0.0),
        "n_samples":          _rf.get("n_samples", 0),
        "labels":             _rf.get("labels", []),
        "feature_importance": _rf.get("feature_importance", {}),
        "report":             _rf.get("report", {}),
        "dataset":            _file_stat(DATA_DIR / "dataset.csv"),
    }


async def _train_sse() -> AsyncGenerator[str, None]:
    import asyncio
    if not ML_AVAILABLE:
        yield _sse("error", "scikit-learn non installe. Lancez : pip install scikit-learn pandas numpy")
        yield _sse("done", ""); return

    q: queue.Queue = queue.Queue()

    def _worker():
        try:
            ds = DATA_DIR / "dataset.csv"
            if not ds.exists():
                q.put(("error", "dataset.csv introuvable — lancez une collecte d'abord")); return

            q.put(("log", "Chargement du dataset..."))
            df = pd.read_csv(ds)
            missing = [c for c in FEATURE_COLS + [LABEL_COL] if c not in df.columns]
            if missing:
                q.put(("error", f"Colonnes manquantes : {missing}")); return

            df = df.dropna(subset=FEATURE_COLS + [LABEL_COL])
            n  = len(df)
            q.put(("log", f"{n} echantillons charges"))
            if n < 20:
                q.put(("error", f"Dataset trop petit ({n} lignes). Collectez plus de donnees.")); return

            counts = df[LABEL_COL].value_counts().to_dict()
            q.put(("log", "Distribution : " + " | ".join(f"{k}={v}" for k, v in counts.items())))

            X = np.nan_to_num(df[FEATURE_COLS].values.astype(float), nan=0.0)
            y = df[LABEL_COL].values

            unique_labels = np.unique(y)
            stratify = y if n >= len(unique_labels) * 5 else None
            X_tr, X_te, y_tr, y_te = train_test_split(
                X, y, test_size=0.2, random_state=42, stratify=stratify
            )
            q.put(("log", f"Split 80/20 : {len(X_tr)} train / {len(X_te)} test"))

            sc      = StandardScaler()
            X_tr_s  = sc.fit_transform(X_tr)
            X_te_s  = sc.transform(X_te)

            q.put(("log", "Entrainement Random Forest (100 arbres, class_weight=balanced)..."))
            clf = RandomForestClassifier(
                n_estimators=100, max_depth=None,
                random_state=42, n_jobs=-1, class_weight="balanced",
            )
            clf.fit(X_tr_s, y_tr)

            y_pred = clf.predict(X_te_s)
            acc    = accuracy_score(y_te, y_pred)
            report = classification_report(y_te, y_pred, output_dict=True, zero_division=0)
            fi     = {FEATURE_COLS[i]: round(float(v), 4)
                      for i, v in enumerate(clf.feature_importances_)}

            q.put(("log", f"Accuracy : {acc*100:.1f}%"))
            q.put(("log", "Feature importance : " + " | ".join(
                f"{k}={v:.3f}" for k, v in sorted(fi.items(), key=lambda x: -x[1])
            )))

            _rf["model"]              = clf
            _rf["scaler"]             = sc
            _rf["trained_at"]         = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            _rf["accuracy"]           = round(float(acc), 4)
            _rf["n_samples"]          = n
            _rf["labels"]             = sorted(clf.classes_.tolist())
            _rf["feature_importance"] = fi
            _rf["report"]             = {
                k: {kk: round(float(vv), 3) if isinstance(vv, float) else vv
                    for kk, vv in v.items()}
                for k, v in report.items() if isinstance(v, dict)
            }
            _rf_save()
            q.put(("success", f"Modele entraine avec succes ! Accuracy : {acc*100:.1f}% sur {len(X_te)} echantillons"))
        except Exception as exc:
            q.put(("error", str(exc)))

    threading.Thread(target=_worker, daemon=True).start()
    loop = asyncio.get_event_loop()
    while True:
        try:
            kind, data = await loop.run_in_executor(None, lambda: q.get(timeout=120))
        except queue.Empty:
            yield _sse("ping", ""); continue
        yield _sse(kind, data)
        if kind in ("error", "success"):
            break
    yield _sse("done", "")


@app.post("/api/model/train")
async def model_train():
    return StreamingResponse(
        _train_sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _prom_scalar(client: httpx.AsyncClient, expr: str) -> float:
    try:
        r = await client.get(f"{PROMETHEUS_URL}/api/v1/query",
                             params={"query": expr}, timeout=5)
        result = r.json().get("data", {}).get("result", [])
        if not result:
            return 0.0
        v = float(result[0]["value"][1])
        return 0.0 if v != v else v
    except Exception:
        return 0.0


@app.post("/api/model/predict/current")
async def model_predict_current():
    if not ML_AVAILABLE:
        raise HTTPException(503, "scikit-learn non installe")
    if _rf["model"] is None and not _rf_load():
        raise HTTPException(400, "Modele non entraine")

    ts      = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    results = []

    async with httpx.AsyncClient() as client:
        for svc in SERVICES_LIST:
            lat = await _prom_scalar(client,
                f'max(http_request_duration_seconds{{application="{svc}",quantile="0.95",uri!~"/actuator/.*"}})')
            total = await _prom_scalar(client,
                f'sum(rate(http_request_duration_seconds_count{{application="{svc}"}}[2m]))')
            err5  = await _prom_scalar(client,
                f'sum(rate(http_request_duration_seconds_count{{application="{svc}",status=~"5.."}}[2m]))')
            err   = (err5 / total) if total > 0 else 0.0
            cpu   = await _prom_scalar(client,
                f'process_cpu_usage{{application="{svc}"}}')
            mem   = await _prom_scalar(client,
                f'sum(jvm_memory_used_bytes{{application="{svc}",area="heap"}}) / 1048576')
            rps   = await _prom_scalar(client,
                f'sum(rate(http_request_duration_seconds_count{{application="{svc}",uri!~"/actuator/.*"}}[2m]))')

            row   = np.nan_to_num(np.array([[lat, err, cpu, mem, rps, 0.0, 0.0]]), nan=0.0)
            row_s = _rf["scaler"].transform(row)
            pred  = _rf["model"].predict(row_s)[0]
            proba = _rf["model"].predict_proba(row_s)[0]
            classes = list(_rf["model"].classes_)
            conf  = float(proba[classes.index(pred)])

            entry = {
                "service":       svc,
                "prediction":    pred,
                "is_anomaly":    pred != "normal",
                "confidence":    round(conf, 3),
                "probabilities": {c: round(float(p), 3) for c, p in zip(classes, proba)},
                "metrics": {
                    "latency_ms":  round(lat * 1000, 1),
                    "error_pct":   round(err * 100, 2),
                    "cpu_pct":     round(cpu * 100, 1),
                    "memory_mb":   round(mem, 0),
                    "rps":         round(rps, 2),
                },
                "timestamp": ts,
            }
            results.append(entry)
            _pred_history.append(entry)

    if len(_pred_history) > 300:
        del _pred_history[:-300]

    return {"predictions": results, "timestamp": ts}


@app.get("/api/model/history")
async def model_history(limit: int = Query(60)):
    return {"history": list(reversed(_pred_history[-limit:]))}


# ─── Suggestions IA (Groq) ────────────────────────────────────────────────────

_ANOMALY_DESC = {
    "cpu_spike":     "pic de charge CPU (saturation processeur)",
    "latency_spike": "latence élevée (ralentissement des réponses HTTP)",
    "error_5xx":     "erreurs HTTP 5xx (défaillances applicatives)",
    "memory_leak":   "fuite mémoire (heap Java en croissance continue)",
}


class SuggestionRequest(BaseModel):
    predictions: list   # liste des dicts retournés par /api/model/predict/current


@app.post("/api/suggestions/generate")
async def generate_suggestion(req: SuggestionRequest):
    if not _GROQ_AVAILABLE:
        raise HTTPException(503, "Package 'groq' non installé — pip install groq")
    if not GROQ_API_KEY:
        raise HTTPException(400, "Variable d'environnement GROQ_API_KEY non configurée")

    anomalies = [p for p in req.predictions if p.get("is_anomaly")]
    if not anomalies:
        return {"suggestion": None, "anomalies": []}

    # Construire le contexte des anomalies
    lines = []
    for p in anomalies:
        svc  = p.get("service", "?")
        lbl  = p.get("prediction", "?")
        m    = p.get("metrics", {})
        desc = _ANOMALY_DESC.get(lbl, lbl)
        details = (
            f"CPU={m.get('cpu_pct','?')}%"
            f", Latence P95={m.get('latency_ms','?')}ms"
            f", Erreurs={m.get('error_pct','?')}%"
            f", Mémoire={m.get('memory_mb','?')}MB"
            f", RPS={m.get('rps','?')}"
        )
        lines.append(f"- **{svc}** : {desc} ({details})")

    context = "\n".join(lines)

    prompt = f"""Tu es un expert SRE spécialisé en microservices Spring Boot 3 avec Prometheus, Loki et Docker.

Le modèle Random Forest a détecté les anomalies suivantes :
{context}

Donne une réponse structurée en 3 sections concises :

**🔍 Diagnostic** : cause probable de chaque anomalie (1-2 phrases)
**⚡ Actions immédiates** : exactement 3 actions à faire maintenant
**🛡️ Prévention** : 2 mesures à long terme

Réponds en français, sois direct et actionnable, maximum 220 mots."""

    try:
        client = GroqClient(api_key=GROQ_API_KEY)
        resp   = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=650,
            temperature=0.25,
        )
        suggestion = resp.choices[0].message.content.strip()
    except Exception as exc:
        raise HTTPException(500, f"Groq API error: {exc}")

    return {
        "suggestion": suggestion,
        "anomalies":  [f"{p['service']}:{p['prediction']}" for p in anomalies],
        "model":      "llama-3.1-8b-instant",
    }


@app.get("/api/suggestions/status")
async def suggestions_status():
    return {
        "groq_available": _GROQ_AVAILABLE,
        "api_key_set":    bool(GROQ_API_KEY),
    }


# ─── Chaos control ────────────────────────────────────────────────────────────

SERVICE_CHAOS = {
    "service-a": os.getenv("SERVICE_A_URL", "http://localhost:8081"),
    "service-b": os.getenv("SERVICE_B_URL", "http://localhost:8082"),
    "service-c": os.getenv("SERVICE_C_URL", "http://localhost:8083"),
}

CHAOS_PROFILES: dict = {
    "normal":        {"cpu": False, "memory": False, "error": False, "latency": 0},
    "cpu_spike":     {"cpu": True,  "memory": False, "error": False, "latency": 0},
    "latency_spike": {"cpu": False, "memory": False, "error": False, "latency": 3000},
    "error_5xx":     {"cpu": False, "memory": False, "error": True,  "latency": 0},
    "memory_leak":   {"cpu": False, "memory": True,  "error": False, "latency": 0},
}


class ChaosApplyRequest(BaseModel):
    label: str
    services: Optional[List[str]] = None   # None = tous les services


async def _apply_profile_to_service(client: httpx.AsyncClient, base_url: str, profile: dict) -> list:
    errors: list = []
    try:
        for path, params in [
            ("/api/stress/cpu",     {"active": "true" if profile["cpu"]    else "false"}),
            ("/api/stress/memory",  {"active": "true" if profile["memory"] else "false"}),
            ("/api/stress/latency", {"delay":  profile["latency"]}),
            ("/api/stress/error",   {"active": "true" if profile["error"]   else "false"}),
        ]:
            r = await client.post(f"{base_url}{path}", params=params, timeout=4)
            if not r.is_success:
                errors.append(f"{path.split('/')[-1]}:{r.status_code}")
    except httpx.ConnectError:
        errors.append("inaccessible")
    except Exception as exc:
        errors.append(str(exc))
    return errors


@app.post("/api/chaos/apply")
async def chaos_apply(req: ChaosApplyRequest):
    if req.label not in CHAOS_PROFILES:
        raise HTTPException(400, f"Label inconnu : {req.label}")

    profile  = CHAOS_PROFILES[req.label]
    normal   = CHAOS_PROFILES["normal"]
    targets  = set(req.services) if req.services else set(SERVICE_CHAOS.keys())
    results  = {}

    async with httpx.AsyncClient() as client:
        for svc_name, base_url in SERVICE_CHAOS.items():
            # Services non ciblés → reset vers normal
            p      = profile if svc_name in targets else normal
            errors = await _apply_profile_to_service(client, base_url, p)
            results[svc_name] = {"ok": len(errors) == 0, "errors": errors, "profile": "target" if svc_name in targets else "normal"}

    return {
        "label":   req.label,
        "profile": profile,
        "results": results,
        "success": all(v["ok"] for v in results.values()),
    }


class ChaosMultiRequest(BaseModel):
    assignments: dict   # {"service-a": "cpu_spike", "service-b": "normal", ...}


@app.post("/api/chaos/apply-multi")
async def chaos_apply_multi(req: ChaosMultiRequest):
    """Applique un profil chaos DIFFÉRENT par service en un seul appel."""
    results = {}
    async with httpx.AsyncClient() as client:
        for svc_name, base_url in SERVICE_CHAOS.items():
            lbl     = req.assignments.get(svc_name, "normal")
            profile = CHAOS_PROFILES.get(lbl, CHAOS_PROFILES["normal"])
            errors  = await _apply_profile_to_service(client, base_url, profile)
            results[svc_name] = {"ok": len(errors) == 0, "errors": errors, "label": lbl}
    return {
        "assignments": req.assignments,
        "results":     results,
        "success":     all(v["ok"] for v in results.values()),
    }


@app.get("/api/chaos/status")
async def chaos_status_all():
    """Lit l'etat chaos actuel de chaque service (avec retry si erreur 500)."""
    results = {}
    async with httpx.AsyncClient() as client:
        for svc_name, base_url in SERVICE_CHAOS.items():
            state = {"ok": False, "unreachable": True}
            for _ in range(3):
                try:
                    r = await client.get(f"{base_url}/api/status", timeout=3)
                    if r.is_success:
                        state = {"ok": True, **r.json()}
                        break
                    # 500 can happen with error mode — retry
                except Exception:
                    pass
            results[svc_name] = state
    return {"services": results}


# ─── Remédiation Docker ────────────────────────────────────────────────────────

class RemediationActionRequest(BaseModel):
    container: str  # nom ou ID du conteneur


class ResourceUpdateRequest(BaseModel):
    container: str
    memory_mb: Optional[int] = None   # ex: 512  → 512m
    cpus: Optional[float] = None      # ex: 0.5  → 0.5 core


class ScaleComposeRequest(BaseModel):
    compose_path: str
    service: str
    replicas: int


@app.get("/api/remediation/containers")
async def remediation_containers():
    """Liste tous les conteneurs (running + stopped) avec leur statut."""
    try:
        r = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=10,
        )
        items = []
        for line in r.stdout.strip().splitlines():
            if line.strip():
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return {"containers": items}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/remediation/stats")
async def remediation_stats():
    """Stats CPU/mémoire en temps réel (docker stats --no-stream)."""
    try:
        r = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=20,
        )
        items = []
        for line in r.stdout.strip().splitlines():
            if line.strip():
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return {"stats": items}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/remediation/restart")
async def remediation_restart(req: RemediationActionRequest):
    """Redémarre un conteneur."""
    try:
        r = subprocess.run(
            ["docker", "restart", req.container],
            capture_output=True, text=True, timeout=60,
        )
        return {"success": r.returncode == 0, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/remediation/stop")
async def remediation_stop(req: RemediationActionRequest):
    """Arrête un conteneur."""
    try:
        r = subprocess.run(
            ["docker", "stop", req.container],
            capture_output=True, text=True, timeout=30,
        )
        return {"success": r.returncode == 0, "stderr": r.stderr.strip()}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/remediation/start")
async def remediation_start(req: RemediationActionRequest):
    """Démarre un conteneur arrêté."""
    try:
        r = subprocess.run(
            ["docker", "start", req.container],
            capture_output=True, text=True, timeout=30,
        )
        return {"success": r.returncode == 0, "stderr": r.stderr.strip()}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/remediation/resources")
async def remediation_resources(req: ResourceUpdateRequest):
    """Met à jour les limites mémoire et/ou CPU d'un conteneur (docker update)."""
    if not req.memory_mb and not req.cpus:
        raise HTTPException(400, "Spécifier memory_mb ou cpus")
    cmd = ["docker", "update"]
    if req.memory_mb:
        cmd += ["--memory", f"{req.memory_mb}m", "--memory-swap", f"{req.memory_mb * 2}m"]
    if req.cpus:
        cmd += ["--cpus", str(req.cpus)]
    cmd.append(req.container)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        return {"success": r.returncode == 0, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/remediation/scale")
async def remediation_scale(req: ScaleComposeRequest):
    """Scale un service via docker compose."""
    if not (1 <= req.replicas <= 10):
        raise HTTPException(400, "replicas doit être entre 1 et 10")
    path = Path(req.compose_path)
    if not path.exists():
        raise HTTPException(400, f"Chemin introuvable : {req.compose_path}")
    try:
        r = subprocess.run(
            ["docker", "compose", "up", "-d",
             "--scale", f"{req.service}={req.replicas}", "--no-recreate"],
            cwd=str(path), capture_output=True, text=True, timeout=120,
        )
        return {"success": r.returncode == 0, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Timeout Docker")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/remediation/logs/{container}")
async def remediation_logs(container: str, lines: int = Query(50, ge=10, le=500)):
    """Dernières N lignes de logs d'un conteneur."""
    try:
        r = subprocess.run(
            ["docker", "logs", "--tail", str(lines), "--timestamps", container],
            capture_output=True, text=True, timeout=10,
        )
        all_lines = (r.stdout + r.stderr).strip().splitlines()
        return {"logs": all_lines, "container": container, "count": len(all_lines)}
    except Exception as e:
        raise HTTPException(500, str(e))
