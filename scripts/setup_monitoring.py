#!/usr/bin/env python3
"""
setup_monitoring.py — Multi-service instrumentation (Docker edition)
Model-Driven Intelligent Observability for AI-Powered Microservices

Phase 0 — Auto-discover all Spring Boot services in the project root
Phase 1 — Instrument each service (deps, Java files, properties, logback)
Phase 2 — Generate monitoring/ infrastructure (once, after all services)
Phase 3 — Update .env and .gitignore at root (once)

ARCHITECTURE : Les microservices s'exécutent dans des conteneurs Docker
sur le réseau 'monitoring-network'. Prometheus les découvre par DNS
(tasks.<service-name>) au lieu de host.docker.internal:PORT.

Run depuis la racine du projet (là où se trouve docker-compose.yml) :
  python setup_monitoring.py
"""

import argparse
import base64
import json
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

# Force UTF-8 sur Windows (évite UnicodeEncodeError avec cp1252)
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr.encoding and sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

REQUIRED_DEPS = [
    ("org.springframework.boot", "spring-boot-starter-actuator",  None),
    ("io.micrometer",            "micrometer-registry-prometheus", None),
    ("io.micrometer",            "micrometer-tracing-bridge-otel", None),
    ("io.opentelemetry",         "opentelemetry-exporter-otlp",   None),
    ("io.opentelemetry",         "opentelemetry-semconv",         "1.30.1-alpha"),
    ("com.github.loki4j",        "loki-logback-appender",         "1.4.2"),
]

# Dans l'architecture Docker, les services s'adressent aux conteneurs par nom
ENV_DEFAULTS = {
    "SERVICE_NAME":                "microservices-project",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://jaeger:4317",   # nom du conteneur Jaeger
    "LOKI_URL":                    "http://loki:3100",      # nom du conteneur Loki
    "OPENAI_API_KEY":              "sk-...",
}

GITIGNORE_REQUIRED = [".env", "*.pkl", "__pycache__/"]

# Keys that the monitoring block writes into application.properties
MONITORING_KEYS = [
    "management.endpoints.web.exposure.include",
    "management.endpoint.prometheus.enabled",
    "management.metrics.export.prometheus.enabled",
    "spring.application.name",
    "otel.exporter.otlp.endpoint",
    "otel.exporter.otlp.protocol",
    "otel.traces.exporter",
    "otel.resource.attributes",
    "management.tracing.sampling.probability",
    "loki.url",
    "management.metrics.tags.application",
    "management.metrics.tags.environment",
]

# Port interne des conteneurs Spring Boot (toujours 8080 dans Docker)
CONTAINER_PORT = 8080

# Port externe de Grafana — 3001 pour éviter le conflit avec le frontend sur 3000
GRAFANA_PORT = 3001

# Port de base pour la détection locale (pour l'affichage seulement)
BASE_PORT = 8080


# ─────────────────────────────────────────────────────────────────────────────
# Utilities
# ─────────────────────────────────────────────────────────────────────────────

def now_ts() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def backup_file(path: Path) -> Path | None:
    """Copy path → path.backup_<timestamp> before modification."""
    if path.exists():
        dest = path.parent / f"{path.name}.backup_{now_ts()}"
        shutil.copy2(path, dest)
        return dest
    return None


def hr(char: str = "─", width: int = 52) -> str:
    return char * width


# ─────────────────────────────────────────────────────────────────────────────
# Phase 0 — Auto-discovery of Spring Boot services
# ─────────────────────────────────────────────────────────────────────────────

def discover_services(root_dir: Path) -> list[dict]:
    """
    Scan depth-1 subdirectories for pom.xml files that declare
    spring-boot-starter-parent. Returns list of service dicts.
    """
    candidates: list[dict] = []

    for subdir in sorted(root_dir.iterdir()):
        if not subdir.is_dir():
            continue
        pom_path = subdir / "pom.xml"
        if not pom_path.exists():
            continue
        try:
            info = _parse_pom(pom_path)
        except Exception as exc:
            print(f"  [warn] {pom_path.relative_to(root_dir)} — parse error: {exc}")
            continue
        if info is None:
            continue
        info["dir"] = subdir
        candidates.append(info)

    # Lire le port depuis application.properties (= port exposé sur l'hôte)
    # Ce port est utilisé pour l'affichage seulement ;
    # Prometheus utilisera toujours CONTAINER_PORT (8080) via dns_sd_configs.
    used_ports: set[int] = set()
    next_port = BASE_PORT

    for svc in candidates:
        detected = _read_port(svc["dir"])
        if detected and detected not in used_ports:
            svc["host_port"] = detected
            used_ports.add(detected)
        else:
            while next_port in used_ports:
                next_port += 1
            svc["host_port"] = next_port
            used_ports.add(next_port)
            next_port += 1

        # 'port' conservé pour la compatibilité avec le reste du code
        svc["port"] = svc["host_port"]

    return candidates


