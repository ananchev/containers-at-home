# energy-tariff: see ansible/notes/energy-monitoring/README.md
ARG PYTHON_IMAGE=python:3.13.18-slim
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ /app/

USER 10001
CMD ["python", "/app/main.py"]
