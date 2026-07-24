# Local infrastructure profile

The `local` Compose profile starts the API, web app, PostgreSQL, Redis and Ollama with synthetic development
defaults. It is for a developer machine only. None of its passwords, database names or URLs are production
values.

From the repository root:

```bash
cp infra/local/.env.example infra/local/.env
docker compose --env-file infra/local/.env \
  -f infra/local/docker-compose.yml \
  --profile local up --build
```

Default endpoints:

- web: `http://localhost:3001`
- API health: `http://localhost:3000/healthz`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- Ollama: `http://localhost:11434`

Data lives in named volumes. Stop containers without deleting data:

```bash
docker compose -f infra/local/docker-compose.yml --profile local down
```

Deleting volumes is intentionally a separate operator action. Replace the local password and avoid exposing
the database, cache or model service beyond a trusted development machine.