def _parse_pom(pom_path: Path) -> dict | None:
    """
    Parse a pom.xml. Returns a service dict if it is a Spring Boot project
    (parent artifactId contains 'spring-boot-starter-parent'), else None.
    """
    tree = ET.parse(str(pom_path))
    root = tree.getroot()

    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    def text(tag: str, elem=None, default: str = "") -> str:
        el = (elem if elem is not None else root).find(f"{ns}{tag}")
        return (el.text or "").strip() if el is not None else default

    parent_el = root.find(f"{ns}parent")
    if parent_el is None:
        return None
    if "spring-boot-starter-parent" not in text("artifactId", parent_el):
        return None

    group_id    = text("groupId") or text("groupId", parent_el)
    artifact_id = text("artifactId")

    existing_deps: list[tuple[str, str]] = []
    for dep in root.iter(f"{ns}dependency"):
        gid = text("groupId", dep)
        aid = text("artifactId", dep)
        if gid and aid:
            existing_deps.append((gid, aid))

    fallback_pkg = _derive_package(group_id, artifact_id)
    main_package = _detect_main_package(pom_path.parent, fallback_pkg)

    # Utilise le nom du dossier (service-a, service-b...) plutôt que l'artifactId
    # car plusieurs services peuvent partager le même artifactId dans le pom.xml
    folder_name = pom_path.parent.name

    return {
        "name":          folder_name,
        "group_id":      group_id,
        "artifact_id":   artifact_id,
        "pom_path":      pom_path,
        "main_package":  main_package,
        "existing_deps": existing_deps,
        "port":          None,
        "host_port":     None,
    }


def _derive_package(group_id: str, artifact_id: str) -> str:
    clean = artifact_id.replace("-", "").replace("_", "").lower()
    return f"{group_id}.{clean}" if group_id else clean


def _detect_main_package(service_dir: Path, fallback: str) -> str:
    src = service_dir / "src" / "main" / "java"
    if src.exists():
        for java_file in src.rglob("*.java"):
            try:
                content = java_file.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if "@SpringBootApplication" in content:
                for line in content.splitlines():
                    s = line.strip()
                    if s.startswith("package ") and s.endswith(";"):
                        return s[8:-1].strip()
    return fallback


def _read_port(service_dir: Path) -> int | None:
    """Read server.port from application.properties; returns None if absent."""
    props = service_dir / "src" / "main" / "resources" / "application.properties"
    if not props.exists():
        return None
    for line in props.read_text(encoding="utf-8", errors="ignore").splitlines():
        s = line.strip()
        if s.startswith("server.port") and "=" in s:
            try:
                return int(s.split("=", 1)[1].strip())
            except ValueError:
                pass
    return None


