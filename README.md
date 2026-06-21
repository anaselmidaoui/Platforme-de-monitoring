# Monitoring Platform — PFA ENSIAS 2A

Plateforme complète de supervision intelligente pour microservices Spring Boot 3.
Collecte des métriques Prometheus, détecte les anomalies par Machine Learning, génère des suggestions de remédiation via IA (Groq), et permet d'agir directement sur les conteneurs Docker.

---

## Architecture globale

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Monitoring Platform                          │
│                                                                     │
│   React + Vite (port 5173)  ◄──►  FastAPI (port 8000)             │
│       5 pages SPA                  REST API + SSE                   │
└─────────────────┬───────────────────────────┬───────────────────────┘
                  │                           │
     ┌────────────▼────────────┐   ┌──────────▼──────────────────────┐
     │  Microservices Spring   │   │     Stack de supervision         │
     │  Boot 3 (Chaos API)     │   │                                  │
     │                         │   │  Prometheus  :9090               │
     │  service-a  :8081        │   │  Grafana     :3001               │
     │  service-b  :8082        │   │  Loki        :3100               │
     │  service-c  :8083        │   │  Jaeger      :16686              │
     └─────────────────────────┘   └──────────────────────────────────┘
```

---

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Microservices | Spring Boot 3.2 · Java 17 · Micrometer · Actuator |
| Métriques | Prometheus (scrape `/actuator/prometheus`) |
| Logs | Loki + Promtail |
| Traces | Jaeger OTLP |
| Visualisation | Grafana |
| Backend API | FastAPI (Python 3.11) + Uvicorn |
| Machine Learning | scikit-learn — RandomForestClassifier |
| IA Suggestions | Groq API — `llama-3.1-8b-instant` |
| Frontend | React 18 · Vite · Tailwind CSS · Recharts |
| Docker | Docker Compose (services + monitoring) |

---

## Structure du projet

```
PFA_final_version/
│
├── app/                             # Microservices + infrastructure
│   ├── docker-compose.yml           # Services A, B, C + frontend Nginx
│   ├── service-a/                   # Spring Boot 3 microservice A
│   │   ├── Dockerfile
│   │   └── pom.xml
│   ├── service-b/                   # Microservice B (identique)
│   ├── service-c/                   # Microservice C (identique)
│   ├── frontend/                    # Frontend Dockerisé (Nginx, port 3000)
│   └── monitoring/
│       ├── docker-compose.monitoring.yml   # Prometheus, Loki, Jaeger, Grafana
│       └── prometheus.yml                 # Config scraping des 3 services
│
├── monitoring-platform/             # Application de supervision (dev)
│   ├── backend/
│   │   ├── main.py                  # FastAPI — 28 endpoints REST/SSE
│   │   └── requirements.txt
│   ├── frontend/
│   │   ├── src/
│   │   │   ├── App.jsx              # Router + Navbar (5 pages)
│   │   │   └── pages/
│   │   │       ├── SetupPage.jsx    # Configuration & scan des services
│   │   │       ├── DashboardPage.jsx # Métriques temps réel (Recharts)
│   │   │       ├── CollectPage.jsx  # Collecte + scénarios de chaos
│   │   │       ├── AnalysePage.jsx  # Prédiction ML + suggestions IA
│   │   │       └── RemediationPage.jsx # Actions Docker (restart/scale/…)
│   │   └── package.json
│   └── start.bat                   # Lancement rapide (Windows)
│
└── scripts/
    ├── collect_metrics.py           # Script standalone de collecte
    ├── push_dashboards.py           # Push des dashboards Grafana
    ├── setup_monitoring.py          # Init de la stack de monitoring
    └── ml/
        ├── rf_model.pkl             # Modèle RandomForest entraîné
        └── data/
            ├── dataset.csv          # ~11 500 échantillons labellisés
            ├── metrics.csv          # Données brutes Prometheus
            ├── logs.json            # Logs Loki
            └── traces.json          # Traces Jaeger
