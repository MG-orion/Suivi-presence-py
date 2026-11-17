FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" httpx
COPY common ./common
COPY services ./services
COPY scripts ./scripts
COPY public ./public
ENV TZ=Europe/Paris DATA_DIR=/data PYTHONUNBUFFERED=1
RUN useradd -m app && mkdir /data && chown app /data
USER app
# Le service lancé est choisi par docker-compose (command)
CMD ["python", "-m", "services.gateway"]
