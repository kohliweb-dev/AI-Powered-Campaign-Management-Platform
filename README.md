# AI-Powered Campaign Management Platform

An AI-powered campaign management platform built using FastAPI, PostgreSQL, MongoDB, Redis, Ollama, RAG, Docker, Kubernetes, Prometheus, and Grafana.

## Project Overview

This platform helps users create, manage, search, and analyze marketing campaigns using AI-powered features.

It also includes an AI chatbot that can answer questions using uploaded PDF documents through Retrieval-Augmented Generation (RAG).

## Features

- **User Management:** User registration, login, password hashing, and JWT authentication.
- **Campaign Management:** Create, view, update, and delete marketing campaigns.
- **AI Campaign Generator:** Generate campaign ideas and marketing strategies using local Ollama Llama 3.2.
- **AI-Powered Campaign Search:** Search campaigns using semantic search.
- **AI Chatbot:** Chat with an AI assistant.
- **PDF-Based RAG:** Upload PDF documents, extract text, generate embeddings, and retrieve relevant information.
- **Analytics Dashboard:** View campaign and API analytics.
- **Caching:** Redis caching for improved performance.
- **Monitoring:** Prometheus metrics and Grafana dashboards.
- **Containerization:** Docker and Docker Compose.
- **Orchestration:** Kubernetes deployments and services.

## Technology Stack

| Component | Technology |
|---|---|
| Backend | Python, FastAPI |
| Frontend | HTML, CSS, JavaScript |
| Relational Database | PostgreSQL |
| NoSQL Database | MongoDB |
| Caching | Redis |
| AI Model | Ollama - Llama 3.2 |
| Embedding Model | nomic-embed-text |
| RAG Vector Database | ChromaDB |
| Authentication | JWT |
| Containers | Docker |
| Orchestration | Kubernetes |
| Monitoring | Prometheus |
| Dashboards | Grafana |

## Project Structure

```text
Enterprise_Capstone/
│
├── backend/
│   ├── main.py
│   ├── config.py
│   ├── database.py
│   ├── mongodb.py
│   ├── cache.py
│   ├── models.py
│   ├── schemas.py
│   ├── security.py
│   └── rag.py
│
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
│
├── kubernetes/
├── monitoring/
├── docker-compose.yml
├── Dockerfile
├── Dockerfile.frontend
├── requirements.txt
└── .gitignore
```

## Getting Started

### Prerequisites

- Python
- Docker Desktop
- PostgreSQL
- MongoDB
- Redis
- Ollama
- Kubernetes enabled in Docker Desktop

### 1. Clone the Repository

```bash
git clone https://github.com/kohliweb-dev/AI-Powered-Campaign-Management-Platform.git
cd AI-Powered-Campaign-Management-Platform
```

### 2. Create a Virtual Environment

```bash
python -m venv .venv
```

Activate it in Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure Environment Variables

Create a `.env` file in the project root and configure your database URLs and application secret.

Required configuration includes:

- `POSTGRES_URL`
- `MONGO_URL`
- `REDIS_URL`
- `SECRET_KEY`

Keep all credentials private. Never commit your `.env` file.

### 5. Start Ollama

Install Ollama and download the required models:

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

Make sure the Ollama service is running.

### 6. Run the Backend

```bash
uvicorn backend.main:app --reload
```

Backend API documentation:

http://localhost:8000/docs

### 7. Run the Frontend

Open the frontend using a local web server, or use the Docker Compose setup.

## Docker Deployment

Build and start the application using:

```bash
docker compose up --build -d
```

Frontend:

http://localhost:5500

Backend API:

http://localhost:8001/docs

## Monitoring

The project integrates Prometheus for collecting backend metrics and Grafana for monitoring and visualization.

The monitoring dashboard includes:

- Total API Requests
- 95th Percentile API Response Time
- API Requests Per Second
- Backend Availability

## Kubernetes Deployment

Kubernetes manifests are available in the `kubernetes/` directory.

The project includes backend and frontend deployments and services.

## AI and RAG Workflow

1. User uploads a PDF document.
2. Text is extracted from the PDF.
3. Text is divided into smaller chunks.
4. Ollama generates embeddings.
5. Embeddings are stored in ChromaDB.
6. User asks a question through the chatbot.
7. Relevant document chunks are retrieved and used to generate an answer.

## Future Improvements

- OpenAI API integration.
- Additional AI-powered campaign recommendations.
- Advanced analytics and reporting.

## Author

**HK**

GitHub: https://github.com/kohliweb-dev

---

*Developed as an Enterprise Capstone Project.*