```

---

## Prérequis

- **Docker Desktop** (avec Docker Compose v2)
- **Python 3.10+** avec pip
- **Node.js 18+** avec npm
- **Java 17+** + Maven (si compilation locale des microservices)
- Clé API **Groq** (gratuite sur [console.groq.com](https://console.groq.com))

---

## Démarrage rapide

### 1 — Lancer la stack infrastructure

```bash
# Créer le réseau partagé (une seule fois)
docker network create monitoring-network

# Démarrer les microservices Spring Boot
cd app
docker compose up -d --build

# Démarrer la supervision (Prometheus, Grafana, Loki, Jaeger)
cd monitoring
docker compose -f docker-compose.monitoring.yml up -d
```

**URLs disponibles après démarrage :**

| Service | URL |
|---------|-----|
| Service A | http://localhost:8081 |
| Service B | http://localhost:8082 |
| Service C | http://localhost:8083 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 (admin / admin) |
| Jaeger UI | http://localhost:16686 |

### 2 — Lancer la plateforme de monitoring

**Option A — Script automatique (Windows)**
```bat
cd monitoring-platform
start.bat
```

**Option B — Manuel**
```bash
# Terminal 1 — Backend
cd monitoring-platform/backend
pip install -r requirements.txt
set GROQ_API_KEY=gsk_VOTRE_CLE_ICI   # Windows
# export GROQ_API_KEY=gsk_VOTRE_CLE_ICI   # Linux/Mac
python -m uvicorn main:app --reload --port 8000

# Terminal 2 — Frontend
cd monitoring-platform/frontend
npm install
npm run dev
```

**Plateforme disponible sur : http://localhost:5173**

---

## Pages de la plateforme

### Configuration (`/`)
- Saisie des URLs des microservices (A, B, C)
- Scan automatique de la connectivité et des endpoints Prometheus
- Instrumentation automatique si manquante
- Chemin du projet pour docker compose

### Dashboard (`/dashboard`)
- Métriques temps réel scraped depuis Prometheus
- Graphes Recharts : latence P95, taux d'erreur, CPU, mémoire
- Fenêtre temporelle configurable (5 min → 24h)

### Collecte (`/collect`)
- **6 scénarios de chaos** sélectionnables :
  - Normal
  - Pic CPU
  - Fuite mémoire
  - Pic de latence
  - Erreurs 5xx
  - Surcharge totale
  - **Scénario réel** — simulation réaliste avec 7 combinaisons de services (`[A] [B] [C] [A+B] [A+C] [B+C] [A+B+C]`), anomalies indépendantes par service, rounds baseline (25%)
- Durée et intervalle configurables
- Résultats sauvegardés en CSV → base d'entraînement du modèle

### Analyse (`/analyse`)
- Prédiction par le modèle RandomForest sur les métriques actuelles
- Résultat par service : label prédit + probabilité + badge d'anomalie
- **Suggestion IA automatique** (Groq) dès qu'une anomalie est détectée :
  - Panel avec 3 sections : Diagnostic / Actions immédiates / Prévention
  - Boutons : Copier · Régénérer · Fermer
- Historique des 60 dernières prédictions avec graphes

### Remédiation (`/remediation`)
- Liste de tous les conteneurs Docker (running + stopped)
- Stats temps réel : CPU%, mémoire utilisée / limite
- Actions par conteneur : **Redémarrer · Arrêter · Démarrer**
- **Actions suggérées** contextuelles selon l'anomalie détectée :
  - `cpu_spike` → Redémarrer / Augmenter les CPU
  - `memory_leak` → Redémarrer / Augmenter la mémoire
  - `latency_spike` / `error_5xx` → Redémarrer / Consulter les logs
- **Modifier les ressources** : limite mémoire (MB) + cores CPU (`docker update`)
- **Scale** des services (docker compose) — curseur 1-10 réplicas
- **Viewer de logs** : dernières N lignes avec coloration erreurs/warnings

---

## Modèle Machine Learning

### Algorithme : RandomForestClassifier (scikit-learn)

**Features utilisées** (par service) :
| Feature | Description |
|---------|-------------|
| `latency_p95` | Latence 95e percentile (secondes) |
| `error_rate` | Taux d'erreur HTTP (0–1) |
| `cpu_usage` | Utilisation CPU normalisée |
| `memory_mb` | Mémoire utilisée (MB) |
| `req_per_second` | Requêtes par seconde |
| `has_errors_in_logs` | Erreurs dans les logs Loki (0/1) |
| `has_slow_traces` | Traces lentes dans Jaeger (0/1) |

**Classes prédites** :
| Label | Signification |
|-------|--------------|
| `normal` | Comportement nominal |
| `cpu_spike` | Pic d'utilisation CPU |
| `memory_leak` | Fuite mémoire |
| `latency_spike` | Augmentation anormale de la latence |
| `error_5xx` | Taux d'erreurs serveur élevé |

**Dataset** : ~11 500 échantillons collectés via les scénarios de chaos.

**Entraînement** : déclenché depuis l'interface (page Analyse → "Entraîner le modèle"), le modèle est sauvegardé en `rf_model.pkl` et rechargé à chaud.

---

## API REST — Référence complète

### Santé & Configuration
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/health` | État du backend |
| POST | `/api/scan` | Scanne la connectivité des services |
| POST | `/api/instrument` | Instrumente automatiquement un service |

