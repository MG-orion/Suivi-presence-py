"""Outils communs : application FastAPI de base, authentification par jeton, appels entre services."""
import os, time
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from . import jwt_

SECRET = os.environ.get("JWT_SECRET") or "dev-secret-change-me"
if not os.environ.get("JWT_SECRET"):
    print("[avertissement] JWT_SECRET non défini : secret de développement utilisé. À définir en production.")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def make_app(name: str) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError):
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.exception_handler(Exception)
    async def _crash(request: Request, exc: Exception):
        print(f"[{name}] erreur : {exc!r}")
        return JSONResponse({"error": "Erreur interne."}, status_code=500)

    @app.get("/health")
    async def _health():
        return {"service": name, "ok": True}

    return app


async def body_of(request: Request) -> dict:
    try:
        b = await request.json()
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}


def bearer(request: Request):
    h = request.headers.get("authorization", "")
    return h[7:] if h.startswith("Bearer ") else None


def auth(request: Request, *roles: str) -> dict:
    """Exige un jeton valide, éventuellement limité à certains rôles."""
    p = jwt_.verify(bearer(request), SECRET)
    if not p:
        raise ApiError(401, "Connexion requise.")
    if roles and p.get("role") not in roles:
        raise ApiError(403, "Action non autorisée.")
    return p


def service_token() -> str:
    return jwt_.sign({"sub": "service", "role": "service"}, SECRET, 60)


async def call(base: str, path: str, method: str = "GET", body=None, token: str | None = None):
    """Appel HTTP JSON vers un autre service (jeton de service par défaut)."""
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.request(
                method, base + path,
                headers={"Authorization": "Bearer " + (token or service_token())},
                json=body,
            )
    except httpx.TimeoutException:
        raise ApiError(504, "Un service ne répond pas.")
    except httpx.HTTPError:
        raise ApiError(503, "Un service est indisponible.")
    try:
        data = r.json()
    except Exception:
        data = None
    if r.status_code >= 400:
        raise ApiError(r.status_code, (data or {}).get("error") or f"Erreur {r.status_code}")
    return data


def now_ms() -> int:
    return int(time.time() * 1000)
