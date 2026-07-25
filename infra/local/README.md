# Local infrastructure profile

The `local` Compose profile starts the API, web app, PostgreSQL, Redis and Ollama. It is for a developer
machine only. Services bind to loopback, and no password is stored in a tracked file.

From the repository root:

```bash
yarn local:env
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

`yarn local:env` creates random PostgreSQL and Redis passwords in the ignored `infra/local/.env` file and
refuses to overwrite it. Deleting volumes is intentionally a separate operator action.