### Métriques
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/metrics/range` | Requête Prometheus sur une plage temporelle |
| GET | `/api/metrics/loki` | Logs depuis Loki |

### Collecte
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/collect/start` | Démarre la collecte de métriques |
| POST | `/api/collect/stop` | Arrête la collecte |
| GET | `/api/collect/status` | État de la collecte en cours |
| GET | `/api/collect/stream` | SSE — stream en temps réel |
| DELETE | `/api/collect/data` | Supprime les données collectées |

### Modèle ML
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/model/status` | État du modèle (entraîné / classes / score) |
| POST | `/api/model/train` | Entraîne le modèle sur le dataset CSV |
| POST | `/api/model/predict/current` | Prédit l'état actuel des 3 services |
| GET | `/api/model/history` | Historique des prédictions |

### Suggestions IA (Groq)
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/suggestions/generate` | Génère une suggestion en français (llama-3.1-8b) |
| GET | `/api/suggestions/status` | Vérifie la disponibilité de Groq et de la clé API |

### Chaos Engineering
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/chaos/apply` | Applique un profil chaos à un ou plusieurs services |
| POST | `/api/chaos/apply-multi` | Applique un profil différent par service |
| GET | `/api/chaos/status` | Lit l'état chaos actuel de chaque service |

### Docker (legacy)
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/docker/containers` | Liste les conteneurs running |
| POST | `/api/docker/scale` | Scale un service (docker compose) |

### Remédiation Docker
| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/remediation/containers` | Tous les conteneurs (running + stopped) |
| GET | `/api/remediation/stats` | CPU% + mémoire temps réel (`docker stats`) |
| POST | `/api/remediation/restart` | Redémarre un conteneur |
| POST | `/api/remediation/stop` | Arrête un conteneur |
| POST | `/api/remediation/start` | Démarre un conteneur arrêté |
| POST | `/api/remediation/resources` | Modifie mémoire/CPU (`docker update`) |
| POST | `/api/remediation/scale` | Scale via docker compose |
| GET | `/api/remediation/logs/{container}` | Dernières N lignes de logs |

Documentation interactive : **http://localhost:8000/docs**

---

## Variables d'environnement

| Variable | Obligatoire | Description |
|----------|-------------|-------------|
| `GROQ_API_KEY` | Oui (suggestions IA) | Clé API Groq — [console.groq.com](https://console.groq.com) |

> Ne jamais commiter la clé API dans le code source. Utiliser une variable d'environnement ou un fichier `.env`.

---

## Ports utilisés

| Port | Service |
|------|---------|
| 5173 | Frontend React (dev) |
| 8000 | Backend FastAPI |
| 8081 | Microservice A (Spring Boot) |
| 8082 | Microservice B (Spring Boot) |
| 8083 | Microservice C (Spring Boot) |
| 9090 | Prometheus |
| 3001 | Grafana |
| 3100 | Loki |
| 16686 | Jaeger UI |

---

## Auteur

Projet de Fin d'Année — ENSIAS 2A  
Anasmidaoui — 2026
