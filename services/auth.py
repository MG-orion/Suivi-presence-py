"""Service d'authentification : comptes, mots de passe, rôles, jetons. Port 4001."""
import asyncio, os, re, secrets, sqlite3, time
from datetime import datetime, timezone
from fastapi import Request
from fastapi.responses import JSONResponse
from common import jwt_
from common.http import ApiError, SECRET, auth, body_of, call, make_app
from common.passwords import hash_password, temp_password, verify_password

TOKEN_TTL = 8 * 3600
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
DUMMY_HASH = hash_password("mot-de-passe-factice")  # égalise le temps de réponse si le compte n'existe pas


def open_db(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('student','trainer','admin')),
        first TEXT NOT NULL,
        name TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL)""")
    db.commit()
    return db


def insert_user(db, email, password, role, first, name, id=None) -> str:
    id = id or "u_" + secrets.token_hex(6)
    with db:
        db.execute(
            "INSERT INTO users (id,email,pass_hash,role,first,name,created_at) VALUES (?,?,?,?,?,?,?)",
            (id, email.strip(), hash_password(password), role, first.strip(), name.strip(),
             datetime.now(timezone.utc).isoformat()),
        )
    return id


def dto(u, with_email=False) -> dict:
    d = {"id": u["id"], "first": u["first"], "name": u["name"], "role": u["role"]}
    if with_email:
        d["email"] = u["email"]
    return d


def create_app(db, urls):
    app = make_app("auth")
    fails: dict = {}  # limitation des tentatives de connexion

    def text(v, n):
        return v.strip()[:n] if isinstance(v, str) else ""

    def token_for(u):
        return jwt_.sign({"sub": u["id"], "role": u["role"], "first": u["first"], "name": u["name"],
                          "tv": u["token_version"]}, SECRET, TOKEN_TTL)

    def user(uid):
        return db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()

    @app.post("/login")
    async def login(request: Request):
        b = await body_of(request)
        email = text(b.get("email"), 200).lower()
        password = b.get("password") if isinstance(b.get("password"), str) else ""
        key = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "")) + "|" + email
        f = fails.get(key)
        if f and f["n"] >= 5 and time.time() - f["t"] < 900:
            raise ApiError(429, "Trop de tentatives. Réessayez dans 15 minutes.")
        u = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        ok = verify_password(password, u["pass_hash"] if u else DUMMY_HASH) and u is not None
        if not ok:
            recent = f and time.time() - f["t"] < 900
            fails[key] = {"n": f["n"] + 1 if recent else 1, "t": time.time()}
            raise ApiError(401, "Adresse e-mail ou mot de passe incorrect.")
        fails.pop(key, None)
        return {"token": token_for(u), "user": dto(u, True)}

    @app.get("/me")
    async def me(request: Request):
        p = auth(request, "student", "trainer", "admin")
        u = user(p["sub"])
        if not u:
            raise ApiError(404, "Compte introuvable.")
        return dto(u, True)

    @app.post("/password")
    async def password(request: Request):
        p = auth(request, "student", "trainer", "admin")
        b = await body_of(request)
        u = user(p["sub"])
        if not u or not verify_password(str(b.get("old") or ""), u["pass_hash"]):
            raise ApiError(403, "Ancien mot de passe incorrect.")
        new = str(b.get("new") or "")
        if len(new) < 8:
            raise ApiError(400, "Le nouveau mot de passe doit faire au moins 8 caractères.")
        with db:  # tous les anciens jetons deviennent invalides
            db.execute("UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?",
                       (hash_password(new), u["id"]))
        return {"ok": True, "token": token_for(user(u["id"]))}

    @app.get("/users")
    async def users(request: Request):
        me_ = auth(request, "student", "trainer", "admin")
        if me_["role"] == "admin":
            rows = db.execute("SELECT * FROM users ORDER BY name, first").fetchall()
        elif me_["role"] == "trainer":
            rows = db.execute("SELECT * FROM users WHERE role = 'student' OR id = ? ORDER BY name, first",
                              (me_["sub"],)).fetchall()
        else:
            rows = db.execute("SELECT * FROM users WHERE id = ?", (me_["sub"],)).fetchall()
        return [dto(u, me_["role"] == "admin" or u["id"] == me_["sub"]) for u in rows]

    @app.post("/users")
    async def create_user(request: Request):
        auth(request, "admin")
        b = await body_of(request)
        role = b.get("role")
        if role not in ("student", "trainer"):
            raise ApiError(400, "Le rôle doit être étudiant ou formateur.")
        first, name, email = text(b.get("first"), 80), text(b.get("name"), 80), text(b.get("email"), 200)
        if not first or not name:
            raise ApiError(400, "Renseignez le prénom et le nom.")
        if not EMAIL_RE.match(email):
            raise ApiError(400, "Adresse e-mail invalide.")
        if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise ApiError(409, "Cette adresse e-mail est déjà utilisée.")
        pw = temp_password()
        uid = insert_user(db, email, pw, role, first, name)
        return JSONResponse({"user": dto(user(uid), True), "tempPassword": pw}, status_code=201)

    @app.post("/users/{uid}/reset-password")
    async def reset_password(request: Request):
        auth(request, "admin")
        u = user(request.path_params["uid"])
        if not u:
            raise ApiError(404, "Compte introuvable.")
        pw = temp_password()
        with db:
            db.execute("UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?",
                       (hash_password(pw), u["id"]))
        return {"tempPassword": pw}

    @app.delete("/users/{uid}")
    async def delete_user(request: Request):
        auth(request, "admin")
        u = user(request.path_params["uid"])
        if not u:
            raise ApiError(404, "Compte introuvable.")
        if u["role"] == "admin":
            raise ApiError(400, "Un compte d'administration ne peut pas être supprimé ici.")
        with db:
            db.execute("DELETE FROM users WHERE id = ?", (u["id"],))
        # Nettoyage dans les autres services (au mieux : en production, passer par une file de messages).
        jobs = []
        if urls.get("attendance"):
            jobs.append(call(urls["attendance"], f"/internal/users/{u['id']}/purge", "POST", {}))
        if urls.get("planning") and u["role"] == "trainer":
            jobs.append(call(urls["planning"], f"/internal/trainers/{u['id']}/unassign", "POST", {}))
        for r in await asyncio.gather(*jobs, return_exceptions=True):
            if isinstance(r, Exception):
                print("[auth] nettoyage différé :", getattr(r, "message", r))
        return {"ok": True}

    # Routes internes (jeton de service uniquement)
    @app.get("/internal/users")
    async def internal_users(request: Request):
        auth(request, "service")
        role = request.query_params.get("role")
        rows = (db.execute("SELECT * FROM users WHERE role = ?", (role,)) if role
                else db.execute("SELECT * FROM users")).fetchall()
        return [dto(u) for u in rows]

    @app.get("/internal/users/{uid}")
    async def internal_user(request: Request):
        auth(request, "service")
        u = user(request.path_params["uid"])
        if not u:
            raise ApiError(404, "Compte introuvable.")
        return {**dto(u), "tokenVersion": u["token_version"]}

    return app


def main():
    import uvicorn
    port = int(os.environ.get("PORT", 4001))
    db = open_db(os.path.join(os.environ.get("DATA_DIR", "data"), "auth.db"))
    app = create_app(db, {"attendance": os.environ.get("ATTENDANCE_URL", "http://localhost:4003"),
                          "planning": os.environ.get("PLANNING_URL", "http://localhost:4002")})
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
