"""Passerelle API : seul service exposé. Sert le front, gère le cookie de session, vérifie les
jetons et route les appels vers les services internes. Port 3000."""
import asyncio, os, time
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from common import jwt_
from common.http import ApiError, SECRET, body_of, call, make_app, now_ms
from common.rules import RULES

COOKIE = "token"
MAX_AGE = 8 * 3600
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


def create_app(urls, secure_cookie=False, introspect_s=15.0, public_dir=None):
    public_dir = public_dir or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
    app = make_app("gateway")
    cache: dict = {}  # id -> (instant, {tv, role} | None)

    @app.middleware("http")
    async def headers_and_csrf(request: Request, call_next):
        if request.url.path.startswith("/api"):
            # Protection CSRF : toute requête modifiante doit porter l'en-tête personnalisé.
            if request.method != "GET" and request.headers.get("x-presence") != "1":
                return JSONResponse({"error": "Requête refusée."}, status_code=403)
        resp = await call_next(request)
        resp.headers.update({
            "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY"})
        if request.url.path.startswith("/api"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    def set_cookie(resp, token):
        resp.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=secure_cookie,
                        max_age=MAX_AGE, path="/")

    def clear_cookie(resp):
        resp.delete_cookie(COOKIE, path="/")

    async def version_of(uid):
        c = cache.get(uid)
        if c and time.time() - c[0] < introspect_s:
            return c[1]
        v = None
        try:
            u = await call(urls["auth"], "/internal/users/" + uid)
            v = {"tv": u["tokenVersion"], "role": u["role"]}
        except ApiError as e:
            if e.status != 404:
                raise
        cache[uid] = (time.time(), v)
        return v

    async def need_auth(request: Request, *roles):
        token = request.cookies.get(COOKIE)
        p = jwt_.verify(token, SECRET) if token else None
        if not p:
            raise ApiError(401, "Connexion requise.")
        v = await version_of(p["sub"])
        if not v or v["tv"] != p.get("tv") or v["role"] != p.get("role"):
            raise ApiError(401, "Session expirée, reconnectez-vous.")  # compte supprimé ou jeton révoqué
        if roles and p["role"] not in roles:
            raise ApiError(403, "Action non autorisée.")
        return p, token

    # ----- connexion -----
    @app.post("/api/login")
    async def login(request: Request):
        b = await body_of(request)
        r = await call(urls["auth"], "/login", "POST", {"email": b.get("email"), "password": b.get("password")})
        resp = JSONResponse({"user": r["user"]})
        set_cookie(resp, r["token"])
        return resp

    @app.post("/api/logout")
    async def logout():
        resp = JSONResponse({"ok": True})
        clear_cookie(resp)
        return resp

    @app.post("/api/password")
    async def password(request: Request):
        p, token = await need_auth(request)
        r = await call(urls["auth"], "/password", "POST", await body_of(request), token)
        cache.pop(p["sub"], None)
        resp = JSONResponse({"ok": True})
        set_cookie(resp, r["token"])
        return resp

    # ----- données agrégées -----
    @app.get("/api/bootstrap")
    async def bootstrap(request: Request):
        p, t = await need_auth(request)
        users, sessions, st = await asyncio.gather(
            call(urls["auth"], "/users", token=t),
            call(urls["planning"], "/sessions", token=t),
            call(urls["attendance"], "/state", token=t))
        me = next((u for u in users if u["id"] == p["sub"]),
                  {"id": p["sub"], "first": p.get("first"), "name": p.get("name"), "role": p["role"]})
        out = []
        for s in sessions:
            state = st["states"].get(s["id"], {"status": "planned", "openedAt": None})
            out.append({**s, "status": state["status"], "openedAt": state["openedAt"],
                        "marks": st["marks"].get(s["id"], {})})
        return {"me": me,
                "students": [u for u in users if u["role"] == "student"],
                "trainers": [u for u in users if u["role"] == "trainer"],
                "sessions": out, "justifs": st["justifs"], "now": now_ms(), "rules": RULES}

    # ----- routage vers les services -----
    def forward(method, base, path, roles, created=False):
        async def handler(request: Request):
            _, token = await need_auth(request, *roles)
            target = path
            for k, v in request.path_params.items():
                target = target.replace("{" + k + "}", v)
            body = await body_of(request) if method in ("POST", "PUT") else None
            r = await call(urls[base], target, method, body, token)
            return JSONResponse(r, status_code=201 if created else 200)
        app.add_api_route("/api" + path, handler, methods=[method])

    ADM, TRA, STU = ("admin",), ("trainer", "admin"), ("student",)
    forward("POST", "auth", "/users", ADM, True)
    forward("POST", "auth", "/users/{id}/reset-password", ADM)
    forward("DELETE", "auth", "/users/{id}", ADM)
    forward("POST", "planning", "/sessions", ADM, True)
    forward("DELETE", "planning", "/sessions/{id}", ADM)
    forward("POST", "attendance", "/sessions/{id}/open", TRA)
    forward("POST", "attendance", "/sessions/{id}/close", TRA)
    forward("GET", "attendance", "/sessions/{id}/code", TRA)
    forward("GET", "attendance", "/sessions/{id}/signatures", TRA)
    forward("POST", "attendance", "/sessions/{id}/point", STU, True)
    forward("PUT", "attendance", "/sessions/{id}/marks/{studentId}", TRA)
    forward("POST", "attendance", "/justifs", STU, True)
    forward("PUT", "attendance", "/justifs/{id}", ADM)

    # Le front est servi en dernier, pour ne pas masquer les routes /api.
    app.mount("/", StaticFiles(directory=public_dir, html=True), name="static")
    return app


def main():
    import uvicorn
    app = create_app({"auth": os.environ.get("AUTH_URL", "http://localhost:4001"),
                      "planning": os.environ.get("PLANNING_URL", "http://localhost:4002"),
                      "attendance": os.environ.get("ATTENDANCE_URL", "http://localhost:4003")},
                     secure_cookie=os.environ.get("COOKIE_SECURE") == "1")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 3000)), log_level="warning")


if __name__ == "__main__":
    main()