def confirm_services(services: list[dict], root_dir: Path) -> bool:
    """Display discovered services and ask for confirmation."""
    print()
    print("=" * 60)
    print("  setup_monitoring.py — Découverte des services (Docker)")
    print("=" * 60)
    print()

    if not services:
        print("  Aucun service Spring Boot détecté.")
        print("  Vérifiez que vos pom.xml déclarent spring-boot-starter-parent.")
        return False

    print("Services Spring Boot détectés :")
    print(f"  {'Nom':<22}  {'Hôte':>10}  {'Conteneur':>10}  Fichier")
    print(f"  {'-'*22}  {'-'*10}  {'-'*10}  {'-'*30}")
    for i, svc in enumerate(services, 1):
        rel = svc["pom_path"].relative_to(root_dir)
        print(
            f"  [{i}] {svc['name']:<20}  "
            f":{svc['host_port']:<9}  "
            f":{CONTAINER_PORT:<9}  "
            f"({rel})"
        )

    print()
    print(f"  Mode : DOCKER — Prometheus scrape via dns_sd_configs (tasks.<name>:{CONTAINER_PORT})")
    print(f"  {len(services)} service(s) seront instrumentés.")
    print()

    try:
        answer = input("Continuer ? [O/n] : ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False

    if answer in ("n", "non", "no"):
        print("Annulé.")
        return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 — Instrument one service (6 actions)
# ─────────────────────────────────────────────────────────────────────────────

def instrument_service(svc: dict, idx: int, total: int) -> bool:
    name    = svc["name"]
    svc_dir = svc["dir"]
    pkg     = svc["main_package"]
    errors  = []

    print()
    print(f"[service {idx}/{total}] {name}")

    # ── 1/6 pom.xml ──────────────────────────────────────────────────────────
    try:
        n = _inject_deps(svc)
        label = f"{n} dépendance(s) ajoutée(s)" if n else "aucune modification (déjà présentes)"
        print(f"  [1/6] pom.xml                → {label}")
    except Exception as exc:
        errors.append(str(exc))
        print(f"  [1/6] pom.xml                → ERREUR: {exc}")

    # ── 2/6 TracingConfig.java ────────────────────────────────────────────────
    try:
        path = _write_java(svc_dir, pkg, "config", "TracingConfig", _tracing_config_java(pkg))
        print(f"  [2/6] TracingConfig.java     → créé ({path.relative_to(svc_dir)})")
    except Exception as exc:
        errors.append(str(exc))
        print(f"  [2/6] TracingConfig.java     → ERREUR: {exc}")

    # ── 3/6 MetricsConfig.java ────────────────────────────────────────────────
    try:
        path = _write_java(svc_dir, pkg, "config", "MetricsConfig", _metrics_config_java(pkg))
        print(f"  [3/6] MetricsConfig.java     → créé ({path.relative_to(svc_dir)})")
    except Exception as exc:
        errors.append(str(exc))
        print(f"  [3/6] MetricsConfig.java     → ERREUR: {exc}")

    # ── 4/6 HttpMetricsFilter.java ────────────────────────────────────────────
    try:
        path = _write_java(svc_dir, pkg, "filter", "HttpMetricsFilter", _http_metrics_filter_java(pkg))
        print(f"  [4/6] HttpMetricsFilter.java → créé ({path.relative_to(svc_dir)})")
    except Exception as exc:
        errors.append(str(exc))
        print(f"  [4/6] HttpMetricsFilter.java → ERREUR: {exc}")

    # ── 5/6 application.properties ────────────────────────────────────────────
    try:
        n = _modify_app_properties(svc_dir, name)
        label = f"{n} propriété(s) ajoutée(s)" if n else "aucune modification (déjà présentes)"
        print(f"  [5/6] application.properties → {label}")
    except Exception as exc:
        errors.append(str(exc))
        print(f"  [5/6] application.properties → ERREUR: {exc}")

    # ── 6/6 logback-spring.xml ────────────────────────────────────────────────
    try:
        _generate_logback(svc_dir)
        print(f"  [6/6] logback-spring.xml     → créé")
    except Exception as exc:
        errors.append(str(exc))
        print(f"  [6/6] logback-spring.xml     → ERREUR: {exc}")

    if errors:
        print(f"  ✗  {name} — {len(errors)} erreur(s)")
        return False
    print(f"  ✓  {name} instrumenté")
    return True


# ── Action 1 — pom.xml dependency injection ──────────────────────────────────

def _inject_deps(svc: dict) -> int:
    pom_path = svc["pom_path"]
    existing = {(g, a) for g, a in svc["existing_deps"]}
    to_add   = [(g, a, v) for g, a, v in REQUIRED_DEPS if (g, a) not in existing]

    if not to_add:
        return 0

    original = pom_path.read_text(encoding="utf-8")
    indent   = "        "

    fragments = []
    for gid, aid, ver in to_add:
        lines = [
            f"{indent}<dependency>",
            f"{indent}    <groupId>{gid}</groupId>",
            f"{indent}    <artifactId>{aid}</artifactId>",
        ]
        if ver:
            lines.append(f"{indent}    <version>{ver}</version>")
        lines.append(f"{indent}</dependency>")
        fragments.append("\n".join(lines))

    blob = "\n" + "\n".join(fragments) + "\n"

    if "</dependencies>" in original:
        new_text = original.replace("</dependencies>", blob + "    </dependencies>", 1)
    else:
        dep_block = f"\n    <dependencies>{blob}    </dependencies>\n"
        new_text = original.replace("</project>", dep_block + "</project>", 1)

    backup_file(pom_path)
    pom_path.write_text(new_text, encoding="utf-8")
    return len(to_add)


# ── Actions 2/3/4 — Java file helpers ────────────────────────────────────────

def _write_java(service_dir: Path, pkg: str, subpkg: str, classname: str, content: str) -> Path:
    pkg_path = Path(*pkg.split("."))
    dest_dir = service_dir / "src" / "main" / "java" / pkg_path / subpkg
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / f"{classname}.java"
    backup_file(path)
    path.write_text(content, encoding="utf-8")
    return path


def _tracing_config_java(pkg: str) -> str:
    return textwrap.dedent(f"""\
        package {pkg}.config;

        import io.opentelemetry.api.OpenTelemetry;
        import io.opentelemetry.api.common.Attributes;
        import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter;
        import io.opentelemetry.sdk.OpenTelemetrySdk;
        import io.opentelemetry.sdk.resources.Resource;
        import io.opentelemetry.sdk.trace.SdkTracerProvider;
        import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
        import io.opentelemetry.semconv.ResourceAttributes;
        import org.springframework.beans.factory.annotation.Value;
        import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
        import org.springframework.context.annotation.Bean;
        import org.springframework.context.annotation.Configuration;

        @Configuration
        public class TracingConfig {{

            @Value("${{otel.exporter.otlp.endpoint:http://jaeger:4317}}")
            private String otlpEndpoint;

            @Value("${{spring.application.name:unknown-service}}")
            private String serviceName;

            @Bean
            @ConditionalOnMissingBean
            public OtlpGrpcSpanExporter otlpGrpcSpanExporter() {{
                return OtlpGrpcSpanExporter.builder()
                        .setEndpoint(otlpEndpoint)
                        .build();
            }}

            @Bean
            @ConditionalOnMissingBean
            public OpenTelemetry openTelemetry(OtlpGrpcSpanExporter exporter) {{
                Resource resource = Resource.getDefault()
                        .merge(Resource.create(Attributes.of(
                                ResourceAttributes.SERVICE_NAME, serviceName
                        )));

                SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
                        .setResource(resource)
                        .addSpanProcessor(BatchSpanProcessor.builder(exporter).build())
                        .build();

                return OpenTelemetrySdk.builder()
                        .setTracerProvider(tracerProvider)
                        .buildAndRegisterGlobal();
            }}
        }}
        """)


def _metrics_config_java(pkg: str) -> str:
    return textwrap.dedent(f"""\
        package {pkg}.config;

        import io.micrometer.core.instrument.MeterRegistry;
        import org.springframework.beans.factory.annotation.Value;
        import org.springframework.boot.actuate.autoconfigure.metrics.MeterRegistryCustomizer;
        import org.springframework.context.annotation.Bean;
        import org.springframework.context.annotation.Configuration;

        @Configuration
        public class MetricsConfig {{

            @Value("${{spring.application.name:unknown-service}}")
            private String applicationName;

            @Value("${{management.metrics.tags.environment:dev}}")
            private String environment;

            @Bean
            public MeterRegistryCustomizer<MeterRegistry> metricsCommonTags() {{
                return registry -> registry.config()
                        .commonTags("application", applicationName, "environment", environment);
            }}
        }}
        """)


def _http_metrics_filter_java(pkg: str) -> str:
    return textwrap.dedent(f"""\
        package {pkg}.filter;

        import io.micrometer.core.instrument.Counter;
        import io.micrometer.core.instrument.MeterRegistry;
        import io.micrometer.core.instrument.Timer;
        import jakarta.servlet.Filter;
        import jakarta.servlet.FilterChain;
        import jakarta.servlet.ServletException;
        import jakarta.servlet.ServletRequest;
        import jakarta.servlet.ServletResponse;
        import jakarta.servlet.http.HttpServletRequest;
        import jakarta.servlet.http.HttpServletResponse;
        import org.springframework.stereotype.Component;

        import java.io.IOException;
        import java.util.concurrent.TimeUnit;

        @Component
        public class HttpMetricsFilter implements Filter {{

            private final MeterRegistry registry;

            public HttpMetricsFilter(MeterRegistry registry) {{
                this.registry = registry;
            }}

            @Override
            public void doFilter(ServletRequest request, ServletResponse response,
                                 FilterChain chain) throws IOException, ServletException {{

                HttpServletRequest  req = (HttpServletRequest)  request;
                HttpServletResponse res = (HttpServletResponse) response;
                long startNanos = System.nanoTime();

                try {{
                    chain.doFilter(request, response);
                }} finally {{
                    long   elapsed = System.nanoTime() - startNanos;
                    String method  = req.getMethod();
                    String uri     = normalizeUri(req.getRequestURI());
                    String status  = String.valueOf(res.getStatus());

                    Counter.builder("http_requests_total")
                            .description("Total number of HTTP requests")
                            .tags("method", method, "uri", uri, "status", status)
                            .register(registry)
                            .increment();

                    Timer.builder("http_request_duration_seconds")
                            .description("HTTP request latency in seconds")
                            .tags("method", method, "uri", uri, "status", status)
                            .publishPercentiles(0.5, 0.95, 0.99)
                            .register(registry)
                            .record(elapsed, TimeUnit.NANOSECONDS);
                }}
            }}

            private String normalizeUri(String uri) {{
                return uri.replaceAll("/\\\\d+", "/{{id}}");
            }}
        }}
        """)


# ── Action 5 — application.properties ────────────────────────────────────────

def _monitoring_props_block(service_name: str) -> str:
    """
    Génère le bloc de propriétés de monitoring.
    Les URLs OTLP et Loki pointent vers les noms de conteneurs Docker
    (résolvables depuis le réseau monitoring-network).
    """
    return textwrap.dedent(f"""\

        # === MONITORING — ajouté par setup_monitoring.py (Docker edition) ===
        management.endpoints.web.exposure.include=health,info,prometheus,metrics
        management.endpoint.prometheus.enabled=true
        management.metrics.export.prometheus.enabled=true
        spring.application.name={service_name}
        otel.exporter.otlp.endpoint=${{OTEL_EXPORTER_OTLP_ENDPOINT:http://jaeger:4317}}
        otel.exporter.otlp.protocol=grpc
        otel.traces.exporter=otlp
        otel.resource.attributes=service.name=${{spring.application.name}}
        management.tracing.sampling.probability=1.0
        loki.url=${{LOKI_URL:http://loki:3100}}
        management.metrics.tags.application=${{spring.application.name}}
        management.metrics.tags.environment=dev
        """)


def _modify_app_properties(svc_dir: Path, service_name: str) -> int:
    props_path = svc_dir / "src" / "main" / "resources" / "application.properties"
    props_path.parent.mkdir(parents=True, exist_ok=True)

    existing = props_path.read_text(encoding="utf-8") if props_path.exists() else ""
    existing_keys = {
        line.split("=", 1)[0].strip()
        for line in existing.splitlines()
        if "=" in line and not line.startswith("#")
    }

    missing_keys = [k for k in MONITORING_KEYS if k not in existing_keys]
    if not missing_keys:
        return 0

    backup_file(props_path)
    with props_path.open("a", encoding="utf-8") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(_monitoring_props_block(service_name))
    return len(missing_keys)


# ── Action 6 — logback-spring.xml ────────────────────────────────────────────

def _generate_logback(svc_dir: Path) -> None:
    logback_path = svc_dir / "src" / "main" / "resources" / "logback-spring.xml"
    logback_path.parent.mkdir(parents=True, exist_ok=True)
    backup_file(logback_path)

    content = textwrap.dedent("""\
        <?xml version="1.0" encoding="UTF-8"?>
        <configuration>

            <springProperty scope="context" name="appName"
                            source="spring.application.name" defaultValue="app"/>
            <springProperty scope="context" name="lokiUrl"
                            source="loki.url" defaultValue="http://loki:3100"/>

            <!-- ══════════════════════════════════════════════════════════
                 LOKI — push JSON structuré via loki4j (sans Promtail)
                 URL résolue par DNS Docker : http://loki:3100
                 ══════════════════════════════════════════════════════════ -->
            <appender name="LOKI" class="com.github.loki4j.logback.Loki4jAppender">
                <http>
                    <url>${lokiUrl}/loki/api/v1/push</url>
                </http>
                <format>
                    <label>
                        <pattern>service=${appName},level=%level</pattern>
                    </label>
                    <message>
                        <pattern>{"ts":"%d{yyyy-MM-dd'T'HH:mm:ss.SSS'Z', UTC}","level":"%level","service":"${appName}","logger":"%logger{36}","msg":"%message","traceId":"%X{traceId:-}","spanId":"%X{spanId:-}"}</pattern>
                    </message>
                    <sortByTime>true</sortByTime>
                </format>
            </appender>

            <!-- ══════════════════════════════════════════════════════════
                 CONSOLE — sortie lisible avec corrélation des traces
                 ══════════════════════════════════════════════════════════ -->
            <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
                <encoder>
                    <pattern>%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} traceId=%X{traceId:-} spanId=%X{spanId:-} - %msg%n</pattern>
                </encoder>
            </appender>

            <root level="INFO">
                <appender-ref ref="LOKI"/>
                <appender-ref ref="CONSOLE"/>
            </root>

        </configuration>
        """)

    logback_path.write_text(content, encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — Generate monitoring/ infrastructure (once, after all services)
# ─────────────────────────────────────────────────────────────────────────────

def check_loki_ready(timeout: int = 60) -> bool:
    """Vérifie que Loki est accessible sur :3100."""
    print("  Vérification Loki...", end="", flush=True)
    for i in range(timeout):
        try:
            urllib.request.urlopen("http://localhost:3100/ready", timeout=2)
            print(f" OK ({i + 1}s)")
            return True
        except Exception:
            time.sleep(1)
            print(".", end="", flush=True)
    print(" TIMEOUT")
    return False


def check_grafana_ready(timeout: int = 60) -> bool:
    """Vérifie que Grafana répond sur :{GRAFANA_PORT}/api/health."""
    print(f"  Vérification Grafana (port {GRAFANA_PORT})...", end="", flush=True)
    for i in range(timeout):
        try:
            resp = urllib.request.urlopen(
                f"http://localhost:{GRAFANA_PORT}/api/health", timeout=2
            )
            data = json.loads(resp.read())
            if data.get("database") == "ok":
                print(f" OK ({i + 1}s)")
                return True
        except Exception:
            pass
        time.sleep(1)
        print(".", end="", flush=True)
    print(" TIMEOUT")
    return False


def get_loki_uid(max_wait_seconds: int = 90) -> str | None:
    """
    Attend que Grafana soit prêt et récupère l'UID réel de Loki.
    Réessaie toutes les 3 secondes pendant max_wait_seconds.
    """
    auth = base64.b64encode(b"admin:admin").decode()
    headers = {"Authorization": f"Basic {auth}"}

    print(f"  Attente Grafana (:{GRAFANA_PORT}) + UID Loki...", end="", flush=True)
    elapsed = 0
    while elapsed < max_wait_seconds:
        try:
            req = urllib.request.Request(
                f"http://localhost:{GRAFANA_PORT}/api/datasources",
                headers=headers,
            )
            resp = urllib.request.urlopen(req, timeout=3)
            datasources = json.loads(resp.read())
            for ds in datasources:
                if ds.get("name", "").lower() == "loki":
                    uid = ds["uid"]
                    print(f" OK ({uid}) après {elapsed}s")
                    return uid
        except Exception:
            pass
        time.sleep(3)
        elapsed += 3
        print(".", end="", flush=True)

    print(f" TIMEOUT après {max_wait_seconds}s")
    return None


def generate_monitoring(root_dir: Path, services: list[dict]) -> Path:
    print()
    print(hr("─"))
    print("PHASE 2 — Génération de monitoring/")
    print(hr("─"))

    mon_dir = root_dir / "monitoring"
    ds_dir  = mon_dir / "grafana" / "provisioning" / "datasources"
    ds_dir.mkdir(parents=True, exist_ok=True)

    files = {
        mon_dir / "docker-compose.monitoring.yml": _docker_compose_monitoring_yml(),
        mon_dir / "prometheus.yml":                _prometheus_yml(services),
        ds_dir  / "prometheus.yaml":               _grafana_ds("Prometheus", "prometheus", "http://prometheus:9090", True),
        ds_dir  / "loki.yaml":                     _grafana_ds("Loki",       "loki",       "http://loki:3100",       False),
        ds_dir  / "jaeger.yaml":                   _grafana_ds("Jaeger",     "jaeger",     "http://jaeger:16686",    False),
    }

    for path, content in files.items():
        path.write_text(content, encoding="utf-8")
        print(f"  [write] {path.relative_to(root_dir)}")

    _start_docker_compose(mon_dir)
    return mon_dir


def _start_docker_compose(mon_dir: Path) -> None:
    compose_file = mon_dir / "docker-compose.monitoring.yml"
    print("\n  Démarrage de Docker Compose monitoring...", flush=True)
    try:
        result = subprocess.run(
            ["docker", "compose", "-f", str(compose_file), "up", "-d"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0:
            print("  Docker Compose monitoring démarré.")
        else:
            print(f"  [WARN] docker compose up a retourné code {result.returncode}")
            if result.stderr:
                print(f"  {result.stderr.strip()[:300]}")
    except FileNotFoundError:
        print("  [WARN] 'docker' non trouvé — démarrer manuellement :")
        print(f"  docker compose -f {compose_file} up -d")
    except subprocess.TimeoutExpired:
        print("  [WARN] docker compose up a expiré (>120s).")


def _docker_compose_monitoring_yml() -> str:
    """
    Stack de monitoring qui se greffe sur le réseau 'monitoring-network'
    déjà créé par le docker-compose.yml principal des microservices.

    Points clés :
    - network 'monitoring-network' déclaré external=true (déjà existant)
    - Prometheus n'a plus besoin de extra_hosts car il contacte les services
      directement par DNS Docker (tasks.<service-name>)
    - Grafana exposé sur {GRAFANA_PORT} pour ne pas entrer en conflit
      avec le frontend React sur le port 3000
    """
    return textwrap.dedent(f"""\
        services:

          prometheus:
            image: prom/prometheus:latest
            container_name: prometheus
            ports:
              - "9090:9090"
            volumes:
              - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
            networks:
              - monitoring-network

          loki:
            image: grafana/loki:latest
            container_name: loki
            ports:
              - "3100:3100"
            command: -config.file=/etc/loki/local-config.yaml
            networks:
              - monitoring-network

          jaeger:
            image: jaegertracing/all-in-one:latest
            container_name: jaeger
            environment:
              - COLLECTOR_OTLP_ENABLED=true
            ports:
              - "16686:16686"   # Jaeger UI
              - "4317:4317"     # OTLP gRPC — reçoit les traces des services
            networks:
              - monitoring-network

          grafana:
            image: grafana/grafana:latest
            container_name: grafana
            ports:
              - "{GRAFANA_PORT}:3000"
            environment:
              - GF_SECURITY_ADMIN_PASSWORD=admin
            depends_on:
              - prometheus
              - loki
              - jaeger
            volumes:
              - ./grafana/provisioning:/etc/grafana/provisioning:ro
            networks:
              - monitoring-network

        networks:
          monitoring-network:
            external: true
            name: monitoring-network
        """)


def _prometheus_yml(services: list[dict]) -> str:
    """
    Génère prometheus.yml avec dns_sd_configs pour chaque service.

    Au lieu de static_configs → host.docker.internal:PORT (architecture locale),
    Prometheus découvre les conteneurs via le DNS Docker :
      tasks.<service-name>  →  résout vers toutes les IPs du service
                                (compatible Docker Swarm pour le scaling)
    Le port cible est toujours CONTAINER_PORT (8080), le port interne
    Spring Boot, indépendamment du port exposé sur l'hôte.
    """
    lines = [
        "global:",
        "  scrape_interval:     15s",
        "  evaluation_interval: 15s",
        "",
        "scrape_configs:",
    ]

    for svc in services:
        lines += [
            "",
            f'  - job_name: "{svc["name"]}"',
            f'    metrics_path: /actuator/prometheus',
            f'    dns_sd_configs:',
            f'      - names: ["tasks.{svc["name"]}"]',
            f'        type: "A"',
            f'        port: {CONTAINER_PORT}',
        ]

    lines.append("")
    return "\n".join(lines)


def _grafana_ds(name: str, ds_type: str, url: str, is_default: bool) -> str:
    default_str = "true" if is_default else "false"
    return textwrap.dedent(f"""\
        apiVersion: 1

        datasources:
          - name: {name}
            type: {ds_type}
            access: proxy
            url: {url}
            isDefault: {default_str}
            editable: false
        """)


def _push_dashboards_via_api(monitoring_dir: Path, loki_uid: str) -> None:
    """
    Pousse les dashboards JSON générés directement dans Grafana via l'API.
    Utilise GRAFANA_PORT (:{GRAFANA_PORT}) au lieu du port 3000 standard.
    """
    dashboards_dir = monitoring_dir / "grafana" / "provisioning" / "dashboards"
    auth = base64.b64encode(b"admin:admin").decode()
    headers = {
        "Authorization": f"Basic {auth}",
        "Content-Type":  "application/json",
    }

    print()
    print(f"  Push des dashboards via API Grafana (:{GRAFANA_PORT})...")

    for json_file in sorted(dashboards_dir.glob("*.json")):
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))

            for panel in data.get("panels", []):
                if panel.get("type") == "logs":
                    panel["datasource"] = {"type": "loki", "uid": loki_uid}

            data.pop("id", None)
            data["version"] = data.get("version", 0) + 1

            payload = json.dumps({
                "dashboard": data,
                "overwrite": True,
                "message":   f"setup_monitoring: loki uid={loki_uid}",
            }).encode()

            req = urllib.request.Request(
                f"http://localhost:{GRAFANA_PORT}/api/dashboards/db",
                data=payload,
                headers=headers,
                method="POST",
            )
            resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
            status = resp.get("status", "?")
            print(f"  [push] {json_file.name} → {status}")

        except Exception as exc:
            print(f"  [WARN] {json_file.name} : {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — Dashboards Grafana
# ─────────────────────────────────────────────────────────────────────────────

def generate_dashboards(services: list[dict], monitoring_dir: Path, loki_uid: str = "loki") -> None:
    dashboards_dir = monitoring_dir / "grafana" / "provisioning" / "dashboards"
    dashboards_dir.mkdir(parents=True, exist_ok=True)

    root_dir = monitoring_dir.parent

    yaml_content = textwrap.dedent("""\
        apiVersion: 1
        providers:
          - name: "default"
            orgId: 1
            folder: "Microservices"
            type: file
            disableDeletion: false
            updateIntervalSeconds: 10
            options:
              path: /etc/grafana/provisioning/dashboards
        """)
    yaml_path = dashboards_dir / "dashboards.yaml"
    yaml_path.write_text(yaml_content, encoding="utf-8")
    print(f"  [write] {yaml_path.relative_to(root_dir)}")

    for svc in services:
        dashboard = _build_dashboard(svc["name"], loki_uid)
        json_path = dashboards_dir / f"{svc['name']}.json"
        json_path.write_text(
            json.dumps(dashboard, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"  [write] {json_path.relative_to(root_dir)} (6 panels)")


def _build_dashboard(service_name: str, loki_uid: str = "loki") -> dict:
    svc = service_name
    panels = [
        _panel_timeseries(
            id_=1,
            title=f"Latence P95 — {svc}",
            expr=(
                f'histogram_quantile(0.95, sum(rate('
                f'http_server_requests_seconds_bucket{{application="{svc}"}}[5m])) by (le))'
            ),
            legend="P95",
            unit="s",
            x=0, y=0,
            thresholds=[
                {"color": "green",  "value": None},
                {"color": "orange", "value": 0.5},
                {"color": "red",    "value": 2},
            ],
        ),
        _panel_timeseries(
            id_=2,
            title=f"Taux erreur 5xx — {svc}",
            expr=(
                f'sum(rate(http_server_requests_seconds_count'
                f'{{application="{svc}",status=~"5.."}}[5m]))'
            ),
            legend="5xx/s",
            unit="reqps",
            x=12, y=0,
            thresholds=[
                {"color": "green", "value": None},
                {"color": "red",   "value": 0.001},
            ],
        ),
        _panel_timeseries(
            id_=3,
            title=f"Requêtes/sec — {svc}",
            expr=(
                f'sum(rate(http_server_requests_seconds_count'
                f'{{application="{svc}"}}[1m]))'
            ),
            legend="req/s",
            unit="reqps",
            x=0, y=8,
            thresholds=None,
        ),
        _panel_timeseries(
            id_=4,
            title=f"CPU — {svc}",
            expr=f'process_cpu_usage{{application="{svc}"}}',
            legend="CPU",
            unit="percentunit",
            x=12, y=8,
            thresholds=[
                {"color": "green",  "value": None},
                {"color": "orange", "value": 0.7},
                {"color": "red",    "value": 0.85},
            ],
        ),
        _panel_timeseries(
            id_=5,
            title=f"Mémoire heap — {svc}",
            expr=f'jvm_memory_used_bytes{{application="{svc}",area="heap"}}',
            legend="Heap",
            unit="bytes",
            x=0, y=16,
            thresholds=None,
        ),
        _panel_logs(id_=6, title=f"Logs — {svc}", service_name=svc, x=12, y=16, loki_uid=loki_uid),
    ]

    return {
        "uid":           f"{service_name}-dashboard",
        "title":         service_name,
        "tags":          ["microservice", "spring-boot", service_name],
        "timezone":      "browser",
        "refresh":       "15s",
        "time":          {"from": "now-1h", "to": "now"},
        "schemaVersion": 38,
        "panels": panels,
    }


def _panel_timeseries(
    id_: int,
    title: str,
    expr: str,
    legend: str,
    unit: str,
    x: int,
    y: int,
    thresholds: list[dict] | None,
) -> dict:
    defaults: dict = {"unit": unit}
    if thresholds is not None:
        defaults["thresholds"] = {"mode": "absolute", "steps": thresholds}

    return {
        "id":         id_,
        "title":      title,
        "type":       "timeseries",
        "datasource": "Prometheus",
        "gridPos":    {"x": x, "y": y, "w": 12, "h": 8},
        "targets": [
            {"expr": expr, "legendFormat": legend, "refId": "A"}
        ],
        "fieldConfig": {"defaults": defaults},
        "options": {
            "tooltip": {"mode": "single"},
            "legend":  {"displayMode": "list", "placement": "bottom"},
        },
    }


def _panel_logs(id_: int, title: str, service_name: str, x: int, y: int, loki_uid: str = "loki") -> dict:
    return {
        "id":         id_,
        "title":      title,
        "type":       "logs",
        "datasource": {"type": "loki", "uid": loki_uid},
        "gridPos":    {"x": x, "y": y, "w": 12, "h": 8},
        "targets": [
            {"expr": f'{{service="{service_name}"}} |= ""', "refId": "A"}
        ],
        "options": {
            "showTime":       True,
            "sortOrder":      "Descending",
            "wrapLogMessage": True,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Phase 3 — .env and .gitignore at project root (once)
# ─────────────────────────────────────────────────────────────────────────────

def update_env_and_gitignore(root_dir: Path) -> None:
    print()
    print(hr("─"))
    print("PHASE 3 — .env et .gitignore")
    print(hr("─"))
    _update_env(root_dir)
    _update_gitignore(root_dir)


def _update_env(root_dir: Path) -> None:
    env_path = root_dir / ".env"
    existing_text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    existing_keys = {
        line.split("=", 1)[0].strip()
        for line in existing_text.splitlines()
        if "=" in line and not line.startswith("#")
    }

    to_add = {k: v for k, v in ENV_DEFAULTS.items() if k not in existing_keys}
    if to_add:
        with env_path.open("a", encoding="utf-8") as f:
            if existing_text and not existing_text.endswith("\n"):
                f.write("\n")
            for k, v in to_add.items():
                f.write(f"{k}={v}\n")
        for k in to_add:
            print(f"  [add]  .env ← {k}")
    else:
        print("  [skip] .env — toutes les clés déjà présentes")

    example_path = root_dir / ".env.example"
    example_path.write_text(
        "\n".join(f"{k}=" for k in ENV_DEFAULTS) + "\n",
        encoding="utf-8",
    )
    print("  [write] .env.example (clés uniquement, valeurs vides)")


def _update_gitignore(root_dir: Path) -> None:
    gi_path  = root_dir / ".gitignore"
    existing = gi_path.read_text(encoding="utf-8") if gi_path.exists() else ""
    present  = set(existing.splitlines())

    missing = [e for e in GITIGNORE_REQUIRED if e not in present]
    if missing:
        with gi_path.open("a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write("\n".join(missing) + "\n")
        for e in missing:
            print(f"  [add]  .gitignore ← {e}")
    else:
        print("  [skip] .gitignore — toutes les entrées déjà présentes")


# ─────────────────────────────────────────────────────────────────────────────
# Final summary
# ─────────────────────────────────────────────────────────────────────────────

def print_summary(services: list[dict], ok: list[str], failed: list[str]) -> None:
    n_ok    = len(ok)
    n_total = len(services)

    print()
    print("=" * 60)
    if failed:
        print(f"  TERMINÉ — {n_ok}/{n_total} service(s) instrumentés  ({len(failed)} erreur(s))")
    else:
        print(f"  TERMINÉ — {n_total} service(s) instrumentés")
    print("=" * 60)

    print()
    print("Services instrumentés (vérification via Prometheus) :")
    for svc in services:
        mark = "✓" if svc["name"] in ok else "✗"
        # L'URL Prometheus est interne au réseau Docker
        print(
            f"  {mark} {svc['name']:<24}"
            f"  DNS: tasks.{svc['name']}:{CONTAINER_PORT}"
            f"  (hôte: localhost:{svc['host_port']})"
        )

    n = len(services)
    dash_list = "\n".join(
        f"  grafana/provisioning/dashboards/{svc['name']}.json"
        for svc in services
    )
    print(f"""
Infrastructure générée dans monitoring/ :
  docker-compose.monitoring.yml   (réseau monitoring-network external)
  prometheus.yml  ({n} job(s) avec dns_sd_configs)
  grafana/provisioning/datasources/prometheus.yaml
  grafana/provisioning/datasources/loki.yaml
  grafana/provisioning/datasources/jaeger.yaml
  grafana/provisioning/dashboards/dashboards.yaml
{dash_list}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORDRE DE DÉMARRAGE OBLIGATOIRE (architecture Docker) :

  1. Démarrer les microservices (crée le réseau monitoring-network) :
       docker compose up -d

  2. Démarrer la stack monitoring (se greffe sur monitoring-network) :
       docker compose -f monitoring/docker-compose.monitoring.yml up -d

  3. Vérifier que Prometheus scrape les cibles :
       http://localhost:9090/targets  →  {n} target(s) UP attendue(s)

  4. Grafana (admin / admin) :
       http://localhost:{GRAFANA_PORT}

  5. Jaeger UI :
       http://localhost:16686

  NOTE SCALING : Pour répliquer un service sans conflit de ports :
    docker compose up -d --scale service-a=3 --no-recreate
    Prometheus découvrira automatiquement les 3 instances via
    tasks.service-a (DNS round-robin Docker).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━""")

    if failed:
        print()
        print("Services en erreur (à corriger manuellement) :")
        for name in failed:
            print(f"  ✗ {name}")

    print()
    print("=" * 60)
    print()


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    argparse.ArgumentParser(
        description="Instrument all Spring Boot microservices found in the current directory."
    ).parse_args()

    root_dir = Path.cwd()
    print(f"\nRacine du projet : {root_dir}")

    # ── Phase 0 — Discovery ──────────────────────────────────────────────────
    services = discover_services(root_dir)
    if not confirm_services(services, root_dir):
        sys.exit(0)

    # ── Phase 1 — Instrument each service ────────────────────────────────────
    ok_services:     list[str] = []
    failed_services: list[str] = []

    for i, svc in enumerate(services, 1):
        success = instrument_service(svc, i, len(services))
        (ok_services if success else failed_services).append(svc["name"])

    # ── Phase 2 — Infrastructure (once, uses full service list) ──────────────
    try:
        mon_dir = generate_monitoring(root_dir, services)
        check_loki_ready(timeout=60)
        check_grafana_ready(timeout=60)
        loki_uid = get_loki_uid(max_wait_seconds=90)
        if loki_uid is None:
            print()
            print("  WARN: UID Loki non récupéré.")
            print("  Lancer après démarrage : python push_dashboards.py")
            loki_uid_for_dashboard = "loki"
        else:
            loki_uid_for_dashboard = loki_uid
        generate_dashboards(services, mon_dir, loki_uid=loki_uid_for_dashboard)
        if loki_uid is not None:
            _push_dashboards_via_api(mon_dir, loki_uid)
    except Exception as exc:
        print(f"  [ERROR] Phase 2 — infrastructure: {exc}")

    # ── Phase 3 — .env + .gitignore (once) ───────────────────────────────────
    try:
        update_env_and_gitignore(root_dir)
    except Exception as exc:
        print(f"  [ERROR] Phase 3 — .env / .gitignore: {exc}")

    # ── Summary ───────────────────────────────────────────────────────────────
    print_summary(services, ok_services, failed_services)


if __name__ == "__main__":
    main()
