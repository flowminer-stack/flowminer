# syntax=docker/dockerfile:1.6
#
# FlowMiner backend image.
#
# Multi-stage build:
#   * Stage 1 (builder) installs all build-time system packages +
#     Python dependencies into a venv at /opt/venv.
#   * Stage 2 (runtime) copies the venv into a slim image with only
#     the *runtime* system packages (libpq, graphviz), and runs as a
#     non-root user.
#
# Pinning to a specific Python patch version (not a floating tag)
# so that rebuilding the image months from now reproduces the same
# environment.

# ─── Stage 1: builder ──────────────────────────────────────────────
FROM python:3.11.10-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build-time system deps for compiling native Python wheels
# (pandas/numpy/scipy/pm4py/cvxopt) and the Rust acceleration module.
# curl is needed for the Rust toolchain installer.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        g++ \
        libpq-dev \
        graphviz \
        graphviz-dev \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain (needed to compile flowminer-accel via maturin).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:$PATH"

# Isolate the Python environment in /opt/venv so it's easy to
# COPY --from=builder in the next stage and so the runtime image
# doesn't carry pip itself.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Build and install the Rust acceleration module.
COPY rust_accel/ ./rust_accel/
RUN pip install --no-cache-dir maturin \
    && cd rust_accel \
    && maturin build --release --interpreter python \
    && pip install --no-cache-dir target/wheels/*.whl \
    && cd .. \
    && rm -rf rust_accel/target


# ─── Stage 2: runtime ──────────────────────────────────────────────
FROM python:3.11.10-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8000

# Runtime-only system packages. libpq5 is the client library
# psycopg2-binary links against. graphviz is used by pm4py to
# render BPMN / Petri nets to PNG/SVG. procps ships pgrep which
# the worker/beat compose healthchecks shell out to — without it,
# the slim Python image misses pgrep entirely and the healthcheck
# exits 127, which Docker reports as "unhealthy" even though the
# celery process is running fine.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        graphviz \
        procps \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1000 flowminer \
    && useradd --system --gid flowminer --uid 1000 \
        --create-home --home-dir /home/flowminer \
        --shell /usr/sbin/nologin flowminer \
    && mkdir -p /data/uploads \
    && chown -R flowminer:flowminer /data/uploads

# Copy the installed venv from the builder stage.
COPY --from=builder /opt/venv /opt/venv

WORKDIR /app

# Copy application code LAST so edits to source don't bust the
# (large) dependency layer above.
COPY --chown=flowminer:flowminer . /app

# Bake the sample event logs into the image so the demo seeder can
# find them at /app/docs/examples without any runtime bind mount.
# The `examples` context is a named additional_context declared in
# docker-compose.yml (backend/worker/beat services) and points at
# the repo-root `docs/examples/` folder. Because the Dockerfile
# references it via COPY --from=examples, builds that go through
# `docker compose build` work out of the box; direct
# `docker build backend/` builds MUST pass
#   --build-context examples=./docs/examples
# or the COPY will fail with "invalid reference".
COPY --from=examples --chown=flowminer:flowminer . /app/docs/examples

# Drop privileges before the process starts. The audit caught
# the previous Dockerfile running as root — fixing it here.
USER flowminer

EXPOSE 8000

# Simple HTTP healthcheck hitting the app's /health endpoint.
# Uses Python stdlib (no curl/wget pulled in) to keep the runtime
# image small.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request, sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).status == 200 else 1)" \
    || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
