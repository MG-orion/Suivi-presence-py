"""Service de pointage : sessions ouvertes/clôturées, code tournant, signatures, appel manuel,
justificatifs. C'est lui qui applique les règles de retard et d'absence. Port 4003."""
import hashlib, hmac, math, os, re, secrets, sqlite3, time
from datetime import datetime, timezone
from fastapi import Request
from fastapi.responses import JSONResponse
from common.http import ApiError, auth, body_of, call, make_app
from common.rules import RULES

SIG_RE = re.compile(r"^[MLl0-9 .\-]+$")


def open_db(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.executescript("""
    CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','open','closed')),
        seed TEXT NOT NULL DEFAULT '',
        opened_at TEXT);
    CREATE TABLE IF NOT EXISTS marks (
        session_id TEXT NOT NULL, student_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('P','R','A','J')),
        method TEXT NOT NULL CHECK (method IN ('signature','qr','manual','auto')),
        at TEXT NOT NULL, sig TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id, student_id));
    CREATE INDEX IF NOT EXISTS idx_marks_student ON marks(student_id);
    CREATE TABLE IF NOT EXISTS justifs (
        id TEXT PRIMARY KEY, student_id TEXT NOT NULL, session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','refused')),
        at TEXT NOT NULL, decided_at TEXT,
        UNIQUE (student_id, session_id));
    """)
    db.commit()
    return db


# ---------- règles métier (fonctions pures, testées) ----------

def point_state(status: str, start_ms: float, now_ms: float):
    """(ok, statut P/R, message). Fenêtre : 15 min avant → 15 min après le début."""
    if status != "open":
        return False, None, ("Cette session est clôturée." if status == "closed"
                             else "Le formateur n'a pas encore ouvert le pointage.")
    m = (now_ms - start_ms) / 60000
    if m < -RULES["before"]:
        return False, None, f"Le pointage ouvre {RULES['before']} minutes avant le début."
    if m <= RULES["late"]:
        return True, "P", None
    if m <= RULES["after"]:
        return True, "R", None
    return False, None, "Le délai de pointage est dépassé. Voyez avec votre formateur."


def slice_of(t_ms: float) -> int:
    return int(t_ms // (RULES["qrSeconds"] * 1000))


def code_for(seed: str, sl: int) -> str:
    d = hmac.new(seed.encode(), str(sl).encode(), hashlib.sha256).digest()
    return str(int.from_bytes(d[:4], "big") % 1000000).zfill(6)


def check_code(seed: str, given, now_ms: float) -> bool:
    digits = re.sub(r"\D", "", str(given or ""))[-6:]
    if len(digits) != 6 or not seed:
        return False
    s = slice_of(now_ms)  # la tranche courante et la précédente sont acceptées
    return any(hmac.compare_digest(code_for(seed, x), digits) for x in (s, s - 1))


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_app(db, urls):
    app = make_app("attendance")

    async def get_session(sid):
        try:
            return await call(urls["planning"], "/internal/sessions/" + sid)
        except ApiError as e:
            if e.status == 404:
                raise ApiError(404, "Session introuvable.")
            raise

    def get_state(sid):
        r = db.execute("SELECT * FROM session_state WHERE session_id = ?", (sid,)).fetchone()
        return dict(r) if r else {"session_id": sid, "status": "planned", "seed": "", "opened_at": None}

    async def manageable(request):
        u = auth(request, "trainer", "admin")
        s = await get_session(request.path_params["sid"])
        if not (u["role"] == "admin" or s.get("trainerId") == u["sub"]):
            raise ApiError(403, "Cette session ne vous est pas attribuée.")
        return s

    # ----- lecture : état agrégé, filtré selon le rôle -----
    @app.get("/state")
    async def state(request: Request):
        u = auth(request, "student", "trainer", "admin")
        q = "SELECT session_id, student_id, status, method, at, (sig <> '') AS g FROM marks"
        rows = (db.execute(q + " WHERE student_id = ?", (u["sub"],)) if u["role"] == "student"
                else db.execute(q)).fetchall()
        marks: dict = {}
        for r in rows:
            marks.setdefault(r["session_id"], {})[r["student_id"]] = {
                "s": r["status"], "m": r["method"], "t": r["at"], "g": bool(r["g"])}
        states = {r["session_id"]: {"status": r["status"], "openedAt": r["opened_at"]}
                  for r in db.execute("SELECT session_id, status, opened_at FROM session_state")}
        jq = ("SELECT id, student_id AS stu, session_id AS ses, reason, status, at, "
              "decided_at AS decidedAt FROM justifs")
        if u["role"] == "student":
            justifs = [dict(r) for r in db.execute(jq + " WHERE student_id = ?", (u["sub"],))]
        elif u["role"] == "admin":
            justifs = [dict(r) for r in db.execute(jq)]
        else:
            justifs = []
        return {"states": states, "marks": marks, "justifs": justifs}

    # ----- cycle de vie d'une session -----
    @app.post("/sessions/{sid}/open")
    async def open_session(request: Request):
        s = await manageable(request)
        seed = get_state(s["id"])["seed"] or secrets.token_hex(16)
        with db:
            db.execute("""INSERT INTO session_state (session_id, status, seed, opened_at) VALUES (?, 'open', ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET status = 'open', seed = excluded.seed,
                opened_at = CASE WHEN session_state.status = 'open' THEN session_state.opened_at ELSE excluded.opened_at END""",
                       (s["id"], seed, iso_now()))
        return {"ok": True}

    @app.post("/sessions/{sid}/close")
    async def close_session(request: Request):
        s = await manageable(request)
        students = await call(urls["auth"], "/internal/users?role=student")
        now = iso_now()
        with db:  # les étudiants sans pointage sont notés absents (automatique)
            for stu in students:
                db.execute("INSERT OR IGNORE INTO marks (session_id, student_id, status, method, at) VALUES (?, ?, 'A', 'auto', ?)",
                           (s["id"], stu["id"], now))
            db.execute("""INSERT INTO session_state (session_id, status) VALUES (?, 'closed')
                ON CONFLICT(session_id) DO UPDATE SET status = 'closed'""", (s["id"],))
        return {"ok": True}

    @app.get("/sessions/{sid}/code")
    async def session_code(request: Request):
        s = await manageable(request)
        st = get_state(s["id"])
        if st["status"] != "open":
            raise ApiError(409, "Le pointage n'est pas ouvert.")
        now = time.time() * 1000
        sl = slice_of(now)
        left = max(1, math.ceil(((sl + 1) * RULES["qrSeconds"] * 1000 - now) / 1000))
        code = code_for(st["seed"], sl)
        return {"code": code, "payload": f"PRESENCE:{s['id']}:{code}", "left": left}

    # ----- pointage par l'étudiant -----
    @app.post("/sessions/{sid}/point")
    async def point(request: Request):
        u = auth(request, "student")
        s = await get_session(request.path_params["sid"])
        st = get_state(s["id"])
        b = await body_of(request)
        method = b.get("method")
        if method not in ("signature", "qr"):
            raise ApiError(400, "Mode de pointage invalide.")
        if db.execute("SELECT 1 FROM marks WHERE session_id = ? AND student_id = ?", (s["id"], u["sub"])).fetchone():
            raise ApiError(409, "Votre présence est déjà enregistrée.")
        now = time.time() * 1000
        ok, status, msg = point_state(st["status"], s["startMs"], now)
        if not ok:
            raise ApiError(403, msg)
        sig = ""
        if method == "qr":
            if not check_code(st["seed"], b.get("code"), now):
                raise ApiError(403, "Code incorrect ou expiré. Vérifiez le code affiché.")
        else:
            sig = b.get("sig") if isinstance(b.get("sig"), str) else ""
            if len(sig) < 10 or len(sig) > 9000 or not SIG_RE.match(sig):
                raise ApiError(400, "Signature invalide.")
        with db:
            n = db.execute("INSERT OR IGNORE INTO marks (session_id, student_id, status, method, at, sig) VALUES (?,?,?,?,?,?)",
                           (s["id"], u["sub"], status, method, iso_now(), sig)).rowcount
        if not n:
            raise ApiError(409, "Votre présence est déjà enregistrée.")
        return JSONResponse({"ok": True, "status": status}, status_code=201)

    # ----- appel manuel -----
    @app.put("/sessions/{sid}/marks/{student_id}")
    async def manual_mark(request: Request):
        s = await manageable(request)
        k = (await body_of(request)).get("s")
        if k not in ("P", "R", "A", "J"):
            raise ApiError(400, "Statut invalide.")
        try:
            stu = await call(urls["auth"], "/internal/users/" + request.path_params["student_id"])
        except ApiError as e:
            if e.status == 404:
                raise ApiError(404, "Étudiant introuvable.")
            raise
        if stu["role"] != "student":
            raise ApiError(404, "Étudiant introuvable.")
        with db:
            db.execute("""INSERT INTO marks (session_id, student_id, status, method, at, sig) VALUES (?,?,?,'manual',?, '')
                ON CONFLICT(session_id, student_id) DO UPDATE SET status = excluded.status, method = 'manual',
                at = excluded.at, sig = ''""", (s["id"], stu["id"], k, iso_now()))
        return {"ok": True}

    @app.get("/sessions/{sid}/signatures")
    async def signatures(request: Request):
        s = await manageable(request)
        return {r["student_id"]: r["sig"] for r in
                db.execute("SELECT student_id, sig FROM marks WHERE session_id = ? AND sig <> ''", (s["id"],))}

    # ----- justificatifs -----
    @app.post("/justifs")
    async def create_justif(request: Request):
        u = auth(request, "student")
        b = await body_of(request)
        s = await get_session(str(b.get("sessionId") or ""))
        reason = b.get("reason").strip()[:500] if isinstance(b.get("reason"), str) else ""
        if len(reason) < 5:
            raise ApiError(400, "Indiquez un motif (5 caractères minimum).")
        m = db.execute("SELECT status FROM marks WHERE session_id = ? AND student_id = ?", (s["id"], u["sub"])).fetchone()
        if not m or m["status"] != "A":
            raise ApiError(400, "Un justificatif ne peut être déposé que pour une absence.")
        if time.time() * 1000 > s["startMs"] + RULES["justifyHours"] * 3600000:
            raise ApiError(403, "Le délai de dépôt est dépassé.")
        jid = "j_" + secrets.token_hex(5)
        with db:
            n = db.execute("INSERT OR IGNORE INTO justifs (id, student_id, session_id, reason, at) VALUES (?,?,?,?,?)",
                           (jid, u["sub"], s["id"], reason, iso_now())).rowcount
        if not n:
            raise ApiError(409, "Un justificatif existe déjà pour cette absence.")
        return JSONResponse({"ok": True, "id": jid}, status_code=201)

    @app.put("/justifs/{jid}")
    async def decide_justif(request: Request):
        auth(request, "admin")
        v = (await body_of(request)).get("status")
        if v not in ("validated", "refused"):
            raise ApiError(400, "Décision invalide.")
        j = db.execute("SELECT * FROM justifs WHERE id = ?", (request.path_params["jid"],)).fetchone()
        if not j:
            raise ApiError(404, "Justificatif introuvable.")
        if j["status"] != "pending":
            raise ApiError(409, "Ce justificatif a déjà été traité.")
        with db:
            db.execute("UPDATE justifs SET status = ?, decided_at = ? WHERE id = ?", (v, iso_now(), j["id"]))
            if v == "validated":  # absence justifiée : exclue du calcul du taux
                db.execute("UPDATE marks SET status = 'J' WHERE session_id = ? AND student_id = ?",
                           (j["session_id"], j["student_id"]))
        return {"ok": True}

    # ----- routes internes (nettoyage demandé par les autres services) -----
    @app.post("/internal/sessions/{sid}/purge")
    async def purge_session(request: Request):
        auth(request, "service")
        sid = request.path_params["sid"]
        with db:
            for t in ("marks", "justifs", "session_state"):
                db.execute(f"DELETE FROM {t} WHERE session_id = ?", (sid,))
        return {"ok": True}

    @app.post("/internal/users/{uid}/purge")
    async def purge_user(request: Request):
        auth(request, "service")
        uid = request.path_params["uid"]
        with db:
            db.execute("DELETE FROM marks WHERE student_id = ?", (uid,))
            db.execute("DELETE FROM justifs WHERE student_id = ?", (uid,))
        return {"ok": True}

    return app


def main():
    import uvicorn
    port = int(os.environ.get("PORT", 4003))
    db = open_db(os.path.join(os.environ.get("DATA_DIR", "data"), "attendance.db"))
    app = create_app(db, {"planning": os.environ.get("PLANNING_URL", "http://localhost:4002"),
                          "auth": os.environ.get("AUTH_URL", "http://localhost:4001")})
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
